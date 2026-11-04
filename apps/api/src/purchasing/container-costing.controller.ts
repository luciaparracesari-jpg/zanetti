import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Perm } from '../auth/decorators';
import { CurrentActor, type Actor } from '../common/actor';
import { ContainerCostingService } from './costing.service';

/**
 * Costeo de contenedores: gastos (flete, maniobras, aduana…), tipo de cambio, costo puesto en bodega por SKU y cierre.
 * Todo exige ver costos.
 */
@Controller('containers')
export class ContainerCostingController {
  constructor(private readonly svc: ContainerCostingService) {}

  @Get(':id/costing')
  @Perm('compras.ver', 'costos.ver')
  costing(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.costing(id);
  }

  @Patch(':id/costing')
  @Perm('compras.editar', 'costos.ver')
  header(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.svc.updateHeader(id, body, actor);
  }

  @Post(':id/costs')
  @Perm('compras.editar', 'costos.ver')
  addExpense(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.svc.addExpense(id, body, actor);
  }

  @Post(':id/costs/defaults')
  @HttpCode(200)
  @Perm('compras.editar', 'costos.ver')
  defaults(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.loadDefaultConcepts(id, actor);
  }

  @Patch(':id/costs/:costId')
  @Perm('compras.editar', 'costos.ver')
  updateExpense(@Param('id', ParseUUIDPipe) id: string, @Param('costId', ParseUUIDPipe) costId: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.svc.updateExpense(id, costId, body, actor);
  }

  @Delete(':id/costs/:costId')
  @Perm('compras.editar', 'costos.ver')
  deleteExpense(@Param('id', ParseUUIDPipe) id: string, @Param('costId', ParseUUIDPipe) costId: string, @CurrentActor() actor: Actor) {
    return this.svc.deleteExpense(id, costId, actor);
  }

  @Patch(':id/duty-rates')
  @Perm('compras.editar', 'costos.ver')
  dutyRates(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.svc.setDutyRates(id, body, actor);
  }

  @Post(':id/link-orders')
  @HttpCode(200)
  @Perm('compras.editar')
  link(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.svc.linkOrders(id, body, actor);
  }

  @Post(':id/costing/close')
  @HttpCode(200)
  @Perm('compras.autorizar', 'costos.ver')
  close(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.close(id, actor);
  }

  @Post(':id/costing/reopen')
  @HttpCode(200)
  @Perm('compras.autorizar', 'costos.ver')
  reopen(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.reopen(id, actor);
  }
}
