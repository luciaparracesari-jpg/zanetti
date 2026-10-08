import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, pk, tsz, updatedAt } from './_columns';
import {
  channelStatus,
  channelType,
  feeBase,
  feeType,
  fulfillmentModel,
  listingStatus,
  locationType,
  recordStatus,
  unmappedStatus,
  warehouseType,
} from './enums';
import { categories, masterSkus } from './catalog';

export const channels = pgTable('channels', {
  id: pk(),
  code: text().notNull().unique(),
  name: text().notNull(),
  type: channelType().notNull(),
  status: channelStatus().notNull().default('ACTIVO'),
  /** Cobertura objetivo en días para reabasto (Amazon 90, Liverpool 45). */
  coverageDays: integer(),
  settings: jsonb(),
  sortOrder: integer().notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const warehouses = pgTable(
  'warehouses',
  {
    id: pk(),
    code: text().notNull().unique(),
    name: text().notNull(),
    type: warehouseType().notNull(),
    /** Obligatorio si el almacén pertenece a un canal (Amazon FBA, Liverpool FBL, 99 Minutos). */
    channelId: uuid().references(() => channels.id, { onDelete: 'restrict' }),
    address: text(),
    city: text(),
    state: text(),
    zip: text(),
    allowNegative: boolean().notNull().default(false),
    status: recordStatus().notNull().default('ACTIVO'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  () => [
    check(
      'warehouses_channel_ck',
      sql`type NOT IN ('FULFILLMENT_CANAL', 'CONSIGNACION') OR channel_id IS NOT NULL`,
    ),
  ],
);

export const warehouseLocations = pgTable(
  'warehouse_locations',
  {
    id: pk(),
    warehouseId: uuid()
      .notNull()
      .references(() => warehouses.id, { onDelete: 'restrict' }),
    code: text().notNull(),
    name: text(),
    type: locationType().notNull().default('ALMACENAJE'),
    status: recordStatus().notNull().default('ACTIVO'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('warehouse_locations_code_uq').on(t.warehouseId, sql`upper(code)`)],
);

/** Publicación o código externo (ASIN, artículo Liverpool, variant ID…) ligado a un SKU maestro. */
export const channelListings = pgTable(
  'channel_listings',
  {
    id: pk(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: 'restrict' }),
    masterSkuId: uuid()
      .notNull()
      .references(() => masterSkus.id, { onDelete: 'restrict' }),
    externalId: text().notNull(),
    externalSku: text().notNull().default(''),
    fnsku: text(),
    unitsPerListing: integer().notNull().default(1),
    title: text(),
    price: numeric({ precision: 14, scale: 2 }),
    fulfillmentModel: fulfillmentModel().notNull().default('BODEGA_PROPIA'),
    fulfillmentWarehouseId: uuid().references(() => warehouses.id, { onDelete: 'restrict' }),
    status: listingStatus().notNull().default('ACTIVA'),
    validFrom: tsz().notNull().defaultNow(),
    validTo: tsz(),
    lastSyncedAt: tsz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Un código externo activo apunta a un solo SKU por canal.
    uniqueIndex('channel_listings_active_uq')
      .on(t.channelId, t.externalId, t.externalSku)
      .where(sql`valid_to IS NULL`),
    index('channel_listings_sku_idx').on(t.masterSkuId),
    index('channel_listings_ext_trgm').using('gin', sql`external_id gin_trgm_ops`),
    index('channel_listings_extsku_trgm').using('gin', sql`external_sku gin_trgm_ops`),
    check('channel_listings_units_ck', sql`units_per_listing > 0`),
    check('channel_listings_valid_ck', sql`valid_to IS NULL OR valid_to >= valid_from`),
  ],
);

/** Comisiones con vigencia. Ej.: Liverpool 16.43% hasta 07-abr-2026 y 19.00% desde 08-abr-2026. */
export const feeRules = pgTable(
  'fee_rules',
  {
    id: pk(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: 'restrict' }),
    categoryId: uuid().references(() => categories.id, { onDelete: 'restrict' }),
    masterSkuId: uuid().references(() => masterSkus.id, { onDelete: 'restrict' }),
    name: text().notNull(),
    feeType: feeType().notNull().default('COMISION'),
    rate: numeric({ precision: 7, scale: 4 }),
    fixedAmount: numeric({ precision: 14, scale: 2 }),
    base: feeBase().notNull().default('VENTA_CON_IVA'),
    validFrom: date({ mode: 'string' }).notNull(),
    validTo: date({ mode: 'string' }),
    notes: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('fee_rules_channel_idx').on(t.channelId, t.validFrom),
    check('fee_rules_amount_ck', sql`rate IS NOT NULL OR fixed_amount IS NOT NULL`),
    check('fee_rules_valid_ck', sql`valid_to IS NULL OR valid_to >= valid_from`),
  ],
);

/** Cola de códigos externos sin mapeo. No tocan inventario hasta mapearse. */
export const unmappedCodes = pgTable(
  'unmapped_codes',
  {
    id: pk(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: 'restrict' }),
    externalId: text().notNull(),
    externalSku: text().notNull().default(''),
    title: text(),
    firstSeenAt: tsz().notNull().defaultNow(),
    lastSeenAt: tsz().notNull().defaultNow(),
    occurrences: integer().notNull().default(1),
    status: unmappedStatus().notNull().default('PENDIENTE'),
    resolvedListingId: uuid().references(() => channelListings.id, { onDelete: 'set null' }),
  },
  (t) => [uniqueIndex('unmapped_codes_uq').on(t.channelId, t.externalId, t.externalSku)],
);
