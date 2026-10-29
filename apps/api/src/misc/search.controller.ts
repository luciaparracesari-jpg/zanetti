import { Controller, Get, Query } from '@nestjs/common';
import { and, asc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import {
  channelListings,
  channels,
  inventoryAdjustments,
  inventoryCounts,
  masterSkus,
  products,
  skuBarcodes,
  skuPackages,
  stockTransfers,
  suppliers,
  warehouses,
  type Db,
} from '@erp/db';
import { ADJUSTMENT_STATUS, COUNT_STATUS, TRANSFER_STATUS } from '@erp/shared';
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
 * Pedidos y clientes se agregan en la entrega 4. Incluye folios de transferencias, ajustes y conteos.
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
        .leftJoin(skuPackages, eq(skuPackages.masterSkuId, masterSkus.id))
        .where(or(ilike(masterSkus.skuCode, p), ilike(masterSkus.name, p), eq(skuBarcodes.barcode, q), ilike(skuPackages.code, p)))
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

    // Documentos de inventario por folio o referencia (TR-000012, AJ-000003, CF-000001, FBA15…).
    const docs: SearchHit[] = [];
    if (can(actor, 'transferencias.ver')) {
      const ts = await this.db
        .select({ id: stockTransfers.id, folio: stockTransfers.folio, reference: stockTransfers.reference, status: stockTransfers.status })
        .from(stockTransfers)
        .where(or(ilike(stockTransfers.folio, p), ilike(stockTransfers.reference, p)))
        .orderBy(sql`${stockTransfers.createdAt} desc`)
        .limit(LIMIT);
      docs.push(...ts.map((t) => ({ id: t.id, title: `Transferencia ${t.folio}`, subtitle: [TRANSFER_STATUS[t.status], t.reference].filter(Boolean).join(' · '), href: `/inventario/transferencias/${t.id}` })));
      const cs = await this.db
        .select({ id: inventoryCounts.id, folio: inventoryCounts.folio, status: inventoryCounts.status })
        .from(inventoryCounts)
        .where(ilike(inventoryCounts.folio, p))
        .limit(LIMIT);
      docs.push(...cs.map((c) => ({ id: c.id, title: `Conteo ${c.folio}`, subtitle: COUNT_STATUS[c.status], href: `/inventario/conteos/${c.id}` })));
    }
    if (can(actor, 'ajustes.ver')) {
      const as = await this.db
        .select({ id: inventoryAdjustments.id, folio: inventoryAdjustments.folio, status: inventoryAdjustments.status })
        .from(inventoryAdjustments)
        .where(ilike(inventoryAdjustments.folio, p))
        .limit(LIMIT);
      docs.push(...as.map((a) => ({ id: a.id, title: `Ajuste ${a.folio}`, subtitle: ADJUSTMENT_STATUS[a.status], href: `/inventario/ajustes/${a.id}` })));
    }
    if (docs.length) groups.push({ module: 'inventario', label: 'Documentos de inventario', hits: docs.slice(0, LIMIT) });

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
