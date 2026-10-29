import type { Db, DbOrTx, Tx } from '@erp/db';
import type { PermissionKey } from '@erp/shared';
import type { Actor } from '../common/actor';
import type { AuditService } from '../audit/audit.service';

export type Level = 'error' | 'warning' | 'info';

export interface RowMessage {
  field?: string;
  level: Level;
  message: string;
}

export interface ColumnDef {
  field: string;
  header: string;
  aliases?: string[];
  required?: boolean;
  example?: string;
  help: string;
}

export type RowValues = Record<string, string | null>;

export interface InputRow {
  rowNumber: number;
  values: RowValues;
  skipped: boolean;
}

export type RowAction = 'CREAR' | 'ACTUALIZAR' | 'SIN_CAMBIOS';

export interface ValidatedRow<P = unknown> {
  rowNumber: number;
  messages: RowMessage[];
  action: RowAction | null;
  plan: P | null;
}

export interface ApplyContext {
  actor: Actor;
  audit: AuditService;
  batchLabel: string;
  batchId: string;
}

export interface ImportTemplate<P = unknown> {
  key: string;
  label: string;
  description: string;
  /** Permisos necesarios para cargar, revisar y aplicar. */
  permissions: PermissionKey[];
  columns: ColumnDef[];
  /** Valida todos los renglones juntos (los duplicados dentro del archivo dependen de los demás). */
  validate(db: DbOrTx, rows: InputRow[], actor: Actor): Promise<ValidatedRow<P>[]>;
  /** Aplica los planes ya validados dentro de la transacción. Devuelve conteos para el resumen. */
  apply(tx: Tx, rows: { rowNumber: number; plan: P }[], ctx: ApplyContext): Promise<Record<string, number>>;
}

export type AnyTemplate = ImportTemplate<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export type { Db };
