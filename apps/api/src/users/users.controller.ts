import {
  BadRequestException,
  Body,
  ConflictException,
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
import { and, asc, eq, ilike, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import { hashPassword, roles, userRoles, userWarehouses, users, warehouses, type Db, type DbOrTx } from '@erp/db';
import { resetPasswordSchema, userCreateSchema, userUpdateSchema } from '@erp/shared';
import { Perm } from '../auth/decorators';
import { SessionService } from '../auth/session.service';
import { CurrentActor, type Actor } from '../common/actor';
import { InjectDb } from '../common/db';
import { countSql, likePattern, orderFrom, readListQuery, str } from '../common/listing';
import { parse } from '../common/zod';
import { AuditService } from '../audit/audit.service';

const publicUser = {
  id: users.id,
  email: users.email,
  name: users.name,
  status: users.status,
  lastLoginAt: users.lastLoginAt,
  lockedUntil: users.lockedUntil,
  mustChangePassword: users.mustChangePassword,
  createdAt: users.createdAt,
};

@Controller('users')
export class UsersController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {}

  @Get()
  @Perm('configuracion.ver')
  async list(@Query() query: Record<string, unknown>, @CurrentActor() actor: Actor) {
    const lq = readListQuery(query, actor, 'configuracion');
    const conds: SQL[] = [];
    if (lq.q) {
      const p = likePattern(lq.q);
      conds.push(or(ilike(users.email, p), ilike(users.name, p))!);
    }
    const status = str(query.status);
    if (status) conds.push(eq(users.status, status as 'ACTIVO'));
    const roleId = str(query.roleId);
    if (roleId) conds.push(sql`exists (select 1 from ${userRoles} ur where ur.user_id = "users"."id" and ur.role_id = ${roleId})`);
    const where = conds.length ? and(...conds) : undefined;
    const [{ total }] = await this.db.select({ total: countSql }).from(users).where(where);
    const rows = await this.db
      .select({
        ...publicUser,
        roleNames: sql<string[]>`coalesce((select array_agg(r.name order by r.name) from ${userRoles} ur join ${roles} r on r.id = ur.role_id where ur.user_id = "users"."id"), '{}')`,
        warehouseCodes: sql<string[]>`coalesce((select array_agg(w.code order by w.code) from ${userWarehouses} uw join ${warehouses} w on w.id = uw.warehouse_id where uw.user_id = "users"."id"), '{}')`,
      })
      .from(users)
      .where(where)
      .orderBy(...orderFrom(lq.sort, { name: users.name, email: users.email, status: users.status, lastLoginAt: users.lastLoginAt }, asc(users.name)))
      .limit(lq.pageSize)
      .offset((lq.page - 1) * lq.pageSize);
    return { items: rows, total, page: lq.page, pageSize: lq.pageSize };
  }

  @Get(':id')
  @Perm('configuracion.ver')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const [user] = await this.db.select(publicUser).from(users).where(eq(users.id, id));
    if (!user) throw new NotFoundException('Usuario no encontrado.');
    const r = await this.db.select({ id: userRoles.roleId }).from(userRoles).where(eq(userRoles.userId, id));
    const w = await this.db.select({ id: userWarehouses.warehouseId }).from(userWarehouses).where(eq(userWarehouses.userId, id));
    return { ...user, roleIds: r.map((x) => x.id), warehouseIds: w.map((x) => x.id) };
  }

  @Post()
  @Perm('configuracion.crear')
  async create(@Body() body: unknown, @CurrentActor() actor: Actor) {
    const data = parse(userCreateSchema, body);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(users)
        .values({ email: data.email, name: data.name, passwordHash: await hashPassword(data.password), mustChangePassword: true })
        .returning(publicUser);
      await this.setRoles(tx, row.id, data.roleIds);
      await this.setWarehouses(tx, row.id, data.warehouseIds);
      await this.audit.log(tx, actor, {
        action: 'CREAR', module: 'configuracion', entity: 'users', entityId: row.id,
        summary: `Creó el usuario ${row.email}`,
        newValues: { email: data.email, name: data.name, roleIds: data.roleIds, warehouseIds: data.warehouseIds },
      });
      return row;
    });
  }

  @Patch(':id')
  @Perm('configuracion.editar')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    const data = parse(userUpdateSchema, body);
    await this.db.transaction(async (tx) => {
      const [before] = await tx.select(publicUser).from(users).where(eq(users.id, id)).for('update');
      if (!before) throw new NotFoundException('Usuario no encontrado.');
      const beforeRoles = (await tx.select({ id: userRoles.roleId }).from(userRoles).where(eq(userRoles.userId, id))).map((r) => r.id);
      const beforeWh = (await tx.select({ id: userWarehouses.warehouseId }).from(userWarehouses).where(eq(userWarehouses.userId, id))).map((r) => r.id);

      if (id === actor.id && data.status && data.status !== 'ACTIVO') {
        throw new BadRequestException('No puedes desactivar tu propio usuario.');
      }
      const losesAdmin =
        (data.status && data.status !== 'ACTIVO') ||
        (data.roleIds && !(await this.includesAdmin(tx, data.roleIds)));
      if (losesAdmin && (await this.includesAdmin(tx, beforeRoles))) {
        await this.assertAnotherActiveAdmin(tx, id);
      }

      const patch: Partial<typeof users.$inferInsert> = {};
      if (data.name) patch.name = data.name;
      if (data.status) {
        patch.status = data.status;
        if (data.status === 'ACTIVO') {
          patch.failedLogins = 0;
          patch.lockedUntil = null;
        }
      }
      if (Object.keys(patch).length) await tx.update(users).set(patch).where(eq(users.id, id));
      if (data.roleIds) await this.setRoles(tx, id, data.roleIds);
      if (data.warehouseIds) await this.setWarehouses(tx, id, data.warehouseIds);
      if (data.status && data.status !== 'ACTIVO') await this.sessions.revokeAllForUser(id);

      const oldValues: Record<string, unknown> = {};
      const newValues: Record<string, unknown> = {};
      if (data.name && data.name !== before.name) { oldValues.name = before.name; newValues.name = data.name; }
      if (data.status && data.status !== before.status) { oldValues.status = before.status; newValues.status = data.status; }
      if (data.roleIds && [...data.roleIds].sort().join() !== [...beforeRoles].sort().join()) { oldValues.roleIds = beforeRoles; newValues.roleIds = data.roleIds; }
      if (data.warehouseIds && [...data.warehouseIds].sort().join() !== [...beforeWh].sort().join()) { oldValues.warehouseIds = beforeWh; newValues.warehouseIds = data.warehouseIds; }
      if (Object.keys(newValues).length) {
        await this.audit.log(tx, actor, {
          action: 'EDITAR', module: 'configuracion', entity: 'users', entityId: id,
          summary: `Editó el usuario ${before.email} (${Object.keys(newValues).join(', ')})`, oldValues, newValues,
        });
      }
    });
    return this.get(id);
  }

  @Post(':id/reset-password')
  @Perm('configuracion.editar')
  @HttpCode(200)
  async resetPassword(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    const { newPassword } = parse(resetPasswordSchema, body);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(users)
        .set({ passwordHash: await hashPassword(newPassword), mustChangePassword: true, failedLogins: 0, lockedUntil: null })
        .where(eq(users.id, id))
        .returning({ email: users.email });
      if (!row) throw new NotFoundException('Usuario no encontrado.');
      await this.sessions.revokeAllForUser(id);
      await this.audit.log(tx, actor, {
        action: 'RESTABLECER_CONTRASENA', module: 'configuracion', entity: 'users', entityId: id,
        summary: `Restableció la contraseña de ${row.email}; deberá cambiarla al entrar`,
      });
      return { ok: true };
    });
  }

  @Post(':id/revoke-sessions')
  @Perm('configuracion.editar')
  @HttpCode(200)
  async revokeSessions(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    await this.sessions.revokeAllForUser(id, id === actor.id ? actor.sessionId : undefined);
    await this.audit.log(this.db, actor, {
      action: 'CERRAR_SESIONES', module: 'configuracion', entity: 'users', entityId: id,
      summary: 'Cerró las sesiones abiertas del usuario',
    });
    return { ok: true };
  }

  private async setRoles(tx: DbOrTx, userId: string, roleIds: string[]) {
    const found = await tx.select({ id: roles.id }).from(roles).where(inArray(roles.id, roleIds));
    if (found.length !== new Set(roleIds).size) throw new BadRequestException('Algún rol no existe.');
    await tx.delete(userRoles).where(eq(userRoles.userId, userId));
    await tx.insert(userRoles).values([...new Set(roleIds)].map((roleId) => ({ userId, roleId })));
  }

  private async setWarehouses(tx: DbOrTx, userId: string, warehouseIds: string[]) {
    await tx.delete(userWarehouses).where(eq(userWarehouses.userId, userId));
    if (warehouseIds.length) {
      await tx.insert(userWarehouses).values([...new Set(warehouseIds)].map((warehouseId) => ({ userId, warehouseId })));
    }
  }

  private async includesAdmin(tx: DbOrTx, roleIds: string[]) {
    if (!roleIds.length) return false;
    const r = await tx.select({ id: roles.id }).from(roles).where(and(inArray(roles.id, roleIds), eq(roles.code, 'ADMIN')));
    return r.length > 0;
  }

  private async assertAnotherActiveAdmin(tx: DbOrTx, exceptUserId: string) {
    const [{ n }] = await tx
      .select({ n: countSql })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .innerJoin(users, eq(users.id, userRoles.userId))
      .where(and(eq(roles.code, 'ADMIN'), eq(users.status, 'ACTIVO'), ne(users.id, exceptUserId)));
    if (n === 0) throw new ConflictException('Debe quedar al menos un Administrador activo.');
  }
}
