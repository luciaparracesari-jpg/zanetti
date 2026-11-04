import { and, eq, gt, ne, sql } from 'drizzle-orm';
import { type DbOrTx, inventoryBalances, inventoryLots, inventoryMovements, stockTransferItemLots } from '@erp/db';
import { InventoryError } from './errors';
import { type DocumentRef, lockSkuWarehouse } from './inventory';
import { fix2, fix4 } from './numbers';

export interface RevalueInput {
  lotId: string;
  /** Costo unitario nuevo (MXN sin IVA, puesto en almacén). */
  unitCost: number;
  document: DocumentRef;
  userId?: string | null;
  notes?: string | null;
}

export interface RevalueResult {
  lotId: string;
  masterSkuId: string;
  lotCode: string;
  oldCost: string;
  newCost: string;
  changed: boolean;
  /** Piezas del lote en almacenes, en camino entre almacenes y ya consumidas (vendidas, ajustadas). */
  onHand: number;
  inTransit: number;
  consumed: number;
  /** Cambio de valor del inventario (en almacenes y en camino) y diferencia de lo ya consumido (va a costo de venta). */
  deltaOnHand: string;
  deltaInTransit: string;
  deltaConsumed: string;
}

/**
 * Cambia el costo de un lote (costeo de contenedor). Las piezas que siguen en existencia se revalúan con un movimiento
 * REVALUACION_COSTO (cantidad 0, costo = diferencia) en cada almacén y ubicación, para que el kardex cuadre con el
 * valor; lo que va en camino entre almacenes toma el costo nuevo; lo ya consumido sólo se informa.
 */
export async function revalueLot(tx: DbOrTx, input: RevalueInput): Promise<RevalueResult> {
  if (!(input.unitCost >= 0)) throw new InventoryError('MOVIMIENTO_INVALIDO', 'El costo unitario no puede ser negativo.');
  const [lot] = await tx
    .select({
      id: inventoryLots.id,
      masterSkuId: inventoryLots.masterSkuId,
      lotCode: inventoryLots.lotCode,
      unitCost: inventoryLots.unitCost,
      costStatus: inventoryLots.costStatus,
      initialQty: inventoryLots.initialQty,
    })
    .from(inventoryLots)
    .where(eq(inventoryLots.id, input.lotId))
    .for('update');
  if (!lot) throw new InventoryError('LOTE_INVALIDO', 'Lote no encontrado.');

  const balances = await tx
    .select({ id: inventoryBalances.id, warehouseId: inventoryBalances.warehouseId, locationId: inventoryBalances.locationId, qty: inventoryBalances.qty })
    .from(inventoryBalances)
    .where(and(eq(inventoryBalances.lotId, lot.id), ne(inventoryBalances.qty, 0)));
  for (const wh of [...new Set(balances.map((b) => b.warehouseId))].sort()) await lockSkuWarehouse(tx, lot.masterSkuId, wh);

  const [transit] = (
    await tx.execute<{ qty: number }>(
      sql`SELECT coalesce(sum(qty - qty_received), 0)::int AS qty FROM stock_transfer_item_lots WHERE lot_id = ${lot.id} AND qty > qty_received`,
    )
  ).rows;
  const oldCost = Number(lot.unitCost);
  const newCost = Number(fix4(input.unitCost));
  const delta = newCost - oldCost;
  const onHand = balances.reduce((a, b) => a + b.qty, 0);
  const inTransit = Number(transit?.qty ?? 0);
  const consumed = Math.max(0, lot.initialQty - onHand - inTransit);
  const changed = Math.abs(delta) > 0.00005;

  if (changed || lot.costStatus !== 'FINAL')
    await tx.update(inventoryLots).set({ unitCost: fix4(newCost), costStatus: 'FINAL' }).where(eq(inventoryLots.id, lot.id));
  if (changed) {
    const now = new Date();
    for (const b of balances.filter((x) => x.qty > 0))
      await tx.insert(inventoryMovements).values({
        occurredAt: now,
        type: 'REVALUACION_COSTO',
        masterSkuId: lot.masterSkuId,
        warehouseId: b.warehouseId,
        locationId: b.locationId,
        lotId: lot.id,
        qty: 0,
        unitCost: fix4(newCost),
        totalCost: fix4(b.qty * delta),
        documentType: input.document.type,
        documentId: input.document.id,
        documentFolio: input.document.folio ?? null,
        documentLine: input.document.line ?? null,
        userId: input.userId ?? null,
        notes: input.notes ?? `Costo del lote ${lot.lotCode}: ${fix4(oldCost)} → ${fix4(newCost)} (${b.qty} pzas)`,
      });
    if (inTransit > 0)
      await tx
        .update(stockTransferItemLots)
        .set({ unitCost: fix4(newCost) })
        .where(and(eq(stockTransferItemLots.lotId, lot.id), gt(stockTransferItemLots.qty, stockTransferItemLots.qtyReceived)));
  }
  return {
    lotId: lot.id,
    masterSkuId: lot.masterSkuId,
    lotCode: lot.lotCode,
    oldCost: fix4(oldCost),
    newCost: fix4(newCost),
    changed,
    onHand,
    inTransit,
    consumed,
    deltaOnHand: fix2(changed ? Math.max(onHand, 0) * delta : 0),
    deltaInTransit: fix2(changed ? inTransit * delta : 0),
    deltaConsumed: fix2(changed ? consumed * delta : 0),
  };
}
