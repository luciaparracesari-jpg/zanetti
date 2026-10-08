import { Body, Controller, Get, NotFoundException, Param, Patch } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { companySettings, currencies, systemParameters, taxRates, type Db } from '@erp/db';
import { z } from 'zod';
import { Perm } from '../auth/decorators';
import { CurrentActor, type Actor } from '../common/actor';
import { InjectDb } from '../common/db';
import { diff } from '../common/diff';
import { parse } from '../common/zod';
import { AuditService } from '../audit/audit.service';

const companySchema = z.object({
  legalName: z.string().trim().min(1).max(200),
  tradeName: z.string().trim().max(200).nullish().transform((v) => v || null),
  rfc: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/, 'RFC inválido')
    .nullish()
    .or(z.literal(''))
    .transform((v) => v || null),
});

const parameterSchema = z.object({ value: z.json() });

@Controller('settings')
export class SettingsController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Perm('configuracion.ver')
  async get() {
    const [company] = await this.db.select().from(companySettings).where(eq(companySettings.id, 1));
    const parameters = await this.db.select().from(systemParameters).orderBy(asc(systemParameters.key));
    const taxes = await this.db.select().from(taxRates).orderBy(asc(taxRates.code));
    const curr = await this.db.select().from(currencies).orderBy(asc(currencies.code));
    return { company, parameters, taxes, currencies: curr };
  }

  @Patch('company')
  @Perm('configuracion.editar')
  async updateCompany(@Body() body: unknown, @CurrentActor() actor: Actor) {
    const data = parse(companySchema.partial(), body);
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(companySettings).where(eq(companySettings.id, 1));
      const [row] = await tx.update(companySettings).set(data).where(eq(companySettings.id, 1)).returning();
      const d = diff(before, row);
      if (d.newValues) {
        await this.audit.log(tx, actor, {
          action: 'EDITAR', module: 'configuracion', entity: 'company_settings', entityId: '1',
          summary: 'Editó los datos de la empresa', ...d,
        });
      }
      return row;
    });
  }

  @Patch('parameters/:key')
  @Perm('configuracion.editar')
  async updateParameter(@Param('key') key: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    const { value } = parse(parameterSchema, body);
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(systemParameters).where(eq(systemParameters.key, key));
      if (!before) throw new NotFoundException('Parámetro no encontrado.');
      const [row] = await tx
        .update(systemParameters)
        .set({ value: value as never, updatedById: actor.id })
        .where(eq(systemParameters.key, key))
        .returning();
      await this.audit.log(tx, actor, {
        action: 'EDITAR', module: 'configuracion', entity: 'system_parameters', entityId: key,
        summary: `Cambió el parámetro ${key}`, oldValues: { value: before.value }, newValues: { value: row.value },
      });
      return row;
    });
  }
}
