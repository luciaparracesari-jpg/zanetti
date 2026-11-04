import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { Perm } from '../auth/decorators';
import { CurrentActor, type Actor } from '../common/actor';
import { MAX_ATTACHMENT_BYTES } from './attachments.service';
import { PurchasingService } from './purchasing.service';

const flag = (v: unknown) => v === true || v === '1' || v === 'true';

/** Órdenes de compra a proveedores: renglones, carga desde Excel, pagos y paso a contenedor. */
@Controller('purchase-orders')
export class PurchaseOrdersController {
  constructor(private readonly svc: PurchasingService) {}

  @Get()
  @Perm('compras.ver')
  list(@Query() q: Record<string, unknown>, @CurrentActor() actor: Actor) {
    return this.svc.list(q, actor);
  }

  @Post()
  @Perm('compras.crear')
  create(@Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.svc.create(body, actor);
  }

  @Get(':id')
  @Perm('compras.ver')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.get(id, actor);
  }

  @Patch(':id')
  @Perm('compras.editar')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.svc.update(id, body, actor);
  }

  /** Orden en Excel para mandar al proveedor (con precios si el usuario los ve y no pide lo contrario). */
  @Get(':id/file')
  @Perm('compras.ver')
  async file(@Param('id', ParseUUIDPipe) id: string, @Query('precios') precios: string | undefined, @CurrentActor() actor: Actor, @Res() res: Response) {
    const f = await this.svc.exportXlsx(id, actor, precios !== '0');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${f.fileName}"`);
    res.send(f.buffer);
  }

  @Post(':id/items')
  @Perm('compras.editar')
  upsertItem(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.svc.upsertItem(id, body, actor);
  }

  @Patch(':id/items/:itemId')
  @Perm('compras.editar')
  updateItem(@Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.svc.updateItem(id, itemId, body, actor);
  }

  @Delete(':id/items/:itemId')
  @Perm('compras.editar')
  deleteItem(@Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string, @CurrentActor() actor: Actor) {
    return this.svc.deleteItem(id, itemId, actor);
  }

  /** Carga de renglones desde Excel: `apply=0` muestra qué haría, `apply=1` lo aplica. */
  @Post(':id/import')
  @HttpCode(200)
  @Perm('compras.editar')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 } }))
  importLines(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: Record<string, unknown>,
    @CurrentActor() actor: Actor,
  ) {
    return this.svc.importLines(id, file, { sheet: typeof body.sheet === 'string' ? body.sheet : undefined, apply: flag(body.apply), replace: flag(body.replace), attach: body.attach === undefined ? true : flag(body.attach) }, actor);
  }

  @Post(':id/payments')
  @Perm('compras.editar', 'costos.ver')
  addPayment(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.svc.addPayment(id, body, actor);
  }

  @Delete(':id/payments/:paymentId')
  @Perm('compras.editar', 'costos.ver')
  deletePayment(@Param('id', ParseUUIDPipe) id: string, @Param('paymentId', ParseUUIDPipe) paymentId: string, @CurrentActor() actor: Actor) {
    return this.svc.deletePayment(id, paymentId, actor);
  }

  @Post(':id/to-container')
  @HttpCode(200)
  @Perm('compras.editar')
  toContainer(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    return this.svc.toContainer(id, body, actor);
  }
}
