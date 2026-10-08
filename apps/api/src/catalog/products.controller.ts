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
  Query,
} from '@nestjs/common';
import { and, asc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { brands, categories, masterSkus, products, type Db } from '@erp/db';
import { productSchema } from '@erp/shared';
import { Perm } from '../auth/decorators';
import { CurrentActor, type Actor } from '../common/actor';
import { InjectDb } from '../common/db';
import { diff } from '../common/diff';
import { countSql, likePattern, orderFrom, readListQuery, str } from '../common/listing';
import { parse } from '../common/zod';
import { AuditService } from '../audit/audit.service';

const skuCount = sql<number>`(select count(*)::int from ${masterSkus} s where s.product_id = "products"."id")`;

@Controller('products')
export class ProductsController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Perm('productos.ver')
  async list(@Query() query: Record<string, unknown>, @CurrentActor() actor: Actor) {
    const lq = readListQuery(query, actor, 'productos');
    const conds: SQL[] = [];
    if (lq.q) {
      const p = likePattern(lq.q);
      conds.push(
        or(
          ilike(products.name, p),
          sql`exists (select 1 from ${masterSkus} s where s.product_id = "products"."id" and s.sku_code ilike ${p})`,
        )!,
      );
    }
    const status = str(query.status);
    if (status) conds.push(eq(products.status, status as 'ACTIVO'));
    const brandId = str(query.brandId);
    if (brandId) conds.push(eq(products.brandId, brandId));
    const categoryId = str(query.categoryId);
    if (categoryId) conds.push(eq(products.categoryId, categoryId));
    const where = conds.length ? and(...conds) : undefined;

    const [{ total }] = await this.db.select({ total: countSql }).from(products).where(where);
    const items = await this.db
      .select({
        id: products.id,
        name: products.name,
        status: products.status,
        brandId: products.brandId,
        brandName: brands.name,
        categoryId: products.categoryId,
        categoryName: categories.name,
        skuCount,
        updatedAt: products.updatedAt,
      })
      .from(products)
      .leftJoin(brands, eq(brands.id, products.brandId))
      .leftJoin(categories, eq(categories.id, products.categoryId))
      .where(where)
      .orderBy(
        ...orderFrom(
          lq.sort,
          { name: products.name, status: products.status, brandName: brands.name, categoryName: categories.name, updatedAt: products.updatedAt, skuCount },
          asc(products.name),
        ),
      )
      .limit(lq.pageSize)
      .offset((lq.page - 1) * lq.pageSize);
    return { items, total, page: lq.page, pageSize: lq.pageSize };
  }

  @Get('options')
  @Perm('productos.ver')
  async options(@Query('q') q?: string) {
    const conds: SQL[] = [eq(products.status, 'ACTIVO')];
    if (q?.trim()) conds.push(ilike(products.name, likePattern(q.trim())));
    return this.db
      .select({ id: products.id, name: products.name })
      .from(products)
      .where(and(...conds))
      .orderBy(asc(products.name))
      .limit(50);
  }

  @Get(':id')
  @Perm('productos.ver')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const row = await this.db.query.products.findFirst({
      where: eq(products.id, id),
      with: {
        brand: true,
        category: true,
        skus: {
          columns: { id: true, skuCode: true, name: true, status: true, isKit: true, basePrice: true },
          orderBy: asc(masterSkus.skuCode),
        },
      },
    });
    if (!row) throw new NotFoundException('Producto no encontrado.');
    return row;
  }

  @Post()
  @Perm('productos.crear')
  async create(@Body() body: unknown, @CurrentActor() actor: Actor) {
    const data = parse(productSchema, body);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(products)
        .values({ ...data, createdById: actor.id, updatedById: actor.id })
        .returning();
      await this.audit.log(tx, actor, {
        action: 'CREAR', module: 'productos', entity: 'products', entityId: row.id,
        summary: `Creó el producto ${row.name}`, newValues: data,
      });
      return row;
    });
  }

  @Patch(':id')
  @Perm('productos.editar')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    const data = parse(productSchema.partial(), body);
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(products).where(eq(products.id, id)).for('update');
      if (!before) throw new NotFoundException('Producto no encontrado.');
      const [row] = await tx
        .update(products)
        .set({ ...data, updatedById: actor.id })
        .where(eq(products.id, id))
        .returning();
      const d = diff(before, row);
      if (d.newValues) {
        await this.audit.log(tx, actor, {
          action: 'EDITAR', module: 'productos', entity: 'products', entityId: id,
          summary: `Editó el producto ${row.name}`, ...d,
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
      const [row] = await tx.delete(products).where(eq(products.id, id)).returning();
      if (!row) throw new NotFoundException('Producto no encontrado.');
      await this.audit.log(tx, actor, {
        action: 'ELIMINAR', module: 'productos', entity: 'products', entityId: id,
        summary: `Eliminó el producto ${row.name}`, oldValues: { name: row.name },
      });
      return { ok: true };
    });
  }
}
