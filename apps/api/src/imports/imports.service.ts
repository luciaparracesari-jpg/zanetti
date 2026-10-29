import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import ExcelJS from 'exceljs';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { dataImportBatches, dataImportRows, users, type Db, type DbOrTx } from '@erp/db';
import type { Paged } from '@erp/shared';
import { can, type Actor } from '../common/actor';
import { InjectDb } from '../common/db';
import { countSql } from '../common/listing';
import { AuditService } from '../audit/audit.service';
import { normHeader, parseFile, UnsupportedFileError, type ParsedSheet } from './parse';
import { initialStockTemplate } from './templates/initial-stock.template';
import { skusTemplate } from './templates/skus.template';
import type { AnyTemplate, InputRow, RowMessage, RowValues, ValidatedRow } from './types';

const TEMPLATES: AnyTemplate[] = [skusTemplate, initialStockTemplate];
const MAX_ROWS = 5000;
const HEADER_SCAN_ROWS = 20;

type RowStatus = 'VALIDO' | 'ADVERTENCIA' | 'ERROR' | 'OMITIDO';

function statusOf(messages: RowMessage[], skipped: boolean): RowStatus {
  if (skipped) return 'OMITIDO';
  if (messages.some((m) => m.level === 'error')) return 'ERROR';
  if (messages.some((m) => m.level === 'warning')) return 'ADVERTENCIA';
  return 'VALIDO';
}

const LEVEL_ORDER = { error: 0, warning: 1, info: 2 } as const;
const sortMessages = (m: RowMessage[]) => [...m].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);

@Injectable()
export class ImportsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  // ───────────────────────────── Plantillas ─────────────────────────────

  templates(actor: Actor) {
    return TEMPLATES.map((t) => ({
      key: t.key,
      label: t.label,
      description: t.description,
      columns: t.columns,
      allowed: t.permissions.every((p) => can(actor, p)),
    }));
  }

  template(key: string, actor: Actor): AnyTemplate {
    const t = TEMPLATES.find((x) => x.key === key);
    if (!t) throw new NotFoundException('Plantilla de importación no encontrada.');
    if (!t.permissions.every((p) => can(actor, p))) {
      throw new ForbiddenException('No tienes los permisos que requiere esta importación.');
    }
    return t;
  }

  /** Archivo de ejemplo: hoja de captura con encabezados y una hoja de instrucciones. */
  async templateFile(key: string, actor: Actor): Promise<Buffer> {
    const t = this.template(key, actor);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'ERP Ecommerce';
    const ws = wb.addWorksheet(t.label.slice(0, 31));
    ws.addRow(t.columns.map((c) => c.header));
    ws.addRow(t.columns.map((c) => c.example ?? ''));
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F5FA8' } };
    ws.getRow(2).font = { italic: true, color: { argb: 'FF8A929C' } };
    t.columns.forEach((c, i) => {
      ws.getColumn(i + 1).width = Math.max(14, c.header.length + 4);
      // Columnas de códigos como texto para que Excel no quite ceros ni use notación científica.
      ws.getColumn(i + 1).numFmt = '@';
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    const help = wb.addWorksheet('Instrucciones');
    help.addRow(['Columna', 'Obligatoria', 'Descripción', 'Ejemplo']);
    help.getRow(1).font = { bold: true };
    for (const c of t.columns) help.addRow([c.header, c.required ? 'Sí' : 'No', c.help, c.example ?? '']);
    help.addRow([]);
    help.addRow(['Borra el renglón de ejemplo antes de cargar el archivo. El orden de las columnas no importa; las columnas que no estén en esta lista se ignoran.']);
    help.getColumn(1).width = 26;
    help.getColumn(2).width = 12;
    help.getColumn(3).width = 90;
    help.getColumn(4).width = 20;
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  // ───────────────────────────── Carga ─────────────────────────────

  /** Ubica la hoja y el renglón de encabezados (puede haber títulos arriba, como "SKU DE OFERTA"). */
  private locateHeader(t: AnyTemplate, sheets: ParsedSheet[]) {
    const byAlias = new Map<string, string>();
    for (const c of t.columns) for (const a of [c.header, ...(c.aliases ?? [])]) byAlias.set(normHeader(a), c.field);
    const required = t.columns.filter((c) => c.required).map((c) => c.field);
    for (const sheet of sheets) {
      for (const row of sheet.rows.slice(0, HEADER_SCAN_ROWS)) {
        const fields = row.cells.map((c) => (c ? byAlias.get(normHeader(c)) ?? null : null));
        if (required.every((f) => fields.includes(f))) {
          return { sheet, headerRow: row, fields };
        }
      }
    }
    return null;
  }

  async upload(templateKey: string, file: { buffer: Buffer; originalname: string; size: number } | undefined, actor: Actor) {
    const t = this.template(templateKey, actor);
    if (!file) throw new BadRequestException('Selecciona un archivo .xlsx o .csv.');
    let sheets: ParsedSheet[];
    try {
      sheets = await parseFile(file.buffer, file.originalname);
    } catch (e) {
      if (e instanceof UnsupportedFileError) throw new UnprocessableEntityException(e.message);
      throw e;
    }
    const found = this.locateHeader(t, sheets);
    if (!found) {
      const req = t.columns.filter((c) => c.required).map((c) => c.header).join(', ');
      throw new UnprocessableEntityException(`No encontré el renglón de encabezados. El archivo debe tener la columna ${req} en alguno de los primeros ${HEADER_SCAN_ROWS} renglones.`);
    }
    const { sheet, headerRow, fields } = found;

    const fileMessages: RowMessage[] = [];
    if (sheets.length > 1) fileMessages.push({ level: 'info', message: `Se leyó la hoja “${sheet.sheetName}”.` });
    const seen = new Set<string>();
    const colField: (string | null)[] = fields.map((f, i) => {
      const header = headerRow.cells[i];
      if (!header) return null;
      if (!f) {
        fileMessages.push({ level: 'info', message: `Columna ignorada: “${header}”.` });
        return null;
      }
      if (seen.has(f)) {
        fileMessages.push({ level: 'warning', message: `La columna “${header}” está repetida; se usa la primera.` });
        return null;
      }
      seen.add(f);
      return f;
    });

    const inputs: InputRow[] = [];
    for (const row of sheet.rows) {
      if (row.rowNumber <= headerRow.rowNumber) continue;
      const values: RowValues = {};
      colField.forEach((f, i) => {
        if (f) values[f] = row.cells[i] ?? null;
      });
      if (Object.values(values).every((x) => x === null)) continue;
      inputs.push({ rowNumber: row.rowNumber, values, skipped: false });
    }
    if (!inputs.length) throw new UnprocessableEntityException('El archivo no tiene renglones con datos debajo del encabezado.');
    if (inputs.length > MAX_ROWS) throw new UnprocessableEntityException(`El archivo tiene ${inputs.length} renglones; el máximo por carga es ${MAX_ROWS}. Divídelo en varios archivos.`);

    const validated = await t.validate(this.db, inputs, actor);
    const byRow = new Map(validated.map((v) => [v.rowNumber, v]));

    const batchId = await this.db.transaction(async (tx) => {
      const [batch] = await tx
        .insert(dataImportBatches)
        .values({
          template: t.key,
          fileName: file.originalname.slice(0, 200),
          sheetName: sheet.sheetName,
          totalRows: inputs.length,
          fileMessages,
          createdById: actor.id,
        })
        .returning({ id: dataImportBatches.id });
      for (let i = 0; i < inputs.length; i += 500) {
        await tx.insert(dataImportRows).values(
          inputs.slice(i, i + 500).map((r) => {
            const v = byRow.get(r.rowNumber)!;
            return {
              batchId: batch.id,
              rowNumber: r.rowNumber,
              raw: r.values,
              status: statusOf(v.messages, false),
              action: v.action,
              messages: sortMessages(v.messages),
              plan: v.plan,
            };
          }),
        );
      }
      await this.audit.log(tx, actor, {
        action: 'CARGAR_IMPORTACION',
        module: 'productos',
        entity: 'data_import_batches',
        entityId: batch.id,
        summary: `Cargó ${file.originalname} para importar ${t.label} (${inputs.length} renglones)`,
      });
      return batch.id;
    });
    return this.get(batchId, actor);
  }

  // ───────────────────────────── Consulta ─────────────────────────────

  private async loadBatch(id: string, actor: Actor) {
    const [batch] = await this.db.select().from(dataImportBatches).where(eq(dataImportBatches.id, id));
    if (!batch) throw new NotFoundException('Importación no encontrada.');
    const t = this.template(batch.template, actor);
    return { batch, t };
  }

  async get(id: string, actor: Actor) {
    const { batch, t } = await this.loadBatch(id, actor);
    const byStatus = await this.db
      .select({ status: dataImportRows.status, n: countSql })
      .from(dataImportRows)
      .where(eq(dataImportRows.batchId, id))
      .groupBy(dataImportRows.status);
    const byAction = await this.db
      .select({ action: dataImportRows.action, n: countSql })
      .from(dataImportRows)
      .where(and(eq(dataImportRows.batchId, id), sql`${dataImportRows.status} in ('VALIDO', 'ADVERTENCIA')`))
      .groupBy(dataImportRows.action);
    const s = Object.fromEntries(byStatus.map((x) => [x.status, x.n])) as Record<RowStatus, number>;
    const a = Object.fromEntries(byAction.map((x) => [x.action ?? 'NINGUNA', x.n])) as Record<string, number>;
    // Campos con algún valor en el archivo (la vista previa sólo muestra esas columnas).
    const present = await this.db.execute<{ key: string }>(sql`
      select k.key from data_import_rows r, jsonb_each(r.raw || coalesce(r.edits, '{}'::jsonb)) k
       where r.batch_id = ${id} and k.value <> 'null'::jsonb
       group by k.key`);
    const presentFields = new Set(present.rows.map((r) => r.key));
    const [creator] = batch.createdById
      ? await this.db.select({ name: users.name }).from(users).where(eq(users.id, batch.createdById))
      : [];
    return {
      ...batch,
      createdByName: creator?.name ?? null,
      template: { key: t.key, label: t.label, columns: t.columns.map((c) => ({ field: c.field, header: c.header, inFile: presentFields.has(c.field) })) },
      summary: {
        valid: s.VALIDO ?? 0,
        warning: s.ADVERTENCIA ?? 0,
        error: s.ERROR ?? 0,
        skipped: s.OMITIDO ?? 0,
        toCreate: a.CREAR ?? 0,
        toUpdate: a.ACTUALIZAR ?? 0,
        unchanged: a.SIN_CAMBIOS ?? 0,
      },
    };
  }

  async rows(id: string, actor: Actor, f: { status?: string; action?: string; q?: string; page: number; pageSize: number }) {
    await this.loadBatch(id, actor);
    const conds: SQL[] = [eq(dataImportRows.batchId, id)];
    if (f.status) conds.push(eq(dataImportRows.status, f.status as RowStatus));
    if (f.action) conds.push(eq(dataImportRows.action, f.action as 'CREAR'));
    if (f.q) conds.push(sql`(coalesce(${dataImportRows.edits}, '{}'::jsonb) || ${dataImportRows.raw})::text ilike ${`%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`}`);
    const where = and(...conds);
    const [{ total }] = await this.db.select({ total: countSql }).from(dataImportRows).where(where);
    const items = await this.db
      .select()
      .from(dataImportRows)
      .where(where)
      .orderBy(
        sql`case ${dataImportRows.status} when 'ERROR' then 0 when 'ADVERTENCIA' then 1 when 'VALIDO' then 2 else 3 end`,
        asc(dataImportRows.rowNumber),
      )
      .limit(f.pageSize)
      .offset((f.page - 1) * f.pageSize);
    return {
      items: items.map((r) => ({ ...r, values: { ...(r.raw as RowValues), ...((r.edits as RowValues | null) ?? {}) } })),
      total,
      page: f.page,
      pageSize: f.pageSize,
    } satisfies Paged<unknown>;
  }

  async list(actor: Actor, page: number, pageSize: number) {
    const keys = TEMPLATES.filter((t) => t.permissions.every((p) => can(actor, p))).map((t) => t.key);
    if (!keys.length) return { items: [], total: 0, page, pageSize };
    const where = inArray(dataImportBatches.template, keys);
    const [{ total }] = await this.db.select({ total: countSql }).from(dataImportBatches).where(where);
    const items = await this.db
      .select({
        id: dataImportBatches.id,
        template: dataImportBatches.template,
        fileName: dataImportBatches.fileName,
        status: dataImportBatches.status,
        totalRows: dataImportBatches.totalRows,
        result: dataImportBatches.result,
        createdAt: dataImportBatches.createdAt,
        appliedAt: dataImportBatches.appliedAt,
        createdByName: users.name,
      })
      .from(dataImportBatches)
      .leftJoin(users, eq(users.id, dataImportBatches.createdById))
      .where(where)
      .orderBy(desc(dataImportBatches.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return { items: items.map((i) => ({ ...i, templateLabel: TEMPLATES.find((t) => t.key === i.template)?.label ?? i.template })), total, page, pageSize };
  }

  // ───────────────────────────── Corrección y revalidación ─────────────────────────────

  /** Valida otra vez todo el lote con los datos actuales (los duplicados y conflictos pueden cambiar). */
  private async revalidate(db: DbOrTx, batchId: string, t: AnyTemplate, actor: Actor): Promise<ValidatedRow[]> {
    const rows = await db.select().from(dataImportRows).where(eq(dataImportRows.batchId, batchId)).orderBy(asc(dataImportRows.rowNumber));
    const inputs: InputRow[] = rows.map((r) => ({
      rowNumber: r.rowNumber,
      values: { ...(r.raw as RowValues), ...((r.edits as RowValues | null) ?? {}) },
      skipped: r.skipped,
    }));
    const validated = await t.validate(db, inputs, actor);
    const idByRow = new Map(rows.map((r) => [r.rowNumber, r]));
    const updates = validated.map((v) => {
      const r = idByRow.get(v.rowNumber)!;
      return { id: r.id, status: statusOf(v.messages, r.skipped), action: v.action, messages: sortMessages(v.messages), plan: v.plan };
    });
    for (let i = 0; i < updates.length; i += 1000) {
      const chunk = JSON.stringify(updates.slice(i, i + 1000));
      await db.execute(sql`
        update data_import_rows d
           set status = x.status::import_row_status,
               action = x.action::import_row_action,
               messages = x.messages,
               plan = x.plan
          from jsonb_to_recordset(${chunk}::jsonb) as x(id bigint, status text, action text, messages jsonb, plan jsonb)
         where d.id = x.id`);
    }
    await db.update(dataImportBatches).set({ validatedAt: new Date() }).where(eq(dataImportBatches.id, batchId));
    return validated;
  }

  async patchRow(batchId: string, rowId: number, body: { values?: Record<string, string | null>; skipped?: boolean }, actor: Actor) {
    const { batch, t } = await this.loadBatch(batchId, actor);
    if (batch.status !== 'VALIDADO') throw new ConflictException('Esta importación ya no admite cambios.');
    const [row] = await this.db
      .select()
      .from(dataImportRows)
      .where(and(eq(dataImportRows.id, rowId), eq(dataImportRows.batchId, batchId)));
    if (!row) throw new NotFoundException('Renglón no encontrado.');
    const fields = new Set(t.columns.map((c) => c.field));
    const patch: Partial<typeof dataImportRows.$inferInsert> = {};
    if (body.values) {
      const edits: RowValues = { ...((row.edits as RowValues | null) ?? {}) };
      for (const [k, val] of Object.entries(body.values)) {
        if (!fields.has(k)) throw new BadRequestException(`Campo desconocido: ${k}`);
        const clean = val === null ? null : val.replace(/[ ​-‍﻿]/g, ' ').trim() || null;
        const original = (row.raw as RowValues)[k] ?? null;
        if (clean === original) delete edits[k];
        else edits[k] = clean;
      }
      patch.edits = Object.keys(edits).length ? edits : null;
    }
    if (body.skipped !== undefined) patch.skipped = body.skipped;
    await this.db.update(dataImportRows).set(patch).where(eq(dataImportRows.id, rowId));
    await this.revalidate(this.db, batchId, t, actor);
    return this.get(batchId, actor);
  }

  async refresh(batchId: string, actor: Actor) {
    const { batch, t } = await this.loadBatch(batchId, actor);
    if (batch.status !== 'VALIDADO') throw new ConflictException('Esta importación ya no admite cambios.');
    await this.revalidate(this.db, batchId, t, actor);
    return this.get(batchId, actor);
  }

  // ───────────────────────────── Aplicar ─────────────────────────────

  async apply(batchId: string, actor: Actor) {
    const { t } = await this.loadBatch(batchId, actor);
    await this.db.transaction(async (tx) => {
      const [batch] = await tx.select().from(dataImportBatches).where(eq(dataImportBatches.id, batchId)).for('update');
      if (batch.status !== 'VALIDADO') throw new ConflictException('Esta importación ya se aplicó o se canceló.');
      // Se valida otra vez dentro de la transacción: los datos pudieron cambiar desde la vista previa.
      const validated = await this.revalidate(tx, batchId, t, actor);
      const rows = await tx.select({ rowNumber: dataImportRows.rowNumber, skipped: dataImportRows.skipped }).from(dataImportRows).where(eq(dataImportRows.batchId, batchId));
      const skipped = new Set(rows.filter((r) => r.skipped).map((r) => r.rowNumber));
      const errors = validated.filter((v) => !skipped.has(v.rowNumber) && v.messages.some((m) => m.level === 'error'));
      if (errors.length) {
        throw new UnprocessableEntityException(
          `Hay ${errors.length} renglones con error (${errors.slice(0, 10).map((e) => e.rowNumber).join(', ')}${errors.length > 10 ? '…' : ''}). Corrígelos u omítelos antes de importar.`,
        );
      }
      const toApply = validated
        .filter((v) => !skipped.has(v.rowNumber) && v.plan && v.action !== 'SIN_CAMBIOS')
        .map((v) => ({ rowNumber: v.rowNumber, plan: v.plan }));
      const result = toApply.length
        ? await t.apply(tx, toApply, { actor, audit: this.audit, batchLabel: batch.fileName, batchId: batch.id })
        : {};
      const summary = { ...result, renglonesAplicados: toApply.length, renglonesOmitidos: skipped.size, sinCambios: validated.filter((v) => !skipped.has(v.rowNumber) && v.action === 'SIN_CAMBIOS').length };
      await tx
        .update(dataImportBatches)
        .set({ status: 'APLICADO', result: summary, appliedAt: new Date(), appliedById: actor.id })
        .where(eq(dataImportBatches.id, batchId));
      await this.audit.log(tx, actor, {
        action: 'APLICAR_IMPORTACION',
        module: 'productos',
        entity: 'data_import_batches',
        entityId: batchId,
        summary: `Importó ${batch.fileName}: ${toApply.length} renglones aplicados, ${skipped.size} omitidos`,
        newValues: summary,
      });
    });
    return this.get(batchId, actor);
  }

  async cancel(batchId: string, actor: Actor) {
    const { batch } = await this.loadBatch(batchId, actor);
    if (batch.status !== 'VALIDADO') throw new ConflictException('Sólo se cancela una importación por confirmar.');
    await this.db.update(dataImportBatches).set({ status: 'CANCELADO' }).where(eq(dataImportBatches.id, batchId));
    await this.audit.log(this.db, actor, {
      action: 'CANCELAR_IMPORTACION',
      module: 'productos',
      entity: 'data_import_batches',
      entityId: batchId,
      summary: `Canceló la importación de ${batch.fileName}`,
    });
    return this.get(batchId, actor);
  }
}
