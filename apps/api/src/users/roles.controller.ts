import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { permissions, rolePermissions, roles, userRoles, type Db } from '@erp/db';
import { allPermissionKeys, roleSchema, rolePermissionsSchema } from '@erp/shared';
import { Perm } from '../auth/decorators';
import { CurrentActor, type Actor } from '../common/actor';
import { InjectDb } from '../common/db';
import { diff } from '../common/diff';
import { parse } from '../common/zod';
import { AuditService } from '../audit/audit.service';

@Controller('roles')
export class RolesController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Perm('configuracion.ver')
  list() {
    return this.db
      .select({
        id: roles.id,
        code: roles.code,
        name: roles.name,
        description: roles.description,
        isSystem: roles.isSystem,
        userCount: sql<number>`(select count(*)::int from ${userRoles} ur where ur.role_id = "roles"."id")`,
        permissionCount: sql<number>`(select count(*)::int from ${rolePermissions} rp where rp.role_id = "roles"."id")`,
      })
      .from(roles)
      .orderBy(sql`${roles.isSystem} desc`, asc(roles.name));
  }

  @Get(':id')
  @Perm('configuracion.ver')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const [role] = await this.db.select().from(roles).where(eq(roles.id, id));
    if (!role) throw new NotFoundException('Rol no encontrado.');
    const keys = await this.db
      .select({ key: permissions.key })
      .from(rolePermissions)
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(eq(rolePermissions.roleId, id));
    return { ...role, permissionKeys: keys.map((k) => k.key).sort() };
  }

  @Post()
  @Perm('configuracion.crear')
  async create(@Body() body: unknown, @CurrentActor() actor: Actor) {
    const data = parse(roleSchema, body);
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(roles).values({ ...data, isSystem: false }).returning();
      await this.audit.log(tx, actor, {
        action: 'CREAR', module: 'configuracion', entity: 'roles', entityId: row.id,
        summary: `Creó el rol ${row.name}`, newValues: data,
      });
      return row;
    });
  }

  @Patch(':id')
  @Perm('configuracion.editar')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    const data = parse(roleSchema.omit({ code: true }).partial(), body);
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(roles).where(eq(roles.id, id)).for('update');
      if (!before) throw new NotFoundException('Rol no encontrado.');
      const [row] = await tx.update(roles).set(data).where(eq(roles.id, id)).returning();
      const d = diff(before, row);
      if (d.newValues) {
        await this.audit.log(tx, actor, {
          action: 'EDITAR', module: 'configuracion', entity: 'roles', entityId: id,
          summary: `Editó el rol ${row.name}`, ...d,
        });
      }
      return row;
    });
  }

  @Put(':id/permissions')
  @Perm('configuracion.editar')
  async setPermissions(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    const { permissionKeys } = parse(rolePermissionsSchema, body);
    const valid = new Set(allPermissionKeys());
    const invalid = permissionKeys.filter((k) => !valid.has(k as never));
    if (invalid.length) throw new BadRequestException(`Permisos desconocidos: ${invalid.join(', ')}`);
    await this.db.transaction(async (tx) => {
      const [role] = await tx.select().from(roles).where(eq(roles.id, id)).for('update');
      if (!role) throw new NotFoundException('Rol no encontrado.');
      if (role.code === 'ADMIN') throw new ConflictException('El Administrador siempre tiene todos los permisos.');
      const before = await tx
        .select({ key: permissions.key })
        .from(rolePermissions)
        .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
        .where(eq(rolePermissions.roleId, id));
      await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, id));
      if (permissionKeys.length) {
        const perms = await tx.select({ id: permissions.id }).from(permissions).where(inArray(permissions.key, permissionKeys));
        await tx.insert(rolePermissions).values(perms.map((p) => ({ roleId: id, permissionId: p.id })));
      }
      const oldSet = new Set(before.map((b) => b.key));
      const newSet = new Set(permissionKeys);
      const added = [...newSet].filter((k) => !oldSet.has(k)).sort();
      const removed = [...oldSet].filter((k) => !newSet.has(k)).sort();
      if (added.length || removed.length) {
        await this.audit.log(tx, actor, {
          action: 'EDITAR_PERMISOS', module: 'configuracion', entity: 'roles', entityId: id,
          summary: `Cambió permisos del rol ${role.name}: +${added.length} / −${removed.length}`,
          oldValues: { quitados: removed }, newValues: { agregados: added },
        });
      }
    });
    return this.get(id);
  }

  @Delete(':id')
  @Perm('configuracion.eliminar')
  @HttpCode(200)
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.db.transaction(async (tx) => {
      const [role] = await tx.select().from(roles).where(eq(roles.id, id)).for('update');
      if (!role) throw new NotFoundException('Rol no encontrado.');
      if (role.isSystem) throw new ConflictException('Los roles iniciales no se eliminan; ajusta sus permisos.');
      await tx.delete(roles).where(eq(roles.id, id));
      await this.audit.log(tx, actor, {
        action: 'ELIMINAR', module: 'configuracion', entity: 'roles', entityId: id,
        summary: `Eliminó el rol ${role.name}`, oldValues: { code: role.code, name: role.name },
      });
      return { ok: true };
    });
  }
}
