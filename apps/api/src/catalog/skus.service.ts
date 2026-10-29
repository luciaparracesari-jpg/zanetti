import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import {
  brands,
  categories,
  channelListings,
  channels,
  costHistory,
  kitComponents,
  masterSkus,
  priceHistory,
  products,
  skuBarcodes,
  skuPackages,
  suppliers,
  warehouses,
  type Db,
  type DbOrTx,
} from '@erp/db';
import { barcodeSchema, kitComponentsSchema, packageSchema, skuCreateSchema, skuUpdateSchema, type ListQuery } from '@erp/shared';
import type { z } from 'zod';
import { can, type Actor } from '../common/actor';
import { InjectDb } from '../common/db';
import { diff } from '../common/diff';
import { countSql, likePattern, orderFrom } from '../common/listing';
import { AuditService } from '../audit/audit.service';

export interface SkuFilters {
  status?: string;
  productId?: string;
  brandId?: string;
  categoryId?: string;
  channelId?: string;
  isKit?: boolean;
  withoutListings?: boolean;
  withoutName?: boolean;
}

const IVA = 1.16;

/** Margen bruto sobre el precio de lista sin IVA. */
export function marginPct(basePrice: string | null, cost: string | null): number | null {
  if (!basePrice || !cost) return null;
  const net = Number(basePrice) / IVA;
  if (net <= 0) return null;
  return Math.round(((net - Number(cost)) / net) * 10000) / 100;
}

/** Quita costo y margen si el usuario no tiene el permiso de campo "costos.ver". */
export function maskCosts<T extends Record<string, unknown>>(row: T, actor: Actor): T {
  if (can(actor, 'costos.ver')) return row;
  const { currentCost: _c, avgCost: _a, marginPct: _m, ...rest } = row as Record<string, unknown>;
  return rest as T;
}

@Injectable()
export class SkusService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async list(lq: ListQuery, f: SkuFilters, actor: Actor) {
    const conds: SQL[] = [];
    if (lq.q) {
      const p = likePattern(lq.q);
      conds.push(
        or(
          ilike(masterSkus.skuCode, p),
          ilike(masterSkus.name, p),
          sql`exists (select 1 from ${skuBarcodes} b where b.master_sku_id = "master_skus"."id" and b.barcode ilike ${p})`,
          sql`exists (select 1 from ${skuPackages} k where k.master_sku_id = "master_skus"."id" and k.code ilike ${p})`,
          sql`exists (select 1 from ${channelListings} l where l.master_sku_id = "master_skus"."id" and (l.external_id ilike ${p} or l.external_sku ilike ${p} or l.fnsku ilike ${p}))`,
        )!,
      );
    }
    if (f.status) conds.push(eq(masterSkus.status, f.status as 'ACTIVO'));
    if (f.productId) conds.push(eq(masterSkus.productId, f.productId));
    if (f.brandId) conds.push(eq(products.brandId, f.brandId));
    if (f.categoryId) conds.push(eq(products.categoryId, f.categoryId));
    if (f.isKit !== undefined) conds.push(eq(masterSkus.isKit, f.isKit));
    if (f.channelId) {
      conds.push(
        sql`exists (select 1 from ${channelListings} l where l.master_sku_id = "master_skus"."id" and l.channel_id = ${f.channelId} and l.valid_to is null)`,
      );
    }
    if (f.withoutListings) {
      conds.push(
        sql`not exists (select 1 from ${channelListings} l where l.master_sku_id = "master_skus"."id" and l.valid_to is null)`,
      );
    }
    if (f.withoutName) conds.push(sql`upper(${masterSkus.name}) = upper(${masterSkus.skuCode})`);
    const where = conds.length ? and(...conds) : undefined;

    const listingCount = sql<number>`(select count(*)::int from ${channelListings} l where l.master_sku_id = "master_skus"."id" and l.valid_to is null)`;
    const primaryBarcode = sql<string | null>`(select b.barcode from ${skuBarcodes} b where b.master_sku_id = "master_skus"."id" order by b.is_primary desc, b.created_at limit 1)`;
    const channelCodes = sql<string[]>`coalesce((select array_agg(distinct c.code order by c.code) from ${channelListings} l join ${channels} c on c.id = l.channel_id where l.master_sku_id = "master_skus"."id" and l.valid_to is null), '{}')`;

    const [{ total }] = await this.db
      .select({ total: countSql })
      .from(masterSkus)
      .innerJoin(products, eq(products.id, masterSkus.productId))
      .where(where);

    const rows = await this.db
      .select({
        id: masterSkus.id,
        skuCode: masterSkus.skuCode,
        name: masterSkus.name,
        status: masterSkus.status,
        isKit: masterSkus.isKit,
        productId: masterSkus.productId,
        productName: products.name,
        brandName: brands.name,
        categoryName: categories.name,
        basePrice: masterSkus.basePrice,
        currentCost: masterSkus.currentCost,
        avgCost: masterSkus.avgCost,
        weightG: masterSkus.weightG,
        leadTimeDays: masterSkus.leadTimeDays,
        minQty: masterSkus.minQty,
        maxQty: masterSkus.maxQty,
        supplierName: suppliers.name,
        primaryBarcode,
        listingCount,
        channelCodes,
        updatedAt: masterSkus.updatedAt,
      })
      .from(masterSkus)
      .innerJoin(products, eq(products.id, masterSkus.productId))
      .leftJoin(brands, eq(brands.id, products.brandId))
      .leftJoin(categories, eq(categories.id, products.categoryId))
      .leftJoin(suppliers, eq(suppliers.id, masterSkus.preferredSupplierId))
      .where(where)
      .orderBy(
        ...orderFrom(
          lq.sort,
          {
            skuCode: masterSkus.skuCode,
            name: masterSkus.name,
            status: masterSkus.status,
            productName: products.name,
            brandName: brands.name,
            categoryName: categories.name,
            basePrice: masterSkus.basePrice,
            currentCost: masterSkus.currentCost,
            listingCount,
            updatedAt: masterSkus.updatedAt,
          },
          asc(masterSkus.skuCode),
        ),
      )
      .limit(lq.pageSize)
      .offset((lq.page - 1) * lq.pageSize);

    const items = rows.map((r) => maskCosts({ ...r, marginPct: marginPct(r.basePrice, r.currentCost) }, actor));
    return { items, total, page: lq.page, pageSize: lq.pageSize };
  }

  async options(q: string | undefined, excludeKits: boolean, onlyKits = false) {
    const conds: SQL[] = [inArray(masterSkus.status, ['ACTIVO', 'BORRADOR'])];
    if (q?.trim()) {
      const p = likePattern(q.trim());
      conds.push(or(ilike(masterSkus.skuCode, p), ilike(masterSkus.name, p))!);
    }
    if (excludeKits) conds.push(eq(masterSkus.isKit, false));
    if (onlyKits) conds.push(eq(masterSkus.isKit, true));
    return this.db
      .select({ id: masterSkus.id, skuCode: masterSkus.skuCode, name: masterSkus.name, isKit: masterSkus.isKit })
      .from(masterSkus)
      .where(and(...conds))
      .orderBy(asc(masterSkus.skuCode))
      .limit(30);
  }

  async get(id: string, actor: Actor) {
    const sku = await this.db.query.masterSkus.findFirst({
      where: eq(masterSkus.id, id),
      with: {
        product: { with: { brand: true, category: true } },
        preferredSupplier: { columns: { id: true, name: true, leadTimeDays: true } },
        barcodes: { orderBy: [desc(skuBarcodes.isPrimary), asc(skuBarcodes.createdAt)] },
        packages: { orderBy: [asc(skuPackages.unitsPerPackage)] },
        components: {
          with: { component: { columns: { id: true, skuCode: true, name: true, status: true } } },
        },
        usedInKits: { with: { kit: { columns: { id: true, skuCode: true, name: true, status: true } } } },
      },
    });
    if (!sku) throw new NotFoundException('SKU no encontrado.');

    const listings = await this.db
      .select({
        id: channelListings.id,
        channelId: channelListings.channelId,
        channelCode: channels.code,
        channelName: channels.name,
        externalId: channelListings.externalId,
        externalSku: channelListings.externalSku,
        fnsku: channelListings.fnsku,
        unitsPerListing: channelListings.unitsPerListing,
        title: channelListings.title,
        price: channelListings.price,
        fulfillmentModel: channelListings.fulfillmentModel,
        warehouseCode: warehouses.code,
        warehouseName: warehouses.name,
        status: channelListings.status,
        validFrom: channelListings.validFrom,
        validTo: channelListings.validTo,
      })
      .from(channelListings)
      .innerJoin(channels, eq(channels.id, channelListings.channelId))
      .leftJoin(warehouses, eq(warehouses.id, channelListings.fulfillmentWarehouseId))
      .where(eq(channelListings.masterSkuId, id))
      .orderBy(asc(channels.sortOrder), sql`${channelListings.validTo} nulls first`, asc(channelListings.externalId));

    const prices = await this.db
      .select()
      .from(priceHistory)
      .where(eq(priceHistory.masterSkuId, id))
      .orderBy(desc(priceHistory.validFrom))
      .limit(20);
    const costs = can(actor, 'costos.ver')
      ? await this.db.select().from(costHistory).where(eq(costHistory.masterSkuId, id)).orderBy(desc(costHistory.validFrom)).limit(20)
      : undefined;

    return maskCosts(
      { ...sku, listings, priceHistory: prices, costHistory: costs, marginPct: marginPct(sku.basePrice, sku.currentCost) },
      actor,
    );
  }

  async create(input: z.infer<typeof skuCreateSchema>, actor: Actor) {
    if (input.currentCost !== null && !can(actor, 'costos.ver')) {
      throw new ForbiddenException('No tienes permiso para capturar costos.');
    }
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(masterSkus)
        .values({ ...input, createdById: actor.id, updatedById: actor.id })
        .returning();
      if (row.basePrice) {
        await tx.insert(priceHistory).values({ masterSkuId: row.id, price: row.basePrice, source: 'ALTA_SKU', changedById: actor.id });
      }
      if (row.currentCost) {
        await tx.insert(costHistory).values({ masterSkuId: row.id, cost: row.currentCost, sourceType: 'CAPTURA_MANUAL', changedById: actor.id });
      }
      await this.audit.log(tx, actor, {
        action: 'CREAR', module: 'productos', entity: 'master_skus', entityId: row.id,
        summary: `Creó el SKU ${row.skuCode}`, newValues: input,
      });
      return row;
    });
  }

  async update(id: string, input: z.infer<typeof skuUpdateSchema>, actor: Actor) {
    if ('currentCost' in input && input.currentCost !== undefined && !can(actor, 'costos.ver')) {
      throw new ForbiddenException('No tienes permiso para modificar costos.');
    }
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(masterSkus).where(eq(masterSkus.id, id)).for('update');
      if (!before) throw new NotFoundException('SKU no encontrado.');

      if (input.isKit === false && before.isKit) {
        const [{ n }] = await tx.select({ n: countSql }).from(kitComponents).where(eq(kitComponents.kitSkuId, id));
        if (n > 0) throw new ConflictException('Quita los componentes antes de desmarcar el kit.');
      }
      if (input.isKit === true && !before.isKit) {
        const [{ n }] = await tx.select({ n: countSql }).from(kitComponents).where(eq(kitComponents.componentSkuId, id));
        if (n > 0) throw new ConflictException('Este SKU es componente de un kit; no puede ser kit a la vez.');
        // Un kit no tiene existencia propia: convertirlo con piezas en almacén las dejaría huérfanas.
        const [{ stock }] = (
          await tx.execute<{ stock: number }>(sql`SELECT coalesce(sum(abs(qty)), 0)::int AS stock FROM inventory_balances WHERE master_sku_id = ${id}::uuid`)
        ).rows;
        if (Number(stock) > 0) throw new ConflictException('El SKU tiene existencia; ajústala a 0 antes de convertirlo en kit.');
      }

      const [row] = await tx
        .update(masterSkus)
        .set({ ...input, updatedById: actor.id })
        .where(eq(masterSkus.id, id))
        .returning();

      if (input.basePrice !== undefined && row.basePrice !== before.basePrice && row.basePrice !== null) {
        await tx.insert(priceHistory).values({ masterSkuId: id, price: row.basePrice, source: 'EDICION_SKU', changedById: actor.id });
      }
      if (input.currentCost !== undefined && row.currentCost !== before.currentCost && row.currentCost !== null) {
        await tx.insert(costHistory).values({ masterSkuId: id, cost: row.currentCost, sourceType: 'CAPTURA_MANUAL', changedById: actor.id });
      }

      const d = diff(before, row);
      if (d.newValues) {
        const changed = Object.keys(d.newValues);
        const summary = changed.includes('currentCost')
          ? `Modificó costo del SKU ${row.skuCode}: ${before.currentCost ?? '—'} → ${row.currentCost ?? '—'}`
          : `Editó el SKU ${row.skuCode} (${changed.join(', ')})`;
        await this.audit.log(tx, actor, {
          action: 'EDITAR', module: 'productos', entity: 'master_skus', entityId: id, summary, ...d,
        });
      }
      return row;
    });
  }

  async addBarcode(id: string, input: z.infer<typeof barcodeSchema>, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const sku = await this.lockSku(tx, id);
      if (input.isPrimary) {
        await tx.update(skuBarcodes).set({ isPrimary: false }).where(eq(skuBarcodes.masterSkuId, id));
      }
      const [row] = await tx.insert(skuBarcodes).values({ ...input, masterSkuId: id }).returning();
      await this.audit.log(tx, actor, {
        action: 'AGREGAR_CODIGO', module: 'productos', entity: 'master_skus', entityId: id,
        summary: `Agregó el código ${row.barcode} (${row.type}) al SKU ${sku.skuCode}`,
        newValues: { barcode: row.barcode, type: row.type, isPrimary: row.isPrimary },
      });
      return row;
    });
  }

  async setPrimaryBarcode(id: string, barcodeId: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const sku = await this.lockSku(tx, id);
      const [bc] = await tx.select().from(skuBarcodes).where(and(eq(skuBarcodes.id, barcodeId), eq(skuBarcodes.masterSkuId, id)));
      if (!bc) throw new NotFoundException('Código no encontrado.');
      await tx.update(skuBarcodes).set({ isPrimary: false }).where(eq(skuBarcodes.masterSkuId, id));
      await tx.update(skuBarcodes).set({ isPrimary: true }).where(eq(skuBarcodes.id, barcodeId));
      await this.audit.log(tx, actor, {
        action: 'EDITAR', module: 'productos', entity: 'master_skus', entityId: id,
        summary: `Marcó ${bc.barcode} como código principal del SKU ${sku.skuCode}`,
      });
      return { ok: true };
    });
  }

  async removeBarcode(id: string, barcodeId: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const sku = await this.lockSku(tx, id);
      const [row] = await tx
        .delete(skuBarcodes)
        .where(and(eq(skuBarcodes.id, barcodeId), eq(skuBarcodes.masterSkuId, id)))
        .returning();
      if (!row) throw new NotFoundException('Código no encontrado.');
      await this.audit.log(tx, actor, {
        action: 'QUITAR_CODIGO', module: 'productos', entity: 'master_skus', entityId: id,
        summary: `Quitó el código ${row.barcode} del SKU ${sku.skuCode}`,
        oldValues: { barcode: row.barcode, type: row.type },
      });
      return { ok: true };
    });
  }

  async setComponents(id: string, input: z.infer<typeof kitComponentsSchema>, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const sku = await this.lockSku(tx, id);
      if (!sku.isKit) throw new ConflictException('Marca el SKU como kit antes de capturar componentes.');
      const before = await tx
        .select({ componentSkuId: kitComponents.componentSkuId, quantity: kitComponents.quantity, skuCode: masterSkus.skuCode })
        .from(kitComponents)
        .innerJoin(masterSkus, eq(masterSkus.id, kitComponents.componentSkuId))
        .where(eq(kitComponents.kitSkuId, id));
      await tx.delete(kitComponents).where(eq(kitComponents.kitSkuId, id));
      if (input.components.length) {
        await tx.insert(kitComponents).values(input.components.map((c) => ({ ...c, kitSkuId: id })));
      }
      const after = input.components.length
        ? await tx
            .select({ componentSkuId: kitComponents.componentSkuId, quantity: kitComponents.quantity, skuCode: masterSkus.skuCode })
            .from(kitComponents)
            .innerJoin(masterSkus, eq(masterSkus.id, kitComponents.componentSkuId))
            .where(eq(kitComponents.kitSkuId, id))
        : [];
      const fmt = (rows: typeof before) => Object.fromEntries(rows.map((r) => [r.skuCode, r.quantity]));
      await this.audit.log(tx, actor, {
        action: 'EDITAR_COMPONENTES', module: 'productos', entity: 'master_skus', entityId: id,
        summary: `Actualizó los componentes del kit ${sku.skuCode}`,
        oldValues: { componentes: fmt(before) }, newValues: { componentes: fmt(after) },
      });
      return after;
    });
  }

  async addPackage(id: string, input: z.infer<typeof packageSchema>, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const sku = await this.lockSku(tx, id);
      const code = input.code.toUpperCase();
      const [asSku] = await tx.select({ skuCode: masterSkus.skuCode }).from(masterSkus).where(sql`upper(${masterSkus.skuCode}) = ${code}`);
      if (asSku) throw new ConflictException(`${code} es el código de un SKU maestro.`);
      const [row] = await tx.insert(skuPackages).values({ ...input, code, masterSkuId: id }).returning();
      await this.audit.log(tx, actor, {
        action: 'AGREGAR_EMPAQUE', module: 'productos', entity: 'master_skus', entityId: id,
        summary: `Agregó la caja ${row.code} (${row.unitsPerPackage} piezas) al SKU ${sku.skuCode}`,
        newValues: { code: row.code, type: row.type, unitsPerPackage: row.unitsPerPackage },
      });
      return row;
    });
  }

  async updatePackage(id: string, packageId: string, units: number, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const sku = await this.lockSku(tx, id);
      const [before] = await tx.select().from(skuPackages).where(and(eq(skuPackages.id, packageId), eq(skuPackages.masterSkuId, id)));
      if (!before) throw new NotFoundException('Empaque no encontrado.');
      const [row] = await tx.update(skuPackages).set({ unitsPerPackage: units }).where(eq(skuPackages.id, packageId)).returning();
      if (before.unitsPerPackage !== units) {
        await this.audit.log(tx, actor, {
          action: 'EDITAR_EMPAQUE', module: 'productos', entity: 'master_skus', entityId: id,
          summary: `Cambió las piezas de la caja ${row.code} del SKU ${sku.skuCode}: ${before.unitsPerPackage} → ${units}`,
          oldValues: { unitsPerPackage: before.unitsPerPackage }, newValues: { unitsPerPackage: units },
        });
      }
      return row;
    });
  }

  async removePackage(id: string, packageId: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const sku = await this.lockSku(tx, id);
      const [row] = await tx.delete(skuPackages).where(and(eq(skuPackages.id, packageId), eq(skuPackages.masterSkuId, id))).returning();
      if (!row) throw new NotFoundException('Empaque no encontrado.');
      await this.audit.log(tx, actor, {
        action: 'QUITAR_EMPAQUE', module: 'productos', entity: 'master_skus', entityId: id,
        summary: `Quitó la caja ${row.code} del SKU ${sku.skuCode}`,
        oldValues: { code: row.code, unitsPerPackage: row.unitsPerPackage },
      });
      return { ok: true };
    });
  }

  private async lockSku(tx: DbOrTx, id: string) {
    const [sku] = await tx.select().from(masterSkus).where(eq(masterSkus.id, id)).for('update');
    if (!sku) throw new NotFoundException('SKU no encontrado.');
    return sku;
  }
}
