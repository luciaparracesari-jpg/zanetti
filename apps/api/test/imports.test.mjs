// Prueba de la importación de SKU maestro (CSV sintético). Mismos requisitos que e2e.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.API_BASE ?? 'http://localhost:4000/api/v1';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@zanetti.mx';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const ADMIN_NEW_PASSWORD = process.env.ADMIN_NEW_PASSWORD ?? `${ADMIN_PASSWORD}x1`;
const RUN = Date.now().toString(36).toUpperCase().slice(-6);
const NUM = String(Date.now()).slice(-6);

let cookie = '';
async function req(method, path, body, extraHeaders = {}) {
  const headers = { 'x-erp-client': 'web', ...extraHeaders };
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
  return { status: res.status, body: json, headers: res.headers };
}

async function login() {
  let r = await req('POST', '/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  if (r.status === 401) r = await req('POST', '/auth/login', { email: ADMIN_EMAIL, password: ADMIN_NEW_PASSWORD });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  if (r.body.mustChangePassword) {
    assert.equal((await req('POST', '/auth/password', { currentPassword: ADMIN_PASSWORD, newPassword: ADMIN_NEW_PASSWORD })).status, 200);
  }
}

const ean13 = (base12) => {
  const d = base12.split('').map(Number);
  const sum = d.reduce((a, x, i) => a + x * (i % 2 === 0 ? 1 : 3), 0);
  return base12 + ((10 - (sum % 10)) % 10);
};

function upload(csv, name = `prueba-${RUN}.csv`) {
  const fd = new FormData();
  fd.append('template', 'skus');
  fd.append('file', new Blob([csv], { type: 'text/csv' }), name);
  return req('POST', '/data-imports', fd);
}

test('importación de SKU maestro: validar, corregir, omitir, aplicar y reimportar', async () => {
  await login();
  const tpl = await req('GET', '/data-imports/templates');
  assert.equal(tpl.status, 200);
  assert.ok(tpl.body.find((t) => t.key === 'skus' && t.allowed));
  const file = await req('GET', '/data-imports/templates/skus/file');
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-type'), /spreadsheetml/);

  const s = (n) => `T${RUN}${n}`;
  const bc1 = ean13(`750${String(Date.now()).slice(-9)}`);
  const bc2 = ean13(`751${String(Date.now()).slice(-9)}`);
  // Renglón 1 es un título como en el archivo real; el encabezado está en el renglón 2.
  const csv = [
    ';SKU DE OFERTA;;;;;',
    'SKU MAESTRO;ID LIVERPOOL FBL/99 MIN;ID LIVERPOOL VENDOR;ASIN AMAZON;UPC-EAN;SKU CAJA MASTER;PIEZAS CAJA MASTER;NOMBRE;Columna extra',
    `${s('A')};11${NUM}01-FBL;OF${RUN};B0${RUN}A1; ${bc1};${s('A')}-C;10;Caja 30 L;x`,
    `${s('B')};11${NUM}02;11${NUM}02-OF;B0${RUN}B1;7503039141040;${s('B')}-C;6;;`,
    `${s('A')};;;B0${RUN}C1;;;;Duplicado;`,
    `${s('D')};;;B0${RUN}D1;${bc2};${s('D')};;;`,
  ].join('\n');
  const up = await upload(csv);
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const id = up.body.id;
  assert.equal(up.body.totalRows, 4);
  assert.ok(up.body.fileMessages.some((m) => m.message.includes('Columna extra')), 'avisa columnas ignoradas');
  assert.equal(up.body.summary.error, 3, 'duplicado ×2 y dígito verificador');

  let rows = (await req('GET', `/data-imports/${id}/rows?pageSize=50`)).body.items;
  const byNum = Object.fromEntries(rows.map((r) => [r.rowNumber, r]));
  assert.equal(byNum[3].status, 'ERROR');
  assert.ok(byNum[3].messages.some((m) => m.message.includes('también aparece')));
  assert.equal(byNum[3].values.barcode, bc1, 'se limpia el espacio invisible');
  assert.ok(byNum[4].messages.some((m) => m.message.includes('dígito verificador')));
  assert.equal(byNum[6].status, 'ADVERTENCIA', 'caja igual al SKU');
  const l4 = byNum[4].plan.listings.find((l) => l.externalSku === `11${NUM}02` && l.warehouse === 'LIV-FBL');
  assert.ok(l4, 'número sin sufijo -FBL se registra en FBL');

  // No se puede aplicar con errores.
  const blocked = await req('POST', `/data-imports/${id}/apply`, {});
  assert.equal(blocked.status, 422);

  // Corregir el código de barras del renglón 4 y omitir el duplicado del renglón 5.
  let r = await req('PATCH', `/data-imports/${id}/rows/${byNum[4].id}`, { values: { barcode: ean13(`752${String(Date.now()).slice(-9)}`) } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await req('PATCH', `/data-imports/${id}/rows/${byNum[5].id}`, { skipped: true });
  assert.equal(r.body.summary.error, 0, JSON.stringify(r.body.summary));
  assert.equal(r.body.summary.skipped, 1);

  const applied = await req('POST', `/data-imports/${id}/apply`, {});
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.status, 'APLICADO');
  assert.equal(applied.body.result.skusCreados, 3);
  assert.equal(applied.body.result.cajas, 2);

  const sku = await req('GET', `/skus?q=${s('A')}`);
  const a = sku.body.items.find((x) => x.skuCode === s('A'));
  assert.equal(a.name, 'Caja 30 L');
  const detail = await req('GET', `/skus/${a.id}`);
  assert.equal(detail.body.packages[0].unitsPerPackage, 10);
  assert.equal(detail.body.listings.length, 3);
  assert.ok(detail.body.listings.some((l) => l.fnsku === null && l.channelCode === 'AMAZON'), 'el SKU no tiene forma de FNSKU');

  // La caja se encuentra en la búsqueda global.
  const found = await req('GET', `/search?q=${s('A')}-C`);
  assert.ok(found.body.some((g) => g.module === 'skus' && g.hits.some((h) => h.title === s('A'))));

  // Ya aplicada, no admite cambios.
  assert.equal((await req('PATCH', `/data-imports/${id}/rows/${byNum[3].id}`, { skipped: true })).status, 409);

  // Reimportar el mismo archivo: nada que crear; el ASIN del renglón 5 ahora choca con nada (se omitió antes).
  const again = await upload(csv.replace(/^.*Duplicado.*$/m, ''));
  assert.equal(again.status, 201);
  assert.equal(again.body.summary.toCreate, 0);
  assert.equal(again.body.summary.unchanged + again.body.summary.error, 3);

  // Un ASIN ya ligado a otro SKU es un error.
  const clash = await upload(
    ['SKU MAESTRO,ASIN AMAZON,ID LIVERPOOL FBL/99 MIN,ID LIVERPOOL VENDOR', `${s('Z')},B0${RUN}A1,,`, `${s('Y')},,12${NUM}03,12${NUM}03`].join('\n'),
  );
  rows = (await req('GET', `/data-imports/${clash.body.id}/rows`)).body.items;
  const z = rows.find((x) => x.values.skuCode === s('Z'));
  const y = rows.find((x) => x.values.skuCode === s('Y'));
  assert.ok(z.messages.some((m) => m.message.includes(`ya está ligada al SKU ${s('A')}`)));
  assert.ok(y.messages.some((m) => m.message.includes('aparece dos veces en este renglón')));
  assert.equal((await req('POST', `/data-imports/${clash.body.id}/cancel`, {})).body.status, 'CANCELADO');

  // Archivo sin encabezado reconocible.
  const bad = await upload('A,B\n1,2');
  assert.equal(bad.status, 422);
  assert.match(bad.body.message, /SKU MAESTRO/);

  // Auditoría de la importación.
  const audit = await req('GET', `/audit-logs?action=APLICAR_IMPORTACION&q=${RUN}`);
  assert.ok(audit.body.total >= 1);

  // Parámetros de reabasto en SKU existentes: lead time, días de seguridad y categoría (sólo si el producto no tiene).
  const cat = `Reabasto ${RUN} / Sartenes`;
  const params = await upload(
    ['SKU MAESTRO,CATEGORIA,LEAD TIME (DIAS),DIAS DE SEGURIDAD', `${s('B')},${cat},115,21`, `${s('A')},,85,`, `${s('D')},,abc,`].join('\n'),
  );
  assert.equal(params.status, 201, JSON.stringify(params.body));
  rows = (await req('GET', `/data-imports/${params.body.id}/rows`)).body.items;
  const pd = rows.find((x) => x.values.skuCode === s('D'));
  assert.ok(pd.messages.some((m) => m.field === 'leadTimeDays' && m.level === 'error'), 'lead time inválido');
  await req('PATCH', `/data-imports/${params.body.id}/rows/${pd.id}`, { skipped: true });
  const pb = rows.find((x) => x.values.skuCode === s('B'));
  assert.equal(pb.action, 'ACTUALIZAR');
  assert.equal(pb.plan.categoryAssign.path, cat);
  const pApplied = await req('POST', `/data-imports/${params.body.id}/apply`, {});
  assert.equal(pApplied.status, 200, JSON.stringify(pApplied.body));
  assert.equal(pApplied.body.result.skusActualizados, 2);
  assert.equal(pApplied.body.result.categoriasCreadas, 2);
  const bId = (await req('GET', `/skus?q=${s('B')}`)).body.items.find((x) => x.skuCode === s('B')).id;
  const bAfter = (await req('GET', `/skus/${bId}`)).body;
  assert.equal(bAfter.leadTimeDays, 115);
  assert.equal(bAfter.safetyDays, 21);
  assert.equal(bAfter.product.category.name, 'Sartenes');
  assert.equal((await req('GET', `/skus/${a.id}`)).body.leadTimeDays, 85);

  // Con categoría ya asignada no se cambia desde la importación.
  const again2 = await upload(['SKU MAESTRO,CATEGORIA,LEAD TIME (DIAS)', `${s('B')},Otra ${RUN},115`].join('\n'));
  rows = (await req('GET', `/data-imports/${again2.body.id}/rows`)).body.items;
  assert.equal(rows[0].action, 'SIN_CAMBIOS');
  assert.ok(rows[0].messages.some((m) => m.field === 'category' && m.message.includes('ya tiene categoría')));
  await req('POST', `/data-imports/${again2.body.id}/cancel`, {});
});
