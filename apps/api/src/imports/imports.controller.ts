import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { importRowPatchSchema, listQuerySchema } from '@erp/shared';
import { AuthOnly } from '../auth/decorators';
import { CurrentActor, type Actor } from '../common/actor';
import { str } from '../common/listing';
import { parse } from '../common/zod';
import { ImportsService } from './imports.service';

const MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Importación de datos. Cada plantilla define sus propios permisos; el servicio los verifica
 * (por eso las rutas sólo exigen sesión).
 */
@Controller('data-imports')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Get('templates')
  @AuthOnly()
  templates(@CurrentActor() actor: Actor) {
    return this.imports.templates(actor);
  }

  @Get('templates/:key/file')
  @AuthOnly()
  async templateFile(@Param('key') key: string, @CurrentActor() actor: Actor, @Res() res: Response) {
    const buf = await this.imports.templateFile(key, actor);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="plantilla-${key}.xlsx"`);
    res.send(buf);
  }

  @Get()
  @AuthOnly()
  list(@Query() query: Record<string, unknown>, @CurrentActor() actor: Actor) {
    const { page, pageSize } = listQuerySchema.parse(query);
    return this.imports.list(actor, page, pageSize);
  }

  @Post()
  @AuthOnly()
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1 } }))
  upload(@UploadedFile() file: Express.Multer.File | undefined, @Body('template') template: string, @CurrentActor() actor: Actor) {
    // multer entrega el nombre en latin1; se convierte para conservar acentos.
    if (file) file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    return this.imports.upload(template ?? '', file, actor);
  }

  @Get(':id')
  @AuthOnly()
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.imports.get(id, actor);
  }

  @Get(':id/rows')
  @AuthOnly()
  rows(@Param('id', ParseUUIDPipe) id: string, @Query() query: Record<string, unknown>, @CurrentActor() actor: Actor) {
    const lq = listQuerySchema.parse(query);
    return this.imports.rows(id, actor, { status: str(query.status), action: str(query.action), q: lq.q, page: lq.page, pageSize: lq.pageSize });
  }

  @Patch(':id/rows/:rowId')
  @AuthOnly()
  patchRow(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('rowId', ParseIntPipe) rowId: number,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ) {
    return this.imports.patchRow(id, rowId, parse(importRowPatchSchema, body), actor);
  }

  @Post(':id/revalidate')
  @AuthOnly()
  @HttpCode(200)
  revalidate(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.imports.refresh(id, actor);
  }

  @Post(':id/apply')
  @AuthOnly()
  @HttpCode(200)
  apply(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.imports.apply(id, actor);
  }

  @Post(':id/cancel')
  @AuthOnly()
  @HttpCode(200)
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.imports.cancel(id, actor);
  }
}
