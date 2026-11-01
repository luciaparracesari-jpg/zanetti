import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, numeric, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, tsz, updatedAt } from './_columns';
import { channelOrderKind, integrationProvider, integrationStatus, syncRunStatus } from './enums';
import { masterSkus } from './catalog';
import { channels, warehouses } from './channels';

/**
 * Conexión con un sistema externo (una cuenta de APLIN, una tienda de Shopify…).
 * Nunca guarda credenciales: `credentialsRef` es el prefijo de las variables de entorno del servidor
 * (p. ej. APLIN → APLIN_BASE_URL y APLIN_ORG_CODE).
 */
export const integrationConnections = pgTable(
  'integration_connections',
  {
    id: pk(),
    code: text().notNull(),
    name: text().notNull(),
    provider: integrationProvider().notNull(),
    credentialsRef: text().notNull(),
    /** Almacén del ERP que representa (APLIN). */
    warehouseId: uuid().references(() => warehouses.id, { onDelete: 'restrict' }),
    channelId: uuid().references(() => channels.id, { onDelete: 'restrict' }),
    status: integrationStatus().notNull().default('ACTIVA'),
    settings: jsonb(),
    lastSyncAt: tsz(),
    lastSyncOk: boolean(),
    lastError: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdById: uuid(),
    updatedById: uuid(),
  },
  (t) => [uniqueIndex('integration_connections_code_uq').on(sql`upper(code)`)],
);

/** Bitácora de sincronizaciones. */
export const integrationSyncRuns = pgTable(
  'integration_sync_runs',
  {
    id: pk(),
    connectionId: uuid()
      .notNull()
      .references(() => integrationConnections.id, { onDelete: 'cascade' }),
    resource: text().notNull(),
    status: syncRunStatus().notNull().default('EN_CURSO'),
    startedAt: tsz().notNull().defaultNow(),
    finishedAt: tsz(),
    stats: jsonb(),
    error: text(),
    triggeredById: uuid(),
  },
  (t) => [index('integration_sync_runs_conn_idx').on(t.connectionId, t.startedAt)],
);

/** Espejo del catálogo del sistema externo, con su existencia (sólo lectura: no mueve el inventario del ERP). */
export const channelCatalogItems = pgTable(
  'channel_catalog_items',
  {
    id: pk(),
    connectionId: uuid()
      .notNull()
      .references(() => integrationConnections.id, { onDelete: 'cascade' }),
    externalId: text().notNull(),
    externalSku: text().notNull(),
    name: text(),
    barcode: text(),
    piecesPerBox: integer(),
    masterSkuId: uuid().references(() => masterSkus.id, { onDelete: 'set null' }),
    /** Cómo se ligó al SKU maestro: SKU, EQUIVALENCIA, CODIGO_BARRAS. */
    matchedBy: text(),
    onHand: integer(),
    available: integer(),
    committed: integer(),
    booked: integer(),
    unavailable: integer(),
    syncedAt: tsz().notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('channel_catalog_items_uq').on(t.connectionId, t.externalId),
    index('channel_catalog_items_sku_idx').on(t.masterSkuId),
  ],
);

/** Órdenes del sistema externo, sin datos personales del comprador. */
export const channelOrders = pgTable(
  'channel_orders',
  {
    id: pk(),
    connectionId: uuid()
      .notNull()
      .references(() => integrationConnections.id, { onDelete: 'cascade' }),
    externalId: text().notNull(),
    orderNumber: text().notNull(),
    kind: channelOrderKind().notNull(),
    type: text(),
    status: text(),
    substatus: text(),
    source: text(),
    /** Si el operador tiene existencia para surtirla (OK / NOT OK). Nulo si no lo informa. */
    stockOk: boolean(),
    pieces: integer().notNull().default(0),
    total: numeric({ precision: 14, scale: 2 }),
    externalCreatedAt: tsz(),
    externalUpdatedAt: tsz(),
    syncedAt: tsz().notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('channel_orders_uq').on(t.connectionId, t.externalId),
    index('channel_orders_number_idx').on(t.connectionId, t.orderNumber),
    index('channel_orders_kind_idx').on(t.connectionId, t.kind, t.externalCreatedAt),
  ],
);

export const channelOrderLines = pgTable(
  'channel_order_lines',
  {
    id: pk(),
    orderId: uuid()
      .notNull()
      .references(() => channelOrders.id, { onDelete: 'cascade' }),
    externalLineId: text().notNull(),
    externalSku: text().notNull(),
    masterSkuId: uuid().references(() => masterSkus.id, { onDelete: 'set null' }),
    quantity: integer().notNull(),
    bookedQuantity: integer(),
    packedQuantity: integer(),
    price: numeric({ precision: 14, scale: 2 }),
  },
  (t) => [uniqueIndex('channel_order_lines_uq').on(t.orderId, t.externalLineId), index('channel_order_lines_sku_idx').on(t.masterSkuId)],
);
