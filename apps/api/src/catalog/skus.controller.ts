import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { barcodeSchema, kitComponentsSchema, skuCreateSchema, skuUpdateSchema } from '@erp/shared';
import { Perm } from '../auth/decorators';
import { CurrentActor, type Actor } from '../common/actor';
import { readListQuery, str } from '../common/listing';
import { parse } from '../common/zod';
import { AuditService } from '../audit/audit.service';
import { SkusService } from './skus.service';

const bool = (v: unknown) => (v === 'true' ? true : v === 'false' ? false : undefined);

@Controller('skus')
export class SkusController {
  constructor(
    private readonly skus: SkusService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Perm('productos.ver')
  list(@Query() query: Record<string, unknown>, @CurrentActor() actor: Actor) {
    const lq = readListQuery(query, actor, 'productos');
    return this.skus.list(
      lq,
      {
        status: str(query.status),
        productId: str(query.productId),
        brandId: str(query.brandId),
        categoryId: str(query.categoryId),
        channelId: str(query.channelId),
        isKit: bool(query.isKit),
        withoutListings: query.withoutListings === 'true',
      },
      actor,
    );
  }

  @Get('options')
  @Perm('productos.ver')
  options(@Query('q') q?: string, @Query('excludeKits') excludeKits?: string) {
    return this.skus.options(q, excludeKits === 'true');
  }

  @Get(':id')
  @Perm('productos.ver')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.skus.get(id, actor);
  }

  @Get(':id/history')
  @Perm('productos.ver')
  history(@Param('id', ParseUUIDPipe) id: string, @Query() query: Record<string, unknown>, @CurrentActor() actor: Actor) {
    const lq = readListQuery(query, actor, 'productos');
    return this.audit.list({ entity: 'master_skus', entityId: id, page: lq.page, pageSize: lq.pageSize });
  }

  @Post()
  @Perm('productos.crear')
  create(@Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.skus.create(parse(skuCreateSchema, body), actor);
  }

  @Patch(':id')
  @Perm('productos.editar')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.skus.update(id, parse(skuUpdateSchema, body), actor);
  }

  @Post(':id/barcodes')
  @Perm('productos.editar')
  addBarcode(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.skus.addBarcode(id, parse(barcodeSchema, body), actor);
  }

  @Post(':id/barcodes/:barcodeId/primary')
  @Perm('productos.editar')
  @HttpCode(200)
  setPrimary(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('barcodeId', ParseUUIDPipe) barcodeId: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.skus.setPrimaryBarcode(id, barcodeId, actor);
  }

  @Delete(':id/barcodes/:barcodeId')
  @Perm('productos.editar')
  @HttpCode(200)
  removeBarcode(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('barcodeId', ParseUUIDPipe) barcodeId: string,
    @CurrentActor() actor: Actor,
  ) {
    return this.skus.removeBarcode(id, barcodeId, actor);
  }

  @Put(':id/components')
  @Perm('productos.editar')
  setComponents(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.skus.setComponents(id, parse(kitComponentsSchema, body), actor);
  }
}
