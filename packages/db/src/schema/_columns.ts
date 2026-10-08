import { timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';

/** Llave primaria UUID v7 (ordenable por tiempo), generada en la aplicación. */
export const pk = () =>
  uuid()
    .primaryKey()
    .$defaultFn(() => uuidv7());

export const tsz = () => timestamp({ withTimezone: true, mode: 'date' });

export const createdAt = () => tsz().notNull().defaultNow();

export const updatedAt = () =>
  tsz()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
