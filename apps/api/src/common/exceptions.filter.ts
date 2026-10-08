import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';

interface PgLikeError {
  code?: string;
  constraint?: string;
  detail?: string;
  message?: string;
  cause?: unknown;
}

/** Mensajes legibles para restricciones conocidas de la base de datos. */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  users_email_uq: 'Ya existe un usuario con ese correo.',
  roles_code_unique: 'Ya existe un rol con ese código.',
  brands_name_uq: 'Ya existe una marca con ese nombre.',
  categories_child_name_uq: 'Ya existe una subcategoría con ese nombre en la categoría.',
  categories_root_name_uq: 'Ya existe una categoría con ese nombre.',
  master_skus_code_uq: 'Ya existe un SKU maestro con ese código.',
  sku_barcodes_barcode_unique: 'Ese código de barras ya está asignado a otro SKU.',
  sku_barcodes_primary_uq: 'El SKU ya tiene un código de barras principal.',
  channel_listings_active_uq: 'Ese código externo ya está ligado a un SKU activo en este canal.',
  channels_code_unique: 'Ya existe un canal con ese código.',
  warehouses_code_unique: 'Ya existe un almacén con ese código.',
  warehouse_locations_code_uq: 'Ya existe una ubicación con ese código en el almacén.',
  suppliers_code_unique: 'Ya existe un proveedor con ese código.',
  fee_rules_no_overlap: 'La vigencia se traslapa con otra regla del mismo canal, tipo y alcance.',
  warehouses_channel_ck: 'Un almacén de fulfillment o consignación debe pertenecer a un canal.',
  kit_components_self_ck: 'Un kit no puede contenerse a sí mismo.',
  master_skus_minmax_ck: 'El mínimo no puede ser mayor que el máximo.',
  saved_filters_uq: 'Ya tienes un filtro guardado con ese nombre.',
};

function findPgError(err: unknown): PgLikeError | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur; i++) {
    const e = cur as PgLikeError;
    if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e;
    cur = e.cause;
  }
  return undefined;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ERP');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof ZodError) {
      return res.status(HttpStatus.UNPROCESSABLE_ENTITY).json({
        statusCode: 422,
        message: 'Revisa los datos capturados.',
        errors: exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const payload =
        typeof body === 'string' ? { statusCode: status, message: body } : { statusCode: status, ...body };
      return res.status(status).json(payload);
    }

    const pg = findPgError(exception);
    if (pg) {
      const friendly = pg.constraint ? CONSTRAINT_MESSAGES[pg.constraint] : undefined;
      switch (pg.code) {
        case '23505':
          return res.status(409).json({ statusCode: 409, message: friendly ?? 'El registro ya existe.' });
        case '23503':
          return res.status(409).json({
            statusCode: 409,
            message: friendly ?? 'El registro está en uso o hace referencia a otro que no existe.',
          });
        case '23514':
        case '23P01':
          return res.status(422).json({ statusCode: 422, message: friendly ?? pg.message ?? 'Dato inválido.' });
        case '23001':
          return res.status(409).json({ statusCode: 409, message: pg.message ?? 'Operación no permitida.' });
        case '22P02':
          return res.status(400).json({ statusCode: 400, message: 'Formato de dato inválido.' });
      }
    }

    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    return res.status(500).json({ statusCode: 500, message: 'Error interno. Intenta de nuevo.' });
  }
}
