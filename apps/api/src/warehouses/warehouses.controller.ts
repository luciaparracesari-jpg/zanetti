import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { channels, warehouseLocations, warehouses, type Db } from '@erp/db';
import { locationSchema, warehouseSchema } from '@erp/shared';
import { Perm } from '../auth/decorators';
import { CurrentActor, type Actor } from '../common/actor';
import { InjectDb } from '../common/db';
import { diff } from '../common/diff';
import { parse } from '../common/zod';
import { AuditService } from '../audit/audit.service';

@Controller()
export class WarehousesController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private scope(actor: Actor) {
    return actor.warehouseIds ? inArray(warehouses.id, actor.warehouseIds) : undefined;
  }

  private assertInScope(actor: Actor, warehouseId: string) {
    if (actor.warehouseIds && !actor.warehouseIds.includes(warehouseId)) {
      throw new ForbiddenException('No tienes acceso a este almacén.');
    }
  }

  @Get('warehouses')
  @Perm('almacenes.ver')
  list(@CurrentActor() actor: Actor) {
    return this.db
      .select({
        id: warehouses.id,
        code: warehouses.code,
        name: warehouses.name,
        type: warehouses.type,
        channelId: warehouses.channelId,
        channelName: channels.name,
        address: warehouses.address,
        city: warehouses.city,
        state: warehouses.state,
        zip: warehouses.zip,
        allowNegative: warehouses.allowNegative,
        status: warehouses.status,
        locationCount: sql<number>`(select count(*)::int from ${warehouseLocations} l where l.warehouse_id = "warehouses"."id")`,
      })
      .from(warehouses)
      .leftJoin(channels, eq(channels.id, warehouses.channelId))
      .where(this.scope(actor))
      .orderBy(asc(warehouses.code));
  }

  @Get('warehouses/options')
  @Perm('productos.ver')
  options(@CurrentActor() actor: Actor) {
    return this.db
      .select({ id: warehouses.id, code: warehouses.code, name: warehouses.name, type: warehouses.type, channelId: warehouses.channelId })
      .from(warehouses)
      .where(and(eq(warehouses.status, 'ACTIVO'), this.scope(actor)))
      .orderBy(asc(warehouses.code));
  }

  @Get('warehouses/:id')
  @Perm('almacenes.ver')
  async get(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    this.assertInScope(actor, id);
    const row = await this.db.query.warehouses.findFirst({
      where: eq(warehouses.id, id),
      with: { channel: { columns: { id: true, code: true, name: true } }, locations: { orderBy: asc(warehouseLocations.code) } },
    });
    if (!row) throw new NotFoundException('Almacén no encontrado.');
    return row;
  }

  @Post('warehouses')
  @Perm('almacenes.crear')
  async create(@Body() body: unknown, @CurrentActor() actor: Actor) {
    const data = parse(warehouseSchema, body);
    if (data.allowNegative && !actor.roles.includes('ADMIN')) {
      throw new ForbiddenException('Sólo el Administrador puede permitir inventario negativo.');
    }
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(warehouses).values(data).returning();
      // Ubicación general por defecto para poder recibir mercancía desde el primer día.
      await tx.insert(warehouseLocations).values({ warehouseId: row.id, code: 'GEN', name: 'General', type: 'ALMACENAJE' });
      await this.audit.log(tx, actor, {
        action: 'CREAR', module: 'almacenes', entity: 'warehouses', entityId: row.id,
        summary: `Creó el almacén ${row.code} · ${row.name}`, newValues: data,
      });
      return row;
    });
  }

  @Patch('warehouses/:id')
  @Perm('almacenes.editar')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    this.assertInScope(actor, id);
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(warehouses).where(eq(warehouses.id, id)).for('update');
      if (!before) throw new NotFoundException('Almacén no encontrado.');
      const data = parse(warehouseSchema, { ...before, ...(body as object), code: before.code });
      if (data.allowNegative !== before.allowNegative && !actor.roles.includes('ADMIN')) {
        throw new ForbiddenException('Sólo el Administrador puede permitir inventario negativo.');
      }
      const [row] = await tx.update(warehouses).set(data).where(eq(warehouses.id, id)).returning();
      const d = diff(before, row);
      if (d.newValues) {
        await this.audit.log(tx, actor, {
          action: 'EDITAR', module: 'almacenes', entity: 'warehouses', entityId: id,
          summary: `Editó el almacén ${row.code}`, ...d,
        });
      }
      return row;
    });
  }

  @Post('warehouses/:id/locations')
  @Perm('almacenes.crear')
  async createLocation(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    this.assertInScope(actor, id);
    const data = parse(locationSchema, body);
    return this.db.transaction(async (tx) => {
      const [wh] = await tx.select().from(warehouses).where(eq(warehouses.id, id));
      if (!wh) throw new NotFoundException('Almacén no encontrado.');
      const [row] = await tx.insert(warehouseLocations).values({ ...data, warehouseId: id }).returning();
      await this.audit.log(tx, actor, {
        action: 'CREAR', module: 'almacenes', entity: 'warehouse_locations', entityId: row.id,
        summary: `Creó la ubicación ${wh.code}/${row.code}`, newValues: data,
      });
      return row;
    });
  }

  @Patch('locations/:id')
  @Perm('almacenes.editar')
  async updateLocation(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    const data = parse(locationSchema.omit({ code: true }).partial(), body);
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(warehouseLocations).where(eq(warehouseLocations.id, id)).for('update');
      if (!before) throw new NotFoundException('Ubicación no encontrada.');
      this.assertInScope(actor, before.warehouseId);
      const [row] = await tx.update(warehouseLocations).set(data).where(eq(warehouseLocations.id, id)).returning();
      const d = diff(before, row);
      if (d.newValues) {
        await this.audit.log(tx, actor, {
          action: 'EDITAR', module: 'almacenes', entity: 'warehouse_locations', entityId: id,
          summary: `Editó la ubicación ${row.code}`, ...d,
        });
      }
      return row;
    });
  }
}
