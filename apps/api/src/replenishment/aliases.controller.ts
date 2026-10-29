import { Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { masterSkus, salesLines, skuAliases, type Db } from '@erp/db';
import { z } from 'zod';
import { Perm } from '../auth/decorators';
import { CurrentActor, type Actor } from '../common/actor';
import { InjectDb } from '../common/db';
import { parse } from '../common/zod';
import { AuditService } from '../audit/audit.service';

/**
 * Equivalencias de códigos de los reportes a SKU maestro. Al crear una equivalencia de un solo SKU,
 * las ventas que ya se habían importado sin SKU con ese código se ligan.
 */
@Controller('sku-aliases')
export class AliasesController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Perm('productos.ver')
  list() {
    return this.db
      .select({ id: skuAliases.id, code: skuAliases.code, multiplier: skuAliases.multiplier, notes: skuAliases.notes, skuId: skuAliases.masterSkuId, skuCode: masterSkus.skuCode, skuName: masterSkus.name })
      .from(skuAliases)
      .innerJoin(masterSkus, eq(masterSkus.id, skuAliases.masterSkuId))
      .orderBy(asc(skuAliases.code));
  }

  @Post()
  @Perm('productos.editar')
  async create(@Body() body: unknown, @CurrentActor() actor: Actor) {
    const data = parse(
      z.object({
        code: z.string().trim().min(1).max(80),
        masterSkuId: z.string().uuid(),
        multiplier: z.number().int().min(1).max(100).default(1),
        notes: z.string().trim().max(300).nullish(),
      }),
      body,
    );
    return this.db.transaction(async (tx) => {
      const [sku] = await tx.select({ id: masterSkus.id, code: masterSkus.skuCode }).from(masterSkus).where(eq(masterSkus.id, data.masterSkuId));
      if (!sku) throw new NotFoundException('SKU no encontrado.');
      const [dup] = await tx.select({ id: skuAliases.id }).from(skuAliases).where(and(sql`upper(${skuAliases.code}) = ${data.code.toUpperCase()}`, eq(skuAliases.masterSkuId, sku.id)));
      if (dup) throw new ConflictException('Esa equivalencia ya existe.');
      const [a] = await tx.insert(skuAliases).values({ code: data.code, masterSkuId: sku.id, multiplier: data.multiplier, notes: data.notes ?? null, createdById: actor.id }).returning();
      const [{ n }] = (await tx.execute<{ n: number }>(sql`select count(*)::int n from sku_aliases where upper(code) = ${data.code.toUpperCase()}`)).rows;
      let linked = 0;
      if (n === 1) {
        const r = await tx
          .update(salesLines)
          .set({ masterSkuId: sku.id, qty: sql`${salesLines.qty} * ${data.multiplier}` })
          .where(and(isNull(salesLines.masterSkuId), sql`upper(${salesLines.externalCode}) = ${data.code.toUpperCase()} or upper(coalesce(${salesLines.externalSku}, '')) = ${data.code.toUpperCase()}`))
          .returning({ id: salesLines.id });
        linked = r.length;
      }
      await this.audit.log(tx, actor, {
        action: 'CREAR', module: 'productos', entity: 'sku_aliases', entityId: a.id,
        summary: `Equivalencia ${data.code} → ${data.multiplier > 1 ? `${data.multiplier} × ` : ''}${sku.code}${linked ? ` (ligó ${linked} ventas)` : ''}`,
      });
      return { ...a, linkedSales: linked };
    });
  }

  @Delete(':id')
  @Perm('productos.editar')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.db.transaction(async (tx) => {
      const [a] = await tx.delete(skuAliases).where(eq(skuAliases.id, id)).returning();
      if (!a) throw new NotFoundException('Equivalencia no encontrada.');
      await this.audit.log(tx, actor, { action: 'ELIMINAR', module: 'productos', entity: 'sku_aliases', entityId: id, summary: `Borró la equivalencia ${a.code}` });
      return { ok: true };
    });
  }
}
