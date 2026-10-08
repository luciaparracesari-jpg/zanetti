import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { savedFilters, type Db } from '@erp/db';
import { savedFilterSchema } from '@erp/shared';
import { AuthOnly } from '../auth/decorators';
import { CurrentActor, type Actor } from '../common/actor';
import { InjectDb } from '../common/db';
import { parse } from '../common/zod';

/** Filtros favoritos por usuario y tabla. */
@Controller('saved-filters')
export class SavedFiltersController {
  constructor(@InjectDb() private readonly db: Db) {}

  @Get()
  @AuthOnly()
  list(@Query('table') table: string, @CurrentActor() actor: Actor) {
    return this.db
      .select()
      .from(savedFilters)
      .where(and(eq(savedFilters.userId, actor.id), eq(savedFilters.tableKey, table ?? '')))
      .orderBy(asc(savedFilters.name));
  }

  @Post()
  @AuthOnly()
  async create(@Body() body: unknown, @CurrentActor() actor: Actor) {
    const data = parse(savedFilterSchema, body);
    return this.db.transaction(async (tx) => {
      if (data.isDefault) {
        await tx
          .update(savedFilters)
          .set({ isDefault: false })
          .where(and(eq(savedFilters.userId, actor.id), eq(savedFilters.tableKey, data.tableKey)));
      }
      const [row] = await tx
        .insert(savedFilters)
        .values({ ...data, userId: actor.id })
        .onConflictDoUpdate({
          target: [savedFilters.userId, savedFilters.tableKey, savedFilters.name],
          set: { filter: data.filter, isDefault: data.isDefault },
        })
        .returning();
      return row;
    });
  }

  @Delete(':id')
  @AuthOnly()
  @HttpCode(200)
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    const rows = await this.db
      .delete(savedFilters)
      .where(and(eq(savedFilters.id, id), eq(savedFilters.userId, actor.id)))
      .returning();
    if (!rows.length) throw new NotFoundException('Filtro no encontrado.');
    return { ok: true };
  }
}
