import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import {
  importContainerLines,
  importContainers,
  purchaseOrderItems,
  purchaseOrderPayments,
  purchaseOrders,
  suppliers,
  type Db,
  type DbOrTx,
} from '@erp/db';
import { nextFolio } from '@erp/domain';
import { listQuerySchema } from '@erp/shared';
import { z } from 'zod';
import { can, type Actor } from '../common/actor';
import { InjectDb } from '../common/db';
import { diff } from '../common/diff';
import { likePattern, str } from '../common/listing';
import { onlyPresent, parse } from '../common/zod';
import { AuditService } from '../audit/audit.service';
import { normHeader, parseFile, UnsupportedFileError, type ParsedSheet } from '../imports/parse';
import { AttachmentsService } from './attachments.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD');
const CURRENCIES = ['MXN', 'USD', 'CNY'] as const;
export const PO_STATUS = ['BORRADOR', 'ENVIADA', 'CONFIRMADA', 'RECIBIDA', 'CANCELADA'] as const;
/** Contenedores a los que ya no se agregan renglones. */
const CLOSED_CONTAINER = ['RECIBIDO', 'CANCELADO', 'PERDIDO'];

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);
const fx = z.coerce.number().positive('Debe ser mayor que 0').max(10_000).nullish().transform((v) => v ?? null);
const price = z.coerce.number().min(0, 'No puede ser negativo').max(10_000_000).nullish().transform((v) => v ?? null);

const headerSchema = z.object({
  supplierRef: optText(80),
  orderDate: isoDate,
  currency: z.enum(CURRENCIES),
  fxRate: fx,
  incoterm: optText(20),
  paymentTerms: optText(200),
  expectedDate: isoDate.nullish().transform((v) => v ?? null),
  notes: optText(2000),
});
const itemSchema = z.object({
  skuId: z.string().uuid('Elige un SKU'),
  qty: z.coerce.number().int('Piezas enteras').positive('Debe ser mayor que 0').max(1_000_000),
  unitPrice: price,
  supplierSku: optText(80),
  notes: optText(500),
});
const createSchema = headerSchema.partial({ currency: true }).extend({
  supplierId: z.string().uuid('Elige el proveedor'),
  items: z.array(itemSchema).max(500).optional(),
});
const paymentSchema = z.object({
  paidAt: isoDate,
  amount: z.coerce.number().positive('Debe ser mayor que 0').max(100_000_000),
  fxRate: fx,
  reference: optText(120),
  notes: optText(500),
});

export interface ImportRowPreview {
  row: number;
  code: string;
  skuId: string | null;
  skuCode: string | null;
  name: string | null;
  qty: number | null;
  unitPrice: number | null;
  supplierSku: string | null;
  action: 'NUEVO' | 'ACTUALIZA' | 'ERROR';
  message: string | null;
}

const toNumber = (v: string | null): number | null => {
  if (v === null) return null;
  const s = v.replace(/[$,\s]/g, '').replace(/^(USD|MXN|US)/i, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};

/** Columnas de una hoja de pedido: SKU y piezas obligatorias; precio y código del proveedor opcionales. */
function findHeader(sheet: ParsedSheet) {
  for (const r of sheet.rows.slice(0, 25)) {
    const hs = r.cells.map((c) => (c ? normHeader(c) : ''));
    const words = hs.map((h) => new Set(h.split(' ')));
    const has = (i: number, ...w: string[]) => w.some((x) => words[i].has(x));
    const idx = (pred: (i: number) => boolean) => hs.findIndex((h, i) => h !== '' && pred(i));
    const sku = idx((i) => (has(i, 'SKU', 'FNSKU') || hs[i] === 'CODIGO' || hs[i] === 'CODIGO ZANETTI') && !has(i, 'PROVEEDOR', 'SUPPLIER'));
    const qty = idx((i) => has(i, 'PIEZAS', 'PIECES', 'CANTIDAD', 'QTY', 'QUANTITY', 'UNIDADES', 'PZAS') && !has(i, 'CAJA', 'CAJAS', 'CARTON', 'CARTONS', 'POR', 'PER', 'BOX', 'CTN', 'CTNS'));
    if (sku < 0 || qty < 0) continue;
    const priceCol = idx((i) => has(i, 'PRECIO', 'PRICE', 'COSTO', 'COST', 'FOB') && !has(i, 'TOTAL', 'IMPORTE', 'AMOUNT'));
    const supplierSku = idx((i) => (has(i, 'SUPPLIER') && has(i, 'CODE')) || (has(i, 'CODIGO') && has(i, 'PROVEEDOR')) || has(i, 'MODELO', 'MODEL'));
    return { headerRow: r.rowNumber, sku, qty, price: priceCol, supplierSku };
  }
  return null;
}

@Injectable()
export class PurchasingService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly files: AttachmentsService,
  ) {}

  // ───────────────────────────── Consultas ─────────────────────────────

  async list(query: Record<string, unknown>, actor: Actor) {
    const { page, pageSize, q } = listQuerySchema.parse(query);
    const costs = can(actor, 'costos.ver');
    const conds: SQL[] = [sql`true`];
    const status = str(query.status);
    if (status) conds.push(sql`po.status::text = ANY(${status.split(',')})`);
    const supplier = str(query.supplierId);
    if (supplier) conds.push(sql`po.supplier_id = ${supplier}::uuid`);
    if (q) {
      const p = likePattern(q);
      conds.push(sql`(po.folio ILIKE ${p} OR po.supplier_ref ILIKE ${p} OR s.name ILIKE ${p}
        OR EXISTS (SELECT 1 FROM purchase_order_items i JOIN master_skus m ON m.id = i.master_sku_id WHERE i.po_id = po.id AND m.sku_code ILIKE ${p}))`);
    }
    const where = sql.join(conds, sql` AND `);
    const [{ total }] = (await this.db.execute<{ total: number }>(sql`SELECT count(*)::int total FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE ${where}`)).rows;
    const rows = (
      await this.db.execute<Record<string, unknown>>(sql`
        SELECT po.id, po.folio, po.supplier_id, s.name supplier, po.supplier_ref, po.order_date, po.expected_date, po.currency, po.fx_rate,
               po.status, coalesce(it.pieces, 0)::int pieces, coalesce(it.skus, 0)::int skus, it.total, coalesce(it.unpriced, 0)::int unpriced,
               pay.paid, ct.codes containers
          FROM purchase_orders po
          JOIN suppliers s ON s.id = po.supplier_id
          LEFT JOIN LATERAL (SELECT sum(qty) pieces, count(*) skus, sum(qty * unit_price)::numeric(16, 2) total,
                                    count(*) FILTER (WHERE unit_price IS NULL) unpriced
                               FROM purchase_order_items i WHERE i.po_id = po.id) it ON true
          LEFT JOIN LATERAL (SELECT sum(amount)::numeric(16, 2) paid FROM purchase_order_payments p WHERE p.po_id = po.id) pay ON true
          LEFT JOIN LATERAL (SELECT string_agg(DISTINCT c.code, ', ' ORDER BY c.code) codes
                               FROM import_container_lines l
                               JOIN purchase_order_items i ON i.id = l.po_item_id
                               JOIN import_containers c ON c.id = l.container_id
                              WHERE i.po_id = po.id AND c.status <> 'CANCELADO') ct ON true
         WHERE ${where}
         ORDER BY po.order_date DESC, po.folio DESC
         LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`)
    ).rows;
    return {
      items: rows.map((r) => ({
        id: r.id,
        folio: r.folio,
        supplierId: r.supplier_id,
        supplier: r.supplier,
        supplierRef: r.supplier_ref,
        orderDate: r.order_date,
        expectedDate: r.expected_date,
        currency: r.currency,
        status: r.status,
        pieces: r.pieces,
        skus: r.skus,
        containers: r.containers ?? null,
        ...(costs ? { fxRate: r.fx_rate, total: r.total ?? '0.00', unpriced: r.unpriced, paid: r.paid ?? '0.00' } : {}),
      })),
      total,
      page,
      pageSize,
    };
  }

  async get(id: string, actor: Actor) {
    const costs = can(actor, 'costos.ver');
    const [po] = (
      await this.db.execute<Record<string, unknown>>(sql`
        SELECT po.*, s.name supplier, s.currency_code supplier_currency FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = ${id}::uuid`)
    ).rows;
    if (!po) throw new NotFoundException('Orden de compra no encontrada.');
    const items = (
      await this.db.execute<Record<string, unknown>>(sql`
        SELECT i.id, i.line_no, i.master_sku_id sku_id, m.sku_code, m.name, i.supplier_sku, i.qty, i.unit_price, i.notes,
               pk.units_per_package case_units, (pk.length_mm::numeric * pk.width_mm * pk.height_mm / 1e9) cbm_case,
               coalesce(cl.qty, 0)::int in_containers, cl.codes containers
          FROM purchase_order_items i
          JOIN master_skus m ON m.id = i.master_sku_id
          LEFT JOIN LATERAL (SELECT * FROM sku_packages p WHERE p.master_sku_id = m.id AND p.type = 'CAJA_MASTER' ORDER BY p.units_per_package DESC LIMIT 1) pk ON true
          LEFT JOIN LATERAL (SELECT sum(l.qty) qty, string_agg(c.code, ', ' ORDER BY c.code) codes
                               FROM import_container_lines l JOIN import_containers c ON c.id = l.container_id
                              WHERE l.po_item_id = i.id AND c.status <> 'CANCELADO') cl ON true
         WHERE i.po_id = ${id}::uuid
         ORDER BY i.line_no`)
    ).rows;
    const containers = (
      await this.db.execute<Record<string, unknown>>(sql`
        SELECT c.id, c.code, c.status, c.cost_status, sum(l.qty)::int pieces
          FROM import_container_lines l
          JOIN purchase_order_items i ON i.id = l.po_item_id
          JOIN import_containers c ON c.id = l.container_id
         WHERE i.po_id = ${id}::uuid
         GROUP BY c.id ORDER BY c.code`)
    ).rows;
    const payments = costs
      ? await this.db.select().from(purchaseOrderPayments).where(eq(purchaseOrderPayments.poId, id)).orderBy(purchaseOrderPayments.paidAt)
      : [];
    const lines = items.map((r) => {
      const qty = Number(r.qty);
      const cases = r.case_units ? qty / Number(r.case_units) : null;
      return {
        id: r.id as string,
        lineNo: r.line_no as number,
        skuId: r.sku_id as string,
        skuCode: r.sku_code as string,
        name: r.name as string,
        supplierSku: r.supplier_sku as string | null,
        qty,
        caseUnits: r.case_units ? Number(r.case_units) : null,
        cases,
        cbm: cases !== null && r.cbm_case ? cases * Number(r.cbm_case) : null,
        inContainers: Number(r.in_containers),
        containers: (r.containers as string | null) ?? null,
        notes: r.notes as string | null,
        ...(costs ? { unitPrice: r.unit_price as string | null, amount: r.unit_price === null ? null : (qty * Number(r.unit_price)).toFixed(2) } : {}),
      };
    });
    const total = lines.reduce((a, l) => a + Number((l as { amount?: string | null }).amount ?? 0), 0);
    const paid = payments.reduce((a, p) => a + Number(p.amount), 0);
    return {
      id: po.id,
      folio: po.folio,
      supplierId: po.supplier_id,
      supplier: po.supplier,
      supplierRef: po.supplier_ref,
      orderDate: po.order_date,
      expectedDate: po.expected_date,
      currency: po.currency,
      incoterm: po.incoterm,
      paymentTerms: po.payment_terms,
      status: po.status,
      notes: po.notes,
      createdAt: po.created_at,
      pieces: lines.reduce((a, l) => a + l.qty, 0),
      cbm: lines.reduce((a, l) => a + (l.cbm ?? 0), 0),
      unpriced: lines.filter((l) => (l as { unitPrice?: string | null }).unitPrice === null).length,
      items: lines,
      containers: containers.map((c) => ({ id: c.id, code: c.code, status: c.status, costStatus: c.cost_status, pieces: c.pieces })),
      ...(costs
        ? {
            fxRate: po.fx_rate,
            total: total.toFixed(2),
            paid: paid.toFixed(2),
            balance: (total - paid).toFixed(2),
            payments: payments.map((p) => ({ ...p, amountMxn: p.fxRate ? (Number(p.amount) * Number(p.fxRate)).toFixed(2) : po.currency === 'MXN' ? p.amount : null })),
          }
        : {}),
    };
  }

  // ───────────────────────────── Encabezado ─────────────────────────────

  async create(body: unknown, actor: Actor) {
    const data = parse(createSchema, body);
    if (data.items?.some((i) => i.unitPrice !== null) && !can(actor, 'costos.ver')) throw new ForbiddenException('No tienes permiso para capturar precios.');
    if (data.fxRate !== null && data.fxRate !== undefined && !can(actor, 'costos.ver')) throw new ForbiddenException('No tienes permiso para capturar el tipo de cambio.');
    return this.db.transaction(async (tx) => {
      const [sup] = await tx.select().from(suppliers).where(eq(suppliers.id, data.supplierId));
      if (!sup) throw new NotFoundException('Proveedor no encontrado.');
      const folio = await nextFolio(tx, 'OC');
      const [po] = await tx
        .insert(purchaseOrders)
        .values({
          folio,
          supplierId: sup.id,
          supplierRef: data.supplierRef ?? null,
          orderDate: data.orderDate,
          currency: data.currency ?? (sup.currencyCode as 'USD'),
          fxRate: data.fxRate === null || data.fxRate === undefined ? null : String(data.fxRate),
          incoterm: data.incoterm ?? null,
          paymentTerms: data.paymentTerms ?? sup.paymentTerms ?? null,
          expectedDate: data.expectedDate ?? null,
          notes: data.notes ?? null,
          createdById: actor.id,
          updatedById: actor.id,
        })
        .returning();
      const seen = new Set<string>();
      let n = 0;
      for (const it of data.items ?? []) {
        if (seen.has(it.skuId)) throw new BadRequestException('Un SKU aparece dos veces en la orden.');
        seen.add(it.skuId);
        await tx.insert(purchaseOrderItems).values({ poId: po.id, lineNo: ++n, masterSkuId: it.skuId, qty: it.qty, unitPrice: it.unitPrice === null ? null : String(it.unitPrice), supplierSku: it.supplierSku, notes: it.notes });
      }
      await this.audit.log(tx, actor, { action: 'CREAR', module: 'compras', entity: 'purchase_orders', entityId: po.id, summary: `Creó la orden de compra ${folio} a ${sup.name}` });
      return po;
    });
  }

  async update(id: string, body: unknown, actor: Actor) {
    const data = onlyPresent(parse(headerSchema.partial().extend({ status: z.enum(PO_STATUS).optional() }), body), body);
    if (data.fxRate !== undefined && !can(actor, 'costos.ver')) throw new ForbiddenException('No tienes permiso para capturar el tipo de cambio.');
    return this.db.transaction(async (tx) => {
      const before = await this.lockPo(tx, id);
      if (before.status === 'CANCELADA' && (data.status === undefined || data.status === 'CANCELADA'))
        throw new ConflictException('La orden está cancelada. Cambia su estado para editarla.');
      if (data.status === 'CANCELADA') {
        const [inUse] = (
          await tx.execute<{ codes: string | null }>(sql`
            SELECT string_agg(DISTINCT c.code, ', ') codes FROM import_container_lines l
              JOIN purchase_order_items i ON i.id = l.po_item_id JOIN import_containers c ON c.id = l.container_id
             WHERE i.po_id = ${id}::uuid AND c.status <> 'CANCELADO'`)
        ).rows;
        if (inUse?.codes) throw new ConflictException(`La orden tiene renglones en ${inUse.codes}. Quítalos del contenedor antes de cancelarla.`);
      }
      const { fxRate, ...rest } = data;
      const [after] = await tx
        .update(purchaseOrders)
        .set({ ...rest, ...(fxRate !== undefined ? { fxRate: fxRate === null ? null : String(fxRate) } : {}), updatedById: actor.id })
        .where(eq(purchaseOrders.id, id))
        .returning();
      const d = diff(before, after);
      if (d.newValues) await this.audit.log(tx, actor, { action: 'EDITAR', module: 'compras', entity: 'purchase_orders', entityId: id, summary: `Editó la orden ${after.folio}`, ...d });
      return after;
    });
  }

  private async lockPo(tx: DbOrTx, id: string) {
    const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)).for('update');
    if (!po) throw new NotFoundException('Orden de compra no encontrada.');
    return po;
  }

  private assertEditable(po: { status: string; folio: string }) {
    if (po.status === 'CANCELADA' || po.status === 'RECIBIDA') throw new ConflictException(`La orden ${po.folio} está ${po.status.toLowerCase()}: ya no se cambian sus renglones.`);
  }

  // ───────────────────────────── Renglones ─────────────────────────────

  /** Agrega un SKU o, si ya está en la orden, cambia sus piezas y precio. */
  async upsertItem(id: string, body: unknown, actor: Actor) {
    const data = parse(itemSchema, body);
    if (data.unitPrice !== null && !can(actor, 'costos.ver')) throw new ForbiddenException('No tienes permiso para capturar precios.');
    return this.db.transaction(async (tx) => {
      const po = await this.lockPo(tx, id);
      this.assertEditable(po);
      const r = await this.writeItem(tx, po.id, data);
      await this.audit.log(tx, actor, { action: 'EDITAR', module: 'compras', entity: 'purchase_orders', entityId: id, summary: `${r.created ? 'Agregó' : 'Cambió'} ${r.skuCode} en la orden ${po.folio}: ${data.qty} pzas` });
      return r;
    });
  }

  private async writeItem(
    tx: DbOrTx,
    poId: string,
    data: { skuId: string; qty: number; unitPrice: number | null; supplierSku?: string | null; notes?: string | null },
    keepPriceIfNull = false,
  ) {
    const [sku] = (await tx.execute<{ code: string; is_kit: boolean }>(sql`SELECT sku_code code, is_kit FROM master_skus WHERE id = ${data.skuId}::uuid`)).rows;
    if (!sku) throw new NotFoundException('SKU no encontrado.');
    const [existing] = await tx.select().from(purchaseOrderItems).where(and(eq(purchaseOrderItems.poId, poId), eq(purchaseOrderItems.masterSkuId, data.skuId)));
    if (existing) {
      const inCont = await this.qtyInContainers(tx, existing.id);
      if (data.qty < inCont) throw new ConflictException(`${sku.code}: ya hay ${inCont} piezas en contenedores; no se puede bajar a ${data.qty}.`);
      await tx
        .update(purchaseOrderItems)
        .set({
          qty: data.qty,
          ...(keepPriceIfNull && data.unitPrice === null ? {} : { unitPrice: data.unitPrice === null ? null : String(data.unitPrice) }),
          ...(data.supplierSku !== undefined && !(keepPriceIfNull && data.supplierSku === null) ? { supplierSku: data.supplierSku } : {}),
          ...(data.notes !== undefined && !(keepPriceIfNull && data.notes === null) ? { notes: data.notes } : {}),
        })
        .where(eq(purchaseOrderItems.id, existing.id));
      return { id: existing.id, skuCode: sku.code, created: false };
    }
    const [{ n }] = (await tx.execute<{ n: number }>(sql`SELECT coalesce(max(line_no), 0)::int + 1 n FROM purchase_order_items WHERE po_id = ${poId}::uuid`)).rows;
    const [row] = await tx
      .insert(purchaseOrderItems)
      .values({ poId, lineNo: n, masterSkuId: data.skuId, qty: data.qty, unitPrice: data.unitPrice === null ? null : String(data.unitPrice), supplierSku: data.supplierSku ?? null, notes: data.notes ?? null })
      .returning({ id: purchaseOrderItems.id });
    return { id: row.id, skuCode: sku.code, created: true };
  }

  private async qtyInContainers(tx: DbOrTx, itemId: string) {
    const [r] = (
      await tx.execute<{ q: number }>(sql`
        SELECT coalesce(sum(l.qty), 0)::int q FROM import_container_lines l JOIN import_containers c ON c.id = l.container_id
         WHERE l.po_item_id = ${itemId}::uuid AND c.status <> 'CANCELADO'`)
    ).rows;
    return Number(r?.q ?? 0);
  }

  async updateItem(id: string, itemId: string, body: unknown, actor: Actor) {
    const data = onlyPresent(parse(itemSchema.omit({ skuId: true }).partial(), body), body);
    if (data.unitPrice !== undefined && data.unitPrice !== null && !can(actor, 'costos.ver')) throw new ForbiddenException('No tienes permiso para capturar precios.');
    return this.db.transaction(async (tx) => {
      const po = await this.lockPo(tx, id);
      this.assertEditable(po);
      const [item] = await tx.select().from(purchaseOrderItems).where(and(eq(purchaseOrderItems.id, itemId), eq(purchaseOrderItems.poId, id)));
      if (!item) throw new NotFoundException('Renglón no encontrado.');
      return this.writeItem(tx, id, {
        skuId: item.masterSkuId,
        qty: data.qty ?? item.qty,
        unitPrice: data.unitPrice === undefined ? (item.unitPrice === null ? null : Number(item.unitPrice)) : data.unitPrice,
        supplierSku: data.supplierSku,
        notes: data.notes,
      });
    });
  }

  async deleteItem(id: string, itemId: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const po = await this.lockPo(tx, id);
      this.assertEditable(po);
      const [item] = (
        await tx.execute<{ code: string; codes: string | null }>(sql`
          SELECT m.sku_code code, (SELECT string_agg(DISTINCT c.code, ', ') FROM import_container_lines l JOIN import_containers c ON c.id = l.container_id
                                    WHERE l.po_item_id = i.id AND c.status <> 'CANCELADO') codes
            FROM purchase_order_items i JOIN master_skus m ON m.id = i.master_sku_id WHERE i.id = ${itemId}::uuid AND i.po_id = ${id}::uuid`)
      ).rows;
      if (!item) throw new NotFoundException('Renglón no encontrado.');
      if (item.codes) throw new ConflictException(`${item.code} ya está en ${item.codes}. Quítalo del contenedor primero.`);
      await tx.delete(purchaseOrderItems).where(eq(purchaseOrderItems.id, itemId));
      await this.audit.log(tx, actor, { action: 'EDITAR', module: 'compras', entity: 'purchase_orders', entityId: id, summary: `Quitó ${item.code} de la orden ${po.folio}` });
      return { ok: true };
    });
  }

  // ───────────────────────────── Carga desde Excel ─────────────────────────────

  /**
   * Lee una hoja de pedido (SKU, piezas y, si viene, precio y código del proveedor). Sin `apply` sólo muestra qué
   * haría; con `apply` agrega o actualiza los renglones (y con `replace` quita los que no vienen en el archivo).
   */
  async importLines(
    id: string,
    file: { buffer: Buffer; originalname: string; mimetype: string; size: number } | undefined,
    opts: { sheet?: string; apply?: boolean; replace?: boolean; attach?: boolean },
    actor: Actor,
  ) {
    if (!file) throw new BadRequestException('Adjunta el archivo de la orden (.xlsx o .csv).');
    let sheets: ParsedSheet[];
    try {
      sheets = await parseFile(file.buffer, file.originalname);
    } catch (e) {
      if (e instanceof UnsupportedFileError) throw new BadRequestException(e.message);
      throw new BadRequestException('No se pudo leer el archivo. ¿Es un Excel válido?');
    }
    const po = await this.get(id, actor);
    const valid = sheets.map((s) => ({ s, h: findHeader(s) })).filter((x) => x.h);
    if (!valid.length) throw new BadRequestException('No encontré una hoja con columnas de SKU y piezas (PIEZAS, PIECES, CANTIDAD o QTY).');
    const supplierKey = normHeader(String(po.supplier));
    const pick =
      (opts.sheet && valid.find((x) => x.s.sheetName === opts.sheet)) ||
      valid.find((x) => normHeader(x.s.sheetName).includes(supplierKey)) ||
      valid.find((x) => supplierKey.split(' ').some((w) => w.length > 3 && normHeader(x.s.sheetName).includes(w))) ||
      valid[0];
    const h = pick.h!;
    const costs = can(actor, 'costos.ver');
    const resolver = await this.skuResolver();
    const existing = new Map(po.items.map((i) => [i.skuId, i]));
    const bySku = new Map<string, ImportRowPreview>();
    const rows: ImportRowPreview[] = [];
    for (const r of pick.s.rows) {
      if (r.rowNumber <= h.headerRow) continue;
      const code = r.cells[h.sku]?.trim() ?? '';
      if (!code) continue;
      const qty = toNumber(r.cells[h.qty] ?? null);
      const priceV = h.price >= 0 && costs ? toNumber(r.cells[h.price] ?? null) : null;
      const supplierSku = h.supplierSku >= 0 ? (r.cells[h.supplierSku] ?? null) : null;
      const sku = resolver(code);
      const row: ImportRowPreview = { row: r.rowNumber, code, skuId: sku?.id ?? null, skuCode: sku?.code ?? null, name: sku?.name ?? null, qty, unitPrice: priceV, supplierSku, action: 'NUEVO', message: null };
      if (normHeader(code) === 'TOTAL') continue;
      if (!sku) Object.assign(row, { action: 'ERROR', message: 'No existe ese SKU (ni como equivalencia o código de barras).' });
      else if (qty === null || Number.isNaN(qty) || qty <= 0 || !Number.isInteger(qty)) Object.assign(row, { action: 'ERROR', message: 'Piezas inválidas.' });
      else if (priceV !== null && (Number.isNaN(priceV) || priceV < 0)) Object.assign(row, { action: 'ERROR', message: 'Precio inválido.' });
      else {
        const prev = bySku.get(sku.id);
        if (prev) {
          prev.qty = (prev.qty ?? 0) + qty;
          if (priceV !== null) prev.unitPrice = priceV;
          prev.message = `Viene en varios renglones; se suman (${prev.qty} pzas).`;
          continue;
        }
        const ex = existing.get(sku.id);
        if (ex) {
          row.action = 'ACTUALIZA';
          if (ex.inContainers > qty) Object.assign(row, { action: 'ERROR', message: `Ya hay ${ex.inContainers} pzas en contenedores.` });
        }
        bySku.set(sku.id, row);
      }
      rows.push(row);
    }
    const ok = rows.filter((r) => r.action !== 'ERROR');
    const removed = opts.replace ? po.items.filter((i) => !bySku.has(i.skuId)) : [];
    const blockedRemoval = removed.filter((i) => i.inContainers > 0);
    const summary = {
      sheet: pick.s.sheetName,
      sheets: valid.map((x) => x.s.sheetName),
      columns: { sku: true, qty: true, price: h.price >= 0, supplierSku: h.supplierSku >= 0 },
      new: ok.filter((r) => r.action === 'NUEVO').length,
      updated: ok.filter((r) => r.action === 'ACTUALIZA').length,
      errors: rows.filter((r) => r.action === 'ERROR').length,
      removed: removed.map((i) => i.skuCode),
      pieces: ok.reduce((a, r) => a + (r.qty ?? 0), 0),
      priceIgnored: h.price >= 0 && !costs,
    };
    if (!opts.apply) return { applied: false, summary, rows };
    if (summary.errors) throw new ConflictException(`El archivo tiene ${summary.errors} renglón(es) con error; corrígelos y vuelve a cargarlo.`);
    if (blockedRemoval.length) throw new ConflictException(`No se pueden quitar ${blockedRemoval.map((i) => i.skuCode).join(', ')}: ya están en un contenedor.`);
    if (!ok.length) throw new BadRequestException('El archivo no trae renglones.');
    await this.db.transaction(async (tx) => {
      const locked = await this.lockPo(tx, id);
      this.assertEditable(locked);
      for (const r of ok) await this.writeItem(tx, id, { skuId: r.skuId!, qty: r.qty!, unitPrice: r.unitPrice, supplierSku: r.supplierSku }, true);
      for (const i of removed) await tx.delete(purchaseOrderItems).where(eq(purchaseOrderItems.id, i.id));
      await this.audit.log(tx, actor, {
        action: 'IMPORTAR',
        module: 'compras',
        entity: 'purchase_orders',
        entityId: id,
        summary: `Cargó ${file.originalname} en la orden ${locked.folio}: ${summary.new} nuevos, ${summary.updated} actualizados${removed.length ? `, ${removed.length} quitados` : ''}`,
      });
      if (opts.attach !== false) await this.files.store(tx, { entityType: 'PURCHASE_ORDER', entityId: id, kind: 'ORDEN', file, notes: `Cargado en renglones (hoja ${pick.s.sheetName})` }, actor);
    });
    return { applied: true, summary, rows };
  }

  /** Código → SKU maestro: código del SKU, equivalencia de 1 pieza o código de barras. */
  private async skuResolver() {
    const rows = (
      await this.db.execute<{ code: string; id: string; sku_code: string; name: string }>(sql`
        SELECT upper(s.sku_code) code, s.id, s.sku_code, s.name FROM master_skus s WHERE NOT s.is_kit
        UNION ALL
        SELECT upper(a.code), s.id, s.sku_code, s.name FROM sku_aliases a JOIN master_skus s ON s.id = a.master_sku_id WHERE a.multiplier = 1 AND NOT s.is_kit
        UNION ALL
        SELECT upper(b.barcode), s.id, s.sku_code, s.name FROM sku_barcodes b JOIN master_skus s ON s.id = b.master_sku_id WHERE NOT s.is_kit`)
    ).rows;
    const map = new Map<string, { id: string; code: string; name: string }>();
    for (const r of rows) if (!map.has(r.code)) map.set(r.code, { id: r.id, code: r.sku_code, name: r.name });
    return (code: string) => map.get(code.trim().toUpperCase()) ?? null;
  }

  // ───────────────────────────── Pagos ─────────────────────────────

  async addPayment(id: string, body: unknown, actor: Actor) {
    const data = parse(paymentSchema, body);
    return this.db.transaction(async (tx) => {
      const po = await this.lockPo(tx, id);
      if (po.status === 'CANCELADA') throw new ConflictException('La orden está cancelada.');
      const [p] = await tx
        .insert(purchaseOrderPayments)
        .values({ poId: id, paidAt: data.paidAt, amount: data.amount.toFixed(2), fxRate: data.fxRate === null ? null : String(data.fxRate), reference: data.reference, notes: data.notes, createdById: actor.id })
        .returning();
      await this.audit.log(tx, actor, { action: 'CREAR', module: 'compras', entity: 'purchase_order_payments', entityId: p.id, summary: `Registró un pago de ${data.amount.toFixed(2)} ${po.currency} a la orden ${po.folio}` });
      return p;
    });
  }

  async deletePayment(id: string, paymentId: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const po = await this.lockPo(tx, id);
      const [p] = await tx.delete(purchaseOrderPayments).where(and(eq(purchaseOrderPayments.id, paymentId), eq(purchaseOrderPayments.poId, id))).returning();
      if (!p) throw new NotFoundException('Pago no encontrado.');
      await this.audit.log(tx, actor, { action: 'ELIMINAR', module: 'compras', entity: 'purchase_order_payments', entityId: paymentId, summary: `Borró un pago de ${p.amount} ${po.currency} de la orden ${po.folio}` });
      return { ok: true };
    });
  }

  // ───────────────────────────── Contenedor ─────────────────────────────

  /**
   * Pasa lo pendiente de la orden a un contenedor. Si el contenedor ya trae el SKU sin orden (p. ej. el pedido sugerido
   * del reabasto), se liga ese renglón y toma las piezas de la orden; si no, se agrega un renglón nuevo.
   */
  async toContainer(id: string, body: unknown, actor: Actor) {
    const data = parse(z.object({ containerId: z.string().uuid('Elige el contenedor') }), body);
    return this.db.transaction(async (tx) => {
      const po = await this.lockPo(tx, id);
      if (po.status === 'CANCELADA') throw new ConflictException('La orden está cancelada.');
      const [c] = await tx.select().from(importContainers).where(eq(importContainers.id, data.containerId)).for('update');
      if (!c) throw new NotFoundException('Contenedor no encontrado.');
      if (CLOSED_CONTAINER.includes(c.status)) throw new ConflictException(`El contenedor ${c.code} está ${c.status.toLowerCase()}.`);
      if (c.costStatus === 'CERRADO') throw new ConflictException(`El costeo de ${c.code} está cerrado. Reábrelo para agregar renglones.`);
      const items = await tx.select().from(purchaseOrderItems).where(eq(purchaseOrderItems.poId, id)).orderBy(purchaseOrderItems.lineNo);
      if (!items.length) throw new BadRequestException('La orden no tiene renglones.');
      const lines = await tx.select().from(importContainerLines).where(eq(importContainerLines.containerId, c.id));
      let added = 0;
      let linked = 0;
      let pieces = 0;
      for (const it of items) {
        const pending = it.qty - (await this.qtyInContainers(tx, it.id));
        if (pending <= 0) continue;
        const free = lines.find((l) => l.masterSkuId === it.masterSkuId && !l.poItemId);
        if (free) {
          await tx.update(importContainerLines).set({ poItemId: it.id, supplierId: po.supplierId, qty: pending, orderDate: po.orderDate }).where(eq(importContainerLines.id, free.id));
          free.poItemId = it.id;
          linked++;
        } else {
          await tx.insert(importContainerLines).values({ containerId: c.id, masterSkuId: it.masterSkuId, supplierId: po.supplierId, qty: pending, orderDate: po.orderDate, poItemId: it.id });
          added++;
        }
        pieces += pending;
      }
      if (!pieces) throw new ConflictException('Todo lo de la orden ya está en contenedores.');
      await this.audit.log(tx, actor, { action: 'EDITAR', module: 'compras', entity: 'import_containers', entityId: c.id, summary: `Pasó la orden ${po.folio} al contenedor ${c.code}: ${pieces} pzas (${added} renglones nuevos, ${linked} ligados)` });
      return { container: c.code, added, linked, pieces };
    });
  }

  // ───────────────────────────── Archivo para el proveedor ─────────────────────────────

  async exportXlsx(id: string, actor: Actor, withPrices: boolean) {
    const po = await this.get(id, actor);
    const prices = withPrices && can(actor, 'costos.ver');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(String(po.folio));
    const font = { name: 'Arial', size: 10 };
    ws.getCell('A1').value = `Purchase order / Orden de compra ${po.folio}`;
    ws.getCell('A1').font = { name: 'Arial', size: 14, bold: true, color: { argb: 'FF1F3864' } };
    const info: [string, string][] = [
      ['Supplier / Proveedor', String(po.supplier)],
      ['Date / Fecha', String(po.orderDate)],
      ['Supplier ref. / Referencia', String(po.supplierRef ?? '')],
      ['Currency / Moneda', String(po.currency)],
      ['Incoterm', String(po.incoterm ?? '')],
      ['Payment terms / Condiciones', String(po.paymentTerms ?? '')],
    ];
    info.forEach(([k, v], i) => {
      ws.getCell(3 + i, 1).value = k;
      ws.getCell(3 + i, 1).font = { ...font, bold: true };
      ws.getCell(3 + i, 3).value = v;
      ws.getCell(3 + i, 3).font = font;
    });
    const head = ['#', 'SKU', 'SUPPLIER CODE / CÓDIGO PROVEEDOR', 'DESCRIPTION / DESCRIPCIÓN', 'PIECES / PIEZAS', 'PCS PER CARTON', 'CARTONS / CAJAS', 'CBM', ...(prices ? ['UNIT PRICE / PRECIO', 'AMOUNT / IMPORTE'] : [])];
    const widths = [5, 15, 20, 55, 12, 11, 11, 9, 13, 14];
    const hr = 10;
    head.forEach((t, j) => {
      const c = ws.getCell(hr, j + 1);
      c.value = t;
      c.font = { ...font, bold: true, color: { argb: 'FFFFFFFF' }, size: 9 };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
      c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      ws.getColumn(j + 1).width = widths[j];
    });
    ws.getRow(hr).height = 30;
    po.items.forEach((it, i) => {
      const r = hr + 1 + i;
      const vals: (string | number | null)[] = [i + 1, it.skuCode, it.supplierSku, it.name, it.qty, it.caseUnits, it.cases !== null ? Math.round(it.cases * 100) / 100 : null, it.cbm !== null ? Math.round(it.cbm * 1000) / 1000 : null];
      if (prices) {
        const p = (it as { unitPrice?: string | null }).unitPrice;
        vals.push(p === null || p === undefined ? null : Number(p), null);
      }
      vals.forEach((v, j) => {
        const c = ws.getCell(r, j + 1);
        c.value = v;
        c.font = font;
        c.alignment = { vertical: 'top', wrapText: j === 3 };
      });
      if (prices) ws.getCell(r, 10).value = { formula: `IF(I${r}="","",E${r}*I${r})` };
      ws.getCell(r, 5).numFmt = '#,##0';
      ws.getCell(r, 8).numFmt = '0.000';
      if (prices) [9, 10].forEach((j) => (ws.getCell(r, j).numFmt = '#,##0.00'));
    });
    const tr = hr + 1 + po.items.length;
    const last = tr - 1;
    ws.getCell(tr, 4).value = 'TOTAL';
    const sums: [number, string, string][] = [[5, 'E', '#,##0'], [7, 'G', '#,##0'], [8, 'H', '0.00'], ...(prices ? ([[10, 'J', '#,##0.00']] as [number, string, string][]) : [])];
    for (const [j, col, fmt] of sums) {
      const c = ws.getCell(tr, j);
      c.value = po.items.length ? { formula: `SUM(${col}${hr + 1}:${col}${last})` } : 0;
      c.numFmt = fmt;
    }
    ws.getRow(tr).font = { ...font, bold: true };
    if (po.notes) {
      ws.getCell(tr + 2, 1).value = `Notes / Notas: ${po.notes}`;
      ws.getCell(tr + 2, 1).font = font;
    }
    ws.views = [{ state: 'frozen', ySplit: hr }];
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), fileName: `${po.folio}_${String(po.supplier).replace(/[^\w-]+/g, '_')}.xlsx` };
  }
}
