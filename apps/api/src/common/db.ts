import { Global, Inject, Module } from '@nestjs/common';
import { getDb } from '@erp/db';

export const DB = Symbol('DB');
export const InjectDb = () => Inject(DB);

@Global()
@Module({
  providers: [{ provide: DB, useFactory: () => getDb() }],
  exports: [DB],
})
export class DbModule {}
