import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { and, asc, desc, eq, ilike, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { channelListings, channels, masterSkus, unmappedCodes, warehouses, type Db, type DbOrTx } from '@erp/db';
import { listingSchema, listingUpdateSchema, mapUnmappedSchema } from '@erp/shared';
import { Perm } from '../auth/decorators';
import { CurrentActor, type Actor } from '../common/actor';
import { InjectDb } from '../common/db';
import { diff } from '../common/diff';
import { countSql, likePattern, orderFrom, readListQuery, str } from '../common/listing';
import { parse } from '../common/zod';
import { AuditService } from '../audit/audit.service';

@Controller('listings')
export class ListingsController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Perm('canales.ver')
  async list(@Query() query: Record<string, unknown>, @CurrentActor() actor: Actor) {
    const lq = readListQuery(query, actor, 'canales');
    const conds: SQL[] = [];
    if (lq.q) {
      const p = likePattern(lq.q);
      conds.push(
        or(
          ilike(channelListings.externalId, p),
          ilike(channelListings.externalSku, p),
          ilike(channelListings.fnsku, p),
          ilike(channelListings.title, p),
          ilike(masterSkus.skuCode, p),
          ilike(masterSkus.name, p),
        )!,
      );
    }
    const channelId = str(query.channelId);
    if (channelId) conds.push(eq(channelListings.channelId, channelId));
    const status = str(query.status);
    if (status) conds.push(eq(channelListings.status, status as 'ACTIVA'));
    const fm = str(query.fulfillmentModel);
    if (fm) conds.push(eq(channelListings.fulfillmentModel, fm as 'BODEGA_PROPIA'));
    const masterSkuId = str(query.masterSkuId);
    if (masterSkuId) conds.push(eq(channelListings.masterSkuId, masterSkuId));
    // Por defecto sólo publicaciones vigentes; ?vigencia=historicas o todas.
    const vigencia = str(query.vigencia) ?? 'vigentes';
    if (vigencia === 'vigentes') conds.push(isNull(channelListings.validTo));
    if (vigencia === 'historicas') conds.push(isNotNull(channelListings.validTo));
    const where = conds.length ? and(...conds) : undefined;

    const [{ total }] = await this.db
      .select({ total: countSql })
      .from(channelListings)
      .innerJoin(masterSkus, eq(masterSkus.id, channelListings.masterSkuId))
      .where(where);
    const items = await this.db
      .select({
        id: channelListings.id,
        channelId: channelListings.channelId,
        channelCode: channels.code,
        channelName: channels.name,
        masterSkuId: channelListings.masterSkuId,
        skuCode: masterSkus.skuCode,
        skuName: masterSkus.name,
        externalId: channelListings.externalId,
        externalSku: channelListings.externalSku,
        fnsku: channelListings.fnsku,
        unitsPerListing: channelListings.unitsPerListing,
        title: channelListings.title,
        price: channelListings.price,
        fulfillmentModel: channelListings.fulfillmentModel,
        fulfillmentWarehouseId: channelListings.fulfillmentWarehouseId,
        warehouseCode: warehouses.code,
        status: channelListings.status,
        validFrom: channelListings.validFrom,
        validTo: channelListings.validTo,
        updatedAt: channelListings.updatedAt,
      })
      .from(channelListings)
      .innerJoin(masterSkus, eq(masterSkus.id, channelListings.masterSkuId))
      .innerJoin(channels, eq(channels.id, channelListings.channelId))
      .leftJoin(warehouses, eq(warehouses.id, channelListings.fulfillmentWarehouseId))
      .where(where)
      .orderBy(
        ...orderFrom(
          lq.sort,
          {
            channelName: channels.name,
            externalId: channelListings.externalId,
            externalSku: channelListings.externalSku,
            skuCode: masterSkus.skuCode,
            price: channelListings.price,
            status: channelListings.status,
            updatedAt: channelListings.updatedAt,
          },
          asc(channels.sortOrder),
        ),
        asc(channelListings.externalId),
      )
      .limit(lq.pageSize)
      .offset((lq.page - 1) * lq.pageSize);
    return { items, total, page: lq.page, pageSize: lq.pageSize };
  }

  @Post()
  @Perm('canales.crear')
  async create(@Body() body: unknown, @CurrentActor() actor: Actor) {
    const data = parse(listingSchema, body);
    return this.db.transaction(async (tx) => {
      await this.checkFulfillment(tx, data.channelId, data.fulfillmentModel, data.fulfillmentWarehouseId);
      const [sku] = await tx.select().from(masterSkus).where(eq(masterSkus.id, data.masterSkuId));
      if (!sku) throw new NotFoundException('SKU no encontrado.');
      const [row] = await tx.insert(channelListings).values(data).returning();
      // Si el código estaba en la cola de mapeo, se marca como resuelto.
      await tx
        .update(unmappedCodes)
        .set({ status: 'MAPEADO', resolvedListingId: row.id })
        .where(
          and(
            eq(unmappedCodes.channelId, row.channelId),
            eq(unmappedCodes.externalId, row.externalId),
            eq(unmappedCodes.externalSku, row.externalSku),
          ),
        );
      await this.audit.log(tx, actor, {
        action: 'CREAR', module: 'canales', entity: 'channel_listings', entityId: row.id,
        summary: `Ligó ${row.externalId}${row.externalSku ? ` / ${row.externalSku}` : ''} al SKU ${sku.skuCode}`,
        newValues: data,
      });
      return row;
    });
  }

  @Patch(':id')
  @Perm('canales.editar')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    const data = parse(listingUpdateSchema, body);
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(channelListings).where(eq(channelListings.id, id)).for('update');
      if (!before) throw new NotFoundException('Publicación no encontrada.');
      if (before.validTo) throw new BadRequestException('La publicación ya fue dada de baja; crea una nueva.');
      const fm = data.fulfillmentModel ?? before.fulfillmentModel;
      const whId = data.fulfillmentWarehouseId !== undefined ? data.fulfillmentWarehouseId : before.fulfillmentWarehouseId;
      await this.checkFulfillment(tx, before.channelId, fm, whId);
      const [row] = await tx.update(channelListings).set(data).where(eq(channelListings.id, id)).returning();
      const d = diff(before, row);
      if (d.newValues) {
        await this.audit.log(tx, actor, {
          action: 'EDITAR', module: 'canales', entity: 'channel_listings', entityId: id,
          summary: `Editó la publicación ${row.externalId}`, ...d,
        });
      }
      return row;
    });
  }

  /** Baja de una publicación: conserva el historial y libera el código para ligarlo a otro SKU. */
  @Post(':id/close')
  @Perm('canales.editar')
  @HttpCode(200)
  async close(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(channelListings).where(eq(channelListings.id, id)).for('update');
      if (!before) throw new NotFoundException('Publicación no encontrada.');
      if (before.validTo) return before;
      const [row] = await tx
        .update(channelListings)
        .set({ validTo: new Date(), status: 'INACTIVA' })
        .where(eq(channelListings.id, id))
        .returning();
      await this.audit.log(tx, actor, {
        action: 'BAJA', module: 'canales', entity: 'channel_listings', entityId: id,
        summary: `Dio de baja la publicación ${row.externalId}`,
        oldValues: { status: before.status, validTo: null }, newValues: { status: row.status, validTo: row.validTo },
      });
      return row;
    });
  }

  // ── Cola de códigos sin mapeo ──────────────────────────────────────

  @Get('unmapped')
  @Perm('canales.ver')
  async unmapped(@Query() query: Record<string, unknown>, @CurrentActor() actor: Actor) {
    const lq = readListQuery(query, actor, 'canales');
    const conds: SQL[] = [eq(unmappedCodes.status, (str(query.status) ?? 'PENDIENTE') as 'PENDIENTE')];
    const channelId = str(query.channelId);
    if (channelId) conds.push(eq(unmappedCodes.channelId, channelId));
    if (lq.q) {
      const p = likePattern(lq.q);
      conds.push(or(ilike(unmappedCodes.externalId, p), ilike(unmappedCodes.externalSku, p), ilike(unmappedCodes.title, p))!);
    }
    const where = and(...conds);
    const [{ total }] = await this.db.select({ total: countSql }).from(unmappedCodes).where(where);
    const items = await this.db
      .select({
        id: unmappedCodes.id,
        channelId: unmappedCodes.channelId,
        channelName: channels.name,
        externalId: unmappedCodes.externalId,
        externalSku: unmappedCodes.externalSku,
        title: unmappedCodes.title,
        occurrences: unmappedCodes.occurrences,
        firstSeenAt: unmappedCodes.firstSeenAt,
        lastSeenAt: unmappedCodes.lastSeenAt,
        status: unmappedCodes.status,
      })
      .from(unmappedCodes)
      .innerJoin(channels, eq(channels.id, unmappedCodes.channelId))
      .where(where)
      .orderBy(...orderFrom(lq.sort, { occurrences: unmappedCodes.occurrences, lastSeenAt: unmappedCodes.lastSeenAt, externalId: unmappedCodes.externalId }, desc(unmappedCodes.occurrences)))
      .limit(lq.pageSize)
      .offset((lq.page - 1) * lq.pageSize);
    return { items, total, page: lq.page, pageSize: lq.pageSize };
  }

  @Post('unmapped/:id/map')
  @Perm('canales.crear')
  async map(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    const data = parse(mapUnmappedSchema, body);
    const [code] = await this.db.select().from(unmappedCodes).where(eq(unmappedCodes.id, id));
    if (!code) throw new NotFoundException('Código no encontrado.');
    return this.create(
      {
        channelId: code.channelId,
        masterSkuId: data.masterSkuId,
        externalId: code.externalId,
        externalSku: code.externalSku,
        title: code.title,
        unitsPerListing: data.unitsPerListing,
        fulfillmentModel: data.fulfillmentModel,
        fulfillmentWarehouseId: data.fulfillmentWarehouseId,
      },
      actor,
    );
  }

  @Post('unmapped/:id/ignore')
  @Perm('canales.editar')
  @HttpCode(200)
  async ignore(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(unmappedCodes).set({ status: 'IGNORADO' }).where(eq(unmappedCodes.id, id)).returning();
      if (!row) throw new NotFoundException('Código no encontrado.');
      await this.audit.log(tx, actor, {
        action: 'IGNORAR', module: 'canales', entity: 'unmapped_codes', entityId: id,
        summary: `Marcó como ignorado el código ${row.externalId}`,
      });
      return row;
    });
  }

  /**
   * Reglas de surtido:
   * - FULFILLMENT_CANAL: el almacén es obligatorio, debe ser de tipo fulfillment y del mismo canal.
   * - BODEGA_PROPIA: el almacén es opcional y debe ser propio u operador logístico.
   */
  private async checkFulfillment(tx: DbOrTx, channelId: string, model: string, warehouseId: string | null) {
    if (!warehouseId) {
      if (model === 'FULFILLMENT_CANAL') throw new BadRequestException('Indica el almacén del canal que surte esta publicación.');
      return;
    }
    const [wh] = await tx.select().from(warehouses).where(eq(warehouses.id, warehouseId));
    if (!wh) throw new BadRequestException('Almacén no encontrado.');
    if (model === 'FULFILLMENT_CANAL' && (wh.channelId !== channelId || wh.type !== 'FULFILLMENT_CANAL')) {
      throw new BadRequestException(`El almacén ${wh.code} no es de fulfillment de este canal.`);
    }
    if (model === 'BODEGA_PROPIA' && !['PROPIO', 'OPERADOR_LOGISTICO'].includes(wh.type)) {
      throw new BadRequestException(`El almacén ${wh.code} no es una bodega propia.`);
    }
  }
}

/** Registro de códigos desconocidos desde importaciones y sincronizaciones (entregas 4 y fase 2). */
export async function registerUnmapped(
  tx: DbOrTx,
  channelId: string,
  externalId: string,
  externalSku = '',
  title?: string | null,
) {
  await tx
    .insert(unmappedCodes)
    .values({ channelId, externalId, externalSku, title: title ?? null })
    .onConflictDoUpdate({
      target: [unmappedCodes.channelId, unmappedCodes.externalId, unmappedCodes.externalSku],
      set: { occurrences: sql`${unmappedCodes.occurrences} + 1`, lastSeenAt: new Date() },
    });
}
