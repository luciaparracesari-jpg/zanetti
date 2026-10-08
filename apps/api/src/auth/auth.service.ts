import crypto from 'node:crypto';
import { HttpException, HttpStatus, Injectable, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { hashPassword, users, verifyPassword, type Db } from '@erp/db';
import { InjectDb } from '../common/db';
import type { Actor } from '../common/actor';
import { AuditService } from '../audit/audit.service';
import { SessionService } from './session.service';

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
// Hash de referencia para igualar el tiempo de respuesta cuando el correo no existe.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword(crypto.randomBytes(16).toString('hex')));

@Injectable()
export class AuthService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  async login(email: string, password: string, ip: string | null, userAgent: string | null) {
    const [user] = await this.db.select().from(users).where(sql`lower(${users.email}) = ${email.toLowerCase()}`);
    const generic = new UnauthorizedException('Correo o contraseña incorrectos.');

    if (!user) {
      await verifyPassword(await getDummyHash(), password);
      await this.audit.log(this.db, null, {
        action: 'LOGIN_FALLIDO',
        module: 'configuracion',
        entity: 'users',
        summary: `Intento de acceso con correo no registrado: ${email}`,
      });
      throw generic;
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const mins = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      throw new HttpException(
        `Cuenta bloqueada temporalmente por intentos fallidos. Intenta en ${mins} min.`,
        HttpStatus.LOCKED,
      );
    }

    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok || user.status !== 'ACTIVO') {
      const failed = user.failedLogins + 1;
      const lock = failed >= MAX_FAILED;
      await this.db
        .update(users)
        .set({
          failedLogins: lock ? 0 : failed,
          lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60000) : user.lockedUntil,
        })
        .where(eq(users.id, user.id));
      await this.audit.log(this.db, { id: user.id, email: user.email, ip }, {
        action: 'LOGIN_FALLIDO',
        module: 'configuracion',
        entity: 'users',
        entityId: user.id,
        summary: lock ? `Cuenta bloqueada ${LOCK_MINUTES} min tras ${MAX_FAILED} intentos` : 'Contraseña incorrecta',
      });
      throw generic;
    }

    await this.db
      .update(users)
      .set({ failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() })
      .where(eq(users.id, user.id));
    const token = await this.sessions.create(user.id, ip, userAgent);
    await this.audit.log(this.db, { id: user.id, email: user.email, ip }, {
      action: 'LOGIN',
      module: 'configuracion',
      entity: 'users',
      entityId: user.id,
      summary: 'Inicio de sesión',
    });
    return { token, mustChangePassword: user.mustChangePassword };
  }

  async logout(actor: Actor) {
    await this.sessions.revoke(actor.sessionId);
    await this.audit.log(this.db, actor, {
      action: 'LOGOUT',
      module: 'configuracion',
      entity: 'users',
      entityId: actor.id,
      summary: 'Cierre de sesión',
    });
  }

  async changePassword(actor: Actor, currentPassword: string, newPassword: string) {
    const [user] = await this.db.select().from(users).where(eq(users.id, actor.id));
    if (!(await verifyPassword(user.passwordHash, currentPassword))) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        message: 'La contraseña actual no es correcta.',
        errors: [{ path: 'currentPassword', message: 'No coincide' }],
      });
    }
    if (currentPassword === newPassword) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        message: 'La nueva contraseña debe ser distinta de la actual.',
        errors: [{ path: 'newPassword', message: 'Debe ser distinta' }],
      });
    }
    await this.db
      .update(users)
      .set({ passwordHash: await hashPassword(newPassword), mustChangePassword: false })
      .where(eq(users.id, actor.id));
    await this.sessions.revokeAllForUser(actor.id, actor.sessionId);
    await this.audit.log(this.db, actor, {
      action: 'CAMBIO_CONTRASENA',
      module: 'configuracion',
      entity: 'users',
      entityId: actor.id,
      summary: 'Cambió su contraseña; se cerraron sus otras sesiones',
    });
  }
}
