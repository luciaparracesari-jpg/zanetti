import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** Usuario autenticado de la petición, con sus permisos ya resueltos. */
export interface Actor {
  id: string;
  email: string;
  name: string;
  sessionId: string;
  roles: string[];
  permissions: Set<string>;
  /** null = sin restricción por almacén. */
  warehouseIds: string[] | null;
  mustChangePassword: boolean;
  ip: string | null;
}

export type ErpRequest = Request & { actor?: Actor };

export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): Actor => {
  const req = ctx.switchToHttp().getRequest<ErpRequest>();
  return req.actor!;
});

export const can = (actor: Actor, key: string) => actor.permissions.has(key);
