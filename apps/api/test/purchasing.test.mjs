// Órdenes de compra, costeo de contenedor (método del negocio), revaluación de lotes, valor por contenedor y P&L por SKU.
// Mismos requisitos que e2e.test.mjs (API con base de prueba y usuario administrador).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.API_BASE ?? 'http://localhost:4000/api/v1';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@zanetti.mx';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const ADMIN_NEW_PASSWORD = process.env.ADMIN_NEW_PASSWORD ?? `${ADMIN_PASSWORD}x1`;
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
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json') && res.ok) return { status: res.status, body: Buffer.from(await res.arrayBuffer()), type, disposition: res.headers.get('content-disposition') };
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, type };
}
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};

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
  const up = ok(await req('POST', '/data-imports', fd), 201);
  return ok(await req('POST', `/data-imports/${up.id}/apply`, {})).result;
}

function csvFile(text, name) {
  const fd = new FormData();
  fd.append('file', new Blob([text], { type: 'text/csv' }), name);
  return fd;
}

const near = (a, b, msg, tol = 0.0006) => assert.ok(Math.abs(Number(a) - Number(b)) <= tol, `${msg}: ${a} vs ${b}`);

test('orden de compra → contenedor → costeo → revaluación → valor → P&L', async () => {
  await login();
  const A = `P${RUN}A`;
  const B = `P${RUN}B`;
  const asin = `B0${RUN}P1`;
  await importAndApply('skus', [
    'SKU MAESTRO,NOMBRE,ASIN AMAZON,SKU CAJA MASTER,PIEZAS CAJA MASTER,CATEGORIA,LEAD TIME (DIAS)',
    `${A},Recipientes prueba ${RUN},${asin},${A}-C,10,Compras ${RUN},127`,
    `${B},Bandeja prueba ${RUN},,${B}-C,5,Compras ${RUN},127`,
  ].join('\n'));
  await importAndApply('medidas', ['SKU MAESTRO,LARGO (CM),ANCHO (CM),ALTO (CM)', `${A},50,40,30`, `${B},40,30,20`].join('\n'));
  const skuA = ok(await req('GET', `/skus?q=${A}`)).items.find((x) => x.skuCode === A);
  const skuB = ok(await req('GET', `/skus?q=${B}`)).items.find((x) => x.skuCode === B);
  const sup = ok(await req('POST', '/suppliers', { name: `Fábrica ${RUN}`, country: 'CN', currencyCode: 'USD' }), 201);

  // ── Orden de compra ──
  const po = ok(await req('POST', '/purchase-orders', { supplierId: sup.id, orderDate: '2026-11-05', supplierRef: `PI-${RUN}` }), 201);
  assert.match(po.folio, /^OC-\d{6}$/);
  assert.equal(po.currency, 'USD', 'toma la moneda del proveedor');

  // Carga desde Excel/CSV: primero muestra qué haría; con un SKU inexistente no aplica.
  const withError = `SKU,PIECES / PIEZAS,PCS PER CARTON,UNIT PRICE\n${A},100,10,7.5\n${B},200,5,4.2\nZZZ${RUN},1,1,1\n,300,,\n`;
  let prev = ok(await req('POST', `/purchase-orders/${po.id}/import`, csvFile(withError, 'orden.csv')));
  assert.equal(prev.applied, false);
  assert.deepEqual([prev.summary.new, prev.summary.errors, prev.summary.pieces], [2, 1, 300]);
  const fdBad = csvFile(withError, 'orden.csv');
  fdBad.append('apply', '1');
  assert.equal((await req('POST', `/purchase-orders/${po.id}/import`, fdBad)).status, 409, 'no aplica con errores');
  const fdOk = csvFile(`SKU,PIECES / PIEZAS,PCS PER CARTON,UNIT PRICE\n${A},100,10,7.5\n${B},200,5,4.2\n`, 'orden.csv');
  fdOk.append('apply', '1');
  prev = ok(await req('POST', `/purchase-orders/${po.id}/import`, fdOk));
  assert.equal(prev.applied, true);
  let full = ok(await req('GET', `/purchase-orders/${po.id}`));
  assert.equal(full.items.length, 2);
  assert.equal(full.total, '1590.00', '100 × 7.5 + 200 × 4.2');
  const files = ok(await req('GET', `/attachments?entityType=PURCHASE_ORDER&entityId=${po.id}`));
  assert.equal(files.length, 1, 'guarda el archivo cargado');
  assert.equal(files[0].kind, 'ORDEN');

  // Archivo adjunto, descarga y borrado.
  const fdPdf = new FormData();
  fdPdf.append('entityType', 'PURCHASE_ORDER');
  fdPdf.append('entityId', po.id);
  fdPdf.append('kind', 'PROFORMA');
  fdPdf.append('file', new Blob(['%PDF-1.4 prueba'], { type: 'application/pdf' }), `proforma ${RUN}.pdf`);
  const att = ok(await req('POST', '/attachments', fdPdf), 201);
  const dl = await req('GET', `/attachments/${att.id}/file`);
  assert.equal(dl.status, 200);
  assert.equal(dl.body.toString(), '%PDF-1.4 prueba');
  const fdExe = new FormData();
  fdExe.append('entityType', 'PURCHASE_ORDER');
  fdExe.append('entityId', po.id);
  fdExe.append('file', new Blob(['MZ'], { type: 'application/octet-stream' }), 'virus.exe');
  assert.equal((await req('POST', '/attachments', fdExe)).status, 400, 'tipo de archivo no permitido');
  ok(await req('DELETE', `/attachments/${att.id}`));

  // Orden en Excel para el proveedor.
  const xl = await req('GET', `/purchase-orders/${po.id}/file`);
  assert.equal(xl.status, 200);
  assert.ok(xl.type.includes('spreadsheetml'));
  assert.equal(xl.body.subarray(0, 2).toString(), 'PK');

  // Pagos.
  ok(await req('POST', `/purchase-orders/${po.id}/payments`, { paidAt: '2026-11-06', amount: 477, fxRate: 18.2, reference: 'Anticipo 30%' }), 201);
  full = ok(await req('GET', `/purchase-orders/${po.id}`));
  assert.deepEqual([full.paid, full.balance], ['477.00', '1113.00']);
  assert.equal(full.payments[0].amountMxn, '8681.40');

  // ── Contenedor: ya trae A sin orden (pedido sugerido); la orden lo liga y agrega B ──
  const code = `CP${RUN}`;
  await importAndApply('contenedores', ['CONTENEDOR,SKU,PIEZAS,FECHA DEL PEDIDO,ESTADO', `${code},${A},90,2026-11-05,EN PRODUCCION`].join('\n'));
  const cont = ok(await req('GET', '/containers')).find((c) => c.code === code);
  const moved = ok(await req('POST', `/purchase-orders/${po.id}/to-container`, { containerId: cont.id }));
  assert.deepEqual([moved.linked, moved.added, moved.pieces], [1, 1, 300]);
  assert.equal((await req('POST', `/purchase-orders/${po.id}/to-container`, { containerId: cont.id })).status, 409, 'ya no queda nada pendiente');
  const detail = ok(await req('GET', `/containers/${cont.id}`));
  assert.deepEqual(detail.lines.map((l) => [l.skuCode, l.qty, l.poFolio]).sort(), [[A, 100, po.folio], [B, 200, po.folio]]);

  // ── Costeo ──
  let cost = ok(await req('GET', `/containers/${cont.id}/costing`));
  assert.ok(cost.issues.some((i) => i.code === 'SIN_TIPO_CAMBIO'), 'orden en USD sin tipo de cambio');
  const closeEarly = await req('POST', `/containers/${cont.id}/costing/close`, {});
  assert.equal(closeEarly.status, 409);
  assert.equal(closeEarly.body.code, 'COSTEO_INCOMPLETO');

  ok(await req('PATCH', `/containers/${cont.id}/costing`, { fxRate: 18, dutyFxRate: 18.1, pedimento: '26 16 1234 6000001' }));
  ok(await req('PATCH', `/containers/${cont.id}/duty-rates`, { items: [{ skuId: skuA.id, dutyRate: 0.25 }] }));
  assert.equal(ok(await req('POST', `/containers/${cont.id}/costs/defaults`, {})).added, 13);
  assert.equal(ok(await req('POST', `/containers/${cont.id}/costs/defaults`, {})).added, 0, 'no repite conceptos');
  cost = ok(await req('GET', `/containers/${cont.id}/costing`));
  const flete = cost.expenses.find((e) => e.concept === 'Flete nacional');
  ok(await req('PATCH', `/containers/${cont.id}/costs/${flete.id}`, { amount: 45000 }));
  const maritimo = ok(await req('POST', `/containers/${cont.id}/costs`, { concept: 'Flete marítimo', amount: 1000, currency: 'USD' }), 201);
  cost = ok(await req('GET', `/containers/${cont.id}/costing`));
  assert.deepEqual(cost.issues, []);
  assert.ok(cost.warnings.some((w) => w.code === 'SIN_ARANCEL'), `${B} sin arancel`);
  const expenses1 = 45000 + 1000 * 18;
  near(cost.totals.expensesMxn, expenses1, 'gastos en pesos', 0.005);
  near(cost.totals.expensePerPiece, expenses1 / 300, 'gasto por pieza', 0.0001);
  const merchA = 7.5 * 18;
  const dutyA = 7.5 * 18.1 * 0.25;
  const lineA = cost.lines.find((l) => l.skuCode === A);
  near(lineA.calc.dutyUnit, dutyA, 'arancel de A');
  near(lineA.calc.unitCost, merchA + dutyA + expenses1 / 300, 'costo puesto en bodega de A', 0.001);
  const lineB = cost.lines.find((l) => l.skuCode === B);
  near(lineB.calc.unitCost, 4.2 * 18 + expenses1 / 300, 'B sin arancel', 0.001);

  // Recibir antes de cerrar: los lotes entran con el costo estimado, provisional.
  ok(await req('POST', `/containers/${cont.id}/receive`, { receivedAt: '2027-03-12' }), 201);
  cost = ok(await req('GET', `/containers/${cont.id}/costing`));
  const lotA = cost.lines.find((l) => l.skuCode === A).lot;
  assert.equal(lotA.costStatus, 'PROVISIONAL');
  near(lotA.unitCost, lineA.calc.unitCost, 'lote con el costo estimado', 0.0001);

  // Sale merma de 10 piezas de A; después llega la factura final del flete (1,200 USD) y se cierra el costeo.
  const st = ok(await req('GET', `/inventory/stock/${skuA.id}`));
  const aplin = st.byWarehouse.find((w) => w.code === 'APLIN');
  const adj = ok(await req('POST', '/adjustments', { warehouseId: aplin.warehouseId, reason: 'MERMA', notes: 'prueba', items: [{ masterSkuId: skuA.id, qty: -10 }] }), 201);
  ok(await req('POST', `/adjustments/${adj.id}/apply`, {}), 201);
  ok(await req('PATCH', `/containers/${cont.id}/costs/${maritimo.id}`, { amount: 1200 }));
  const closed = ok(await req('POST', `/containers/${cont.id}/costing/close`, {}));
  const expenses2 = 45000 + 1200 * 18;
  const finalA = merchA + dutyA + expenses2 / 300;
  const rvA = closed.revalued.find((x) => x.skuCode === A);
  assert.equal(rvA.changed, true);
  assert.deepEqual([rvA.onHand, rvA.consumed], [90, 10]);
  near(rvA.newCost, finalA, 'costo final de A', 0.001);
  near(rvA.deltaOnHand, 90 * (Number(rvA.newCost) - Number(rvA.oldCost)), 'revaluación de lo que queda', 0.01);
  near(rvA.deltaConsumed, 10 * (Number(rvA.newCost) - Number(rvA.oldCost)), 'diferencia de la merma', 0.01);
  cost = ok(await req('GET', `/containers/${cont.id}/costing`));
  assert.equal(cost.costStatus, 'CERRADO');
  assert.equal(cost.lines.find((l) => l.skuCode === A).lot.costStatus, 'FINAL');
  assert.equal((await req('POST', `/containers/${cont.id}/costs`, { concept: 'Otro', amount: 1 })).status, 409, 'cerrado no se edita');

  // El kardex cuadra: valor = existencia × costo nuevo.
  const kx = ok(await req('GET', `/inventory/kardex?skuId=${skuA.id}&warehouseId=${aplin.warehouseId}`));
  assert.ok(kx.items.some((m) => m.type === 'REVALUACION_COSTO'));
  near(kx.summary.closingValue, 90 * Number(rvA.newCost), 'valor del kardex', 0.02);

  // ── Valor del inventario por contenedor ──
  const val = ok(await req('GET', '/inventory-valuation/containers'));
  const row = val.lots.find((l) => l.lot === code);
  assert.ok(row, 'aparece el contenedor');
  assert.equal(row.costStatus, 'CERRADO');
  assert.equal(row.byWarehouse.APLIN.qty, 290);
  near(row.value, 90 * Number(rvA.newCost) + 200 * Number(closed.revalued.find((x) => x.skuCode === B).newCost), 'valor del contenedor', 0.02);

  // Reabrir y volver a cerrar sin cambios no mueve nada.
  ok(await req('POST', `/containers/${cont.id}/costing/reopen`, {}));
  const again = ok(await req('POST', `/containers/${cont.id}/costing/close`, {}));
  assert.ok(again.revalued.every((x) => !x.changed));

  // ── P&L por SKU (Amazon): último precio de venta del canal y costo del contenedor elegido ──
  const amz = ['Order_ID,Shipment_ID,Shipment_Date,Fulfillment,ASIN,SKU,Transaction_Type,Financial_Component,Quantity,Total'];
  amz.push(`801-${RUN}-1,S1,2026-09-10+00:00,AFN,${asin},SKU-${RUN},SHIPMENT,OUR_PRICE,1,500.00`);
  amz.push(`801-${RUN}-2,S2,2026-09-28+00:00,AFN,${asin},SKU-${RUN},SHIPMENT,OUR_PRICE,1,562.50`);
  await importAndApply('ventas-amazon', amz.join('\n'));
  const opts = ok(await req('GET', '/profitability/options'));
  const amazon = opts.channels.find((c) => c.code === 'AMAZON');
  const prevSettings = amazon.settings;
  ok(await req('PUT', `/profitability/channels/${amazon.id}`, { commissionRate: 0.15, commissionBase: 'VENTA_NETA', adsRate: 0.1, storagePerUnit: 20, inboundPerBox: 120, fulfillmentPerUnit: 0 }));
  ok(await req('PUT', `/profitability/sku/${skuA.id}/channels/${amazon.id}`, { listPrice: 640, fulfillmentPerUnit: 70, storagePerUnit: null, adsRate: null }));
  ok(await req('PUT', `/profitability/sku/${skuB.id}/channels/${amazon.id}`, { listPrice: 580, fulfillmentPerUnit: 75, storagePerUnit: 10, adsRate: 0.09 }));
  try {
    const pl = ok(await req('GET', `/profitability/sku?channelId=${amazon.id}&containerId=${cont.id}`));
    const pa = pl.rows.find((r) => r.skuCode === A);
    assert.equal(pa.price.source, 'ULTIMA_VENTA');
    assert.equal(pa.price.lastSaleDate, '2026-09-28');
    near(pa.price.used, 652.5, 'último precio con IVA (562.50 × 1.16)', 0.01);
    assert.equal(pa.cost.source, 'CONTENEDOR');
    const net = 652.5 / 1.16;
    const cogs = merchA + dutyA + expenses2 / 300 + 120 / 10;
    near(pa.pl.cogs, cogs, 'COGS', 0.002);
    const ebitda = net - cogs - net * 0.15 - 70 - net * 0.1 - 20;
    near(pa.pl.ebitda, ebitda, 'EBITDA', 0.002);
    assert.equal(pa.containerQty, 100);
    const pb = pl.rows.find((r) => r.skuCode === B);
    assert.equal(pb.price.source, 'CAPTURADO', 'sin ventas en Amazon usa el capturado');
    near(pb.pl.ebitda, 580 / 1.16 - (4.2 * 18 + expenses2 / 300 + 120 / 5) - (580 / 1.16) * 0.15 - 75 - (580 / 1.16) * 0.09 - 10, 'EBITDA de B', 0.002);
    near(pa.pl.product, merchA, 'el costo del producto no se divide entre 1.16', 0.002);
  } finally {
    const s = prevSettings ?? {};
    await req('PUT', `/profitability/channels/${amazon.id}`, {
      commissionRate: s.commissionRate ?? null,
      commissionBase: s.commissionBase ?? 'VENTA_NETA',
      adsRate: s.adsRate ?? 0,
      storagePerUnit: s.storagePerUnit ?? 0,
      inboundPerBox: s.inboundPerBox ?? 0,
      fulfillmentPerUnit: s.fulfillmentPerUnit ?? 0,
    });
  }

  // La orden ya no se puede cancelar mientras tenga renglones en un contenedor.
  assert.equal((await req('PATCH', `/purchase-orders/${po.id}`, { status: 'CANCELADA' })).status, 409);
  const listed = ok(await req('GET', `/purchase-orders?q=${po.folio}`));
  assert.equal(listed.items[0].containers, code);
});
