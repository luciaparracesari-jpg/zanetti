// Ventas, contenedores y reabasto con datos sintéticos. Mismos requisitos que e2e.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.API_BASE ?? 'http://localhost:4000/api/v1';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@zanetti.mx';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const ADMIN_NEW_PASSWORD = process.env.ADMIN_NEW_PASSWORD ?? `${ADMIN_PASSWORD}x1`;
const RUN = Date.now().toString(36).toUpperCase().slice(-6);
const NUM = String(Date.now()).slice(-6);
const FECHA = '2026-10-29';

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

async function importFile(template, csv, name = `${template}-${RUN}.csv`) {
  const fd = new FormData();
  fd.append('template', template);
  fd.append('file', new Blob([csv], { type: 'text/csv' }), name);
  const up = await req('POST', '/data-imports', fd);
  assert.equal(up.status, 201, JSON.stringify(up.body));
  return up.body;
}

async function apply(batch) {
  const r = await req('POST', `/data-imports/${batch.id}/apply`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.result;
}

const day = (m, d) => `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

test('ventas importadas, contenedores, medidas y cálculo de reabasto', async () => {
  await login();
  const A = `R${RUN}A`;
  const B = `R${RUN}B`;
  const K = `R${RUN}K`;
  const asin = `B0${RUN}A9`;
  const article = `13${NUM}11`;

  // Catálogo: A con ASIN y caja de 10; B con artículo de Liverpool; kit K = A + B.
  let b = await importFile('skus', [
    'SKU MAESTRO,NOMBRE,ASIN AMAZON,ID LIVERPOOL FBL/99 MIN,SKU CAJA MASTER,PIEZAS CAJA MASTER,CATEGORIA,LEAD TIME (DIAS)',
    `${A},Sartén prueba ${RUN},${asin},,${A}-C,10,Pruebas ${RUN},115`,
    `${B},Utensilios prueba ${RUN},,${article}-FBL,${B}-C,5,Pruebas ${RUN},85`,
  ].join('\n'));
  await apply(b);
  b = await importFile('kits', ['SKU KIT,NOMBRE,COMPONENTE,CANTIDAD', `${K},Kit prueba ${RUN},${A},1`, `${K},Kit prueba ${RUN},${B},1`].join('\n'));
  await apply(b);
  b = await importFile('inventario-inicial', ['SKU MAESTRO,ALMACEN,CANTIDAD,COSTO UNITARIO,LOTE', `${A},APLIN,100,50,L1`, `${A},AMZ-FBA,20,50,L1`, `${B},APLIN,40,30,L1`].join('\n'));
  await apply(b);

  // Ventas de Amazon: 31, 31 y 30 piezas de A en jul–sep (AFN) + renglones de envío que se ignoran + 1 devolución.
  const amz = ['Order_ID,Shipment_ID,Shipment_Date,Fulfillment,ASIN,SKU,Transaction_Type,Financial_Component,Quantity,Total'];
  let o = 0;
  for (const [m, n] of [[7, 31], [8, 31], [9, 30]]) {
    for (let i = 1; i <= n; i++) {
      o++;
      const d = `${day(m, Math.min(i, 28))}+00:00`;
      amz.push(`701-${RUN}-${o},S${o},${d},AFN,${asin},SKU-${RUN},SHIPMENT,OUR_PRICE,1,862.07`);
      amz.push(`701-${RUN}-${o},S${o},${d},AFN,${asin},SKU-${RUN},SHIPMENT,SHIPPING,1,0`);
    }
  }
  amz.push(`702-${RUN}-1,S9,${day(9, 15)}+00:00,AFN,${asin},SKU-${RUN},RETURN,OUR_PRICE,1,-862.07`);
  amz.push(`703-${RUN}-1,S10,${day(9, 16)}+00:00,AFN,B0ZZZZZZZZ,X,SHIPMENT,OUR_PRICE,1,100`);
  b = await importFile('ventas-amazon', amz.join('\n'));
  assert.equal(b.summary.toCreate, 94, JSON.stringify(b.summary)); // 92 ventas + 1 devolución + 1 ASIN sin ligar
  assert.equal(b.summary.warning, 1);
  let res = await apply(b);
  assert.equal(res.ventas, 93);
  assert.equal(res.devoluciones, 1);
  assert.equal(res.sinSku, 1);
  // Volver a cargar el mismo reporte no duplica.
  b = await importFile('ventas-amazon', amz.join('\n'));
  assert.equal(b.summary.toCreate, 0, JSON.stringify(b.summary));
  await req('POST', `/data-imports/${b.id}/cancel`, {});

  // Liverpool: 10 piezas de B por mes por artículo; un código de reporte desconocido se liga con una equivalencia.
  const liv = ['Almacén,Fecha,Artículo,sku,Nº documento,Referencia,Venta con descuento,cant'];
  for (const m of [7, 8, 9]) for (let i = 1; i <= 10; i++) liv.push(`0001,${day(m, i)},${article},,95${m}${i}${NUM},R${m}${i},599,1`);
  liv.push(`0002,${day(9, 20)},99${NUM},BUNDLE ${RUN},95999${NUM},R999,999,2`);
  b = await importFile('ventas-liverpool', liv.join('\n'));
  res = await apply(b);
  assert.equal(res.ventas, 31);
  assert.equal(res.sinSku, 1);
  const unm = await req('GET', '/sales/unmapped');
  assert.ok(unm.body.some((u) => u.code === `99${NUM}`));
  const skuB = (await req('GET', `/skus?q=${B}`)).body.items.find((x) => x.skuCode === B);
  const skuA = (await req('GET', `/skus?q=${A}`)).body.items.find((x) => x.skuCode === A);
  const al = await req('POST', '/sku-aliases', { code: `99${NUM}`, masterSkuId: skuB.id, multiplier: 2 });
  assert.equal(al.status, 201, JSON.stringify(al.body));
  assert.equal(al.body.linkedSales, 1, 'liga la venta que estaba sin SKU');

  const monthly = await req('GET', '/sales/monthly?months=12');
  const mA = monthly.body.skus.find((s) => s.skuCode === A);
  assert.equal(mA.byMonth['2026-09'], 29, '30 ventas − 1 devolución');

  // Medidas de la caja de A (50 × 40 × 30 cm = 0.06 CBM) y contenedor en camino.
  b = await importFile('medidas', ['SKU MAESTRO,LARGO (CM),ANCHO (CM),ALTO (CM),PESO BRUTO (KG),CBM', `${A},50,40,30,12,0.6`].join('\n'));
  assert.equal(b.summary.warning, 1, 'CBM del archivo distinto a las medidas');
  await apply(b);
  const cont = `CT${RUN}`;
  b = await importFile('contenedores', ['CONTENEDOR,SKU,PIEZAS,FECHA DEL PEDIDO,ESTADO,PROVEEDOR', `${cont},${A},50,2026-09-21,EN PRODUCCION,Proveedor ${RUN}`, `${cont},${B},200,2026-09-21,EN PRODUCCION,Proveedor ${RUN}`].join('\n'));
  res = await apply(b);
  assert.equal(res.contenedoresCreados, 1);
  const list = await req('GET', '/containers');
  const c = list.body.find((x) => x.code === cont);
  assert.equal(c.eta, '2027-01-14', 'pedido 21-sep + 115 días (lo más lento)');
  assert.ok(Math.abs(c.cbm - 0.3) < 1e-6, '5 cajas × 0.06 CBM');

  // Reabasto
  const r = await req('GET', `/replenishment?fecha=${FECHA}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const chA = r.body.channels.find((x) => x.skuCode === A);
  const daily = ((31 + 31 + 29) / 3) * (12 / 365);
  assert.ok(Math.abs(chA.demandFba - daily) < 1e-9, `${chA.demandFba} vs ${daily}`);
  assert.ok(Math.abs(chA.coverFba - 20 / daily) < 1e-9);
  const ideal = Math.round(daily * 90);
  assert.equal(chA.suggestFba, Math.ceil((ideal - 20) / 10) * 10);
  assert.equal(chA.sendFba, chA.suggestFba);
  assert.equal(chA.via, 'DHL');
  const chB = r.body.channels.find((x) => x.skuCode === B);
  assert.ok(chB.demandFbl > 0 && chB.fbl === 0 && chB.suggestFbl > 0);
  const chinaA = r.body.china.find((x) => x.skuCode === A);
  assert.equal(chinaA.onTheWay, 50);
  assert.ok(chinaA.minOrder > 0 && chinaA.minOrder % 10 === 0, 'pedido en cajas de 10');
  assert.equal(chinaA.physical, 120);
  assert.ok(chinaA.fullCbm <= 68);

  // Envío sugerido → transferencia en borrador; los kits no se mandan sin armar.
  const sh = await req('POST', '/replenishment/shipments', { destination: 'AMZ-FBA', items: [{ masterSkuId: skuA.id, qty: chA.sendFba }] });
  assert.equal(sh.status, 201, JSON.stringify(sh.body));
  assert.match(sh.body.folio, /^TR-/);
  const kitId = (await req('GET', `/skus?q=${K}`)).body.items.find((x) => x.skuCode === K).id;
  const shk = await req('POST', '/replenishment/shipments', { destination: 'AMZ-FBA', items: [{ masterSkuId: kitId, qty: 1 }] });
  assert.equal(shk.status, 400);

  // Pedido planeado: no cuenta como en camino.
  const ord = await req('POST', '/replenishment/orders', { code: `PL${RUN}`, mode: 'LLENO', fecha: FECHA });
  assert.equal(ord.status, 201, JSON.stringify(ord.body));
  const r2 = await req('GET', `/replenishment?fecha=${FECHA}`);
  assert.equal(r2.body.china.find((x) => x.skuCode === A).onTheWay, 50);

  // Parámetros
  const p = await req('PATCH', '/replenishment/params', { colchonFba: 7 });
  assert.equal(p.status, 200);
  assert.equal((await req('PATCH', '/replenishment/params', { mesesHistoria: 40 })).status, 422);

  // Llegada a APLIN: ETD + naviera + aduana; con llegada a puerto, puerto + aduana; la fecha capturada manda.
  const eta = async () => (await req('GET', `/containers/${c.id}`)).body;
  assert.equal((await req('PATCH', `/containers/${c.id}`, { etd: '2026-10-01' })).status, 200);
  assert.deepEqual(await eta().then((x) => [x.eta, x.etaSource]), ['2026-11-25', 'ETD']);
  await req('PATCH', `/containers/${c.id}`, { portEta: '2026-11-09' });
  assert.deepEqual(await eta().then((x) => [x.eta, x.etaSource]), ['2026-11-24', 'PUERTO']);
  await req('PATCH', `/containers/${c.id}`, { etaOverride: '2026-11-20' });
  assert.deepEqual(await eta().then((x) => [x.eta, x.etaSource]), ['2026-11-20', 'MANUAL']);

  // Recibir el contenedor en APLIN: entran lotes con su costo (provisional si no hay).
  const rec = await req('POST', `/containers/${c.id}/receive`, { receivedAt: '2027-01-14' });
  assert.equal(rec.status, 201, JSON.stringify(rec.body));
  assert.equal(rec.body.pieces, 250);
  const st = await req('GET', `/inventory/stock/${skuA.id}`);
  const aplin = st.body.byWarehouse.find((w) => w.code === 'APLIN');
  assert.equal(aplin.onHand, 150);
  assert.equal((await req('POST', `/containers/${c.id}/receive`, {})).status, 409, 'no se recibe dos veces');
  const r3 = await req('GET', `/replenishment?fecha=${FECHA}`);
  assert.equal(r3.body.china.find((x) => x.skuCode === A).onTheWay, 0);
});
