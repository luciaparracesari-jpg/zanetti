import { Injectable } from '@nestjs/common';
import crypto from 'node:crypto';
import { and, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import {
  permissions,
  rolePermissions,
  roles,
  sessions,
  userRoles,
  userWarehouses,
  users,
  type Db,
} from '@erp/db';
import { allPermissionKeys } from '@erp/shared';
import { InjectDb } from '../common/db';
import type { Actor } from '../common/actor';

export const SESSION_COOKIE = 'erp_session';

export const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

export const sessionTtlMs = () => Number(process.env.SESSION_TTL_HOURS ?? 12) * 3600_000;

@Injectable()
export class SessionService {
  constructor(@InjectDb() private readonly db: Db) {}

  /** Crea la sesión y devuelve el token en claro (sólo viaja en la cookie httpOnly). */
  async create(userId: string, ip: string | null, userAgent: string | null): Promise<string> {
    const token = crypto.randomBytes(32).toString('base64url');
    await this.db.insert(sessions).values({
      userId,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + sessionTtlMs()),
      ip,
      userAgent: userAgent?.slice(0, 300) ?? null,
    });
    return token;
  }

  async resolve(token: string, ip: string | null): Promise<Actor | null> {
    const now = new Date();
    const [row] = await this.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(eq(sessions.tokenHash, sha256(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)),
      );
    if (!row || row.user.status !== 'ACTIVO') return null;

    if (now.getTime() - row.session.lastSeenAt.getTime() > 60_000) {
      await this.db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.session.id));
    }
    return this.buildActor(row.user, row.session.id, ip);
  }

  async buildActor(user: typeof users.$inferSelect, sessionId: string, ip: string | null): Promise<Actor> {
    const roleRows = await this.db
      .select({ id: roles.id, code: roles.code })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, user.id));
    const roleCodes = roleRows.map((r) => r.code);

    let keys: string[];
    if (roleCodes.includes('ADMIN')) {
      keys = allPermissionKeys();
    } else if (roleRows.length) {
      const permRows = await this.db
        .selectDistinct({ key: permissions.key })
        .from(rolePermissions)
        .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
        .where(
          inArray(
            rolePermissions.roleId,
            roleRows.map((r) => r.id),
          ),
        );
      keys = permRows.map((p) => p.key);
    } else {
      keys = [];
    }

    const wh = await this.db
      .select({ id: userWarehouses.warehouseId })
      .from(userWarehouses)
      .where(eq(userWarehouses.userId, user.id));

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      sessionId,
      roles: roleCodes,
      permissions: new Set(keys),
      warehouseIds: wh.length ? wh.map((w) => w.id) : null,
      mustChangePassword: user.mustChangePassword,
      ip,
    };
  }

  async revoke(sessionId: string) {
    await this.db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
  }

  async revokeAllForUser(userId: string, exceptSessionId?: string) {
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          exceptSessionId ? sql`${sessions.id} <> ${exceptSessionId}` : undefined,
        ),
      );
  }

  /** Limpieza de sesiones vencidas hace más de 30 días. */
  async purgeExpired() {
    await this.db.delete(sessions).where(lt(sessions.expiresAt, new Date(Date.now() - 30 * 86400_000)));
  }
}
