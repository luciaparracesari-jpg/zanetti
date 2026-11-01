import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Perm } from '../auth/decorators';
import { CurrentActor, type Actor } from '../common/actor';
import { IntegrationsService } from './integrations.service';

/**
 * Conexiones con sistemas externos (APLIN, después Shopify, Amazon…).
 * Ninguna ruta recibe ni devuelve credenciales: sólo el prefijo de las variables de entorno del servidor.
 */
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly svc: IntegrationsService) {}

  @Get()
  @Perm('integraciones.ver')
  list() {
    return this.svc.list();
  }

  /** Prefijos de credenciales que el servidor tiene configurados (sólo los nombres). */
  @Get('credential-refs')
  @Perm('integraciones.crear')
  refs() {
    return this.svc.credentialRefs();
  }

  @Post()
  @Perm('integraciones.crear')
  create(@Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.svc.create(body, actor);
  }

  @Get(':id')
  @Perm('integraciones.ver')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return (await this.svc.list()).find((c) => c.id === id) ?? (await this.svc.get(id));
  }

  @Patch(':id')
  @Perm('integraciones.editar')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.svc.update(id, body, actor);
  }

  @Post(':id/sync')
  @HttpCode(200)
  @Perm('integraciones.editar')
  sync(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.sync(id, actor);
  }

  @Get(':id/runs')
  @Perm('integraciones.ver')
  runs(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.runs(id);
  }

  @Get(':id/stock')
  @Perm('integraciones.ver')
  stock(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.stock(id);
  }

  @Get(':id/orders')
  @Perm('integraciones.ver')
  orders(@Param('id', ParseUUIDPipe) id: string, @Query() q: { kind?: string; alert?: string; q?: string; limit?: string }) {
    return this.svc.orders(id, q);
  }

  @Get(':id/summary')
  @Perm('integraciones.ver')
  summary(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.summary(id);
  }
}
