// Pruebas del inventario (entrega 2): FIFO, negativos, concurrencia, reservas, transferencias,
// conteos, autorización por umbral, inventario inicial e inmutabilidad del kardex.
// Mismos requisitos que e2e.test.mjs: API en marcha y base de desarrollo; crea datos con sufijo único.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const BASE = process.env.API_BASE ?? 'http://localhost:4000/api/v1';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@zanetti.mx';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const ADMIN_NEW_PASSWORD = process.env.ADMIN_NEW_PASSWORD ?? `${ADMIN_PASSWORD}x1`;
const RUN = Date.now().toString(36).toUpperCase().slice(-6);

class Client {
  cookie = '';
  async req(method, path, body) {
    const headers = { 'x-erp-client': 'web' };
    if (this.cookie) headers.cookie = this.cookie;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, { method, headers, body: payload });
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
}

let adminClient;
/** Una sola sesión de Administrador para todo el archivo (el login tiene límite por minuto). */
async function loginAdmin() {
  if (adminClient) return adminClient;
  const c = new Client();
  let r = await c.post('/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  if (r.status === 401) r = await c.post('/auth/login', { email: ADMIN_EMAIL, password: ADMIN_NEW_PASSWORD });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  if (r.body.mustChangePassword) {
    assert.equal((await c.post('/auth/password', { currentPassword: ADMIN_PASSWORD, newPassword: ADMIN_NEW_PASSWORD })).status, 200);
  }
  adminClient = c;
  return c;
}

const ok = (r, status = 201) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};

/** Datos base: dos almacenes propios con GEN y cuarentena, un producto con dos SKU y una caja master. */
async function setup(admin, tag) {
  const R = `${RUN}${tag}`;
  const wh = ok(await admin.post('/warehouses', { code: `TA${R}`, name: `Prueba origen ${R}`, type: 'PROPIO' }));
  const wh2 = ok(await admin.post('/warehouses', { code: `TB${R}`, name: `Prueba destino ${R}`, type: 'PROPIO' }));
  const cua = ok(await admin.post(`/warehouses/${wh.id}/locations`, { code: 'CUA', name: 'Cuarentena', type: 'CUARENTENA' }));
  const whFull = ok(await admin.get(`/warehouses/${wh.id}`), 200);
  const gen = whFull.locations.find((l) => l.code === 'GEN');
  const prod = ok(await admin.post('/products', { name: `Inventario ${R}` }));
  const a = ok(await admin.post('/skus', { skuCode: `INV-${R}-A`, productId: prod.id, name: 'SKU A' }));
  const b = ok(await admin.post('/skus', { skuCode: `INV-${R}-B`, productId: prod.id, name: 'SKU B' }));
  const kit = ok(await admin.post('/skus', { skuCode: `INV-${R}-K`, productId: prod.id, name: 'Kit A+B', isKit: true }));
  ok(await admin.req('PUT', `/skus/${kit.id}/components`, { components: [{ componentSkuId: a.id, quantity: 2 }, { componentSkuId: b.id, quantity: 1 }] }), 200);
  const box = ok(await admin.post(`/skus/${a.id}/packages`, { code: `INV-${R}-A-C12`, type: 'CAJA_MASTER', unitsPerPackage: 12 }));
  return { wh, wh2, cua, gen, a, b, kit, box };
}

/** Al terminar, los almacenes de prueba se desactivan para no ensuciar el dashboard de desarrollo. */
async function teardown(admin, d) {
  for (const w of [d.wh, d.wh2]) await admin.patch(`/warehouses/${w.id}`, { status: 'INACTIVO' });
}

/** Crea y aplica un ajuste; devuelve la respuesta de aplicar. */
async function adjust(c, warehouseId, items, reason = 'INVENTARIO_INICIAL', applyBody = {}) {
  const adj = await c.post('/adjustments', { warehouseId, reason, notes: 'prueba', items });
  if (adj.status !== 201) return adj;
  const r = await c.post(`/adjustments/${adj.body.id}/apply`, applyBody);
  return { ...r, id: adj.body.id };
}

const stockOf = async (c, skuId, whId) => {
  const s = ok(await c.get(`/inventory/stock/${skuId}`), 200);
  return s.byWarehouse.find((w) => w.warehouseId === whId);
};

test('inventario: FIFO, negativos, concurrencia, transferencias y conteos', async () => {
  const admin = await loginAdmin();
  const d = await setup(admin, 'F');

  // ── Entradas: dos lotes con costo distinto (el más antiguo primero) ──
  ok(await adjust(admin, d.wh.id, [{ masterSkuId: d.a.id, qty: 10, unitCost: '100' }]), 201);
  ok(await adjust(admin, d.wh.id, [{ masterSkuId: d.a.id, qty: 10, unitCost: '150' }]), 201);
  ok(await adjust(admin, d.wh.id, [{ masterSkuId: d.b.id, qty: 40, unitCost: '20' }]), 201);
  let st = await stockOf(admin, d.a.id, d.wh.id);
  assert.equal(st.onHand, 20);
  assert.equal(st.value, '2500.00');
  const skuA = ok(await admin.get(`/skus/${d.a.id}`), 200);
  assert.equal(Number(skuA.avgCost), 125, 'costo promedio ponderado de los lotes con existencia');

  // ── Salida FIFO: 12 pzas = 10 a 100 + 2 a 150 ──
  const out = ok(await adjust(admin, d.wh.id, [{ masterSkuId: d.a.id, qty: -12 }], 'MERMA'), 201);
  assert.equal(out.status, 'APLICADO');
  const mv = ok(await admin.get(`/inventory/movements?documentId=${out.id}`), 200);
  const costs = mv.items.map((m) => [m.qty, Number(m.unitCost)]).sort((x, y) => x[1] - y[1]);
  assert.deepEqual(costs, [[-10, 100], [-2, 150]]);
  const adjDetail = ok(await admin.get(`/adjustments/${out.id}`), 200);
  assert.equal(adjDetail.totalValue, '1300.00');

  // ── Sin negativos: rechazo con lo disponible; Administrador puede autorizar ──
  const neg = await adjust(admin, d.wh.id, [{ masterSkuId: d.a.id, qty: -9 }], 'MERMA');
  assert.equal(neg.status, 409, JSON.stringify(neg.body));
  assert.equal(neg.body.code, 'STOCK_INSUFICIENTE');
  assert.equal(neg.body.details.available, 8);
  const negOk = ok(await admin.post(`/adjustments/${neg.id}/apply`, { authorizeNegative: true }), 201);
  assert.equal(negOk.shortage, 1);
  st = await stockOf(admin, d.a.id, d.wh.id);
  assert.equal(st.onHand, -1, 'el faltante autorizado queda como existencia negativa');
  // Una entrada cubre primero el faltante
  ok(await adjust(admin, d.wh.id, [{ masterSkuId: d.a.id, qty: 31, unitCost: '120' }]), 201);
  st = await stockOf(admin, d.a.id, d.wh.id);
  assert.equal(st.onHand, 30);
  const det = ok(await admin.get(`/inventory/stock/${d.a.id}`), 200);
  assert.ok(det.balances.every((b) => b.qty > 0 && b.lotCode), 'sin saldos negativos ni sin lote después de cubrir');

  // ── Kits: en bodega propia se pueden armar con los componentes; armados tienen existencia física ──
  let kitStock = ok(await admin.get(`/inventory/stock/${d.kit.id}`), 200);
  let kw = kitStock.byWarehouse.find((w) => w.warehouseId === d.wh.id);
  assert.equal(kw.assemblable, 15, 'min(30/2, 40/1)');
  assert.equal(kw.available, 15);
  assert.equal(kw.onHand, 0);
  assert.equal(kitStock.byWarehouse.find((w) => w.code === 'AMZ-FBA').assemblable, 0, 'FBA no arma kits');
  const noKit = await adjust(admin, d.wh.id, [{ masterSkuId: d.kit.id, qty: -1 }], 'MERMA');
  assert.equal(noKit.status, 409, 'no hay kits armados que sacar');
  const armado = ok(await admin.post('/inventory/kit-assembly', { kitId: d.kit.id, warehouseId: d.wh.id, qty: 3, mode: 'ARMAR' }));
  assert.equal(armado.unitCost, (2 * 120 + 20).toFixed(4), 'el kit cuesta lo que costaron sus componentes');
  kitStock = ok(await admin.get(`/inventory/stock/${d.kit.id}`), 200);
  kw = kitStock.byWarehouse.find((w) => w.warehouseId === d.wh.id);
  assert.equal(kw.onHand, 3);
  assert.equal(kw.assemblable, 12, 'quedan 24 A y 37 B');
  assert.equal(kw.available, 15);
  ok(await admin.post('/inventory/kit-assembly', { kitId: d.kit.id, warehouseId: d.wh.id, qty: 3, mode: 'DESARMAR' }));
  st = await stockOf(admin, d.a.id, d.wh.id);
  assert.equal(st.onHand, 30, 'los componentes regresan');
  assert.equal(st.value, '3600.00', 'armar y desarmar no cambian el valor');
  assert.equal((await stockOf(admin, d.b.id, d.wh.id)).onHand, 40);

  // ── Concurrencia: dos salidas de 25 sobre 30 en paralelo → sólo una pasa ──
  const [r1, r2] = await Promise.all([
    adjust(admin, d.wh.id, [{ masterSkuId: d.a.id, qty: -25 }], 'MERMA'),
    adjust(admin, d.wh.id, [{ masterSkuId: d.a.id, qty: -25 }], 'MERMA'),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [201, 409]);
  st = await stockOf(admin, d.a.id, d.wh.id);
  assert.equal(st.onHand, 5);
  ok(await adjust(admin, d.wh.id, [{ masterSkuId: d.a.id, qty: 55, unitCost: '130' }]), 201); // 60 en total

  // ── Reubicación a cuarentena: deja de estar disponible ──
  ok(await admin.post('/inventory/relocations', { masterSkuId: d.a.id, warehouseId: d.wh.id, fromLocationId: d.gen.id, toLocationId: d.cua.id, qty: 6 }), 201);
  st = await stockOf(admin, d.a.id, d.wh.id);
  assert.equal(st.onHand, 60);
  assert.equal(st.blocked, 6);
  assert.equal(st.available, 54);

  // ── Transferencia por cajas: autorizar aparta, cancelar libera ──
  const tr0 = ok(await admin.post('/transfers', { originWarehouseId: d.wh.id, destinationWarehouseId: d.wh2.id, items: [{ masterSkuId: d.a.id, packageId: d.box.id, packageQty: 2 }] }));
  ok(await admin.post(`/transfers/${tr0.id}/authorize`), 201);
  st = await stockOf(admin, d.a.id, d.wh.id);
  assert.equal(st.committed, 24, '2 cajas × 12 pzas apartadas');
  assert.equal(st.available, 30);
  ok(await admin.post(`/transfers/${tr0.id}/cancel`), 201);
  st = await stockOf(admin, d.a.id, d.wh.id);
  assert.equal(st.committed, 0);

  // No se puede autorizar más de lo disponible (lo bloqueado en cuarentena no cuenta)
  const tooMuch = ok(await admin.post('/transfers', { originWarehouseId: d.wh.id, destinationWarehouseId: d.wh2.id, items: [{ masterSkuId: d.a.id, qtyRequested: 55 }] }));
  const tmAuth = await admin.post(`/transfers/${tooMuch.id}/authorize`);
  assert.equal(tmAuth.status, 409);
  assert.equal(tmAuth.body.code, 'STOCK_INSUFICIENTE');

  // ── Envío, tránsito, recepción parcial y cierre con diferencias ──
  const tr = ok(await admin.post('/transfers', {
    originWarehouseId: d.wh.id,
    destinationWarehouseId: d.wh2.id,
    reference: `FBA15${RUN}`,
    items: [{ masterSkuId: d.a.id, packageId: d.box.id, packageQty: 2 }, { masterSkuId: d.b.id, qtyRequested: 10 }],
  }));
  ok(await admin.post(`/transfers/${tr.id}/authorize`), 201);
  let t = ok(await admin.get(`/transfers/${tr.id}`), 200);
  const itemA = t.items.find((i) => i.masterSkuId === d.a.id);
  const itemB = t.items.find((i) => i.masterSkuId === d.b.id);
  const tooMany = await admin.post(`/transfers/${tr.id}/ship`, { items: [{ itemId: itemA.id, qtyShipped: 25 }] });
  assert.equal(tooMany.status, 422, 'no se envía más de lo autorizado');
  const ship = ok(await admin.post(`/transfers/${tr.id}/ship`, { items: [{ itemId: itemB.id, qtyShipped: 8 }] }));
  assert.equal(ship.units, 32);
  st = await stockOf(admin, d.a.id, d.wh.id);
  assert.equal(st.onHand, 36);
  assert.equal(st.committed, 0, 'al enviar se consume lo apartado');
  let dest = await stockOf(admin, d.a.id, d.wh2.id);
  assert.equal(dest.inTransit, 24);
  t = ok(await admin.get(`/transfers/${tr.id}`), 200);
  const shippedLots = t.items.find((i) => i.masterSkuId === d.a.id).lots;
  // La reubicación se llevó a cuarentena lo más antiguo (5 del lote de 120 y 1 del de 130):
  // en GEN sólo queda el lote de 130, y de ahí sale el envío.
  assert.deepEqual(shippedLots.map((l) => [l.qty, Number(l.unitCost)]), [[24, 130]]);

  const partial = ok(await admin.post(`/transfers/${tr.id}/receive`, { items: [{ itemId: itemA.id, qty: 20 }] }));
  assert.equal(partial.status, 'ENVIADA');
  dest = await stockOf(admin, d.a.id, d.wh2.id);
  assert.equal(dest.onHand, 20);
  assert.equal(dest.inTransit, 4);
  assert.equal(dest.value, (20 * 130).toFixed(2), 'los lotes llegan con su costo de origen');
  const over = await admin.post(`/transfers/${tr.id}/receive`, { items: [{ itemId: itemA.id, qty: 5 }] });
  assert.equal(over.status, 422, 'no se recibe más de lo enviado');
  const closed = ok(await admin.post(`/transfers/${tr.id}/receive`, { items: [{ itemId: itemA.id, qty: 3 }, { itemId: itemB.id, qty: 8 }], close: true }));
  assert.equal(closed.status, 'RECIBIDA_CON_DIFERENCIAS');
  assert.equal(closed.missing, 1);
  dest = await stockOf(admin, d.a.id, d.wh2.id);
  assert.equal(dest.onHand, 23);
  assert.equal(dest.inTransit, 0);
  const cancelShipped = await admin.post(`/transfers/${tr.id}/cancel`);
  assert.equal(cancelShipped.status, 409);

  // Kardex del destino con saldo acumulado
  const k = ok(await admin.get(`/inventory/kardex?skuId=${d.a.id}&warehouseId=${d.wh2.id}`), 200);
  assert.equal(k.summary.closingQty, 23);
  assert.equal(k.items[0].balance, 23);

  // ── Conteo: foto, movimiento posterior, captura y ajuste sólo de la diferencia ──
  const cf = ok(await admin.post('/counts', { warehouseId: d.wh.id, locationId: d.gen.id, blind: true, skuIds: [d.a.id, d.b.id] }));
  let count = ok(await admin.get(`/counts/${cf.id}`), 200);
  const lineA = count.lines.find((l) => l.masterSkuId === d.a.id);
  const lineB = count.lines.find((l) => l.masterSkuId === d.b.id);
  assert.equal(lineA.systemQty, 30, 'GEN tiene 36 − 6 en cuarentena');
  // Después de la foto sale 1 pieza: el conteo no debe "devolverla"
  ok(await adjust(admin, d.wh.id, [{ masterSkuId: d.a.id, qty: -1, locationId: d.gen.id }], 'DANO'), 201);
  const dupCount = await admin.post('/counts', { warehouseId: d.wh.id });
  assert.equal(dupCount.status, 409, 'no se abren dos conteos sobre la misma zona');
  const resolved = ok(await admin.get(`/counts/${cf.id}/resolve?code=${d.box.code}`), 200);
  assert.equal(resolved.units, 12);
  ok(await admin.patch(`/counts/${cf.id}/lines`, { lines: [{ lineId: lineA.id, countedQty: 28 }, { lineId: lineB.id, countedQty: 32 }] }), 200);
  const close = ok(await admin.post(`/counts/${cf.id}/close`, {}));
  assert.equal(close.adjusted, 1, 'B coincide (40 − 8 enviadas); A tiene −2');
  assert.equal(close.unitsMinus, 2);
  st = await stockOf(admin, d.a.id, d.wh.id);
  assert.equal(st.onHand, 33, '36 − 1 (daño) − 2 (conteo)');
  count = ok(await admin.get(`/counts/${cf.id}`), 200);
  assert.equal(count.status, 'CERRADO');

  // ── Búsqueda global por folio ──
  const search = ok(await admin.get(`/search?q=${encodeURIComponent(t.folio)}`), 200);
  assert.ok(search.some((g) => g.module === 'inventario' && g.hits.some((h) => h.title.includes(t.folio))));

  // ── El kardex es de sólo inserción ──
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgresql://erp:erp@localhost:5432/erp' });
  await db.connect();
  try {
    await assert.rejects(db.query('UPDATE inventory_movements SET qty = qty WHERE master_sku_id = $1', [d.a.id]), /solo inserción/);
    await assert.rejects(db.query('DELETE FROM inventory_movements WHERE master_sku_id = $1', [d.a.id]), /solo inserción/);
    await assert.rejects(
      db.query(`UPDATE inventory_balances SET qty = -1 WHERE master_sku_id = $1 AND lot_id IS NOT NULL`, [d.a.id]),
      /inventory_balances_lot_qty_ck/,
      'un lote nunca queda negativo',
    );
    // La vista cuadra con el libro de movimientos
    const { rows } = await db.query(
      `SELECT (SELECT coalesce(sum(qty), 0) FROM inventory_movements WHERE master_sku_id = $1)::int AS ledger,
              (SELECT coalesce(sum(on_hand), 0) FROM inventory_stock WHERE master_sku_id = $1)::int AS view`,
      [d.a.id],
    );
    assert.equal(rows[0].ledger, rows[0].view);
  } finally {
    await db.end();
  }
  await teardown(admin, d);
});

test('inventario: autorización por umbral, permisos y costos ocultos', async () => {
  const admin = await loginAdmin();
  const d = await setup(admin, 'U');
  ok(await adjust(admin, d.wh.id, [{ masterSkuId: d.a.id, qty: 50, unitCost: '100' }]), 201);

  // Usuario de almacén: crea ajustes pero no autoriza ni ve costos
  const roles = ok(await admin.get('/roles'), 200);
  const almacen = roles.find((r) => r.code === 'ALMACEN');
  const email = `almacen.${RUN.toLowerCase()}@zanetti.mx`;
  ok(await admin.post('/users', { email, name: 'Almacén prueba', password: 'Temporal2026a', roleIds: [almacen.id] }));
  const user = new Client();
  ok(await user.post('/auth/login', { email, password: 'Temporal2026a' }), 200);
  const pw = await user.post('/auth/password', { currentPassword: 'Temporal2026a', newPassword: 'Temporal2026b' });
  assert.ok([200, 201].includes(pw.status), JSON.stringify(pw.body));

  const stock = ok(await user.get(`/inventory/stock/${d.a.id}`), 200);
  assert.equal(stock.total.value, undefined, 'sin permiso de costos no se ve el valor');
  assert.ok(stock.balances.every((b) => b.unitCost === undefined));
  const withCost = await user.post('/adjustments', { warehouseId: d.wh.id, reason: 'MERMA', items: [{ masterSkuId: d.a.id, qty: 1, unitCost: '10' }] });
  assert.equal(withCost.status, 403, 'no puede capturar costos');

  const prev = ok(await admin.get('/settings'), 200).parameters.find((p) => p.key === 'ajustes.umbral_autorizacion_mxn').value;
  ok(await admin.patch('/settings/parameters/ajustes.umbral_autorizacion_mxn', { value: 500 }), 200);
  try {
    const small = await adjust(user, d.wh.id, [{ masterSkuId: d.a.id, qty: -2 }], 'DANO');
    assert.equal(small.body.status, 'APLICADO', '200 MXN < umbral');
    const big = await adjust(user, d.wh.id, [{ masterSkuId: d.a.id, qty: -10 }], 'DANO');
    assert.equal(big.body.status, 'POR_AUTORIZAR', '1,000 MXN > umbral');
    let st = await stockOf(admin, d.a.id, d.wh.id);
    assert.equal(st.onHand, 48, 'el ajuste por autorizar no mueve inventario');
    assert.equal((await user.post(`/adjustments/${big.id}/authorize`)).status, 403);
    const negByUser = await user.post(`/adjustments/${big.id}/apply`, { authorizeNegative: true });
    assert.equal(negByUser.status, 403, 'sólo el Administrador autoriza negativos');
    ok(await admin.post(`/adjustments/${big.id}/authorize`), 201);
    st = await stockOf(admin, d.a.id, d.wh.id);
    assert.equal(st.onHand, 38);
  } finally {
    ok(await admin.patch('/settings/parameters/ajustes.umbral_autorizacion_mxn', { value: prev }), 200);
  }
  await teardown(admin, d);
});

test('inventario inicial desde CSV: valida, aplica y no duplica', async () => {
  const admin = await loginAdmin();
  const d = await setup(admin, 'I');
  const csv = [
    'SKU MAESTRO,ALMACEN,UBICACION,CANTIDAD,COSTO UNITARIO,LOTE,FECHA ENTRADA',
    `${d.a.skuCode},${d.wh.code},GEN,30,85.5,L-${RUN},15/08/2026`,
    `${d.a.skuCode},${d.wh2.code},,12,85.5,L-${RUN},2026-08-15`,
    `${d.b.skuCode},${d.wh.code},CUA,5,,,`,
    `${d.kit.skuCode},${d.wh.code},,3,10,,`,
    `${d.a.skuCode},${d.wh.code},NOEXISTE,1,10,,`,
    `${d.b.skuCode},${d.wh.code},GEN,4,10,X-${RUN},2099-01-01`,
  ].join('\n');
  const fd = new FormData();
  fd.append('template', 'inventario-inicial');
  fd.append('file', new Blob([csv], { type: 'text/csv' }), `inventario-${RUN}.csv`);
  const batch = ok(await admin.req('POST', '/data-imports', fd));
  assert.equal(batch.summary.error, 2, 'ubicación inexistente y fecha futura');
  const rows = ok(await admin.get(`/data-imports/${batch.id}/rows?pageSize=50`), 200).items;
  const warn = rows.find((r) => r.rowNumber === 4);
  assert.ok(warn.messages.some((m) => /Sin costo/.test(m.message)));
  const kitRow = rows.find((r) => r.rowNumber === 5);
  assert.ok(kitRow.messages.some((m) => m.level === 'warning' && /kits ya armados/.test(m.message)), 'un kit se carga como armado, con aviso');
  for (const r of rows.filter((x) => x.status === 'ERROR')) ok(await admin.patch(`/data-imports/${batch.id}/rows/${r.id}`, { skipped: true }), 200);
  const applied = ok(await admin.post(`/data-imports/${batch.id}/apply`), 200);
  assert.equal(applied.status, 'APLICADO');
  assert.equal(applied.result.piezas, 50);
  assert.equal(applied.result.lotes, 3, 'el mismo lote en dos almacenes es un solo lote');
  const a = ok(await admin.get(`/inventory/stock/${d.a.id}`), 200);
  assert.equal(a.total.onHand, 42);
  assert.equal(a.total.value, (42 * 85.5).toFixed(2));
  const b = await stockOf(admin, d.b.id, d.wh.id);
  assert.equal(b.blocked, 5, 'lo cargado en cuarentena queda bloqueado');
  const again = await admin.post(`/data-imports/${batch.id}/apply`);
  assert.ok(again.status >= 400, 'un lote aplicado no se vuelve a aplicar');
  await teardown(admin, d);
});
