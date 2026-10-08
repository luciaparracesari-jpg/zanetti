// Prueba de punta a punta contra una API en marcha y una base de datos de desarrollo.
// Uso:
//   API_BASE=http://localhost:4000/api/v1 ADMIN_EMAIL=admin@zanetti.mx ADMIN_PASSWORD=... \
//   ADMIN_NEW_PASSWORD=... DATABASE_URL=... node --test test/
// Crea datos con un sufijo único; no la corras contra producción.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const BASE = process.env.API_BASE ?? 'http://localhost:4000/api/v1';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@zanetti.mx';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const ADMIN_NEW_PASSWORD = process.env.ADMIN_NEW_PASSWORD ?? `${ADMIN_PASSWORD}x1`;
const RUN = Date.now().toString(36).toUpperCase();

class Client {
  cookie = '';
  async req(method, path, body, { csrf = true } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (csrf) headers['x-erp-client'] = 'web';
    if (this.cookie) headers.cookie = this.cookie;
    const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  }
  get = (p) => this.req('GET', p);
  post = (p, b) => this.req('POST', p, b ?? {});
  patch = (p, b) => this.req('PATCH', p, b);
  put = (p, b) => this.req('PUT', p, b);
  del = (p) => this.req('DELETE', p);
}

async function loginAdmin() {
  const c = new Client();
  let r = await c.post('/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  if (r.status === 401) r = await c.post('/auth/login', { email: ADMIN_EMAIL, password: ADMIN_NEW_PASSWORD });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  if (r.body.mustChangePassword) {
    const blocked = await c.get('/skus');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'PASSWORD_CHANGE_REQUIRED');
    const ch = await c.post('/auth/password', { currentPassword: ADMIN_PASSWORD, newPassword: ADMIN_NEW_PASSWORD });
    assert.equal(ch.status, 200, JSON.stringify(ch.body));
  }
  return c;
}

const ean13 = (base12) => {
  const d = base12.split('').map(Number);
  const sum = d.reduce((a, x, i) => a + x * (i % 2 === 0 ? 1 : 3), 0);
  return base12 + ((10 - (sum % 10)) % 10);
};

test('seguridad: CSRF, credenciales y sesión', async () => {
  const c = new Client();
  const noHeader = await c.req('POST', '/auth/login', { email: ADMIN_EMAIL, password: 'x' }, { csrf: false });
  assert.equal(noHeader.status, 403);
  const bad = await c.post('/auth/login', { email: ADMIN_EMAIL, password: 'incorrecta-123' });
  assert.equal(bad.status, 401);
  const anon = await new Client().get('/skus');
  assert.equal(anon.status, 401);
});

test('flujo de catálogo, kits, publicaciones, comisiones, permisos y auditoría', async () => {
  const admin = await loginAdmin();

  const me = await admin.get('/auth/me');
  assert.equal(me.status, 200);
  assert.ok(me.body.roles.includes('ADMIN'));
  assert.ok(me.body.permissions.includes('costos.ver'));

  // Catálogo base
  const brand = await admin.post('/brands', { name: `Zanetti ${RUN}` });
  assert.equal(brand.status, 201, JSON.stringify(brand.body));
  const dupBrand = await admin.post('/brands', { name: `zanetti ${RUN}` });
  assert.equal(dupBrand.status, 409, 'marca duplicada sin importar mayúsculas');

  const cat = await admin.post('/categories', { name: `Organización ${RUN}` });
  assert.equal(cat.status, 201);
  const sub = await admin.post('/categories', { name: 'Cajas', parentId: cat.body.id });
  assert.equal(sub.status, 201);
  const cycle = await admin.patch(`/categories/${cat.body.id}`, { parentId: sub.body.id });
  assert.equal(cycle.status, 400, 'no se permiten ciclos de categorías');

  const prod = await admin.post('/products', { name: `Caja organizadora ${RUN}`, brandId: brand.body.id, categoryId: sub.body.id });
  assert.equal(prod.status, 201);

  // SKU con precio y costo
  const code1 = `ZNT-${RUN}-1`;
  const sku1 = await admin.post('/skus', {
    skuCode: code1.toLowerCase(), productId: prod.body.id, name: 'Caja 30 L', basePrice: '499.00', currentCost: '85', minQty: 10, maxQty: 200,
  });
  assert.equal(sku1.status, 201, JSON.stringify(sku1.body));
  assert.equal(sku1.body.skuCode, code1, 'el código se normaliza a mayúsculas');
  const badMinMax = await admin.post('/skus', { skuCode: `${code1}X`, productId: prod.body.id, name: 'x', minQty: 50, maxQty: 10 });
  assert.equal(badMinMax.status, 422);

  const sku2 = await admin.post('/skus', { skuCode: `ZNT-${RUN}-2`, productId: prod.body.id, name: 'Caja 50 L', basePrice: '699' });
  assert.equal(sku2.status, 201);

  // Cambio de costo queda en historial y auditoría
  const upd = await admin.patch(`/skus/${sku1.body.id}`, { currentCost: '91' });
  assert.equal(upd.status, 200);
  const ficha = await admin.get(`/skus/${sku1.body.id}`);
  assert.equal(ficha.status, 200);
  assert.equal(ficha.body.currentCost, '91.0000');
  assert.equal(ficha.body.costHistory.length, 2);
  assert.ok(typeof ficha.body.marginPct === 'number');
  const hist = await admin.get(`/skus/${sku1.body.id}/history`);
  assert.ok(hist.body.items.some((h) => h.summary.includes('Modificó costo') && h.oldValues.currentCost === '85.0000'));

  // Códigos de barras
  const badEan = await admin.post(`/skus/${sku1.body.id}/barcodes`, { barcode: '7501234567890', type: 'EAN13' });
  assert.equal(badEan.status, 422, 'dígito verificador inválido');
  const ean = ean13(`750${String(Date.now()).slice(-9)}`);
  const okEan = await admin.post(`/skus/${sku1.body.id}/barcodes`, { barcode: ean, type: 'EAN13', isPrimary: true });
  assert.equal(okEan.status, 201, JSON.stringify(okEan.body));
  const dupEan = await admin.post(`/skus/${sku2.body.id}/barcodes`, { barcode: ean, type: 'EAN13' });
  assert.equal(dupEan.status, 409);

  // Kit (bundle) con componentes; un kit no puede ser componente
  const kit = await admin.post('/skus', { skuCode: `ZNT-${RUN}-KIT`, productId: prod.body.id, name: 'Bundle 2 cajas', isKit: true });
  assert.equal(kit.status, 201);
  const comps = await admin.put(`/skus/${kit.body.id}/components`, {
    components: [{ componentSkuId: sku1.body.id, quantity: 1 }, { componentSkuId: sku2.body.id, quantity: 1 }],
  });
  assert.equal(comps.status, 200, JSON.stringify(comps.body));
  assert.equal(comps.body.length, 2);
  const kit2 = await admin.post('/skus', { skuCode: `ZNT-${RUN}-KIT2`, productId: prod.body.id, name: 'Kit de kits', isKit: true });
  const nested = await admin.put(`/skus/${kit2.body.id}/components`, { components: [{ componentSkuId: kit.body.id, quantity: 1 }] });
  assert.equal(nested.status, 422, 'un kit no puede ser componente de otro kit');

  // Publicaciones: Liverpool FBL exige almacén del canal
  const channels = (await admin.get('/channels')).body;
  const liverpool = channels.find((c) => c.code === 'LIVERPOOL');
  const amazon = channels.find((c) => c.code === 'AMAZON');
  assert.equal(liverpool.coverageDays, 45);
  assert.equal(amazon.coverageDays, 90);
  assert.equal(liverpool.currentFee, '0.1900', 'comisión vigente de Liverpool');
  const whs = (await admin.get('/warehouses')).body;
  const fbl = whs.find((w) => w.code === 'LIV-FBL');
  const fba = whs.find((w) => w.code === 'AMZ-FBA');
  const aplin = whs.find((w) => w.code === 'APLIN');

  const art = `11${RUN}`;
  const wrongWh = await admin.post('/listings', {
    channelId: liverpool.id, masterSkuId: sku1.body.id, externalId: art, fulfillmentModel: 'FULFILLMENT_CANAL', fulfillmentWarehouseId: fba.id,
  });
  assert.equal(wrongWh.status, 400, 'FBA no es almacén de Liverpool');
  const lst = await admin.post('/listings', {
    channelId: liverpool.id, masterSkuId: sku1.body.id, externalId: art, externalSku: 'X00TEST', fulfillmentModel: 'FULFILLMENT_CANAL', fulfillmentWarehouseId: fbl.id,
  });
  assert.equal(lst.status, 201, JSON.stringify(lst.body));
  const vendor = await admin.post('/listings', {
    channelId: liverpool.id, masterSkuId: sku1.body.id, externalId: `${art}V`, fulfillmentModel: 'BODEGA_PROPIA', fulfillmentWarehouseId: aplin.id,
  });
  assert.equal(vendor.status, 201, 'Liverpool Vendor surte desde APLIN');
  const dup = await admin.post('/listings', { channelId: liverpool.id, masterSkuId: sku2.body.id, externalId: art, externalSku: 'X00TEST', fulfillmentModel: 'FULFILLMENT_CANAL', fulfillmentWarehouseId: fbl.id });
  assert.equal(dup.status, 409, 'un código externo vigente apunta a un solo SKU');
  const closed = await admin.post(`/listings/${lst.body.id}/close`);
  assert.equal(closed.status, 200);
  const relinked = await admin.post('/listings', { channelId: liverpool.id, masterSkuId: sku2.body.id, externalId: art, externalSku: 'X00TEST', fulfillmentModel: 'FULFILLMENT_CANAL', fulfillmentWarehouseId: fbl.id });
  assert.equal(relinked.status, 201, 'tras la baja, el código se puede ligar a otro SKU');

  const asin = await admin.post('/listings', { channelId: amazon.id, masterSkuId: kit.body.id, externalId: `B0${RUN}`.slice(0, 10), externalSku: 'Bundle - 2 cajas', fulfillmentModel: 'FULFILLMENT_CANAL', fulfillmentWarehouseId: fba.id });
  assert.equal(asin.status, 201);

  // Búsqueda global por código externo
  const found = await admin.get(`/search?q=${encodeURIComponent(art)}`);
  assert.ok(found.body.some((g) => g.module === 'publicaciones'));

  // Comisiones: no se permiten vigencias traslapadas
  const overlap = await admin.post(`/channels/${liverpool.id}/fee-rules`, { name: 'Prueba', rate: '0.18', validFrom: '2026-06-01' });
  assert.equal(overlap.status, 422);
  assert.match(overlap.body.message, /traslapa/);

  // Usuario de Consulta: sólo ve, y sin costos
  const roles = (await admin.get('/roles')).body;
  const consulta = roles.find((r) => r.code === 'CONSULTA');
  const email = `consulta.${RUN.toLowerCase()}@zanetti.mx`;
  const u = await admin.post('/users', { email, name: 'Consulta prueba', password: 'Temporal2026a', roleIds: [consulta.id] });
  assert.equal(u.status, 201, JSON.stringify(u.body));
  const viewer = new Client();
  assert.equal((await viewer.post('/auth/login', { email, password: 'Temporal2026a' })).status, 200);
  assert.equal((await viewer.post('/auth/password', { currentPassword: 'Temporal2026a', newPassword: 'Consulta2026b' })).status, 200);
  const vlist = await viewer.get(`/skus?q=${RUN}`);
  assert.equal(vlist.status, 200);
  assert.ok(vlist.body.items.length >= 3);
  assert.ok(!('currentCost' in vlist.body.items[0]), 'Consulta no ve costos');
  const vcreate = await viewer.post('/skus', { skuCode: `ZNT-${RUN}-NO`, productId: prod.body.id, name: 'No' });
  assert.equal(vcreate.status, 403);
  const vexport = await viewer.get('/skus?export=1');
  assert.equal(vexport.status, 403, 'Consulta no exporta');
  const vusers = await viewer.get('/users');
  assert.equal(vusers.status, 403);

  // No se puede quitar al último Administrador
  const self = await admin.patch(`/users/${me.body.id}`, { status: 'INACTIVO' });
  assert.equal(self.status, 400);

  // Auditoría
  const audit = await admin.get(`/audit-logs?q=${RUN}`);
  assert.equal(audit.status, 200);
  assert.ok(audit.body.total >= 5);
});

test('la bitácora de auditoría rechaza UPDATE y DELETE en la base de datos', async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await assert.rejects(client.query('update audit_logs set summary = summary where id = (select min(id) from audit_logs)'), /solo inserción/);
    await assert.rejects(client.query('delete from audit_logs where id = (select min(id) from audit_logs)'), /solo inserción/);
  } finally {
    await client.end();
  }
});
