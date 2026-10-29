import { ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { masterSkus, systemParameters, warehouseLocations, warehouses, type DbOrTx } from '@erp/db';
import { can, type Actor } from '../common/actor';

/** Filtro por los almacenes asignados al usuario (null = todos). */
export function whScope(actor: Actor, col: PgColumn): SQL | undefined {
  return actor.warehouseIds ? inArray(col, actor.warehouseIds.length ? actor.warehouseIds : ['00000000-0000-0000-0000-000000000000']) : undefined;
}

/** Lista de almacenes del usuario como fragmento SQL para consultas crudas. */
export function whScopeSql(actor: Actor, column: SQL): SQL {
  if (!actor.warehouseIds) return sql`true`;
  if (actor.warehouseIds.length === 0) return sql`false`;
  return sql`${column} IN (${sql.join(actor.warehouseIds.map((id) => sql`${id}::uuid`), sql`, `)})`;
}

export function assertWarehouse(actor: Actor, warehouseId: string) {
  if (actor.warehouseIds && !actor.warehouseIds.includes(warehouseId)) throw new ForbiddenException('No tienes acceso a este almacén.');
}

export const showCosts = (actor: Actor) => can(actor, 'costos.ver');
export const isAdmin = (actor: Actor) => actor.roles.includes('ADMIN');

/** Autorización de inventario negativo: sólo el Administrador y sólo si la pide explícitamente. */
export function negativeAuth(actor: Actor, requested: boolean | undefined): string | null {
  if (!requested) return null;
  if (!isAdmin(actor)) throw new ForbiddenException('Sólo el Administrador puede autorizar inventario negativo.');
  return actor.id;
}

export async function loadWarehouseOr404(tx: DbOrTx, id: string) {
  const [w] = await tx.select().from(warehouses).where(eq(warehouses.id, id));
  if (!w) throw new NotFoundException('Almacén no encontrado.');
  return w;
}

export async function locationsOf(tx: DbOrTx, warehouseId: string) {
  return tx
    .select({ id: warehouseLocations.id, code: warehouseLocations.code, type: warehouseLocations.type, status: warehouseLocations.status })
    .from(warehouseLocations)
    .where(eq(warehouseLocations.warehouseId, warehouseId));
}

export async function skusById(tx: DbOrTx, ids: string[]) {
  if (ids.length === 0) return new Map<string, { id: string; skuCode: string; name: string; isKit: boolean; avgCost: string | null; currentCost: string | null }>();
  const rows = await tx
    .select({ id: masterSkus.id, skuCode: masterSkus.skuCode, name: masterSkus.name, isKit: masterSkus.isKit, avgCost: masterSkus.avgCost, currentCost: masterSkus.currentCost })
    .from(masterSkus)
    .where(inArray(masterSkus.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r]));
}

/** Parámetro numérico (null si no está definido o es null). */
export async function numericParam(tx: DbOrTx, key: string): Promise<number | null> {
  const [p] = await tx.select({ value: systemParameters.value }).from(systemParameters).where(eq(systemParameters.key, key));
  const v = p?.value;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}


/** Errores por renglón con el mismo formato 422 que zod (la pantalla los pinta por campo). */
export const rowErrors = (errors: { path: string; message: string }[]) =>
  new UnprocessableEntityException({ message: 'Revisa los renglones marcados.', errors });
