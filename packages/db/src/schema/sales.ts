import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, numeric, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, tsz, updatedAt } from './_columns';
import { containerStatus, saleLineKind, saleSource } from './enums';
import { masterSkus, suppliers } from './catalog';
import { channelListings, channels } from './channels';
import { dataImportBatches } from './imports';

/**
 * Renglón de venta o devolución tal como lo reporta el canal (una pieza o varias del mismo SKU).
 * Es la base de la demanda para el reabasto. No mueve inventario: las existencias de FBA y FBL
 * se actualizan con los reportes o la API de cada canal.
 */
export const salesLines = pgTable(
  'sales_lines',
  {
    id: pk(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: 'restrict' }),
    /** De dónde salió según el canal: AMZ-FBA, AMZ-MFN, LIVERPOOL, SHOPIFY. */
    origin: text().notNull(),
    saleDate: date({ mode: 'string' }).notNull(),
    /** SKU maestro vendido (puede ser un kit). Nulo si el código del canal aún no está ligado. */
    masterSkuId: uuid().references(() => masterSkus.id, { onDelete: 'restrict' }),
    listingId: uuid().references(() => channelListings.id, { onDelete: 'set null' }),
    /** Código del canal: ASIN, artículo de Liverpool o SKU de Shopify. */
    externalCode: text().notNull(),
    externalSku: text(),
    orderRef: text(),
    /** Piezas con signo: positivas en ventas, negativas en devoluciones. */
    qty: integer().notNull(),
    kind: saleLineKind().notNull(),
    /** Venta neta sin IVA en MXN, si el reporte la trae. */
    amount: numeric({ precision: 14, scale: 2 }),
    source: saleSource().notNull().default('IMPORTACION'),
    /** Llave única del renglón en el reporte: evita duplicar al volver a importar. */
    sourceKey: text().notNull(),
    importBatchId: uuid().references(() => dataImportBatches.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('sales_lines_source_key_uq').on(t.sourceKey),
    index('sales_lines_sku_date_idx').on(t.masterSkuId, t.saleDate),
    index('sales_lines_channel_date_idx').on(t.channelId, t.saleDate),
    index('sales_lines_code_idx').on(t.channelId, t.externalCode),
    check('sales_lines_qty_ck', sql`qty <> 0`),
  ],
);

/** Equivalencias de códigos de los reportes a SKU maestro (p. ej. X002XDSCUD-26 → X002XDSCUD, "Bundle: 2XF13" → 2 × X002XDYF13). */
export const skuAliases = pgTable(
  'sku_aliases',
  {
    id: pk(),
    code: text().notNull(),
    masterSkuId: uuid()
      .notNull()
      .references(() => masterSkus.id, { onDelete: 'cascade' }),
    multiplier: integer().notNull().default(1),
    notes: text(),
    createdAt: createdAt(),
    createdById: uuid(),
  },
  (t) => [
    uniqueIndex('sku_aliases_uq').on(sql`upper(code)`, t.masterSkuId),
    check('sku_aliases_multiplier_ck', sql`multiplier > 0`),
  ],
);

/** Contenedor de importación (CONT-50…): mercancía pedida a proveedores que viaja junta. */
export const importContainers = pgTable(
  'import_containers',
  {
    id: pk(),
    code: text().notNull(),
    status: containerStatus().notNull().default('EN_PRODUCCION'),
    /** Salida del barco; con ella la llegada es ETD + naviera + aduana. */
    etd: date({ mode: 'string' }),
    /** Llegada a APLIN capturada a mano (tiene prioridad sobre el cálculo). */
    etaOverride: date({ mode: 'string' }),
    capacityCbm: numeric({ precision: 8, scale: 2 }),
    receivedAt: tsz(),
    notes: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdById: uuid(),
    updatedById: uuid(),
  },
  (t) => [uniqueIndex('import_containers_code_uq').on(sql`upper(code)`)],
);

export const importContainerLines = pgTable(
  'import_container_lines',
  {
    id: pk(),
    containerId: uuid()
      .notNull()
      .references(() => importContainers.id, { onDelete: 'cascade' }),
    masterSkuId: uuid()
      .notNull()
      .references(() => masterSkus.id, { onDelete: 'restrict' }),
    supplierId: uuid().references(() => suppliers.id, { onDelete: 'set null' }),
    qty: integer().notNull(),
    orderDate: date({ mode: 'string' }).notNull(),
    /** Costo unitario puesto en almacén (MXN sin IVA), si ya se conoce. */
    unitCost: numeric({ precision: 14, scale: 4 }),
    notes: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index('import_container_lines_container_idx').on(t.containerId),
    index('import_container_lines_sku_idx').on(t.masterSkuId),
    check('import_container_lines_qty_ck', sql`qty > 0`),
  ],
);

/** Ajustes del reabasto por SKU: excluirlo del pedido a China o fijar su venta diaria (p. ej. productos nuevos). */
export const replenishmentOverrides = pgTable('replenishment_overrides', {
  masterSkuId: uuid()
    .primaryKey()
    .references(() => masterSkus.id, { onDelete: 'cascade' }),
  includeInOrders: boolean().notNull().default(true),
  manualDailyDemand: numeric({ precision: 10, scale: 3 }),
  notes: text(),
  updatedAt: updatedAt(),
  updatedById: uuid(),
});
