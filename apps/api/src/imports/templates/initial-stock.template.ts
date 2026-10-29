import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { inventoryLots, masterSkus, warehouseLocations, warehouses, type DbOrTx, type Tx } from '@erp/db';
import { postMovement, refreshAvgCost } from '@erp/domain';
import type { Actor } from '../../common/actor';
import type { ImportTemplate, InputRow, RowMessage, ValidatedRow } from '../types';

export interface InitialStockPlan {
  skuId: string;
  skuCode: string;
  warehouseId: string;
  warehouseCode: string;
  locationId: string | null;
  locationCode: string | null;
  qty: number;
  unitCost: string | null;
  lotCode: string | null;
  receivedAt: string | null;
  /** PROVISIONAL cuando el costo es estimado (o falta) y debe confirmarse después. */
  costStatus: 'FINAL' | 'PROVISIONAL';
  /** Texto para la vista previa. */
  label: string;
}

const up = (v: string | null) => (v ? v.trim().toUpperCase() : null);

/** Fecha AAAA-MM-DD o DD/MM/AAAA. */
function parseDate(v: string | null): { value: string | null; ok: boolean } {
  if (!v) return { value: null, ok: true };
  const s = v.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  let y: number, mo: number, d: number;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else {
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (!m) return { value: null, ok: false };
    [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return { value: null, ok: false };
  return { value: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, ok: true };
}

function parseQty(v: string | null): { value: number | null; ok: boolean } {
  if (!v) return { value: null, ok: false };
  const n = Number(v.replace(/,/g, '').trim());
  if (!Number.isInteger(n) || n < 0 || n > 1_000_000) return { value: null, ok: false };
  return { value: n, ok: true };
}

function parseCost(v: string | null): { value: string | null; ok: boolean } {
  if (!v) return { value: null, ok: true };
  const s = v.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return { value: null, ok: false };
  return { value: Number(s).toFixed(4), ok: true };
}

/** Sinónimos de almacén que aparecen en hojas de inventario. */
const WAREHOUSE_ALIASES: Record<string, string> = {
  FBA: 'AMZ-FBA',
  AMAZON: 'AMZ-FBA',
  'AMAZON FBA': 'AMZ-FBA',
  FBL: 'LIV-FBL',
  'LIVERPOOL FBL': 'LIV-FBL',
  '99 MIN': 'LIV-99MIN',
  '99MIN': 'LIV-99MIN',
  'LIVERPOOL 99 MIN': 'LIV-99MIN',
  BODEGA: 'APLIN',
};

export const initialStockTemplate: ImportTemplate<InitialStockPlan> = {
  key: 'inventario-inicial',
  label: 'Inventario inicial',
  description:
    'Carga las existencias de arranque por SKU, almacén y ubicación con su costo unitario. Cada renglón crea un lote (FIFO) y un movimiento de inventario inicial; reimportar el mismo lote no lo duplica dentro del mismo archivo.',
  permissions: ['ajustes.autorizar', 'costos.ver'],
  columns: [
    { field: 'skuCode', header: 'SKU MAESTRO', aliases: ['SKU', 'CODIGO SKU', 'SKU MASTER'], required: true, example: 'X003Q4BXC7', help: 'SKU maestro existente (no kits).' },
    { field: 'warehouse', header: 'ALMACEN', aliases: ['ALMACÉN', 'BODEGA', 'CODIGO ALMACEN'], required: true, example: 'APLIN', help: 'Código del almacén: APLIN, AMZ-FBA, LIV-FBL o LIV-99MIN. También se aceptan FBA, FBL y 99 MIN.' },
    { field: 'location', header: 'UBICACION', aliases: ['UBICACIÓN', 'LOCALIDAD'], example: 'GEN', help: 'Código de la ubicación dentro del almacén. Si falta, se usa GEN.' },
    { field: 'qty', header: 'CANTIDAD', aliases: ['PIEZAS', 'EXISTENCIA', 'STOCK', 'UNIDADES'], required: true, example: '120', help: 'Piezas físicas (entero). Un 0 se ignora.' },
    { field: 'cost', header: 'COSTO UNITARIO', aliases: ['COSTO', 'COSTO UNITARIO SIN IVA', 'COSTO MXN'], example: '85.50', help: 'Costo por pieza en MXN sin IVA, puesto en almacén. Si falta se usa el costo actual del SKU y el lote queda con costo provisional.' },
    { field: 'lot', header: 'LOTE', aliases: ['NUMERO DE LOTE', 'LOTE PROVEEDOR'], example: 'PO-2026-014', help: 'Opcional. Si el mismo lote está en varios almacenes, repítelo con el mismo costo.' },
    { field: 'costStatus', header: 'ESTADO DEL COSTO', aliases: ['ESTADO COSTO', 'TIPO DE COSTO'], example: 'FINAL', help: 'FINAL o PROVISIONAL. Usa PROVISIONAL si el costo es estimado (por ejemplo, de otro contenedor). Si falta: FINAL cuando hay costo y PROVISIONAL cuando no.' },
    { field: 'receivedAt', header: 'FECHA ENTRADA', aliases: ['FECHA', 'FECHA DE ENTRADA', 'FECHA RECEPCION'], example: '2026-09-30', help: 'Fecha en que entró la mercancía (define el orden FIFO). Formato AAAA-MM-DD o DD/MM/AAAA. Si falta, se usa la fecha de carga y el orden del archivo: de arriba hacia abajo, del lote más antiguo al más reciente.' },
  ],

  async validate(db: DbOrTx, rows: InputRow[], actor: Actor): Promise<ValidatedRow<InitialStockPlan>[]> {
    const active = rows.filter((r) => !r.skipped);
    const v = (r: InputRow, f: string) => r.values[f] ?? null;

    const codes = [...new Set(active.map((r) => up(v(r, 'skuCode'))).filter((x): x is string => Boolean(x)))];
    const skus = codes.length
      ? await db
          .select({ id: masterSkus.id, skuCode: masterSkus.skuCode, isKit: masterSkus.isKit, status: masterSkus.status, currentCost: masterSkus.currentCost, avgCost: masterSkus.avgCost })
          .from(masterSkus)
          .where(inArray(sql`upper(${masterSkus.skuCode})`, codes))
      : [];
    const skuBy = new Map(skus.map((s) => [s.skuCode.toUpperCase(), s]));
    const whs = await db.select({ id: warehouses.id, code: warehouses.code, name: warehouses.name, status: warehouses.status }).from(warehouses);
    const whBy = new Map<string, (typeof whs)[number]>();
    for (const w of whs) {
      whBy.set(w.code.toUpperCase(), w);
      whBy.set(w.name.toUpperCase(), w);
    }
    for (const [alias, code] of Object.entries(WAREHOUSE_ALIASES)) {
      const w = whBy.get(code);
      if (w && !whBy.has(alias)) whBy.set(alias, w);
    }
    const locs = await db.select({ id: warehouseLocations.id, warehouseId: warehouseLocations.warehouseId, code: warehouseLocations.code, status: warehouseLocations.status }).from(warehouseLocations);
    const locBy = new Map(locs.map((l) => [`${l.warehouseId}|${l.code.toUpperCase()}`, l]));
    const genOf = (whId: string) => locBy.get(`${whId}|GEN`) ?? null;

    // Existencia actual por SKU y almacén (para avisar que se sumará).
    const skuIds = skus.map((s) => s.id);
    const current = skuIds.length
      ? (
          await db.execute<{ master_sku_id: string; warehouse_id: string; on_hand: number }>(
            sql`SELECT master_sku_id, warehouse_id, on_hand FROM inventory_stock WHERE on_hand <> 0 AND master_sku_id IN (${sql.join(
              skuIds.map((i) => sql`${i}::uuid`),
              sql`, `,
            )})`,
          )
        ).rows
      : [];
    const onHand = new Map(current.map((c) => [`${c.master_sku_id}|${c.warehouse_id}`, Number(c.on_hand)]));
    const lotsInDb = skuIds.length
      ? await db
          .select({ masterSkuId: inventoryLots.masterSkuId, lotCode: inventoryLots.lotCode, unitCost: inventoryLots.unitCost })
          .from(inventoryLots)
          .where(inArray(inventoryLots.masterSkuId, skuIds))
      : [];
    const lotDb = new Map(lotsInDb.map((l) => [`${l.masterSkuId}|${l.lotCode.toUpperCase()}`, l.unitCost]));

    // Índices dentro del archivo.
    const keyOf = new Map<number, string>();
    const keyIdx = new Map<string, number[]>();
    const lotCost = new Map<string, Set<string>>();
    const today = new Date().toISOString().slice(0, 10);

    const prelim = rows.map((r) => {
      const m: RowMessage[] = [];
      const err = (field: string, message: string) => m.push({ field, level: 'error', message });
      const code = up(v(r, 'skuCode'));
      const sku = code ? skuBy.get(code) : undefined;
      if (!code) err('skuCode', 'Falta el SKU maestro.');
      else if (!sku) err('skuCode', `El SKU ${code} no existe. Impórtalo primero con la plantilla de SKU maestro.`);
      else if (sku.isKit) err('skuCode', `${sku.skuCode} es un kit: carga la existencia de sus componentes.`);
      else if (sku.status === 'INACTIVO') m.push({ field: 'skuCode', level: 'warning', message: `${sku.skuCode} está inactivo.` });

      const whRaw = up(v(r, 'warehouse'));
      const wh = whRaw ? whBy.get(whRaw) : undefined;
      if (!whRaw) err('warehouse', 'Falta el almacén.');
      else if (!wh) err('warehouse', `No existe el almacén “${v(r, 'warehouse')}”. Usa ${whs.map((w) => w.code).join(', ')}.`);
      else if (wh.status !== 'ACTIVO') err('warehouse', `El almacén ${wh.code} está inactivo.`);
      else if (actor.warehouseIds && !actor.warehouseIds.includes(wh.id)) err('warehouse', `No tienes acceso al almacén ${wh.code}.`);

      const locRaw = up(v(r, 'location'));
      let loc: (typeof locs)[number] | null = null;
      if (wh) {
        if (locRaw) {
          loc = locBy.get(`${wh.id}|${locRaw}`) ?? null;
          if (!loc) err('location', `El almacén ${wh.code} no tiene la ubicación ${locRaw}.`);
          else if (loc.status !== 'ACTIVO') err('location', `La ubicación ${wh.code}/${loc.code} está inactiva.`);
        } else loc = genOf(wh.id);
      }

      const q = parseQty(v(r, 'qty'));
      if (!q.ok) err('qty', 'La cantidad debe ser un entero de 0 en adelante.');
      const c = parseCost(v(r, 'cost'));
      if (!c.ok) err('cost', 'Costo inválido: usa números con punto decimal, sin IVA.');
      const fallback = sku?.currentCost ?? sku?.avgCost ?? null;
      if (c.ok && !c.value && sku && q.value)
        m.push({
          field: 'cost',
          level: 'warning',
          message: fallback ? `Sin costo: se usará el costo actual del SKU (${Number(fallback).toFixed(2)}) como provisional.` : 'Sin costo y el SKU no tiene costo: el lote queda en 0 como provisional. Captúralo antes de calcular márgenes.',
        });

      const statusRaw = up(v(r, 'costStatus'));
      let costStatus: 'FINAL' | 'PROVISIONAL' = c.value ? 'FINAL' : 'PROVISIONAL';
      if (statusRaw) {
        if (statusRaw === 'FINAL' || statusRaw === 'PROVISIONAL') costStatus = statusRaw;
        else err('costStatus', 'Usa FINAL o PROVISIONAL.');
        if (statusRaw === 'FINAL' && !c.value) err('costStatus', 'Un costo FINAL necesita costo unitario.');
      }

      const lot = v(r, 'lot')?.trim() || null;
      if (lot && lot.length > 40) err('lot', 'El lote admite hasta 40 caracteres.');
      const d = parseDate(v(r, 'receivedAt'));
      if (!d.ok) err('receivedAt', 'Fecha inválida: usa AAAA-MM-DD o DD/MM/AAAA.');
      else if (d.value && d.value > today) err('receivedAt', 'La fecha de entrada no puede ser futura.');

      if (!r.skipped && sku && wh) {
        const k = `${sku.id}|${wh.id}|${loc?.id ?? ''}|${(lot ?? '').toUpperCase()}`;
        keyOf.set(r.rowNumber, k);
        keyIdx.set(k, [...(keyIdx.get(k) ?? []), r.rowNumber]);
        if (lot && c.value) {
          const lk = `${sku.id}|${lot.toUpperCase()}`;
          lotCost.set(lk, (lotCost.get(lk) ?? new Set()).add(c.value));
        }
      }
      return { r, m, sku, wh, loc, q, c, lot, d, fallback, costStatus };
    });

    return prelim.map(({ r, m, sku, wh, loc, q, c, lot, d, fallback, costStatus }): ValidatedRow<InitialStockPlan> => {
      if (!r.skipped) {
        const k = keyOf.get(r.rowNumber);
        const dups = k ? (keyIdx.get(k) ?? []).filter((n) => n !== r.rowNumber) : [];
        if (dups.length) m.push({ field: 'skuCode', level: 'error', message: `Renglón repetido (mismo SKU, almacén, ubicación y lote) con ${dups.join(', ')}. Súmalos en uno.` });
        if (sku && lot) {
          const lk = `${sku.id}|${lot.toUpperCase()}`;
          if ((lotCost.get(lk)?.size ?? 0) > 1) m.push({ field: 'cost', level: 'error', message: `El lote ${lot} trae costos distintos en el archivo.` });
          const inDb = lotDb.get(lk);
          if (inDb && c.value && Math.abs(Number(inDb) - Number(c.value)) > 0.00005)
            m.push({ field: 'lot', level: 'error', message: `El lote ${lot} ya existe con costo ${Number(inDb).toFixed(2)}.` });
          else if (inDb) m.push({ field: 'lot', level: 'info', message: `El lote ${lot} ya existe; las piezas se suman a ese lote.` });
        }
        if (sku && wh && q.value) {
          const has = onHand.get(`${sku.id}|${wh.id}`);
          if (has) m.push({ field: 'qty', level: 'warning', message: `${sku.skuCode} ya tiene ${has} pzas en ${wh.code}; estas se sumarán.` });
        }
        if (q.ok && q.value === 0) m.push({ field: 'qty', level: 'info', message: 'Cantidad 0: el renglón no mueve inventario.' });
      }
      const hasError = m.some((x) => x.level === 'error');
      if (hasError || !sku || !wh || !q.ok) return { rowNumber: r.rowNumber, messages: m, action: null, plan: null };
      const cost = c.value ?? (fallback ? Number(fallback).toFixed(4) : null);
      return {
        rowNumber: r.rowNumber,
        messages: m,
        action: q.value === 0 ? 'SIN_CAMBIOS' : 'CREAR',
        plan: {
          skuId: sku.id,
          skuCode: sku.skuCode,
          warehouseId: wh.id,
          warehouseCode: wh.code,
          locationId: loc?.id ?? null,
          locationCode: loc?.code ?? null,
          qty: q.value ?? 0,
          unitCost: c.value,
          lotCode: lot,
          receivedAt: d.value,
          costStatus,
          label: `${q.value} pzas de ${sku.skuCode} en ${wh.code}/${loc?.code ?? 'GEN'}${cost ? ` a ${Number(cost).toFixed(2)}${costStatus === 'PROVISIONAL' ? ' (provisional)' : ''}` : ''}${lot ? ` · lote ${lot}` : ''}`,
        },
      };
    });
  },

  async apply(tx: Tx, rows, ctx) {
    let units = 0;
    const lots = new Set<string>();
    const lastCost = new Map<string, string>();
    const ordered = [...rows].sort((a, b) => a.plan.skuId.localeCompare(b.plan.skuId) || a.rowNumber - b.rowNumber);
    for (const { rowNumber, plan } of ordered) {
      if (plan.qty <= 0) continue;
      const r = await postMovement(tx, {
        type: 'INVENTARIO_INICIAL',
        masterSkuId: plan.skuId,
        warehouseId: plan.warehouseId,
        locationId: plan.locationId,
        qty: plan.qty,
        unitCost: plan.unitCost,
        lot: {
          code: plan.lotCode,
          receivedAt: plan.receivedAt ? new Date(`${plan.receivedAt}T12:00:00-06:00`) : null,
          costStatus: plan.costStatus ?? (plan.unitCost ? 'FINAL' : 'PROVISIONAL'),
        },
        document: { type: 'IMPORTACION', id: ctx.batchId, folio: ctx.batchLabel.slice(0, 80), line: rowNumber },
        userId: ctx.actor.id,
        notes: 'Inventario inicial',
        idempotencyKey: `IMP:${ctx.batchId}:${rowNumber}`,
      });
      if (!r.duplicate) {
        units += plan.qty;
        for (const l of r.lines) if (l.lotId) lots.add(l.lotId);
      }
      // El último costo FINAL del archivo (el lote más reciente) será el costo actual del SKU si aún no tenía.
      if (plan.unitCost && plan.costStatus !== 'PROVISIONAL') lastCost.set(plan.skuId, plan.unitCost);
    }
    for (const [skuId, cost] of lastCost) {
      await tx
        .update(masterSkus)
        .set({ currentCost: cost })
        .where(and(eq(masterSkus.id, skuId), isNull(masterSkus.currentCost)));
    }
    await refreshAvgCost(tx, rows.map((r) => r.plan.skuId));
    await ctx.audit.log(tx, ctx.actor, {
      action: 'INVENTARIO_INICIAL', module: 'inventario', entity: 'inventory_movements', entityId: ctx.batchId,
      summary: `Cargó inventario inicial desde ${ctx.batchLabel}: ${units} pzas en ${rows.length} renglones`,
      newValues: { units, rows: rows.length },
    });
    return { piezas: units, lotes: lots.size, movimientos: rows.filter((r) => r.plan.qty > 0).length };
  },
};
