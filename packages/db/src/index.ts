import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, types } from 'pg';
import * as schema from './schema';

export * as schema from './schema';
export * from './schema';
export { hashPassword, verifyPassword } from './password';

// DATE (oid 1082) llega como texto "YYYY-MM-DD" para no correr el día por zona horaria.
types.setTypeParser(1082, (v) => v);
// BIGINT (oid 20) como número: los identificadores de bitácora caben en 2^53.
types.setTypeParser(20, (v) => Number(v));

export type Db = NodePgDatabase<typeof schema>;

let pool: Pool | undefined;
let db: Db | undefined;

/** Cliente único por proceso. */
export function getDb(url = process.env.DATABASE_URL): Db {
  if (!db) {
    if (!url) throw new Error('DATABASE_URL no está definida');
    pool = new Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX ?? 10) });
    db = drizzle(pool, { schema, casing: 'snake_case' });
  }
  return db;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
  db = undefined;
}

/** Tipo de transacción para servicios que reciben `tx` o `db`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;
