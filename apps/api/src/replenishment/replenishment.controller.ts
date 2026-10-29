import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Perm } from '../auth/decorators';
import { CurrentActor, type Actor } from '../common/actor';
import { ReplenishmentService } from './replenishment.service';

/** Reabasto: envíos sugeridos a FBA y Liverpool, pedido a China y parámetros. */
@Controller('replenishment')
export class ReplenishmentController {
  constructor(private readonly svc: ReplenishmentService) {}

  @Get()
  @Perm('reabasto.ver')
  compute(@Query('fecha') fecha?: string) {
    return this.svc.compute({ fecha });
  }

  @Get('params')
  @Perm('reabasto.ver')
  params() {
    return this.svc.storedParams();
  }

  @Patch('params')
  @Perm('reabasto.editar')
  updateParams(@Body() body: unknown, @CurrentActor() a: Actor) {
    return this.svc.updateParams(body, a);
  }

  @Patch('skus/:id')
  @Perm('reabasto.editar')
  updateSku(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() a: Actor) {
    return this.svc.updateSku(id, body, a);
  }

  @Post('shipments')
  @Perm('transferencias.crear')
  shipment(@Body() body: unknown, @CurrentActor() a: Actor) {
    return this.svc.createShipment(body, a);
  }

  @Post('orders')
  @Perm('compras.crear')
  order(@Body() body: unknown, @CurrentActor() a: Actor) {
    return this.svc.createOrder(body, a);
  }
}
