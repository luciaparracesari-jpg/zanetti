import { and, eq, sql } from 'drizzle-orm';
import { type DbOrTx, inventoryReservations, inventoryStock, masterSkus, warehouses } from '@erp/db';
import { InventoryError } from './errors';
import { lockSkuWarehouse, negativesAllowedGlobally } from './inventory';

export type ReservationSource = (typeof inventoryReservations.sourceType.enumValues)[number];

export interface StockRow {
  onHand: number;
  blocked: number;
  reserved: number;
  committed: number;
  inTransit: number;
  available: number;
}

const ZERO: StockRow = { onHand: 0, blocked: 0, reserved: 0, committed: 0, inTransit: 0, available: 0 };

/** Existencia de un SKU en un almacén (vista inventory_stock). */
export async function stockOf(tx: DbOrTx, masterSkuId: string, warehouseId: string): Promise<StockRow> {
  const [r] = await tx
    .select({
      onHand: inventoryStock.onHand,
      blocked: inventoryStock.blocked,
      reserved: inventoryStock.reserved,
      committed: inventoryStock.committed,
      inTransit: inventoryStock.inTransit,
      available: inventoryStock.available,
    })
    .from(inventoryStock)
    .where(and(eq(inventoryStock.masterSkuId, masterSkuId), eq(inventoryStock.warehouseId, warehouseId)));
  return r ?? ZERO;
}

export interface ReserveInput {
  masterSkuId: string;
  warehouseId: string;
  qty: number;
  sourceType: ReservationSource;
  sourceId: string;
  sourceLine?: number | null;
  /** Permite reservar más de lo disponible (pedido pagado que se surtirá cuando llegue mercancía). */
  allowOversell?: boolean;
}

/** Aparta existencia disponible para un pedido o una transferencia autorizada. */
export async function reserve(tx: DbOrTx, input: ReserveInput): Promise<{ id: string; available: number }> {
  if (!Number.isInteger(input.qty) || input.qty <= 0) throw new InventoryError('MOVIMIENTO_INVALIDO', 'La cantidad a reservar debe ser un entero positivo.');
  await lockSkuWarehouse(tx, input.masterSkuId, input.warehouseId);
  const st = await stockOf(tx, input.masterSkuId, input.warehouseId);
  if (st.available < input.qty && !input.allowOversell) {
    const [wh] = await tx.select({ code: warehouses.code, allowNegative: warehouses.allowNegative }).from(warehouses).where(eq(warehouses.id, input.warehouseId));
    if (!wh?.allowNegative && !(await negativesAllowedGlobally(tx))) {
      const [s] = await tx.select({ skuCode: masterSkus.skuCode }).from(masterSkus).where(eq(masterSkus.id, input.masterSkuId));
      throw new InventoryError(
        'STOCK_INSUFICIENTE',
        `Disponible insuficiente de ${s?.skuCode ?? 'SKU'} en ${wh?.code ?? 'el almacén'}: hay ${Math.max(st.available, 0)} y se requieren ${input.qty}.`,
        { skuCode: s?.skuCode, warehouse: wh?.code, available: Math.max(st.available, 0), requested: input.qty },
      );
    }
  }
  const [row] = await tx
    .insert(inventoryReservations)
    .values({
      masterSkuId: input.masterSkuId,
      warehouseId: input.warehouseId,
      qty: input.qty,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceLine: input.sourceLine ?? null,
    })
    .returning({ id: inventoryReservations.id });
  return { id: row.id, available: st.available - input.qty };
}

/** Cierra las reservas activas de un documento: CONSUMIDA al surtir/enviar, LIBERADA al cancelar. */
export async function closeReservations(
  tx: DbOrTx,
  sourceType: ReservationSource,
  sourceId: string,
  status: 'CONSUMIDA' | 'LIBERADA',
): Promise<number> {
  const r = await tx
    .update(inventoryReservations)
    .set({ status, closedAt: sql`now()` })
    .where(
      and(
        eq(inventoryReservations.sourceType, sourceType),
        eq(inventoryReservations.sourceId, sourceId),
        eq(inventoryReservations.status, 'ACTIVA'),
      ),
    )
    .returning({ id: inventoryReservations.id });
  return r.length;
}
