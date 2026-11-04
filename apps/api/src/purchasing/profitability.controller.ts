import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query } from '@nestjs/common';
import { Perm } from '../auth/decorators';
import { CurrentActor, type Actor } from '../common/actor';
import { ProfitabilityService } from './profitability.service';

/** P&L por SKU y canal (rentabilidad por pieza). Todo exige ver costos. */
@Controller('profitability')
export class ProfitabilityController {
  constructor(private readonly svc: ProfitabilityService) {}

  @Get('options')
  @Perm('reportes.ver', 'costos.ver')
  options() {
    return this.svc.options();
  }

  @Get('sku')
  @Perm('reportes.ver', 'costos.ver')
  skuPl(@Query() q: Record<string, unknown>) {
    return this.svc.skuPl(q);
  }

  @Put('sku/:skuId/channels/:channelId')
  @Perm('canales.editar', 'costos.ver')
  saveSku(@Param('skuId', ParseUUIDPipe) skuId: string, @Param('channelId', ParseUUIDPipe) channelId: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.svc.saveSkuInputs(skuId, channelId, body, actor);
  }

  @Put('channels/:channelId')
  @Perm('canales.editar', 'costos.ver')
  saveChannel(@Param('channelId', ParseUUIDPipe) channelId: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.svc.saveChannelSettings(channelId, body, actor);
  }
}
