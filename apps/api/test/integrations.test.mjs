// Integración con APLIN (sólo consulta) contra un APLIN simulado.
// La API debe arrancar con APLINTEST_BASE_URL=http://localhost:4900 y APLINTEST_ORG_CODE=prueba-aplin (como en CI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { order, product, startMockAplin } from './mock-aplin.mjs';

const BASE = process.env.API_BASE ?? 'http://localhost:4000/api/v1';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@zanetti.mx';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const ADMIN_NEW_PASSWORD = process.env.ADMIN_NEW_PASSWORD ?? `${ADMIN_PASSWORD}x1`;
const MOCK_PORT = Number(process.env.APLIN_MOCK_PORT ?? 4900);
const RUN = Date.now().toString(36).toUpperCase().slice(-6);

let cookie = '';
async function req(method, path, body) {
  const headers = { 'x-erp-client': 'web' };
  if (cookie) headers.cookie = cookie;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

async function login() {
  let r = await req('POST', '/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  if (r.status === 401) r = await req('POST', '/auth/login', { email: ADMIN_EMAIL, password: ADMIN_NEW_PASSWORD });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  if (r.body.mustChangePassword) assert.equal((await req('POST', '/auth/password', { currentPassword: ADMIN_PASSWORD, newPassword: ADMIN_NEW_PASSWORD })).status, 200);
}

async function importAndApply(template, csv) {
  const fd = new FormData();
  fd.append('template', template);
  fd.append('file', new Blob([csv], { type: 'text/csv' }), `${template}-${RUN}.csv`);
  const up = await req('POST', '/data-imports', fd);
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const r = await req('POST', `/data-imports/${up.body.id}/apply`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

test('APLIN: conexión de sólo consulta, existencias comparadas y órdenes clasificadas', async (t) => {
  await login();
  const refs = await req('GET', '/integrations/credential-refs');
  assert.equal(refs.status, 200);
  if (!refs.body.aplin.includes('APLINTEST')) {
    t.skip('La API no arrancó con APLINTEST_BASE_URL / APLINTEST_ORG_CODE.');
    return;
  }
  const mock = await startMockAplin({ port: MOCK_PORT, code: 'prueba-aplin' });
  try {
    const A = `AP${RUN}A`;
    const B = `AP${RUN}B`;
    await importAndApply('skus', ['SKU MAESTRO,NOMBRE,SKU CAJA MASTER,PIEZAS CAJA MASTER', `${A},Producto A ${RUN},${A}-C,10`, `${B},Producto B ${RUN},${B}-C,10`].join('\n'));
    await importAndApply('inventario-inicial', ['SKU MAESTRO,ALMACEN,CANTIDAD,COSTO UNITARIO,LOTE', `${A},APLIN,100,50,L1`, `${B},APLIN,40,30,L1`].join('\n'));

    // APLIN: A tiene 90 (10 apartadas), B cuadra con 40, y un producto que el ERP no conoce. SKU en minúsculas también se liga.
    mock.state.products = [
      product(9001, A, { onHand: 90, available: 80, committed: 10 }),
      product(9002, B.toLowerCase(), { onHand: 40, available: 40 }),
      product(9003, `NOEXISTE${RUN}`, { onHand: 5, available: 5 }),
    ];
    mock.state.orders = [
      order(1, `FBA19V${RUN}`, [[A, 30]], { type: 'B2B', status: 'OPEN', substatus: 'TO_RELEASE', fulfillmentStatus: 'NOT OK', source: 'DASHBOARD' }),
      order(2, 'LIV_50', [[B, 12]], { type: 'B2B', status: 'SENT', source: 'DASHBOARD' }),
      order(3, '1230125705', [[A, 1, 599]], { source: 'LIVERPOOL' }),
      order(4, '#2221-ZT', [[A, 2, 450]], { price: 900 }),
      order(5, '#1404', [[B, 1, 380]], { price: 380 }),
      order(6, 'ML-777', [[A, 1]], { source: 'MELI' }),
      order(7, 'BORRADA', [[A, 1]], { deleted: true }),
    ];

    // Alta: sólo con un prefijo que el servidor sí tiene; el código no se repite.
    const code = `APLIN${RUN}`;
    assert.equal((await req('POST', '/integrations', { code, name: 'APLIN prueba', provider: 'APLIN', credentialsRef: 'NOEXISTE' })).status, 422);
    const c = await req('POST', '/integrations', { code, name: 'APLIN prueba', provider: 'APLIN', credentialsRef: 'APLINTEST' });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(c.body.credentialsOk, true);
    assert.equal((await req('POST', '/integrations', { code, name: 'Otra', provider: 'APLIN', credentialsRef: 'APLINTEST' })).status, 422);
    const id = c.body.id;

    // Sincronizar (con paginación de 2 en 2) y comprobar que sólo se usó el token y GET.
    const s = await req('POST', `/integrations/${id}/sync`);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.deepEqual(s.body.productos, { productos: 3, ligados: 2, sinLigar: 1 });
    assert.equal(s.body.ordenes.ordenes, 6, 'la orden borrada no se trae');
    assert.deepEqual(s.body.ordenes.porTipo, { ENVIO_FBA: 1, ENVIO_FBL: 1, LIVERPOOL_VENDOR: 1, SHOPIFY_ZANETTI: 1, SHOPIFY_LEANTRAVEL: 1, OTRO: 1 });
    assert.ok(mock.state.calls.every((x) => x.startsWith('GET ') || x === 'POST /org/token'), mock.state.calls.join(', '));
    assert.ok(mock.state.calls.filter((x) => x.startsWith('GET /products')).length >= 2, 'recorre las páginas');

    // Ninguna respuesta trae el código de organización.
    const list = await req('GET', '/integrations');
    assert.ok(!JSON.stringify(list.body).includes('prueba-aplin'));

    // Existencias: APLIN manda; el ERP sólo compara.
    const st = await req('GET', `/integrations/${id}/stock`);
    assert.equal(st.status, 200);
    const a = st.body.items.find((x) => x.skuCode === A);
    assert.equal(a.aplinOnHand, 90);
    assert.equal(a.erpOnHand, 100);
    assert.equal(a.difference, -10);
    assert.equal(a.state, 'DIFERENCIA');
    assert.equal(st.body.items.find((x) => x.skuCode === B).state, 'CUADRA');
    assert.equal(st.body.items.find((x) => x.externalSku === `NOEXISTE${RUN}`).state, 'SIN_LIGAR');
    const inv = await req('GET', `/inventory/stock/${a.skuId}`);
    assert.equal(inv.body.byWarehouse.find((w) => w.code === 'APLIN').onHand, 100, 'sincronizar no mueve el inventario del ERP');

    // Órdenes: alerta de envío a FBA sin existencia; sin datos personales.
    const alerts = await req('GET', `/integrations/${id}/orders?alert=1`);
    assert.deepEqual(alerts.body.map((o) => o.orderNumber), [`FBA19V${RUN}`]);
    const all = await req('GET', `/integrations/${id}/orders`);
    assert.ok(!/cliente@example\.com|Calle 1|5555555555/.test(JSON.stringify(all.body)), 'no guarda comprador ni dirección');
    assert.equal(all.body.find((o) => o.orderNumber === '#2221-ZT').lines[0].skuCode, A);
    const sum = await req('GET', `/integrations/${id}/summary`);
    assert.equal(sum.body.vendorLast30.find((v) => v.skuCode === A).pieces, 1, 'venta Vendor = faltante en FBL');

    // Volver a sincronizar no duplica.
    mock.state.orders[0].fulfillmentStatus = 'OK';
    await req('POST', `/integrations/${id}/sync`);
    const again = await req('GET', `/integrations/${id}/orders`);
    assert.equal(again.body.length, 6);
    assert.equal((await req('GET', `/integrations/${id}/orders?alert=1`)).body.length, 0);

    // Código rechazado por APLIN: 502, queda registrado y la conexión marca el error.
    mock.state.code = 'otro';
    mock.state.tokens.clear();
    const bad = await req('POST', `/integrations/${id}/sync`);
    assert.equal(bad.status, 502);
    const after = (await req('GET', '/integrations')).body.find((x) => x.id === id);
    assert.equal(after.lastSyncOk, false);
    assert.match(after.lastError, /rechazó/);
    const runs = await req('GET', `/integrations/${id}/runs`);
    assert.equal(runs.body[0].status, 'ERROR');
  } finally {
    await mock.close();
  }
});
