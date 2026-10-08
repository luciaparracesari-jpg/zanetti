import { ForbiddenException } from '@nestjs/common';
import { asc, desc, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { listQuerySchema, type ListQuery } from '@erp/shared';
import { can, type Actor } from './actor';

export const EXPORT_LIMIT = 10_000;

/**
 * Lee page/pageSize/sort/q. Con `export=1` exige el permiso de exportar del módulo
 * y permite traer hasta 10,000 renglones para el archivo CSV/Excel.
 */
export function readListQuery(query: Record<string, unknown>, actor: Actor, module: string): ListQuery {
  const isExport = query.export === '1' || query.export === 'true';
  if (isExport) {
    if (!can(actor, `${module}.exportar`)) throw new ForbiddenException('No tienes permiso para exportar.');
    const base = listQuerySchema.parse({ ...query, page: 1, pageSize: 1 });
    return { ...base, page: 1, pageSize: EXPORT_LIMIT };
  }
  return listQuerySchema.parse(query);
}

/** Traduce "campo:asc" a ORDER BY usando sólo columnas permitidas. */
export function orderFrom(
  sort: string | undefined,
  allowed: Record<string, PgColumn | SQL>,
  fallback: SQL | PgColumn,
): (SQL | PgColumn)[] {
  if (sort) {
    const [field, dir] = sort.split(':');
    const col = allowed[field];
    if (col) return [dir === 'desc' ? desc(col) : asc(col)];
  }
  return [fallback];
}

/** Patrón ILIKE seguro: escapa % y _ que escriba el usuario. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

export const countSql = sql<number>`count(*)::int`;

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}
