import {
  boolean,
  check,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, pk, updatedAt } from './_columns';
import { users } from './security';

export const companySettings = pgTable(
  'company_settings',
  {
    id: integer().primaryKey().default(1),
    legalName: text().notNull(),
    tradeName: text(),
    rfc: text(),
    timezone: text().notNull().default('America/Mexico_City'),
    baseCurrency: text().notNull().default('MXN'),
    updatedAt: updatedAt(),
  },
  () => [check('company_settings_singleton_ck', sql`id = 1`)],
);

export const systemParameters = pgTable('system_parameters', {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  description: text(),
  updatedAt: updatedAt(),
  updatedById: uuid(),
});

export const taxRates = pgTable(
  'tax_rates',
  {
    id: pk(),
    code: text().notNull(),
    name: text().notNull(),
    rate: numeric({ precision: 7, scale: 4 }).notNull(),
    validFrom: date({ mode: 'string' }).notNull(),
    validTo: date({ mode: 'string' }),
  },
  (t) => [uniqueIndex('tax_rates_code_from_uq').on(t.code, t.validFrom)],
);

export const currencies = pgTable('currencies', {
  code: text().primaryKey(),
  name: text().notNull(),
  symbol: text().notNull(),
  decimals: integer().notNull().default(2),
});

export const exchangeRates = pgTable(
  'exchange_rates',
  {
    id: pk(),
    date: date({ mode: 'string' }).notNull(),
    currencyCode: text()
      .notNull()
      .references(() => currencies.code),
    rate: numeric({ precision: 14, scale: 6 }).notNull(),
    source: text().notNull().default('DOF'),
  },
  (t) => [uniqueIndex('exchange_rates_uq').on(t.date, t.currencyCode, t.source)],
);

export const savedFilters = pgTable(
  'saved_filters',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tableKey: text().notNull(),
    name: text().notNull(),
    filter: jsonb().notNull(),
    isDefault: boolean().notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('saved_filters_uq').on(t.userId, t.tableKey, t.name)],
);
