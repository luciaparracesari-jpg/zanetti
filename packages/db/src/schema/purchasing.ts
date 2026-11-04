import { sql } from 'drizzle-orm';
import { check, customType, date, index, integer, numeric, pgSequence, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, updatedAt } from './_columns';
import { attachmentKind, purchaseOrderStatus } from './enums';
import { masterSkus, suppliers } from './catalog';

export const purchaseOrderFolioSeq = pgSequence('purchase_order_folio_seq', { startWith: 1 });

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/**
 * Orden de compra a un proveedor (OC-000001). Los precios van en la moneda de la orden; `fxRate` es el tipo de
 * cambio que el usuario captura para costearla (si falta se usa el del contenedor).
 */
export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    id: pk(),
    folio: text().notNull().unique(),
    supplierId: uuid()
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    /** Número de orden o proforma del proveedor. */
    supplierRef: text(),
    orderDate: date({ mode: 'string' }).notNull(),
    currency: text().notNull().default('USD'),
    fxRate: numeric({ precision: 12, scale: 4 }),
    incoterm: text(),
    paymentTerms: text(),
    /** Fecha en que el proveedor termina la producción. */
    expectedDate: date({ mode: 'string' }),
    status: purchaseOrderStatus().notNull().default('BORRADOR'),
    notes: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdById: uuid(),
    updatedById: uuid(),
  },
  (t) => [
    index('purchase_orders_supplier_idx').on(t.supplierId, t.status),
    check('purchase_orders_currency_ck', sql`currency IN ('MXN', 'USD', 'CNY')`),
    check('purchase_orders_fx_ck', sql`fx_rate IS NULL OR fx_rate > 0`),
  ],
);

export const purchaseOrderItems = pgTable(
  'purchase_order_items',
  {
    id: pk(),
    poId: uuid()
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'cascade' }),
    lineNo: integer().notNull(),
    masterSkuId: uuid()
      .notNull()
      .references(() => masterSkus.id, { onDelete: 'restrict' }),
    /** Código o modelo con que el proveedor conoce el producto. */
    supplierSku: text(),
    qty: integer().notNull(),
    /** Precio unitario en la moneda de la orden (sin IVA). */
    unitPrice: numeric({ precision: 14, scale: 4 }),
    notes: text(),
  },
  (t) => [
    unique('purchase_order_items_sku_uq').on(t.poId, t.masterSkuId),
    index('purchase_order_items_sku_idx').on(t.masterSkuId),
    check('purchase_order_items_qty_ck', sql`qty > 0`),
    check('purchase_order_items_price_ck', sql`unit_price IS NULL OR unit_price >= 0`),
  ],
);

/** Pagos al proveedor (anticipo, saldo) con el tipo de cambio al que se pagaron. */
export const purchaseOrderPayments = pgTable(
  'purchase_order_payments',
  {
    id: pk(),
    poId: uuid()
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'cascade' }),
    paidAt: date({ mode: 'string' }).notNull(),
    /** En la moneda de la orden. */
    amount: numeric({ precision: 14, scale: 2 }).notNull(),
    fxRate: numeric({ precision: 12, scale: 4 }),
    reference: text(),
    notes: text(),
    createdAt: createdAt(),
    createdById: uuid(),
  },
  (t) => [
    index('purchase_order_payments_po_idx').on(t.poId, t.paidAt),
    check('purchase_order_payments_amount_ck', sql`amount > 0`),
    check('purchase_order_payments_fx_ck', sql`fx_rate IS NULL OR fx_rate > 0`),
  ],
);

/**
 * Archivos adjuntos (orden, proforma, factura, packing list, pedimento…) de una orden de compra o de un contenedor.
 * El contenido vive en la base para que el respaldo de PostgreSQL lo incluya; las consultas de listas no lo leen.
 */
export const attachments = pgTable(
  'attachments',
  {
    id: pk(),
    entityType: text().notNull(),
    entityId: uuid().notNull(),
    kind: attachmentKind().notNull().default('OTRO'),
    fileName: text().notNull(),
    mimeType: text().notNull(),
    sizeBytes: integer().notNull(),
    sha256: text().notNull(),
    data: bytea().notNull(),
    notes: text(),
    createdAt: createdAt(),
    createdById: uuid(),
  },
  (t) => [
    index('attachments_entity_idx').on(t.entityType, t.entityId),
    check('attachments_entity_ck', sql`entity_type IN ('PURCHASE_ORDER', 'CONTAINER')`),
    check('attachments_size_ck', sql`size_bytes > 0`),
  ],
);
