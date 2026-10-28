import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, tsz } from './_columns';
import { importBatchStatus, importRowAction, importRowStatus } from './enums';
import { users } from './security';

/**
 * Importación de datos desde Excel o CSV: cargar → validar → revisar y corregir → confirmar.
 * Nada toca los catálogos hasta que el lote se aplica, y se aplica en una sola transacción.
 */
export const dataImportBatches = pgTable(
  'data_import_batches',
  {
    id: pk(),
    template: text().notNull(),
    fileName: text().notNull(),
    sheetName: text(),
    status: importBatchStatus().notNull().default('VALIDADO'),
    totalRows: integer().notNull().default(0),
    /** Avisos del archivo completo (columnas ignoradas, encabezado detectado…). */
    fileMessages: jsonb().notNull().default(sql`'[]'::jsonb`),
    /** Resultado al aplicar: conteos de lo creado y actualizado. */
    result: jsonb(),
    createdById: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    validatedAt: tsz().notNull().defaultNow(),
    appliedById: uuid().references(() => users.id, { onDelete: 'set null' }),
    appliedAt: tsz(),
  },
  (t) => [index('data_import_batches_created_idx').on(t.createdAt)],
);

export const dataImportRows = pgTable(
  'data_import_rows',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    batchId: uuid()
      .notNull()
      .references(() => dataImportBatches.id, { onDelete: 'cascade' }),
    /** Número de renglón en el archivo original (para ubicarlo en Excel). */
    rowNumber: integer().notNull(),
    /** Valores tal como llegaron, ya limpios de espacios invisibles. */
    raw: jsonb().notNull(),
    /** Valores corregidos en pantalla; si existe, reemplaza a `raw` campo por campo. */
    edits: jsonb(),
    status: importRowStatus().notNull(),
    action: importRowAction(),
    skipped: boolean().notNull().default(false),
    /** [{ field, level: 'error' | 'warning' | 'info', message }] */
    messages: jsonb().notNull().default(sql`'[]'::jsonb`),
    /** Lo que se hará al aplicar (para la vista previa). */
    plan: jsonb(),
  },
  (t) => [
    uniqueIndex('data_import_rows_uq').on(t.batchId, t.rowNumber),
    index('data_import_rows_status_idx').on(t.batchId, t.status),
  ],
);
