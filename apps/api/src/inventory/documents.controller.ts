import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Perm } from '../auth/decorators';
import { CurrentActor, type Actor } from '../common/actor';
import { AdjustmentsService } from './adjustments.service';
import { CountsService } from './counts.service';
import { TransfersService } from './transfers.service';

/** Ajustes de inventario: borrador → (por autorizar) → aplicado. */
@Controller('adjustments')
export class AdjustmentsController {
  constructor(private readonly svc: AdjustmentsService) {}

  @Get()
  @Perm('ajustes.ver')
  list(@Query() q: Record<string, string>, @CurrentActor() a: Actor) {
    return this.svc.list(q, a);
  }

  @Get(':id')
  @Perm('ajustes.ver')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() a: Actor) {
    return this.svc.get(id, a);
  }

  @Post()
  @Perm('ajustes.crear')
  create(@Body() body: unknown, @CurrentActor() a: Actor) {
    return this.svc.create(body, a);
  }

  @Patch(':id')
  @Perm('ajustes.editar')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() a: Actor) {
    return this.svc.update(id, body, a);
  }

  @Post(':id/apply')
  @Perm('ajustes.crear')
  apply(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() a: Actor) {
    return this.svc.apply(id, body, a);
  }

  @Post(':id/authorize')
  @Perm('ajustes.autorizar')
  authorize(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() a: Actor) {
    return this.svc.authorize(id, body, a);
  }

  @Post(':id/cancel')
  @Perm('ajustes.ver')
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() a: Actor) {
    return this.svc.cancel(id, a);
  }
}

/** Transferencias entre almacenes: borrador → autorizada → en tránsito → recibida. */
@Controller('transfers')
export class TransfersController {
  constructor(private readonly svc: TransfersService) {}

  @Get()
  @Perm('transferencias.ver')
  list(@Query() q: Record<string, string>, @CurrentActor() a: Actor) {
    return this.svc.list(q, a);
  }

  @Get(':id')
  @Perm('transferencias.ver')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() a: Actor) {
    return this.svc.get(id, a);
  }

  @Post()
  @Perm('transferencias.crear')
  create(@Body() body: unknown, @CurrentActor() a: Actor) {
    return this.svc.create(body, a);
  }

  @Patch(':id')
  @Perm('transferencias.editar')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() a: Actor) {
    return this.svc.update(id, body, a);
  }

  @Post(':id/authorize')
  @Perm('transferencias.autorizar')
  authorize(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() a: Actor) {
    return this.svc.authorize(id, a);
  }

  @Post(':id/ship')
  @Perm('transferencias.editar')
  ship(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() a: Actor) {
    return this.svc.ship(id, body, a);
  }

  @Post(':id/receive')
  @Perm('transferencias.editar')
  receive(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() a: Actor) {
    return this.svc.receive(id, body, a);
  }

  @Post(':id/cancel')
  @Perm('transferencias.editar')
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() a: Actor) {
    return this.svc.cancel(id, a);
  }
}

/** Conteos físicos (cíclicos o totales). Cerrar un conteo ajusta inventario: requiere autorizar ajustes. */
@Controller('counts')
export class CountsController {
  constructor(private readonly svc: CountsService) {}

  @Get()
  @Perm('transferencias.ver')
  list(@Query() q: Record<string, string>, @CurrentActor() a: Actor) {
    return this.svc.list(q, a);
  }

  @Get(':id')
  @Perm('transferencias.ver')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() a: Actor) {
    return this.svc.get(id, a);
  }

  @Get(':id/resolve')
  @Perm('transferencias.ver')
  resolve(@Param('id', ParseUUIDPipe) id: string, @Query('code') code: string, @CurrentActor() a: Actor) {
    return this.svc.resolve(id, code ?? '', a);
  }

  @Post()
  @Perm('transferencias.crear')
  create(@Body() body: unknown, @CurrentActor() a: Actor) {
    return this.svc.create(body, a);
  }

  @Patch(':id/lines')
  @Perm('transferencias.editar')
  capture(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() a: Actor) {
    return this.svc.capture(id, body, a);
  }

  @Post(':id/lines')
  @Perm('transferencias.editar')
  addLine(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() a: Actor) {
    return this.svc.addLine(id, body, a);
  }

  @Post(':id/close')
  @Perm('ajustes.autorizar')
  close(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() a: Actor) {
    return this.svc.close(id, body, a);
  }

  @Post(':id/cancel')
  @Perm('transferencias.editar')
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() a: Actor) {
    return this.svc.cancel(id, a);
  }
}
