import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { categories, channelListings, channels, feeRules, masterSkus, unmappedCodes, warehouses, type Db } from '@erp/db';
import { channelSchema, feeRuleSchema } from '@erp/shared';
import { Perm } from '../auth/decorators';
import { CurrentActor, type Actor } from '../common/actor';
import { InjectDb } from '../common/db';
import { diff } from '../common/diff';
import { parse } from '../common/zod';
import { AuditService } from '../audit/audit.service';

@Controller()
export class ChannelsController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  @Get('channels')
  @Perm('canales.ver')
  list() {
    return this.db
      .select({
        id: channels.id,
        code: channels.code,
        name: channels.name,
        type: channels.type,
        status: channels.status,
        coverageDays: channels.coverageDays,
        sortOrder: channels.sortOrder,
        activeListings: sql<number>`(select count(*)::int from ${channelListings} l where l.channel_id = "channels"."id" and l.valid_to is null)`,
        pendingUnmapped: sql<number>`(select count(*)::int from ${unmappedCodes} u where u.channel_id = "channels"."id" and u.status = 'PENDIENTE')`,
        warehouseCount: sql<number>`(select count(*)::int from ${warehouses} w where w.channel_id = "channels"."id")`,
        currentFee: sql<string | null>`(select f.rate::text from ${feeRules} f where f.channel_id = "channels"."id" and f.fee_type = 'COMISION' and f.category_id is null and f.master_sku_id is null and f.valid_from <= (now() at time zone 'America/Mexico_City')::date and (f.valid_to is null or f.valid_to >= (now() at time zone 'America/Mexico_City')::date) limit 1)`,
      })
      .from(channels)
      .orderBy(asc(channels.sortOrder), asc(channels.name));
  }

  /** Para selectores en cualquier pantalla con sesión (pedidos, publicaciones, almacenes). */
  @Get('channels/options')
  @Perm('productos.ver')
  options() {
    return this.db
      .select({ id: channels.id, code: channels.code, name: channels.name, status: channels.status })
      .from(channels)
      .orderBy(asc(channels.sortOrder), asc(channels.name));
  }

  @Post('channels')
  @Perm('canales.crear')
  async create(@Body() body: unknown, @CurrentActor() actor: Actor) {
    const data = parse(channelSchema, body);
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(channels).values(data).returning();
      await this.audit.log(tx, actor, {
        action: 'CREAR', module: 'canales', entity: 'channels', entityId: row.id,
        summary: `Creó el canal ${row.name}`, newValues: data,
      });
      return row;
    });
  }

  @Patch('channels/:id')
  @Perm('canales.editar')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    const data = parse(channelSchema.omit({ code: true }).partial(), body);
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(channels).where(eq(channels.id, id)).for('update');
      if (!before) throw new NotFoundException('Canal no encontrado.');
      const [row] = await tx.update(channels).set(data).where(eq(channels.id, id)).returning();
      const d = diff(before, row);
      if (d.newValues) {
        await this.audit.log(tx, actor, {
          action: 'EDITAR', module: 'canales', entity: 'channels', entityId: id,
          summary: `Editó el canal ${row.name}`, ...d,
        });
      }
      return row;
    });
  }

  // ── Reglas de comisión ─────────────────────────────────────────────

  @Get('channels/:id/fee-rules')
  @Perm('canales.ver')
  feeRules(@Param('id', ParseUUIDPipe) id: string) {
    return this.db
      .select({
        id: feeRules.id,
        name: feeRules.name,
        feeType: feeRules.feeType,
        rate: feeRules.rate,
        fixedAmount: feeRules.fixedAmount,
        base: feeRules.base,
        validFrom: feeRules.validFrom,
        validTo: feeRules.validTo,
        notes: feeRules.notes,
        categoryId: feeRules.categoryId,
        categoryName: categories.name,
        masterSkuId: feeRules.masterSkuId,
        skuCode: masterSkus.skuCode,
      })
      .from(feeRules)
      .leftJoin(categories, eq(categories.id, feeRules.categoryId))
      .leftJoin(masterSkus, eq(masterSkus.id, feeRules.masterSkuId))
      .where(eq(feeRules.channelId, id))
      .orderBy(asc(feeRules.feeType), desc(feeRules.validFrom));
  }

  @Post('channels/:id/fee-rules')
  @Perm('canales.editar')
  async createFee(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    const data = parse(feeRuleSchema, body);
    return this.db.transaction(async (tx) => {
      const [ch] = await tx.select().from(channels).where(eq(channels.id, id));
      if (!ch) throw new NotFoundException('Canal no encontrado.');
      const [row] = await tx.insert(feeRules).values({ ...data, channelId: id }).returning();
      await this.audit.log(tx, actor, {
        action: 'CREAR', module: 'canales', entity: 'fee_rules', entityId: row.id,
        summary: `Agregó la regla "${row.name}" a ${ch.name} desde ${row.validFrom}`, newValues: data,
      });
      return row;
    });
  }

  @Patch('fee-rules/:id')
  @Perm('canales.editar')
  async updateFee(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(feeRules).where(eq(feeRules.id, id)).for('update');
      if (!before) throw new NotFoundException('Regla no encontrada.');
      // Se valida el registro completo para conservar las reglas cruzadas (tasa o monto, vigencias).
      const data = parse(feeRuleSchema, { ...before, ...(body as object) });
      const [row] = await tx.update(feeRules).set(data).where(eq(feeRules.id, id)).returning();
      const d = diff(before, row);
      if (d.newValues) {
        await this.audit.log(tx, actor, {
          action: 'EDITAR', module: 'canales', entity: 'fee_rules', entityId: id,
          summary: `Editó la regla "${row.name}"`, ...d,
        });
      }
      return row;
    });
  }

  @Delete('fee-rules/:id')
  @Perm('canales.eliminar')
  @HttpCode(200)
  async removeFee(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.delete(feeRules).where(eq(feeRules.id, id)).returning();
      if (!row) throw new NotFoundException('Regla no encontrada.');
      await this.audit.log(tx, actor, {
        action: 'ELIMINAR', module: 'canales', entity: 'fee_rules', entityId: id,
        summary: `Eliminó la regla "${row.name}" (${row.validFrom} a ${row.validTo ?? 'vigente'})`,
        oldValues: { rate: row.rate, validFrom: row.validFrom, validTo: row.validTo },
      });
      return { ok: true };
    });
  }
}
