import { Controller, Get, Query } from '@nestjs/common';
import { and, asc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { channelListings, channels, masterSkus, products, skuBarcodes, suppliers, warehouses, type Db } from '@erp/db';
import { AuthOnly } from '../auth/decorators';
import { can, CurrentActor, type Actor } from '../common/actor';
import { InjectDb } from '../common/db';
import { likePattern } from '../common/listing';

export interface SearchHit {
  id: string;
  title: string;
  subtitle?: string | null;
  href: string;
}
export interface SearchGroup {
  module: string;
  label: string;
  hits: SearchHit[];
}

const LIMIT = 8;

/**
 * Búsqueda global agrupada por módulo. Sólo devuelve los grupos que el usuario puede ver.
 * Pedidos y clientes se agregan en la entrega 4.
 */
@Controller('search')
export class SearchController {
  constructor(@InjectDb() private readonly db: Db) {}

  @Get()
  @AuthOnly()
  async search(@Query('q') raw: string | undefined, @CurrentActor() actor: Actor): Promise<SearchGroup[]> {
    const q = (raw ?? '').trim();
    if (q.length < 2) return [];
    const p = likePattern(q);
    const groups: SearchGroup[] = [];

    if (can(actor, 'productos.ver')) {
      const skus = await this.db
        .selectDistinct({ id: masterSkus.id, skuCode: masterSkus.skuCode, name: masterSkus.name, status: masterSkus.status })
        .from(masterSkus)
        .leftJoin(skuBarcodes, eq(skuBarcodes.masterSkuId, masterSkus.id))
        .where(or(ilike(masterSkus.skuCode, p), ilike(masterSkus.name, p), eq(skuBarcodes.barcode, q)))
        .orderBy(asc(masterSkus.skuCode))
        .limit(LIMIT);
      if (skus.length) {
        groups.push({
          module: 'skus',
          label: 'SKU maestros',
          hits: skus.map((s) => ({ id: s.id, title: s.skuCode, subtitle: s.name, href: `/productos/skus/${s.id}` })),
        });
      }
      const prods = await this.db
        .select({ id: products.id, name: products.name })
        .from(products)
        .where(ilike(products.name, p))
        .orderBy(asc(products.name))
        .limit(LIMIT);
      if (prods.length) {
        groups.push({
          module: 'productos',
          label: 'Productos',
          hits: prods.map((x) => ({ id: x.id, title: x.name, href: `/productos/catalogo?producto=${x.id}` })),
        });
      }
    }

    if (can(actor, 'canales.ver')) {
      const ls = await this.db
        .select({
          id: channelListings.id,
          externalId: channelListings.externalId,
          externalSku: channelListings.externalSku,
          channel: channels.name,
          skuId: masterSkus.id,
          skuCode: masterSkus.skuCode,
        })
        .from(channelListings)
        .innerJoin(channels, eq(channels.id, channelListings.channelId))
        .innerJoin(masterSkus, eq(masterSkus.id, channelListings.masterSkuId))
        .where(
          and(
            isNull(channelListings.validTo),
            or(ilike(channelListings.externalId, p), ilike(channelListings.externalSku, p), ilike(channelListings.fnsku, p)),
          ),
        )
        .orderBy(asc(channelListings.externalId))
        .limit(LIMIT);
      if (ls.length) {
        groups.push({
          module: 'publicaciones',
          label: 'Publicaciones (ASIN, artículo Liverpool, Shopify…)',
          hits: ls.map((l) => ({
            id: l.id,
            title: `${l.externalId}${l.externalSku ? ` · ${l.externalSku}` : ''}`,
            subtitle: `${l.channel} → ${l.skuCode}`,
            href: `/productos/skus/${l.skuId}?tab=publicaciones`,
          })),
        });
      }
    }

    if (can(actor, 'proveedores.ver')) {
      const sup = await this.db
        .select({ id: suppliers.id, name: suppliers.name, code: suppliers.code })
        .from(suppliers)
        .where(or(ilike(suppliers.name, p), ilike(suppliers.code, p)))
        .orderBy(asc(suppliers.name))
        .limit(LIMIT);
      if (sup.length) {
        groups.push({
          module: 'proveedores',
          label: 'Proveedores',
          hits: sup.map((s) => ({ id: s.id, title: s.name, subtitle: s.code, href: `/compras/proveedores?q=${encodeURIComponent(s.name)}` })),
        });
      }
    }

    if (can(actor, 'almacenes.ver')) {
      const wh = await this.db
        .select({ id: warehouses.id, code: warehouses.code, name: warehouses.name })
        .from(warehouses)
        .where(
          and(
            or(ilike(warehouses.code, p), ilike(warehouses.name, p)),
            actor.warehouseIds ? sql`${warehouses.id} = any(${actor.warehouseIds})` : undefined,
          ),
        )
        .limit(LIMIT);
      if (wh.length) {
        groups.push({
          module: 'almacenes',
          label: 'Almacenes',
          hits: wh.map((w) => ({ id: w.id, title: `${w.code} · ${w.name}`, href: `/almacenes/${w.id}` })),
        });
      }
    }

    return groups;
  }
}
