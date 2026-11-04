import { Controller, Get } from '@nestjs/common';
import { Perm } from '../auth/decorators';
import { ValuationService } from './valuation.service';

@Controller('inventory-valuation')
export class ValuationController {
  constructor(private readonly svc: ValuationService) {}

  /** Valor del inventario por contenedor, lo que viene en camino y lo pedido sin contenedor. */
  @Get('containers')
  @Perm('inventario.ver', 'costos.ver')
  byContainer() {
    return this.svc.byContainer();
  }
}
