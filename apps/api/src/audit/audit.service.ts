import { Injectable } from '@nestjs/common';
import { and, desc, eq, gte, ilike, lte, or, type SQL } from 'drizzle-orm';
import { auditLogs, type Db, type DbOrTx } from '@erp/db';
import type { Paged } from '@erp/shared';
import { InjectDb } from '../common/db';
import type { Actor } from '../common/actor';
import { countSql, likePattern } from '../common/listing';

export interface AuditEntry {
  action: string;
  module: string;
  entity: string;
  entityId?: string | null;
  summary?: string | null;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
}

export interface AuditFilter {
  entity?: string;
  entityId?: string;
  module?: string;
  userId?: string;
  action?: string;
  from?: string;
  to?: string;
  q?: string;
  page: number;
  pageSize: number;
}

@Injectable()
export class AuditService {
  constructor(@InjectDb() private readonly db: Db) {}

  /** Registra en la misma transacción que el cambio (si se pasa `tx`). */
  async log(tx: DbOrTx, actor: Pick<Actor, 'id' | 'email' | 'ip'> | null, e: AuditEntry) {
    await tx.insert(auditLogs).values({
      userId: actor?.id ?? null,
      userEmail: actor?.email ?? null,
      ip: actor?.ip ?? null,
      action: e.action,
      module: e.module,
      entity: e.entity,
      entityId: e.entityId ?? null,
      summary: e.summary ?? null,
      oldValues: e.oldValues ?? null,
      newValues: e.newValues ?? null,
    });
  }

  async list(f: AuditFilter): Promise<Paged<typeof auditLogs.$inferSelect>> {
    const conds: SQL[] = [];
    if (f.entity) conds.push(eq(auditLogs.entity, f.entity));
    if (f.entityId) conds.push(eq(auditLogs.entityId, f.entityId));
    if (f.module) conds.push(eq(auditLogs.module, f.module));
    if (f.userId) conds.push(eq(auditLogs.userId, f.userId));
    if (f.action) conds.push(eq(auditLogs.action, f.action));
    if (f.from) conds.push(gte(auditLogs.occurredAt, new Date(`${f.from}T00:00:00-06:00`)));
    if (f.to) conds.push(lte(auditLogs.occurredAt, new Date(`${f.to}T23:59:59.999-06:00`)));
    if (f.q) {
      const p = likePattern(f.q);
      conds.push(or(ilike(auditLogs.summary, p), ilike(auditLogs.userEmail, p), ilike(auditLogs.entityId, p))!);
    }
    const where = conds.length ? and(...conds) : undefined;
    const [{ total }] = await this.db.select({ total: countSql }).from(auditLogs).where(where);
    const items = await this.db
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.occurredAt), desc(auditLogs.id))
      .limit(f.pageSize)
      .offset((f.page - 1) * f.pageSize);
    return { items, total, page: f.page, pageSize: f.pageSize };
  }
}
