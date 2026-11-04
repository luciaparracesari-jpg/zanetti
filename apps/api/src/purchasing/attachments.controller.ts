import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { AuthOnly } from '../auth/decorators';
import { CurrentActor, type Actor } from '../common/actor';
import { AttachmentsService, MAX_ATTACHMENT_BYTES } from './attachments.service';

/** Archivos de órdenes de compra y contenedores. El servicio revisa los permisos de compras. */
@Controller('attachments')
export class AttachmentsController {
  constructor(private readonly svc: AttachmentsService) {}

  @Get()
  @AuthOnly()
  list(@Query('entityType') type: string, @Query('entityId', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.list(type, id, actor);
  }

  @Post()
  @AuthOnly()
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 } }))
  upload(@Body() body: unknown, @UploadedFile() file: Express.Multer.File | undefined, @CurrentActor() actor: Actor) {
    return this.svc.upload(body, file, actor);
  }

  @Get(':id/file')
  @AuthOnly()
  async download(@Param('id', ParseUUIDPipe) id: string, @Query('inline') inline: string | undefined, @CurrentActor() actor: Actor, @Res() res: Response) {
    const a = await this.svc.download(id, actor);
    const viewable = inline === '1' && (a.mimeType === 'application/pdf' || a.mimeType.startsWith('image/'));
    res.setHeader('Content-Type', a.mimeType);
    res.setHeader('Content-Length', String(a.sizeBytes));
    res.setHeader('Content-Disposition', `${viewable ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.fileName)}`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(a.data);
  }

  @Delete(':id')
  @AuthOnly()
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.svc.remove(id, actor);
  }
}
