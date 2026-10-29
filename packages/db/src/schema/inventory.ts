import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  numeric,
  pgSequence,
  pgView,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, pk, tsz, updatedAt } from './_columns';
import {
  adjustmentReason,
  adjustmentStatus,
  countStatus,
  lotCostStatus,
  movementType,
  reservationSource,
  reservationStatus,
  transferStatus,
} from './enums';
import { masterSkus, skuPackages, suppliers } from './catalog';
import { channels, warehouseLocations, warehouses } from './channels';
import { users } from './security';

// Folios de documentos (TR-000001, AJ-000001, CF-000001) y de lotes automáticos.
export const transferFolioSeq = pgSequence('transfer_folio_seq', { startWith: 1 });
export const adjustmentFolioSeq = pgSequence('adjustment_folio_seq', { startWith: 1 });
export const countFolioSeq = pgSequence('count_folio_seq', { startWith: 1 });
export const lotCodeSeq = pgSequence('lot_code_seq', { startWith: 1 });

/** Lote: unidades de un SKU que entraron juntas con el mismo costo. Base del costeo FIFO. */
export const inventoryLots = pgTable(
  'inventory_lots',
  {
    id: pk(),
    masterSkuId: uuid()
      .notNull()
      .references(() => masterSkus.id, { onDelete: 'restrict' }),
    lotCode: text().notNull(),
    receivedAt: tsz().notNull().defaultNow(),
    initialQty: integer().notNull(),
    /** Costo unitario en MXN sin IVA, puesto en almacén. */
    unitCost: numeric({ precision: 14, scale: 4 }).notNull(),
    costStatus: lotCostStatus().notNull().default('FINAL'),
    sourceType: text().notNull(),
    sourceId: text(),
    supplierId: uuid().references(() => suppliers.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('inventory_lots_code_uq').on(t.masterSkuId, sql`upper(lot_code)`),
    index('inventory_lots_fifo_idx').on(t.masterSkuId, t.receivedAt),
    check('inventory_lots_qty_ck', sql`initial_qty > 0`),
    check('inventory_lots_cost_ck', sql`unit_cost >= 0`),
  ],
);

/**
 * Existencia por SKU, almacén, ubicación y lote. Sólo la escribe postMovement() (packages/domain).
 * Un saldo sin lote (lot_id nulo) sólo aparece cuando el Administrador autoriza inventario negativo.
 */
export const inventoryBalances = pgTable(
  'inventory_balances',
  {
    id: pk(),
    masterSkuId: uuid()
      .notNull()
      .references(() => masterSkus.id, { onDelete: 'restrict' }),
    warehouseId: uuid()
      .notNull()
      .references(() => warehouses.id, { onDelete: 'restrict' }),
    locationId: uuid()
      .notNull()
      .references(() => warehouseLocations.id, { onDelete: 'restrict' }),
    lotId: uuid().references(() => inventoryLots.id, { onDelete: 'restrict' }),
    qty: integer().notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('inventory_balances_key_uq').on(t.masterSkuId, t.warehouseId, t.locationId, t.lotId).nullsNotDistinct(),
    index('inventory_balances_sku_wh_idx').on(t.masterSkuId, t.warehouseId),
    index('inventory_balances_wh_idx').on(t.warehouseId),
    index('inventory_balances_lot_idx').on(t.lotId),
    // Un lote nunca queda negativo; el faltante autorizado vive en el saldo sin lote.
    check('inventory_balances_lot_qty_ck', sql`lot_id IS NULL OR qty >= 0`),
  ],
);

/** Libro de movimientos: sólo inserción (trigger). Una corrección es un movimiento nuevo. */
export const inventoryMovements = pgTable(
  'inventory_movements',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    occurredAt: tsz().notNull().defaultNow(),
    type: movementType().notNull(),
    masterSkuId: uuid()
      .notNull()
      .references(() => masterSkus.id, { onDelete: 'restrict' }),
    warehouseId: uuid()
      .notNull()
      .references(() => warehouses.id, { onDelete: 'restrict' }),
    locationId: uuid()
      .notNull()
      .references(() => warehouseLocations.id, { onDelete: 'restrict' }),
    lotId: uuid().references(() => inventoryLots.id, { onDelete: 'restrict' }),
    /** Con signo: positivo entra, negativo sale. */
    qty: integer().notNull(),
    unitCost: numeric({ precision: 14, scale: 4 }).notNull(),
    totalCost: numeric({ precision: 16, scale: 4 }).notNull(),
    documentType: text().notNull(),
    documentId: text().notNull(),
    documentFolio: text(),
    documentLine: integer(),
    channelId: uuid().references(() => channels.id, { onDelete: 'restrict' }),
    userId: uuid().references(() => users.id, { onDelete: 'set null' }),
    notes: text(),
    reversalOfId: bigint({ mode: 'number' }),
    negativeAuthorizedById: uuid().references(() => users.id, { onDelete: 'set null' }),
    idempotencyKey: text().unique(),
  },
  (t) => [
    index('inventory_movements_sku_idx').on(t.masterSkuId, t.occurredAt, t.id),
    index('inventory_movements_wh_idx').on(t.warehouseId, t.occurredAt),
    index('inventory_movements_doc_idx').on(t.documentType, t.documentId),
    index('inventory_movements_lot_idx').on(t.lotId),
    index('inventory_movements_type_idx').on(t.type, t.occurredAt),
    check('inventory_movements_qty_ck', sql`qty <> 0 OR type = 'REVALUACION_COSTO'`),
  ],
);

/** Reservas: pedidos pagados sin surtir (entrega 4) y transferencias autorizadas sin enviar. */
export const inventoryReservations = pgTable(
  'inventory_reservations',
  {
    id: pk(),
    masterSkuId: uuid()
      .notNull()
      .references(() => masterSkus.id, { onDelete: 'restrict' }),
    warehouseId: uuid()
      .notNull()
      .references(() => warehouses.id, { onDelete: 'restrict' }),
    qty: integer().notNull(),
    sourceType: reservationSource().notNull(),
    sourceId: uuid().notNull(),
    sourceLine: integer(),
    status: reservationStatus().notNull().default('ACTIVA'),
    createdAt: createdAt(),
    closedAt: tsz(),
  },
  (t) => [
    index('inventory_reservations_active_idx').on(t.masterSkuId, t.warehouseId).where(sql`status = 'ACTIVA'`),
    index('inventory_reservations_source_idx').on(t.sourceType, t.sourceId),
    check('inventory_reservations_qty_ck', sql`qty > 0`),
  ],
);

// ───────────────────────────── Transferencias ─────────────────────────────

export const stockTransfers = pgTable(
  'stock_transfers',
  {
    id: pk(),
    folio: text().notNull().unique(),
    originWarehouseId: uuid()
      .notNull()
      .references(() => warehouses.id, { onDelete: 'restrict' }),
    destinationWarehouseId: uuid()
      .notNull()
      .references(() => warehouses.id, { onDelete: 'restrict' }),
    status: transferStatus().notNull().default('BORRADOR'),
    /** Guía, ID de envío de Amazon (FBA15…) o cita de Liverpool. */
    reference: text(),
    notes: text(),
    createdById: uuid().references(() => users.id, { onDelete: 'set null' }),
    authorizedById: uuid().references(() => users.id, { onDelete: 'set null' }),
    authorizedAt: tsz(),
    shippedById: uuid().references(() => users.id, { onDelete: 'set null' }),
    shippedAt: tsz(),
    receivedById: uuid().references(() => users.id, { onDelete: 'set null' }),
    receivedAt: tsz(),
    cancelledAt: tsz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('stock_transfers_status_idx').on(t.status, t.createdAt),
    check('stock_transfers_wh_ck', sql`origin_warehouse_id <> destination_warehouse_id`),
  ],
);

export const stockTransferItems = pgTable(
  'stock_transfer_items',
  {
    id: pk(),
    transferId: uuid()
      .notNull()
      .references(() => stockTransfers.id, { onDelete: 'cascade' }),
    lineNo: integer().notNull(),
    masterSkuId: uuid()
      .notNull()
      .references(() => masterSkus.id, { onDelete: 'restrict' }),
    qtyRequested: integer().notNull(),
    /** Si se capturó por cajas: la caja y cuántas cajas. */
    packageId: uuid().references(() => skuPackages.id, { onDelete: 'set null' }),
    packageQty: integer(),
    qtyShipped: integer(),
    qtyReceived: integer(),
    notes: text(),
  },
  (t) => [
    unique('stock_transfer_items_sku_uq').on(t.transferId, t.masterSkuId),
    check('stock_transfer_items_qty_ck', sql`qty_requested > 0 AND coalesce(qty_shipped, 0) >= 0 AND coalesce(qty_received, 0) >= 0`),
    check('stock_transfer_items_recv_ck', sql`qty_received IS NULL OR qty_received <= qty_shipped`),
  ],
);

/** Lotes que salieron en cada partida (para que entren al destino con el mismo costo). */
export const stockTransferItemLots = pgTable(
  'stock_transfer_item_lots',
  {
    id: pk(),
    itemId: uuid()
      .notNull()
      .references(() => stockTransferItems.id, { onDelete: 'cascade' }),
    lotId: uuid().references(() => inventoryLots.id, { onDelete: 'restrict' }),
    qty: integer().notNull(),
    /** Piezas de este lote ya recibidas en el destino. */
    qtyReceived: integer().notNull().default(0),
    unitCost: numeric({ precision: 14, scale: 4 }).notNull(),
  },
  (t) => [
    index('stock_transfer_item_lots_item_idx').on(t.itemId),
    check('stock_transfer_item_lots_qty_ck', sql`qty > 0 AND qty_received >= 0 AND qty_received <= qty`),
  ],
);

// ───────────────────────────── Ajustes ─────────────────────────────

export const inventoryAdjustments = pgTable(
  'inventory_adjustments',
  {
    id: pk(),
    folio: text().notNull().unique(),
    warehouseId: uuid()
      .notNull()
      .references(() => warehouses.id, { onDelete: 'restrict' }),
    reason: adjustmentReason().notNull(),
    notes: text(),
    status: adjustmentStatus().notNull().default('BORRADOR'),
    /** Valor absoluto estimado del ajuste (MXN) para decidir si requiere autorización. */
    totalValue: numeric({ precision: 16, scale: 2 }),
    createdById: uuid().references(() => users.id, { onDelete: 'set null' }),
    authorizedById: uuid().references(() => users.id, { onDelete: 'set null' }),
    authorizedAt: tsz(),
    appliedById: uuid().references(() => users.id, { onDelete: 'set null' }),
    appliedAt: tsz(),
    cancelledAt: tsz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('inventory_adjustments_status_idx').on(t.status, t.createdAt)],
);

export const inventoryAdjustmentItems = pgTable(
  'inventory_adjustment_items',
  {
    id: pk(),
    adjustmentId: uuid()
      .notNull()
      .references(() => inventoryAdjustments.id, { onDelete: 'cascade' }),
    lineNo: integer().notNull(),
    masterSkuId: uuid()
      .notNull()
      .references(() => masterSkus.id, { onDelete: 'restrict' }),
    locationId: uuid().references(() => warehouseLocations.id, { onDelete: 'restrict' }),
    /** Salida de un lote específico (opcional; si falta se aplica FIFO). */
    lotId: uuid().references(() => inventoryLots.id, { onDelete: 'restrict' }),
    /** Con signo: positivo entra, negativo sale. */
    qty: integer().notNull(),
    /** Costo de las entradas (sin IVA). Si falta se usa el costo promedio del SKU. */
    unitCost: numeric({ precision: 14, scale: 4 }),
    notes: text(),
  },
  (t) => [index('inventory_adjustment_items_adj_idx').on(t.adjustmentId), check('inventory_adjustment_items_qty_ck', sql`qty <> 0`)],
);

// ───────────────────────────── Conteos físicos ─────────────────────────────

export const inventoryCounts = pgTable('inventory_counts', {
  id: pk(),
  folio: text().notNull().unique(),
  warehouseId: uuid()
    .notNull()
    .references(() => warehouses.id, { onDelete: 'restrict' }),
  /** Ubicación contada; nula = todo el almacén. */
  locationId: uuid().references(() => warehouseLocations.id, { onDelete: 'restrict' }),
  status: countStatus().notNull().default('ABIERTO'),
  /** Conteo ciego: quien captura no ve la existencia del sistema. */
  blind: boolean().notNull().default(true),
  notes: text(),
  createdById: uuid().references(() => users.id, { onDelete: 'set null' }),
  frozenAt: tsz().notNull().defaultNow(),
  closedById: uuid().references(() => users.id, { onDelete: 'set null' }),
  closedAt: tsz(),
  createdAt: createdAt(),
});

export const inventoryCountLines = pgTable(
  'inventory_count_lines',
  {
    id: pk(),
    countId: uuid()
      .notNull()
      .references(() => inventoryCounts.id, { onDelete: 'cascade' }),
    masterSkuId: uuid()
      .notNull()
      .references(() => masterSkus.id, { onDelete: 'restrict' }),
    locationId: uuid()
      .notNull()
      .references(() => warehouseLocations.id, { onDelete: 'restrict' }),
    /** Existencia del sistema al abrir el conteo. */
    systemQty: integer().notNull(),
    countedQty: integer(),
    countedById: uuid().references(() => users.id, { onDelete: 'set null' }),
    countedAt: tsz(),
  },
  (t) => [
    unique('inventory_count_lines_uq').on(t.countId, t.masterSkuId, t.locationId),
    check('inventory_count_lines_qty_ck', sql`counted_qty IS NULL OR counted_qty >= 0`),
  ],
);

/**
 * Vista de existencias por SKU y almacén (migración 0005):
 * físico, bloqueado (cuarentena y merma), reservado, comprometido, en tránsito, disponible y valor FIFO.
 */
export const inventoryStock = pgView('inventory_stock', {
  masterSkuId: uuid('master_sku_id').notNull(),
  warehouseId: uuid('warehouse_id').notNull(),
  onHand: integer('on_hand').notNull(),
  blocked: integer('blocked').notNull(),
  reserved: integer('reserved').notNull(),
  committed: integer('committed').notNull(),
  inTransit: integer('in_transit').notNull(),
  available: integer('available').notNull(),
  value: numeric('value', { precision: 16, scale: 2 }).notNull(),
  /** Valor al costo de lo enviado hacia este almacén y aún no recibido (migración 0006). */
  inTransitValue: numeric('in_transit_value', { precision: 16, scale: 2 }).notNull(),
}).existing();
