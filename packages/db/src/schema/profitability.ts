import { sql } from 'drizzle-orm';
import { check, numeric, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { updatedAt } from './_columns';
import { masterSkus } from './catalog';
import { channels } from './channels';

/**
 * Supuestos del P&L de un SKU en un canal: precio de lista con IVA y, si difieren de los del canal, tarifa de
 * fulfillment (FBA/FBL) y almacenaje por pieza y porcentaje de publicidad. Los del canal viven en `channels.settings.pl`.
 */
export const skuChannelEconomics = pgTable(
  'sku_channel_economics',
  {
    masterSkuId: uuid()
      .notNull()
      .references(() => masterSkus.id, { onDelete: 'cascade' }),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    listPrice: numeric({ precision: 14, scale: 2 }),
    fulfillmentPerUnit: numeric({ precision: 14, scale: 2 }),
    storagePerUnit: numeric({ precision: 14, scale: 2 }),
    /** Publicidad (PPC) como fracción de la venta neta: 0.10 = 10%. */
    adsRate: numeric({ precision: 6, scale: 4 }),
    notes: text(),
    updatedAt: updatedAt(),
    updatedById: uuid(),
  },
  (t) => [
    primaryKey({ columns: [t.masterSkuId, t.channelId] }),
    check('sku_channel_economics_values_ck', sql`coalesce(list_price, 0) >= 0 AND coalesce(fulfillment_per_unit, 0) >= 0 AND coalesce(storage_per_unit, 0) >= 0 AND coalesce(ads_rate, 0) BETWEEN 0 AND 1`),
  ],
);
