import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ErpRequest } from '../common/actor';
import { ALLOW_PENDING_PASSWORD, AUTH_ONLY, IS_PUBLIC, PERMS } from './decorators';
import { SESSION_COOKIE, SessionService } from './session.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Guard global:
 * 1. Toda petición que modifica datos debe traer el encabezado `x-erp-client` (defensa CSRF:
 *    un formulario de otro sitio no puede enviarlo).
 * 2. Exige una sesión válida salvo en rutas @Public.
 * 3. Exige los permisos de @Perm. Una ruta sin @Perm ni @AuthOnly se rechaza (falla cerrada).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const req = ctx.switchToHttp().getRequest<ErpRequest>();

    if (!SAFE_METHODS.has(req.method) && req.get('x-erp-client') !== 'web') {
      throw new ForbiddenException('Solicitud rechazada: falta el encabezado del cliente.');
    }

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (!token) throw new UnauthorizedException('Inicia sesión para continuar.');
    const actor = await this.sessions.resolve(token, req.ip ?? null);
    if (!actor) throw new UnauthorizedException('Tu sesión expiró. Inicia sesión de nuevo.');
    req.actor = actor;

    if (actor.mustChangePassword && !this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PASSWORD, targets)) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'PASSWORD_CHANGE_REQUIRED',
        message: 'Debes cambiar tu contraseña antes de continuar.',
      });
    }

    const perms = this.reflector.getAllAndOverride<string[]>(PERMS, targets);
    if (perms?.length) {
      if (perms.every((p) => actor.permissions.has(p))) return true;
      throw new ForbiddenException('No tienes permiso para esta acción.');
    }
    if (this.reflector.getAllAndOverride<boolean>(AUTH_ONLY, targets)) return true;
    throw new ForbiddenException('Ruta sin permiso declarado.');
  }
}
