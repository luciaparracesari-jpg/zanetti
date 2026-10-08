import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, pk, tsz, updatedAt } from './_columns';
import { userStatus } from './enums';
import { warehouses } from './channels';

export const users = pgTable(
  'users',
  {
    id: pk(),
    email: text().notNull(),
    name: text().notNull(),
    passwordHash: text().notNull(),
    status: userStatus().notNull().default('ACTIVO'),
    failedLogins: integer().notNull().default(0),
    lockedUntil: tsz(),
    lastLoginAt: tsz(),
    mustChangePassword: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_uq').on(sql`lower(email)`)],
);

export const roles = pgTable('roles', {
  id: pk(),
  code: text().notNull().unique(),
  name: text().notNull(),
  description: text(),
  isSystem: boolean().notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const permissions = pgTable(
  'permissions',
  {
    id: pk(),
    key: text().notNull().unique(),
    module: text().notNull(),
    action: text().notNull(),
  },
  (t) => [uniqueIndex('permissions_module_action_uq').on(t.module, t.action)],
);

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid()
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: uuid()
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionId] })],
);

export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid()
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] })],
);

/** Limita a un usuario a ciertos almacenes. Sin renglones = acceso a todos. */
export const userWarehouses = pgTable(
  'user_warehouses',
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    warehouseId: uuid()
      .notNull()
      .references(() => warehouses.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.warehouseId] })],
);

export const sessions = pgTable(
  'sessions',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text().notNull().unique(),
    createdAt: createdAt(),
    expiresAt: tsz().notNull(),
    lastSeenAt: tsz().notNull().defaultNow(),
    revokedAt: tsz(),
    ip: text(),
    userAgent: text(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

/** Bitácora de cambios. Sólo inserción: un trigger rechaza UPDATE y DELETE. */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    occurredAt: tsz().notNull().defaultNow(),
    userId: uuid(),
    userEmail: text(),
    action: text().notNull(),
    module: text().notNull(),
    entity: text().notNull(),
    entityId: text(),
    summary: text(),
    oldValues: jsonb(),
    newValues: jsonb(),
    ip: text(),
  },
  (t) => [
    index('audit_logs_entity_idx').on(t.entity, t.entityId),
    index('audit_logs_occurred_idx').on(t.occurredAt),
    index('audit_logs_user_idx').on(t.userId, t.occurredAt),
  ],
);
