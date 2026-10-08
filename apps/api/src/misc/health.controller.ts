import { Controller, Get } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Db } from '@erp/db';
import { Public } from '../auth/decorators';
import { InjectDb } from '../common/db';

@Controller('health')
export class HealthController {
  constructor(@InjectDb() private readonly db: Db) {}

  /** Para el monitor del VPS: responde 200 si la API y la base de datos están arriba. */
  @Get()
  @Public()
  async health() {
    await this.db.execute(sql`select 1`);
    return { status: 'ok', time: new Date().toISOString() };
  }
}
