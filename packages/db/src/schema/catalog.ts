import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, pk, tsz, updatedAt } from './_columns';
import { barcodeType, costMethod, packageType, recordStatus, skuStatus } from './enums';
import { channels } from './channels';

export const brands = pgTable(
  'brands',
  {
    id: pk(),
    name: text().notNull(),
    status: recordStatus().notNull().default('ACTIVO'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  () => [uniqueIndex('brands_name_uq').on(sql`lower(name)`)],
);

export const categories = pgTable(
  'categories',
  {
    id: pk(),
    name: text().notNull(),
    parentId: uuid().references((): AnyPgColumn => categories.id, { onDelete: 'restrict' }),
    status: recordStatus().notNull().default('ACTIVO'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('categories_child_name_uq')
      .on(t.parentId, sql`lower(name)`)
      .where(sql`parent_id IS NOT NULL`),
    uniqueIndex('categories_root_name_uq').on(sql`lower(name)`).where(sql`parent_id IS NULL`),
  ],
);

export const attributes = pgTable('attributes', {
  id: pk(),
  name: text().notNull().unique(),
});

export const attributeValues = pgTable(
  'attribute_values',
  {
    id: pk(),
    attributeId: uuid()
      .notNull()
      .references(() => attributes.id, { onDelete: 'cascade' }),
    value: text().notNull(),
  },
  (t) => [uniqueIndex('attribute_values_uq').on(t.attributeId, t.value)],
);

export const suppliers = pgTable('suppliers', {
  id: pk(),
  code: text().unique(),
  name: text().notNull(),
  legalName: text(),
  taxId: text(),
  country: text().notNull().default('MX'),
  currencyCode: text().notNull().default('MXN'),
  paymentTerms: text(),
  leadTimeDays: integer(),
  moq: integer(),
  contactName: text(),
  email: text(),
  phone: text(),
  rating: integer(),
  status: recordStatus().notNull().default('ACTIVO'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const products = pgTable(
  'products',
  {
    id: pk(),
    name: text().notNull(),
    description: text(),
    brandId: uuid().references(() => brands.id, { onDelete: 'restrict' }),
    categoryId: uuid().references(() => categories.id, { onDelete: 'restrict' }),
    status: recordStatus().notNull().default('ACTIVO'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdById: uuid(),
    updatedById: uuid(),
  },
  (t) => [
    index('products_brand_idx').on(t.brandId),
    index('products_category_idx').on(t.categoryId),
    index('products_name_trgm').using('gin', sql`name gin_trgm_ops`),
  ],
);

/** SKU maestro: entidad central del ERP. Cada variante de un producto es un SKU maestro. */
export const masterSkus = pgTable(
  'master_skus',
  {
    id: pk(),
    skuCode: text().notNull(),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    name: text().notNull(),
    description: text(),
    isKit: boolean().notNull().default(false),
    weightG: integer(),
    lengthMm: integer(),
    widthMm: integer(),
    heightMm: integer(),
    basePrice: numeric({ precision: 14, scale: 2 }),
    costMethod: costMethod().notNull().default('FIFO'),
    currentCost: numeric({ precision: 14, scale: 4 }),
    avgCost: numeric({ precision: 14, scale: 4 }),
    preferredSupplierId: uuid().references(() => suppliers.id, { onDelete: 'set null' }),
    leadTimeDays: integer(),
    safetyDays: integer(),
    minQty: integer(),
    maxQty: integer(),
    status: skuStatus().notNull().default('ACTIVO'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdById: uuid(),
    updatedById: uuid(),
  },
  (t) => [
    uniqueIndex('master_skus_code_uq').on(sql`upper(sku_code)`),
    index('master_skus_product_idx').on(t.productId),
    index('master_skus_status_idx').on(t.status),
    index('master_skus_code_trgm').using('gin', sql`sku_code gin_trgm_ops`),
    index('master_skus_name_trgm').using('gin', sql`name gin_trgm_ops`),
    check('master_skus_dims_ck', sql`coalesce(weight_g, 0) >= 0 AND coalesce(length_mm, 0) >= 0 AND coalesce(width_mm, 0) >= 0 AND coalesce(height_mm, 0) >= 0`),
    check('master_skus_minmax_ck', sql`min_qty IS NULL OR max_qty IS NULL OR min_qty <= max_qty`),
  ],
);

export const skuAttributeValues = pgTable(
  'sku_attribute_values',
  {
    masterSkuId: uuid()
      .notNull()
      .references(() => masterSkus.id, { onDelete: 'cascade' }),
    attributeId: uuid()
      .notNull()
      .references(() => attributes.id, { onDelete: 'restrict' }),
    attributeValueId: uuid()
      .notNull()
      .references(() => attributeValues.id, { onDelete: 'restrict' }),
  },
  (t) => [primaryKey({ columns: [t.masterSkuId, t.attributeId] })],
);

export const skuBarcodes = pgTable(
  'sku_barcodes',
  {
    id: pk(),
    masterSkuId: uuid()
      .notNull()
      .references(() => masterSkus.id, { onDelete: 'cascade' }),
    barcode: text().notNull().unique(),
    type: barcodeType().notNull().default('EAN13'),
    isPrimary: boolean().notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index('sku_barcodes_sku_idx').on(t.masterSkuId),
    uniqueIndex('sku_barcodes_primary_uq').on(t.masterSkuId).where(sql`is_primary`),
  ],
);

/** Componentes de un kit (bundle). Una venta del kit descuenta cada componente. */
export const kitComponents = pgTable(
  'kit_components',
  {
    kitSkuId: uuid()
      .notNull()
      .references(() => masterSkus.id, { onDelete: 'cascade' }),
    componentSkuId: uuid()
      .notNull()
      .references(() => masterSkus.id, { onDelete: 'restrict' }),
    quantity: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.kitSkuId, t.componentSkuId] }),
    check('kit_components_qty_ck', sql`quantity > 0`),
    check('kit_components_self_ck', sql`kit_sku_id <> component_sku_id`),
  ],
);

export const productImages = pgTable(
  'product_images',
  {
    id: pk(),
    masterSkuId: uuid()
      .notNull()
      .references(() => masterSkus.id, { onDelete: 'cascade' }),
    url: text().notNull(),
    alt: text(),
    position: integer().notNull().default(0),
  },
  (t) => [index('product_images_sku_idx').on(t.masterSkuId, t.position)],
);

export const priceHistory = pgTable(
  'price_history',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    masterSkuId: uuid()
      .notNull()
      .references(() => masterSkus.id, { onDelete: 'restrict' }),
    channelId: uuid().references(() => channels.id, { onDelete: 'restrict' }),
    price: numeric({ precision: 14, scale: 2 }).notNull(),
    validFrom: tsz().notNull().defaultNow(),
    source: text().notNull(),
    changedById: uuid(),
  },
  (t) => [index('price_history_sku_idx').on(t.masterSkuId, t.validFrom)],
);

export const costHistory = pgTable(
  'cost_history',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    masterSkuId: uuid()
      .notNull()
      .references(() => masterSkus.id, { onDelete: 'restrict' }),
    cost: numeric({ precision: 14, scale: 4 }).notNull(),
    validFrom: tsz().notNull().defaultNow(),
    sourceType: text().notNull(),
    sourceId: text(),
    changedById: uuid(),
  },
  (t) => [index('cost_history_sku_idx').on(t.masterSkuId, t.validFrom)],
);

/**
 * Empaques del SKU (caja master, caja interior, tarima). El código del empaque identifica la caja
 * en recepciones y envíos a FBA/FBL; `units_per_package` dice cuántas piezas trae.
 */
export const skuPackages = pgTable(
  'sku_packages',
  {
    id: pk(),
    masterSkuId: uuid()
      .notNull()
      .references(() => masterSkus.id, { onDelete: 'cascade' }),
    code: text().notNull(),
    type: packageType().notNull().default('CAJA_MASTER'),
    unitsPerPackage: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('sku_packages_code_uq').on(sql`upper(code)`),
    index('sku_packages_sku_idx').on(t.masterSkuId),
    index('sku_packages_code_trgm').using('gin', sql`code gin_trgm_ops`),
    check('sku_packages_units_ck', sql`units_per_package > 0`),
  ],
);
