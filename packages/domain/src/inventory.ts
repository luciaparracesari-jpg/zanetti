import { and, asc, eq, isNull, like, lt, sql } from 'drizzle-orm';
import {
  type DbOrTx,
  inventoryBalances,
  inventoryLots,
  inventoryMovements,
  masterSkus,
  movementType,
  systemParameters,
  warehouseLocations,
  warehouses,
} from '@erp/db';
import { InventoryError } from './errors';
import { nextFolio } from './folio';
import { fix4, toNum } from './numbers';

export type MovementType = (typeof movementType.enumValues)[number];

/** Tipos que sólo suman, sólo restan, o ambos (el signo de qty decide). */
const IN_TYPES = new Set<MovementType>([
  'INVENTARIO_INICIAL',
  'ENTRADA_COMPRA',
  'ENTRADA_IMPORTACION',
  'DEVOLUCION_CLIENTE',
  'AJUSTE_ENTRADA',
  'TRANSFER_ENTRADA',
  'DESARMADO_KIT',
]);
const OUT_TYPES = new Set<MovementType>(['SALIDA_VENTA', 'DEVOLUCION_PROVEEDOR', 'AJUSTE_SALIDA', 'TRANSFER_SALIDA', 'ARMADO_KIT']);
const SIGNED_TYPES = new Set<MovementType>(['CONTEO_AJUSTE']);

/** Ubicaciones cuyo stock no se vende ni se envía; sólo salen si se pide la ubicación explícitamente. */
export const BLOCKED_LOCATION_TYPES = ['CUARENTENA', 'MERMA'] as const;

export interface DocumentRef {
  /** AJUSTE, TRANSFERENCIA, CONTEO, IMPORTACION, REUBICACION, PEDIDO… */
  type: string;
  id: string;
  folio?: string | null;
  line?: number | null;
}

export interface MovementInput {
  type: MovementType;
  masterSkuId: string;
  warehouseId: string;
  /** Entrada: dónde se guarda (por omisión GEN). Salida: de dónde sale (por omisión FIFO en ubicaciones vendibles). */
  locationId?: string | null;
  /** Entrada: lote existente (transferencias). Salida: lote específico en lugar de FIFO. */
  lotId?: string | null;
  /** Con signo: positivo entra, negativo sale. */
  qty: number;
  /** Costo unitario sin IVA de una entrada que crea lote. Si falta se usa el promedio del SKU (costo provisional). */
  unitCost?: string | number | null;
  /** Datos del lote nuevo de una entrada. */
  lot?: { code?: string | null; receivedAt?: Date | null; supplierId?: string | null; costStatus?: 'PROVISIONAL' | 'FINAL' };
  document: DocumentRef;
  channelId?: string | null;
  userId?: string | null;
  notes?: string | null;
  occurredAt?: Date;
  /** Si ya existe un movimiento con esta llave, no se repite (reintentos, conectores). */
  idempotencyKey?: string | null;
  /** Usuario Administrador que autoriza que la salida deje la existencia en negativo. */
  negativeAuthorizedById?: string | null;
  reversalOfId?: number | null;
}

export interface PostedLine {
  movementId: number;
  locationId: string;
  lotId: string | null;
  qty: number;
  unitCost: string;
  totalCost: string;
}

export interface PostResult {
  duplicate: boolean;
  lines: PostedLine[];
  /** Suma con signo de qty × costo. */
  totalCost: string;
  /** Piezas que quedaron en negativo (faltante autorizado). */
  shortage: number;
}

interface SkuCtx {
  id: string;
  skuCode: string;
  isKit: boolean;
  avgCost: string | null;
  currentCost: string | null;
}
interface WhCtx {
  id: string;
  code: string;
  status: string;
  allowNegative: boolean;
}

/** Serializa los movimientos de un SKU en un almacén hasta que termine la transacción. */
export async function lockSkuWarehouse(tx: DbOrTx, masterSkuId: string, warehouseId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${masterSkuId}::text || ':' || ${warehouseId}::text, 0))`);
}

async function loadSku(tx: DbOrTx, id: string): Promise<SkuCtx> {
  const [s] = await tx
    .select({
      id: masterSkus.id,
      skuCode: masterSkus.skuCode,
      isKit: masterSkus.isKit,
      avgCost: masterSkus.avgCost,
      currentCost: masterSkus.currentCost,
    })
    .from(masterSkus)
    .where(eq(masterSkus.id, id));
  if (!s) throw new InventoryError('SKU_NO_ENCONTRADO', 'El SKU no existe.');
  if (s.isKit)
    throw new InventoryError(
      'SKU_ES_KIT',
      `${s.skuCode} es un kit: su existencia se calcula con sus componentes. Mueve los componentes.`,
      { skuCode: s.skuCode },
    );
  return s;
}

async function loadWarehouse(tx: DbOrTx, id: string): Promise<WhCtx> {
  const [w] = await tx
    .select({ id: warehouses.id, code: warehouses.code, status: warehouses.status, allowNegative: warehouses.allowNegative })
    .from(warehouses)
    .where(eq(warehouses.id, id));
  if (!w) throw new InventoryError('ALMACEN_NO_ENCONTRADO', 'El almacén no existe.');
  if (w.status !== 'ACTIVO') throw new InventoryError('ALMACEN_INACTIVO', `El almacén ${w.code} está inactivo.`);
  return w;
}

async function loadLocation(tx: DbOrTx, warehouseId: string, locationId: string) {
  const [l] = await tx
    .select({ id: warehouseLocations.id, code: warehouseLocations.code, type: warehouseLocations.type, status: warehouseLocations.status })
    .from(warehouseLocations)
    .where(and(eq(warehouseLocations.id, locationId), eq(warehouseLocations.warehouseId, warehouseId)));
  if (!l) throw new InventoryError('UBICACION_INVALIDA', 'La ubicación no pertenece al almacén.');
  return l;
}

/** Ubicación por omisión para entradas: GEN, si no la primera de almacenaje, si no la primera activa. */
export async function defaultLocationId(tx: DbOrTx, warehouseId: string): Promise<string> {
  const rows = await tx
    .select({ id: warehouseLocations.id, code: warehouseLocations.code, type: warehouseLocations.type })
    .from(warehouseLocations)
    .where(and(eq(warehouseLocations.warehouseId, warehouseId), eq(warehouseLocations.status, 'ACTIVO')))
    .orderBy(asc(warehouseLocations.code));
  const pick =
    rows.find((r) => r.code.toUpperCase() === 'GEN') ?? rows.find((r) => r.type === 'ALMACENAJE') ?? rows.find((r) => !BLOCKED_LOCATION_TYPES.includes(r.type as never));
  if (!pick) throw new InventoryError('UBICACION_INVALIDA', 'El almacén no tiene ubicaciones activas. Da de alta al menos una (GEN).');
  return pick.id;
}

/** Parámetro global inventario.permitir_negativos. */
export async function negativesAllowedGlobally(tx: DbOrTx): Promise<boolean> {
  const [p] = await tx.select({ value: systemParameters.value }).from(systemParameters).where(eq(systemParameters.key, 'inventario.permitir_negativos'));
  return p?.value === true;
}

/** Costo para valuar salidas sin lote y entradas sin costo: promedio, si no el costo actual, si no 0. */
const fallbackCost = (s: SkuCtx): { cost: number; known: boolean } => {
  const avg = toNum(s.avgCost);
  if (avg !== null) return { cost: avg, known: true };
  const cur = toNum(s.currentCost);
  if (cur !== null) return { cost: cur, known: true };
  return { cost: 0, known: false };
};

async function addBalance(tx: DbOrTx, k: { masterSkuId: string; warehouseId: string; locationId: string; lotId: string | null }, delta: number) {
  // UPDATE y luego INSERT (no upsert): el CHECK de lote no negativo se evalúa sobre la fila propuesta
  // antes del ON CONFLICT. El candado por SKU y almacén evita la carrera entre ambos pasos.
  const updated = await tx
    .update(inventoryBalances)
    .set({ qty: sql`${inventoryBalances.qty} + ${delta}`, updatedAt: sql`now()` })
    .where(
      and(
        eq(inventoryBalances.masterSkuId, k.masterSkuId),
        eq(inventoryBalances.warehouseId, k.warehouseId),
        eq(inventoryBalances.locationId, k.locationId),
        k.lotId ? eq(inventoryBalances.lotId, k.lotId) : isNull(inventoryBalances.lotId),
      ),
    )
    .returning({ id: inventoryBalances.id });
  if (updated.length === 0) await tx.insert(inventoryBalances).values({ ...k, qty: delta });
}

interface Row {
  type: MovementType;
  locationId: string;
  lotId: string | null;
  qty: number;
  unitCost: number;
}

async function insertMovements(tx: DbOrTx, input: MovementInput, rows: Row[], occurredAt: Date): Promise<PostedLine[]> {
  if (rows.length === 0) return [];
  const values = rows.map((r, i) => ({
    occurredAt,
    type: r.type,
    masterSkuId: input.masterSkuId,
    warehouseId: input.warehouseId,
    locationId: r.locationId,
    lotId: r.lotId,
    qty: r.qty,
    unitCost: fix4(r.unitCost),
    totalCost: fix4(r.qty * r.unitCost),
    documentType: input.document.type,
    documentId: input.document.id,
    documentFolio: input.document.folio ?? null,
    documentLine: input.document.line ?? null,
    channelId: input.channelId ?? null,
    userId: input.userId ?? null,
    notes: input.notes ?? null,
    reversalOfId: input.reversalOfId ?? null,
    negativeAuthorizedById: r.lotId === null && r.qty < 0 ? (input.negativeAuthorizedById ?? null) : null,
    idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}#${i}` : null,
  }));
  const inserted = await tx.insert(inventoryMovements).values(values).returning({ id: inventoryMovements.id });
  return rows.map((r, i) => ({
    movementId: inserted[i].id,
    locationId: r.locationId,
    lotId: r.lotId,
    qty: r.qty,
    unitCost: fix4(r.unitCost),
    totalCost: fix4(r.qty * r.unitCost),
  }));
}

async function existingByKey(tx: DbOrTx, key: string): Promise<PostResult | null> {
  const rows = await tx
    .select({
      id: inventoryMovements.id,
      locationId: inventoryMovements.locationId,
      lotId: inventoryMovements.lotId,
      qty: inventoryMovements.qty,
      unitCost: inventoryMovements.unitCost,
      totalCost: inventoryMovements.totalCost,
    })
    .from(inventoryMovements)
    .where(like(inventoryMovements.idempotencyKey, `${key.replace(/[%_\\]/g, '\\$&')}#%`))
    .orderBy(asc(inventoryMovements.id));
  if (rows.length === 0) return null;
  const total = rows.reduce((a, r) => a + Number(r.totalCost), 0);
  return {
    duplicate: true,
    lines: rows.map((r) => ({ movementId: r.id, locationId: r.locationId, lotId: r.lotId, qty: r.qty, unitCost: r.unitCost, totalCost: r.totalCost })),
    totalCost: fix4(total),
    shortage: 0,
  };
}

/**
 * Registra un movimiento de inventario. Es la única función que escribe `inventory_balances`.
 *
 * - Entradas: crean un lote nuevo (o suman a un lote existente en transferencias). Si el almacén tenía
 *   faltante autorizado (saldo negativo sin lote), la entrada primero lo cubre.
 * - Salidas: consumen lotes en orden FIFO (fecha de entrada) en las ubicaciones vendibles, o de la
 *   ubicación / lote indicados. Nunca dejan un lote en negativo. Si no alcanza, sólo continúan cuando
 *   el almacén permite negativos, el parámetro global lo permite o un Administrador lo autoriza; el
 *   faltante queda en el saldo sin lote, valuado al costo promedio.
 * - Debe llamarse dentro de una transacción; toma un candado por SKU y almacén.
 */
export async function postMovement(tx: DbOrTx, input: MovementInput): Promise<PostResult> {
  if (!Number.isInteger(input.qty) || input.qty === 0)
    throw new InventoryError('MOVIMIENTO_INVALIDO', 'La cantidad debe ser un entero distinto de cero.');
  if (IN_TYPES.has(input.type) && input.qty < 0)
    throw new InventoryError('MOVIMIENTO_INVALIDO', `Un movimiento ${input.type} debe ser una entrada (cantidad positiva).`);
  if (OUT_TYPES.has(input.type) && input.qty > 0)
    throw new InventoryError('MOVIMIENTO_INVALIDO', `Un movimiento ${input.type} debe ser una salida (cantidad negativa).`);
  if (!IN_TYPES.has(input.type) && !OUT_TYPES.has(input.type) && !SIGNED_TYPES.has(input.type))
    throw new InventoryError('MOVIMIENTO_INVALIDO', `El tipo ${input.type} no se registra con postMovement.`);

  await lockSkuWarehouse(tx, input.masterSkuId, input.warehouseId);
  if (input.idempotencyKey) {
    const dup = await existingByKey(tx, input.idempotencyKey);
    if (dup) return dup;
  }
  const sku = await loadSku(tx, input.masterSkuId);
  const wh = await loadWarehouse(tx, input.warehouseId);
  const occurredAt = input.occurredAt ?? new Date();
  const result = input.qty > 0 ? await postIn(tx, input, sku, occurredAt) : await postOut(tx, input, sku, wh, occurredAt);
  return result;
}

async function postIn(tx: DbOrTx, input: MovementInput, sku: SkuCtx, occurredAt: Date): Promise<PostResult> {
  const locationId = input.locationId ?? (await defaultLocationId(tx, input.warehouseId));
  if (input.locationId) await loadLocation(tx, input.warehouseId, input.locationId);

  let lotId: string;
  let unitCost: number;
  if (input.lotId) {
    const [lot] = await tx
      .select({ id: inventoryLots.id, masterSkuId: inventoryLots.masterSkuId, unitCost: inventoryLots.unitCost })
      .from(inventoryLots)
      .where(eq(inventoryLots.id, input.lotId));
    if (!lot || lot.masterSkuId !== input.masterSkuId) throw new InventoryError('LOTE_INVALIDO', 'El lote no corresponde al SKU.');
    lotId = lot.id;
    unitCost = Number(lot.unitCost);
  } else {
    const given = toNum(input.unitCost ?? null);
    if (given !== null && given < 0) throw new InventoryError('MOVIMIENTO_INVALIDO', 'El costo unitario no puede ser negativo.');
    const fb = fallbackCost(sku);
    unitCost = given ?? fb.cost;
    const costStatus = input.lot?.costStatus ?? (given === null ? 'PROVISIONAL' : 'FINAL');
    const code = input.lot?.code?.trim() || (await nextFolio(tx, 'L')).replace('L-', 'L');
    const [existing] = await tx
      .select({ id: inventoryLots.id, unitCost: inventoryLots.unitCost })
      .from(inventoryLots)
      .where(and(eq(inventoryLots.masterSkuId, input.masterSkuId), sql`upper(${inventoryLots.lotCode}) = upper(${code})`));
    if (existing) {
      // El mismo lote físico repartido en varios almacenes o ubicaciones: se reutiliza si el costo coincide.
      if (Math.abs(Number(existing.unitCost) - unitCost) > 0.00005)
        throw new InventoryError('LOTE_DUPLICADO', `El lote ${code} ya existe para ${sku.skuCode} con otro costo (${existing.unitCost}).`, {
          lotCode: code,
          unitCost: existing.unitCost,
        });
      lotId = existing.id;
      await tx
        .update(inventoryLots)
        .set({ initialQty: sql`${inventoryLots.initialQty} + ${input.qty}` })
        .where(eq(inventoryLots.id, existing.id));
    } else {
      const [lot] = await tx
        .insert(inventoryLots)
        .values({
          masterSkuId: input.masterSkuId,
          lotCode: code,
          receivedAt: input.lot?.receivedAt ?? occurredAt,
          initialQty: input.qty,
          unitCost: fix4(unitCost),
          costStatus,
          sourceType: input.document.type,
          sourceId: input.document.id,
          supplierId: input.lot?.supplierId ?? null,
        })
        .returning({ id: inventoryLots.id });
      lotId = lot.id;
    }
  }

  // Primero se cubre el faltante autorizado del almacén (saldos negativos sin lote).
  const rows: Row[] = [];
  let remaining = input.qty;
  const shortages = await tx
    .select({ locationId: inventoryBalances.locationId, qty: inventoryBalances.qty })
    .from(inventoryBalances)
    .where(
      and(
        eq(inventoryBalances.masterSkuId, input.masterSkuId),
        eq(inventoryBalances.warehouseId, input.warehouseId),
        isNull(inventoryBalances.lotId),
        lt(inventoryBalances.qty, 0),
      ),
    )
    .orderBy(asc(inventoryBalances.updatedAt));
  for (const s of shortages) {
    if (remaining === 0) break;
    const take = Math.min(-s.qty, remaining);
    rows.push({ type: input.type, locationId: s.locationId, lotId: null, qty: take, unitCost });
    await addBalance(tx, { masterSkuId: input.masterSkuId, warehouseId: input.warehouseId, locationId: s.locationId, lotId: null }, take);
    remaining -= take;
  }
  if (remaining > 0) {
    rows.push({ type: input.type, locationId, lotId, qty: remaining, unitCost });
    await addBalance(tx, { masterSkuId: input.masterSkuId, warehouseId: input.warehouseId, locationId, lotId }, remaining);
  }
  const lines = await insertMovements(tx, input, rows, occurredAt);
  return { duplicate: false, lines, totalCost: fix4(rows.reduce((a, r) => a + r.qty * r.unitCost, 0)), shortage: 0 };
}

async function postOut(tx: DbOrTx, input: MovementInput, sku: SkuCtx, wh: WhCtx, occurredAt: Date): Promise<PostResult> {
  const need = -input.qty;
  if (input.locationId) await loadLocation(tx, input.warehouseId, input.locationId);

  // Saldos elegibles: la ubicación pedida, o todas las vendibles del almacén.
  const scope = [
    eq(inventoryBalances.masterSkuId, input.masterSkuId),
    eq(inventoryBalances.warehouseId, input.warehouseId),
    input.locationId
      ? eq(inventoryBalances.locationId, input.locationId)
      : sql`${warehouseLocations.type} NOT IN ('CUARENTENA', 'MERMA')`,
  ];
  const balances = await tx
    .select({
      locationId: inventoryBalances.locationId,
      lotId: inventoryBalances.lotId,
      qty: inventoryBalances.qty,
      unitCost: inventoryLots.unitCost,
      locationCode: warehouseLocations.code,
    })
    .from(inventoryBalances)
    .innerJoin(warehouseLocations, eq(warehouseLocations.id, inventoryBalances.locationId))
    .leftJoin(inventoryLots, eq(inventoryLots.id, inventoryBalances.lotId))
    .where(and(...scope))
    .orderBy(asc(inventoryLots.receivedAt), asc(inventoryLots.createdAt), asc(inventoryLots.id), asc(warehouseLocations.code));

  const lots = balances.filter((b) => b.lotId !== null && b.qty > 0 && (!input.lotId || b.lotId === input.lotId));
  if (input.lotId && lots.length === 0 && balances.every((b) => b.lotId !== input.lotId))
    throw new InventoryError('LOTE_INVALIDO', 'El lote indicado no tiene existencia en ese almacén o ubicación.');
  const fromLots = lots.reduce((a, b) => a + b.qty, 0);
  const pendingShortage = balances.filter((b) => b.lotId === null).reduce((a, b) => a + b.qty, 0); // ≤ 0
  const net = input.lotId ? fromLots : fromLots + pendingShortage;

  let shortage = 0;
  if (net < need) {
    const allowed = wh.allowNegative || (await negativesAllowedGlobally(tx)) || Boolean(input.negativeAuthorizedById);
    if (!allowed)
      throw new InventoryError(
        'STOCK_INSUFICIENTE',
        `Existencia insuficiente de ${sku.skuCode} en ${wh.code}: hay ${Math.max(net, 0)} y se requieren ${need}.`,
        { skuCode: sku.skuCode, warehouse: wh.code, available: Math.max(net, 0), requested: need },
      );
    shortage = need - Math.max(net, 0);
  }

  const rows: Row[] = [];
  let remaining = need;
  for (const b of lots) {
    if (remaining === 0) break;
    const take = Math.min(b.qty, remaining);
    rows.push({ type: input.type, locationId: b.locationId, lotId: b.lotId, qty: -take, unitCost: Number(b.unitCost) });
    await addBalance(tx, { masterSkuId: input.masterSkuId, warehouseId: input.warehouseId, locationId: b.locationId, lotId: b.lotId }, -take);
    remaining -= take;
  }
  if (remaining > 0) {
    // Faltante autorizado: saldo sin lote, valuado al costo promedio del SKU.
    const locationId = input.locationId ?? (await defaultLocationId(tx, input.warehouseId));
    const cost = fallbackCost(sku).cost;
    rows.push({ type: input.type, locationId, lotId: null, qty: -remaining, unitCost: cost });
    await addBalance(tx, { masterSkuId: input.masterSkuId, warehouseId: input.warehouseId, locationId, lotId: null }, -remaining);
  }
  const lines = await insertMovements(tx, input, rows, occurredAt);
  return { duplicate: false, lines, totalCost: fix4(rows.reduce((a, r) => a + r.qty * r.unitCost, 0)), shortage };
}

export interface RelocateInput {
  masterSkuId: string;
  warehouseId: string;
  fromLocationId: string;
  toLocationId: string;
  qty: number;
  lotId?: string | null;
  document: DocumentRef;
  userId?: string | null;
  notes?: string | null;
  idempotencyKey?: string | null;
}

/**
 * Reubicación dentro del mismo almacén (p. ej. de recepción a GEN, o a cuarentena).
 * Conserva lote y costo; nunca deja la ubicación de origen en negativo.
 */
export async function relocate(tx: DbOrTx, input: RelocateInput): Promise<PostResult> {
  if (!Number.isInteger(input.qty) || input.qty <= 0) throw new InventoryError('MOVIMIENTO_INVALIDO', 'La cantidad debe ser un entero positivo.');
  if (input.fromLocationId === input.toLocationId) throw new InventoryError('MOVIMIENTO_INVALIDO', 'La ubicación de origen y destino son la misma.');
  await lockSkuWarehouse(tx, input.masterSkuId, input.warehouseId);
  if (input.idempotencyKey) {
    const dup = await existingByKey(tx, input.idempotencyKey);
    if (dup) return dup;
  }
  const sku = await loadSku(tx, input.masterSkuId);
  const wh = await loadWarehouse(tx, input.warehouseId);
  await loadLocation(tx, input.warehouseId, input.fromLocationId);
  await loadLocation(tx, input.warehouseId, input.toLocationId);

  const lots = await tx
    .select({ lotId: inventoryBalances.lotId, qty: inventoryBalances.qty, unitCost: inventoryLots.unitCost })
    .from(inventoryBalances)
    .innerJoin(inventoryLots, eq(inventoryLots.id, inventoryBalances.lotId))
    .where(
      and(
        eq(inventoryBalances.masterSkuId, input.masterSkuId),
        eq(inventoryBalances.warehouseId, input.warehouseId),
        eq(inventoryBalances.locationId, input.fromLocationId),
        sql`${inventoryBalances.qty} > 0`,
        input.lotId ? eq(inventoryBalances.lotId, input.lotId) : sql`true`,
      ),
    )
    .orderBy(asc(inventoryLots.receivedAt), asc(inventoryLots.createdAt), asc(inventoryLots.id));
  const available = lots.reduce((a, l) => a + l.qty, 0);
  if (available < input.qty)
    throw new InventoryError(
      'STOCK_INSUFICIENTE',
      `En la ubicación de origen hay ${available} piezas de ${sku.skuCode}; no se pueden reubicar ${input.qty}.`,
      { skuCode: sku.skuCode, warehouse: wh.code, available, requested: input.qty },
    );
  const rows: Row[] = [];
  let remaining = input.qty;
  for (const l of lots) {
    if (remaining === 0) break;
    const take = Math.min(l.qty, remaining);
    const cost = Number(l.unitCost);
    rows.push({ type: 'REUBICACION', locationId: input.fromLocationId, lotId: l.lotId, qty: -take, unitCost: cost });
    rows.push({ type: 'REUBICACION', locationId: input.toLocationId, lotId: l.lotId, qty: take, unitCost: cost });
    await addBalance(tx, { masterSkuId: input.masterSkuId, warehouseId: input.warehouseId, locationId: input.fromLocationId, lotId: l.lotId }, -take);
    await addBalance(tx, { masterSkuId: input.masterSkuId, warehouseId: input.warehouseId, locationId: input.toLocationId, lotId: l.lotId }, take);
    remaining -= take;
  }
  const lines = await insertMovements(
    tx,
    { type: 'REUBICACION', masterSkuId: input.masterSkuId, warehouseId: input.warehouseId, qty: input.qty, document: input.document, userId: input.userId, notes: input.notes, idempotencyKey: input.idempotencyKey },
    rows,
    new Date(),
  );
  return { duplicate: false, lines, totalCost: '0.0000', shortage: 0 };
}

/**
 * Recalcula el costo promedio del SKU con los lotes que tienen existencia (todas las ubicaciones y almacenes).
 * Si ya no hay existencia, conserva el último promedio.
 */
export async function refreshAvgCost(tx: DbOrTx, masterSkuIds: string[]): Promise<void> {
  const ids = [...new Set(masterSkuIds)];
  if (ids.length === 0) return;
  await tx.execute(sql`
    UPDATE master_skus s
       SET avg_cost = round(x.avg, 4), updated_at = now()
      FROM (
        SELECT b.master_sku_id, sum(b.qty * l.unit_cost) / sum(b.qty) AS avg
          FROM inventory_balances b
          JOIN inventory_lots l ON l.id = b.lot_id
         WHERE b.qty > 0 AND b.master_sku_id IN (${sql.join(
           ids.map((id) => sql`${id}::uuid`),
           sql`, `,
         )})
         GROUP BY b.master_sku_id
      ) x
     WHERE s.id = x.master_sku_id AND s.avg_cost IS DISTINCT FROM round(x.avg, 4)`);
}

/** Existencia física de un SKU en un almacén por ubicación (para conteos y validaciones). */
export async function onHandByLocation(tx: DbOrTx, masterSkuId: string, warehouseId: string) {
  return tx
    .select({ locationId: inventoryBalances.locationId, qty: sql<number>`sum(${inventoryBalances.qty})::int` })
    .from(inventoryBalances)
    .where(and(eq(inventoryBalances.masterSkuId, masterSkuId), eq(inventoryBalances.warehouseId, warehouseId)))
    .groupBy(inventoryBalances.locationId);
}

