import { config } from 'dotenv';
import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { closeDb, getDb } from './index';

config({ path: path.resolve(__dirname, '../../../.env') });

/** Aplica las migraciones pendientes. Uso: pnpm db:deploy */
async function main() {
  const db = getDb();
  const migrationsFolder = path.resolve(__dirname, '../migrations');
  await migrate(db, { migrationsFolder });
  console.log('Migraciones aplicadas.');
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
