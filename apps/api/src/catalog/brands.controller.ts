import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { and, asc, eq, ilike, sql, type SQL } from 'drizzle-orm';
import { brands, products, type Db } from '@erp/db';
import { brandSchema } from '@erp/shared';
import { Perm } from '../auth/decorators';
import { CurrentActor, type Actor } from '../common/actor';
import { InjectDb } from '../common/db';
import { diff } from '../common/diff';
import { countSql, likePattern, orderFrom, readListQuery, str } from '../common/listing';
import { parse } from '../common/zod';
import { AuditService } from '../audit/audit.service';

const productCount = sql<number>`(select count(*)::int from ${products} p where p.brand_id = "brands"."id")`;

@Controller('brands')
export class BrandsController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Perm('productos.ver')
  async list(@Query() query: Record<string, unknown>, @CurrentActor() actor: Actor) {
    const lq = readListQuery(query, actor, 'productos');
    const conds: SQL[] = [];
    if (lq.q) conds.push(ilike(brands.name, likePattern(lq.q)));
    const status = str(query.status);
    if (status) conds.push(eq(brands.status, status as 'ACTIVO'));
    const where = conds.length ? and(...conds) : undefined;
    const [{ total }] = await this.db.select({ total: countSql }).from(brands).where(where);
    const items = await this.db
      .select({ id: brands.id, name: brands.name, status: brands.status, updatedAt: brands.updatedAt, productCount })
      .from(brands)
      .where(where)
      .orderBy(...orderFrom(lq.sort, { name: brands.name, status: brands.status, updatedAt: brands.updatedAt }, asc(brands.name)))
      .limit(lq.pageSize)
      .offset((lq.page - 1) * lq.pageSize);
    return { items, total, page: lq.page, pageSize: lq.pageSize };
  }

  @Get('options')
  @Perm('productos.ver')
  options() {
    return this.db
      .select({ id: brands.id, name: brands.name })
      .from(brands)
      .where(eq(brands.status, 'ACTIVO'))
      .orderBy(asc(brands.name));
  }

  @Post()
  @Perm('productos.crear')
  async create(@Body() body: unknown, @CurrentActor() actor: Actor) {
    const data = parse(brandSchema, body);
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(brands).values(data).returning();
      await this.audit.log(tx, actor, {
        action: 'CREAR', module: 'productos', entity: 'brands', entityId: row.id,
        summary: `Creó la marca ${row.name}`, newValues: data,
      });
      return row;
    });
  }

  @Patch(':id')
  @Perm('productos.editar')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    const data = parse(brandSchema.partial(), body);
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(brands).where(eq(brands.id, id)).for('update');
      if (!before) throw new NotFoundException('Marca no encontrada.');
      const [row] = await tx.update(brands).set(data).where(eq(brands.id, id)).returning();
      const d = diff(before, row);
      if (d.newValues) {
        await this.audit.log(tx, actor, {
          action: 'EDITAR', module: 'productos', entity: 'brands', entityId: id,
          summary: `Editó la marca ${row.name}`, ...d,
        });
      }
      return row;
    });
  }

  @Delete(':id')
  @Perm('productos.eliminar')
  @HttpCode(200)
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.delete(brands).where(eq(brands.id, id)).returning();
      if (!row) throw new NotFoundException('Marca no encontrada.');
      await this.audit.log(tx, actor, {
        action: 'ELIMINAR', module: 'productos', entity: 'brands', entityId: id,
        summary: `Eliminó la marca ${row.name}`, oldValues: { name: row.name },
      });
      return { ok: true };
    });
  }
}
