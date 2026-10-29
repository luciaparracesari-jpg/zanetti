import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@erp/db';

const SEQUENCES = {
  TR: 'transfer_folio_seq',
  AJ: 'adjustment_folio_seq',
  CF: 'count_folio_seq',
  L: 'lot_code_seq',
} as const;
export type FolioPrefix = keyof typeof SEQUENCES;

/** Siguiente folio de documento: TR-000001 (transferencia), AJ-000001 (ajuste), CF-000001 (conteo). */
export async function nextFolio(tx: DbOrTx, prefix: FolioPrefix): Promise<string> {
  const r = await tx.execute<{ n: string }>(sql`SELECT nextval(${SEQUENCES[prefix]}::regclass)::text AS n`);
  return `${prefix}-${String(r.rows[0].n).padStart(6, '0')}`;
}
