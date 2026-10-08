import {
  BadRequestException,
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
import { asc, eq, sql } from 'drizzle-orm';
import { categories, products, type Db } from '@erp/db';
import { categorySchema } from '@erp/shared';
import { Perm } from '../auth/decorators';
import { CurrentActor, type Actor } from '../common/actor';
import { InjectDb } from '../common/db';
import { diff } from '../common/diff';
import { parse } from '../common/zod';
import { AuditService } from '../audit/audit.service';

export interface CategoryNode {
  id: string;
  name: string;
  parentId: string | null;
  status: 'ACTIVO' | 'INACTIVO';
  path: string;
  depth: number;
  productCount: number;
}

@Controller('categories')
export class CategoriesController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** Árbol aplanado y ordenado por ruta ("Hogar / Cocina / Organizadores"). */
  @Get()
  @Perm('productos.ver')
  async list(): Promise<CategoryNode[]> {
    const rows = await this.db
      .select({
        id: categories.id,
        name: categories.name,
        parentId: categories.parentId,
        status: categories.status,
        productCount: sql<number>`(select count(*)::int from ${products} p where p.category_id = "categories"."id")`,
      })
      .from(categories)
      .orderBy(asc(categories.name));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const pathOf = (id: string, guard = 0): string[] => {
      const r = byId.get(id);
      if (!r || guard > 20) return [];
      return r.parentId ? [...pathOf(r.parentId, guard + 1), r.name] : [r.name];
    };
    return rows
      .map((r) => {
        const parts = pathOf(r.id);
        return { ...r, path: parts.join(' / '), depth: parts.length - 1 };
      })
      .sort((a, b) => a.path.localeCompare(b.path, 'es'));
  }

  @Post()
  @Perm('productos.crear')
  async create(@Body() body: unknown, @CurrentActor() actor: Actor) {
    const data = parse(categorySchema, body);
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(categories).values(data).returning();
      await this.audit.log(tx, actor, {
        action: 'CREAR', module: 'productos', entity: 'categories', entityId: row.id,
        summary: `Creó la categoría ${row.name}`, newValues: data,
      });
      return row;
    });
  }

  @Patch(':id')
  @Perm('productos.editar')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    const data = parse(categorySchema.partial(), body);
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(categories).where(eq(categories.id, id)).for('update');
      if (!before) throw new NotFoundException('Categoría no encontrada.');
      if (data.parentId) {
        // Evita ciclos: el nuevo padre no puede ser la misma categoría ni una de sus descendientes.
        const all = await tx.select({ id: categories.id, parentId: categories.parentId }).from(categories);
        let cur: string | null = data.parentId;
        for (let i = 0; cur && i < 50; i++) {
          if (cur === id) throw new BadRequestException('Una categoría no puede quedar dentro de sí misma.');
          cur = all.find((c) => c.id === cur)?.parentId ?? null;
        }
      }
      const [row] = await tx.update(categories).set(data).where(eq(categories.id, id)).returning();
      const d = diff(before, row);
      if (d.newValues) {
        await this.audit.log(tx, actor, {
          action: 'EDITAR', module: 'productos', entity: 'categories', entityId: id,
          summary: `Editó la categoría ${row.name}`, ...d,
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
      const [row] = await tx.delete(categories).where(eq(categories.id, id)).returning();
      if (!row) throw new NotFoundException('Categoría no encontrada.');
      await this.audit.log(tx, actor, {
        action: 'ELIMINAR', module: 'productos', entity: 'categories', entityId: id,
        summary: `Eliminó la categoría ${row.name}`, oldValues: { name: row.name },
      });
      return { ok: true };
    });
  }
}
