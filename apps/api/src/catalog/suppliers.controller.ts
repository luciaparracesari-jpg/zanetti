import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { and, asc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { masterSkus, suppliers, type Db } from '@erp/db';
import { z } from 'zod';
import { Perm } from '../auth/decorators';
import { CurrentActor, type Actor } from '../common/actor';
import { InjectDb } from '../common/db';
import { diff } from '../common/diff';
import { countSql, likePattern, orderFrom, readListQuery, str } from '../common/listing';
import { parse } from '../common/zod';
import { AuditService } from '../audit/audit.service';

/** Ficha básica de proveedor; el módulo completo (productos, historial, calificación) llega en la entrega 3. */
const supplierSchema = z.object({
  code: z.string().trim().toUpperCase().max(20).nullish().transform((v) => v || null),
  name: z.string().trim().min(1, 'Requerido').max(200),
  legalName: z.string().trim().max(200).nullish().transform((v) => v || null),
  taxId: z.string().trim().max(20).nullish().transform((v) => v || null),
  country: z.string().trim().length(2).toUpperCase().default('MX'),
  currencyCode: z.enum(['MXN', 'USD', 'CNY']).default('MXN'),
  paymentTerms: z.string().trim().max(200).nullish().transform((v) => v || null),
  leadTimeDays: z.coerce.number().int().min(0).max(730).nullish().transform((v) => v ?? null),
  moq: z.coerce.number().int().min(0).nullish().transform((v) => v ?? null),
  contactName: z.string().trim().max(120).nullish().transform((v) => v || null),
  email: z.union([z.email('Correo inválido'), z.literal(''), z.null()]).optional().transform((v) => v || null),
  phone: z.string().trim().max(40).nullish().transform((v) => v || null),
  status: z.enum(['ACTIVO', 'INACTIVO']).default('ACTIVO'),
});

@Controller('suppliers')
export class SuppliersController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Perm('proveedores.ver')
  async list(@Query() query: Record<string, unknown>, @CurrentActor() actor: Actor) {
    const lq = readListQuery(query, actor, 'proveedores');
    const conds: SQL[] = [];
    if (lq.q) {
      const p = likePattern(lq.q);
      conds.push(or(ilike(suppliers.name, p), ilike(suppliers.code, p), ilike(suppliers.contactName, p))!);
    }
    const status = str(query.status);
    if (status) conds.push(eq(suppliers.status, status as 'ACTIVO'));
    const where = conds.length ? and(...conds) : undefined;
    const skuCount = sql<number>`(select count(*)::int from ${masterSkus} s where s.preferred_supplier_id = "suppliers"."id")`;
    const [{ total }] = await this.db.select({ total: countSql }).from(suppliers).where(where);
    const items = await this.db
      .select({
        id: suppliers.id, code: suppliers.code, name: suppliers.name, country: suppliers.country,
        currencyCode: suppliers.currencyCode, leadTimeDays: suppliers.leadTimeDays, moq: suppliers.moq,
        contactName: suppliers.contactName, email: suppliers.email, phone: suppliers.phone,
        paymentTerms: suppliers.paymentTerms, legalName: suppliers.legalName, taxId: suppliers.taxId,
        status: suppliers.status, skuCount,
      })
      .from(suppliers)
      .where(where)
      .orderBy(...orderFrom(lq.sort, { name: suppliers.name, code: suppliers.code, country: suppliers.country, leadTimeDays: suppliers.leadTimeDays }, asc(suppliers.name)))
      .limit(lq.pageSize)
      .offset((lq.page - 1) * lq.pageSize);
    return { items, total, page: lq.page, pageSize: lq.pageSize };
  }

  @Get('options')
  @Perm('productos.ver')
  options() {
    return this.db
      .select({ id: suppliers.id, name: suppliers.name, leadTimeDays: suppliers.leadTimeDays })
      .from(suppliers)
      .where(eq(suppliers.status, 'ACTIVO'))
      .orderBy(asc(suppliers.name));
  }

  @Post()
  @Perm('proveedores.crear')
  async create(@Body() body: unknown, @CurrentActor() actor: Actor) {
    const data = parse(supplierSchema, body);
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(suppliers).values(data).returning();
      await this.audit.log(tx, actor, {
        action: 'CREAR', module: 'proveedores', entity: 'suppliers', entityId: row.id,
        summary: `Creó el proveedor ${row.name}`, newValues: data,
      });
      return row;
    });
  }

  @Patch(':id')
  @Perm('proveedores.editar')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    const data = parse(supplierSchema.partial(), body);
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(suppliers).where(eq(suppliers.id, id)).for('update');
      if (!before) throw new NotFoundException('Proveedor no encontrado.');
      const [row] = await tx.update(suppliers).set(data).where(eq(suppliers.id, id)).returning();
      const d = diff(before, row);
      if (d.newValues) {
        await this.audit.log(tx, actor, {
          action: 'EDITAR', module: 'proveedores', entity: 'suppliers', entityId: id,
          summary: `Editó el proveedor ${row.name}`, ...d,
        });
      }
      return row;
    });
  }
}
