import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { containerCosts, costHistory, importContainerLines, importContainers, masterSkus, type Db, type DbOrTx } from '@erp/db';
import {
  computeContainerCost,
  DEFAULT_COST_CONCEPTS,
  fix4,
  refreshAvgCost,
  revalueLot,
  type CostingExpense,
  type CostingLine,
  type CostingResult,
  type RevalueResult,
} from '@erp/domain';
import { z } from 'zod';
import type { Actor } from '../common/actor';
import { InjectDb } from '../common/db';
import { diff } from '../common/diff';
import { onlyPresent, parse } from '../common/zod';
import { AuditService } from '../audit/audit.service';

const CURRENCIES = ['MXN', 'USD', 'CNY'] as const;
const BASES = ['PIEZAS', 'CBM', 'VALOR'] as const;
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);
const fxSchema = z.coerce.number().positive('Debe ser mayor que 0').max(10_000).nullish().transform((v) => v ?? null);
const expenseSchema = z.object({
  concept: z.string().trim().min(1, 'Requerido').max(120),
  amount: z.coerce.number().min(0, 'No puede ser negativo').max(100_000_000),
  currency: z.enum(CURRENCIES).default('MXN'),
  fxRate: fxSchema,
  basis: z.enum(BASES).default('PIEZAS'),
  invoiceRef: optText(80),
  notes: optText(300),
});

export interface ContainerLineInfo {
  id: string;
  skuId: string;
  skuCode: string;
  name: string;
  qty: number;
  qtyReceived: number | null;
  /** Piezas que se costean: las recibidas si el contenedor ya llegó. */
  qtyCosted: number;
  supplier: string | null;
  poItemId: string | null;
  poId: string | null;
  poFolio: string | null;
  unitPrice: string | null;
  currency: string | null;
  poFxRate: string | null;
  caseUnits: number | null;
  cbm: number | null;
  unitCost: string | null;
  merchUnitCost: string | null;
  expenseUnitCost: string | null;
  dutyUnitCost: string | null;
  /** Tasa de arancel (IGI) del SKU. */
  dutyRate: string | null;
}

@Injectable()
export class ContainerCostingService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async container(tx: DbOrTx, id: string, lock = false) {
    const q = tx.select().from(importContainers).where(eq(importContainers.id, id));
    const [c] = lock ? await q.for('update') : await q;
    if (!c) throw new NotFoundException('Contenedor no encontrado.');
    return c;
  }

  async lines(tx: DbOrTx, containerId: string, received: boolean): Promise<ContainerLineInfo[]> {
    const rows = (
      await tx.execute<Record<string, unknown>>(sql`
        SELECT l.id, l.master_sku_id sku_id, m.sku_code, m.name, m.duty_rate, l.qty, l.qty_received, l.unit_cost, l.merch_unit_cost, l.expense_unit_cost, l.duty_unit_cost,
               l.po_item_id, s.name supplier, i.unit_price, po.id po_id, po.folio, po.currency, po.fx_rate po_fx,
               pk.units_per_package case_units, (pk.length_mm::numeric * pk.width_mm * pk.height_mm / 1e9) cbm_case
          FROM import_container_lines l
          JOIN master_skus m ON m.id = l.master_sku_id
          LEFT JOIN purchase_order_items i ON i.id = l.po_item_id
          LEFT JOIN purchase_orders po ON po.id = i.po_id
          LEFT JOIN suppliers s ON s.id = coalesce(l.supplier_id, po.supplier_id)
          LEFT JOIN LATERAL (SELECT * FROM sku_packages p WHERE p.master_sku_id = m.id AND p.type = 'CAJA_MASTER' ORDER BY p.units_per_package DESC LIMIT 1) pk ON true
         WHERE l.container_id = ${containerId}::uuid
         ORDER BY l.created_at, l.id`)
    ).rows;
    return rows.map((r) => {
      const qty = Number(r.qty);
      const qtyReceived = r.qty_received === null ? null : Number(r.qty_received);
      const qtyCosted = received && qtyReceived !== null ? qtyReceived : qty;
      const caseUnits = r.case_units ? Number(r.case_units) : null;
      return {
        id: r.id as string,
        skuId: r.sku_id as string,
        skuCode: r.sku_code as string,
        name: r.name as string,
        qty,
        qtyReceived,
        qtyCosted,
        supplier: (r.supplier as string | null) ?? null,
        poItemId: (r.po_item_id as string | null) ?? null,
        poId: (r.po_id as string | null) ?? null,
        poFolio: (r.folio as string | null) ?? null,
        unitPrice: (r.unit_price as string | null) ?? null,
        currency: (r.currency as string | null) ?? null,
        poFxRate: (r.po_fx as string | null) ?? null,
        caseUnits,
        cbm: caseUnits && r.cbm_case ? (qtyCosted / caseUnits) * Number(r.cbm_case) : null,
        unitCost: (r.unit_cost as string | null) ?? null,
        merchUnitCost: (r.merch_unit_cost as string | null) ?? null,
        expenseUnitCost: (r.expense_unit_cost as string | null) ?? null,
        dutyUnitCost: (r.duty_unit_cost as string | null) ?? null,
        dutyRate: (r.duty_rate as string | null) ?? null,
      };
    });
  }

  private expensesOf(tx: DbOrTx, containerId: string) {
    return tx.select().from(containerCosts).where(eq(containerCosts.containerId, containerId)).orderBy(containerCosts.lineNo);
  }

  /** Cálculo del costo con los datos de hoy (precios de las órdenes, gastos y tipo de cambio). */
  compute(
    lines: ContainerLineInfo[],
    expenses: (typeof containerCosts.$inferSelect)[],
    c: { fxRate: string | null; dutyFxRate: string | null },
    qtyOverride?: Map<string, number>,
  ): CostingResult {
    const inputLines: CostingLine[] = lines
      .map((l) => {
        const qty = qtyOverride?.has(l.id) ? qtyOverride.get(l.id)! : l.qtyCosted;
        return {
          id: l.id,
          skuId: l.skuId,
          skuCode: l.skuCode,
          qty,
          unitPrice: l.unitPrice === null ? null : Number(l.unitPrice),
          currency: l.currency,
          fxRate: l.poFxRate === null ? null : Number(l.poFxRate),
          cbm: l.caseUnits && l.cbm !== null && l.qtyCosted > 0 ? (l.cbm / l.qtyCosted) * qty : null,
          dutyRate: l.dutyRate === null ? null : Number(l.dutyRate),
        };
      })
      .filter((l) => l.qty > 0);
    const inputExpenses: CostingExpense[] = expenses.map((e) => ({
      id: e.id,
      concept: e.concept,
      amount: Number(e.amount),
      currency: e.currency,
      fxRate: e.fxRate === null ? null : Number(e.fxRate),
      basis: e.basis,
    }));
    return computeContainerCost(inputLines, inputExpenses, c.fxRate === null ? null : Number(c.fxRate), { dutyFx: c.dutyFxRate === null ? null : Number(c.dutyFxRate) });
  }

  /** Vista del costeo: encabezado, gastos, costo por renglón y avisos. */
  async costing(id: string) {
    const c = await this.container(this.db, id);
    const received = c.status === 'RECIBIDO';
    const lines = await this.lines(this.db, id, received);
    const expenses = await this.expensesOf(this.db, id);
    const r = this.compute(lines, expenses, c);
    const byLine = new Map(r.lines.map((l) => [l.id, l]));
    const byExpense = new Map(r.expenses.map((e) => [e.id, e]));
    const lots = received
      ? (
          await this.db.execute<{ sku_id: string; unit_cost: string; cost_status: string; on_hand: number }>(sql`
            SELECT l.master_sku_id sku_id, l.unit_cost, l.cost_status,
                   coalesce((SELECT sum(b.qty) FROM inventory_balances b WHERE b.lot_id = l.id), 0)::int on_hand
              FROM inventory_lots l WHERE l.source_type = 'IMPORTACION' AND l.source_id = ${id}`)
        ).rows
      : [];
    const lotBySku = new Map(lots.map((l) => [l.sku_id, l]));
    return {
      id: c.id,
      code: c.code,
      status: c.status,
      received,
      pedimento: c.pedimento,
      invoiceRef: c.invoiceRef,
      fxRate: c.fxRate,
      dutyFxRate: c.dutyFxRate,
      costStatus: c.costStatus,
      costClosedAt: c.costClosedAt,
      totals: r.totals,
      issues: r.issues,
      warnings: r.warnings,
      expenses: expenses.map((e) => ({ ...e, fxUsed: byExpense.get(e.id)?.fxRate ?? null, amountMxn: (byExpense.get(e.id)?.amountMxn ?? 0).toFixed(2) })),
      lines: lines.map((l) => {
        const x = byLine.get(l.id);
        const lot = lotBySku.get(l.skuId);
        return {
          ...l,
          fxUsed: x?.fxRate ?? null,
          calc: x
            ? { merchUnit: fix4(x.merchUnit), dutyUnit: fix4(x.dutyUnit), expenseUnit: fix4(x.expenseUnit), unitCost: fix4(x.unitCost), merchTotal: x.merchTotal.toFixed(2), dutyTotal: x.dutyTotal.toFixed(2), expenseTotal: x.expenseTotal.toFixed(2), total: x.total.toFixed(2) }
            : null,
          lot: lot ? { unitCost: lot.unit_cost, costStatus: lot.cost_status, onHand: Number(lot.on_hand) } : null,
        };
      }),
      defaultConcepts: DEFAULT_COST_CONCEPTS.map((d) => d.concept),
    };
  }

  private assertOpen(c: { costStatus: string; code: string }) {
    if (c.costStatus === 'CERRADO') throw new ConflictException(`El costeo de ${c.code} está cerrado. Reábrelo para cambiarlo.`);
  }

  async updateHeader(id: string, body: unknown, actor: Actor) {
    const data = onlyPresent(parse(z.object({ pedimento: optText(40), invoiceRef: optText(120), fxRate: fxSchema, dutyFxRate: fxSchema }).partial(), body), body);
    return this.db.transaction(async (tx) => {
      const before = await this.container(tx, id, true);
      if (data.fxRate !== undefined || data.dutyFxRate !== undefined) this.assertOpen(before);
      const [after] = await tx
        .update(importContainers)
        .set({
          ...(data.pedimento !== undefined ? { pedimento: data.pedimento } : {}),
          ...(data.invoiceRef !== undefined ? { invoiceRef: data.invoiceRef } : {}),
          ...(data.fxRate !== undefined ? { fxRate: data.fxRate === null ? null : String(data.fxRate) } : {}),
          ...(data.dutyFxRate !== undefined ? { dutyFxRate: data.dutyFxRate === null ? null : String(data.dutyFxRate) } : {}),
          updatedById: actor.id,
        })
        .where(eq(importContainers.id, id))
        .returning();
      const d = diff(before, after);
      if (d.newValues) await this.audit.log(tx, actor, { action: 'EDITAR', module: 'compras', entity: 'import_containers', entityId: id, summary: `Editó los datos de costeo de ${after.code}`, ...d });
      return { ok: true };
    });
  }

  async addExpense(id: string, body: unknown, actor: Actor) {
    const data = parse(expenseSchema, body);
    return this.db.transaction(async (tx) => {
      const c = await this.container(tx, id, true);
      this.assertOpen(c);
      const [{ n }] = (await tx.execute<{ n: number }>(sql`SELECT coalesce(max(line_no), 0)::int + 1 n FROM container_costs WHERE container_id = ${id}::uuid`)).rows;
      const [row] = await tx
        .insert(containerCosts)
        .values({ containerId: id, lineNo: n, ...data, amount: data.amount.toFixed(2), fxRate: data.fxRate === null ? null : String(data.fxRate), createdById: actor.id })
        .returning();
      await this.audit.log(tx, actor, { action: 'CREAR', module: 'compras', entity: 'container_costs', entityId: row.id, summary: `Agregó el gasto "${row.concept}" (${row.amount} ${row.currency}) a ${c.code}` });
      return row;
    });
  }

  async updateExpense(id: string, expenseId: string, body: unknown, actor: Actor) {
    const data = onlyPresent(parse(expenseSchema.partial(), body), body);
    return this.db.transaction(async (tx) => {
      const c = await this.container(tx, id, true);
      this.assertOpen(c);
      const [before] = await tx.select().from(containerCosts).where(and(eq(containerCosts.id, expenseId), eq(containerCosts.containerId, id)));
      if (!before) throw new NotFoundException('Gasto no encontrado.');
      const { amount, fxRate, ...rest } = data;
      const [after] = await tx
        .update(containerCosts)
        .set({ ...rest, ...(amount !== undefined ? { amount: amount.toFixed(2) } : {}), ...(fxRate !== undefined ? { fxRate: fxRate === null ? null : String(fxRate) } : {}) })
        .where(eq(containerCosts.id, expenseId))
        .returning();
      const d = diff(before, after);
      if (d.newValues) await this.audit.log(tx, actor, { action: 'EDITAR', module: 'compras', entity: 'container_costs', entityId: expenseId, summary: `Editó el gasto "${after.concept}" de ${c.code}`, ...d });
      return after;
    });
  }

  async deleteExpense(id: string, expenseId: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const c = await this.container(tx, id, true);
      this.assertOpen(c);
      const [row] = await tx.delete(containerCosts).where(and(eq(containerCosts.id, expenseId), eq(containerCosts.containerId, id))).returning();
      if (!row) throw new NotFoundException('Gasto no encontrado.');
      await this.audit.log(tx, actor, { action: 'ELIMINAR', module: 'compras', entity: 'container_costs', entityId: expenseId, summary: `Quitó el gasto "${row.concept}" de ${c.code}` });
      return { ok: true };
    });
  }

  /** Agrega en 0 los conceptos habituales que el contenedor aún no tiene, para sólo capturar montos. */
  async loadDefaultConcepts(id: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const c = await this.container(tx, id, true);
      this.assertOpen(c);
      const have = new Set((await this.expensesOf(tx, id)).map((e) => e.concept.trim().toUpperCase()));
      let n = (await this.expensesOf(tx, id)).reduce((a, e) => Math.max(a, e.lineNo), 0);
      let added = 0;
      for (const d of DEFAULT_COST_CONCEPTS) {
        if (have.has(d.concept.toUpperCase())) continue;
        await tx.insert(containerCosts).values({ containerId: id, lineNo: ++n, concept: d.concept, amount: '0.00', currency: d.currency, basis: 'PIEZAS', createdById: actor.id });
        added++;
      }
      if (added) await this.audit.log(tx, actor, { action: 'CREAR', module: 'compras', entity: 'container_costs', entityId: id, summary: `Cargó ${added} conceptos de gasto en ${c.code}` });
      return { added };
    });
  }

  /** Liga los renglones del contenedor que no tienen orden con renglones de las órdenes indicadas (mismo SKU). */
  async linkOrders(id: string, body: unknown, actor: Actor) {
    const data = parse(z.object({ poIds: z.array(z.string().uuid()).min(1, 'Elige al menos una orden').max(20) }), body);
    return this.db.transaction(async (tx) => {
      const c = await this.container(tx, id, true);
      this.assertOpen(c);
      const items = (
        await tx.execute<{ id: string; sku_id: string; supplier_id: string; status: string; folio: string }>(sql`
          SELECT i.id, i.master_sku_id sku_id, po.supplier_id, po.status, po.folio
            FROM purchase_order_items i JOIN purchase_orders po ON po.id = i.po_id
           WHERE po.id IN (${sql.join(data.poIds.map((x) => sql`${x}::uuid`), sql`, `)})
           ORDER BY po.order_date, i.line_no`)
      ).rows;
      if (items.some((i) => i.status === 'CANCELADA')) throw new ConflictException('No se puede ligar una orden cancelada.');
      const lines = await tx.select().from(importContainerLines).where(eq(importContainerLines.containerId, id));
      const used = new Set(lines.map((l) => l.poItemId).filter(Boolean));
      let linked = 0;
      const missing: string[] = [];
      for (const l of lines.filter((x) => !x.poItemId)) {
        const it = items.find((i) => i.sku_id === l.masterSkuId && !used.has(i.id));
        if (!it) {
          missing.push(l.masterSkuId);
          continue;
        }
        used.add(it.id);
        await tx.update(importContainerLines).set({ poItemId: it.id, supplierId: it.supplier_id }).where(eq(importContainerLines.id, l.id));
        linked++;
      }
      const codes = missing.length
        ? (await tx.select({ code: masterSkus.skuCode }).from(masterSkus).where(inArray(masterSkus.id, missing))).map((r) => r.code)
        : [];
      if (linked) await this.audit.log(tx, actor, { action: 'EDITAR', module: 'compras', entity: 'import_containers', entityId: id, summary: `Ligó ${linked} renglones de ${c.code} a ${[...new Set(items.map((i) => i.folio))].join(', ')}` });
      return { linked, unmatched: codes };
    });
  }

  /**
   * Cierra el costeo: fija el costo puesto en bodega de cada renglón y, si el contenedor ya se recibió, revalúa sus
   * lotes (lo que queda en existencia se ajusta con REVALUACION_COSTO; la diferencia de lo ya vendido se informa).
   */
  async close(id: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const c = await this.container(tx, id, true);
      this.assertOpen(c);
      if (c.status === 'PLANEADO' || c.status === 'CANCELADO') throw new ConflictException(`Un contenedor ${c.status.toLowerCase()} no se costea.`);
      const received = c.status === 'RECIBIDO';
      const lines = await this.lines(tx, id, received);
      if (!lines.length) throw new BadRequestException('El contenedor no tiene renglones.');
      const expenses = await this.expensesOf(tx, id);
      const r = this.compute(lines, expenses, c);
      if (r.issues.length)
        throw new ConflictException({ message: `No se puede cerrar el costeo: ${r.issues.length} pendiente(s). ${r.issues[0].message}`, code: 'COSTEO_INCOMPLETO', details: { issues: r.issues } });
      const byLine = new Map(r.lines.map((l) => [l.id, l]));
      for (const l of lines) {
        const x = byLine.get(l.id);
        await tx
          .update(importContainerLines)
          .set(
            x
              ? { unitCost: fix4(x.unitCost), merchUnitCost: fix4(x.merchUnit), dutyUnitCost: fix4(x.dutyUnit), expenseUnitCost: fix4(x.expenseUnit) }
              : { unitCost: null, merchUnitCost: null, dutyUnitCost: null, expenseUnitCost: null },
          )
          .where(eq(importContainerLines.id, l.id));
      }
      // Costo por SKU (un SKU puede venir en varios renglones): promedio ponderado por piezas.
      const bySku = new Map<string, { code: string; qty: number; value: number }>();
      for (const x of r.lines) {
        const l = lines.find((y) => y.id === x.id)!;
        const s = bySku.get(x.skuId) ?? { code: l.skuCode, qty: 0, value: 0 };
        s.qty += x.qty;
        s.value += x.qty * x.unitCost;
        bySku.set(x.skuId, s);
      }
      const revalued: (RevalueResult & { skuCode: string })[] = [];
      for (const [skuId, s] of bySku) {
        const cost = s.value / s.qty;
        if (received) {
          const lots = (
            await tx.execute<{ id: string }>(sql`SELECT id FROM inventory_lots WHERE source_type = 'IMPORTACION' AND source_id = ${id} AND master_sku_id = ${skuId}::uuid`)
          ).rows;
          for (const lot of lots)
            revalued.push({ ...(await revalueLot(tx, { lotId: lot.id, unitCost: cost, document: { type: 'COSTEO', id, folio: c.code }, userId: actor.id })), skuCode: s.code });
        }
        await tx.insert(costHistory).values({ masterSkuId: skuId, cost: fix4(cost), sourceType: 'COSTEO_CONTENEDOR', sourceId: id, changedById: actor.id });
        await tx.update(masterSkus).set({ currentCost: fix4(cost), updatedById: actor.id }).where(eq(masterSkus.id, skuId));
      }
      if (received) await refreshAvgCost(tx, [...bySku.keys()]);
      await tx.update(importContainers).set({ costStatus: 'CERRADO', costClosedAt: new Date(), costClosedById: actor.id, updatedById: actor.id }).where(eq(importContainers.id, id));
      const sum = (k: 'deltaOnHand' | 'deltaInTransit' | 'deltaConsumed') => revalued.reduce((a, x) => a + Number(x[k]), 0).toFixed(2);
      await this.audit.log(tx, actor, {
        action: 'AUTORIZAR',
        module: 'compras',
        entity: 'import_containers',
        entityId: id,
        summary: `Cerró el costeo de ${c.code}: ${r.totals.pieces} pzas, mercancía ${r.totals.merchMxn.toFixed(2)} + arancel ${r.totals.dutyMxn.toFixed(2)} + gastos ${r.totals.expensesMxn.toFixed(2)} MXN${received ? `; revaluó ${revalued.filter((x) => x.changed).length} lotes (${sum('deltaOnHand')} en existencia)` : ''}`,
      });
      return {
        ok: true,
        totals: r.totals,
        received,
        revalued: revalued.map((x) => ({ skuCode: x.skuCode, lotCode: x.lotCode, oldCost: x.oldCost, newCost: x.newCost, changed: x.changed, onHand: x.onHand, inTransit: x.inTransit, consumed: x.consumed, deltaOnHand: x.deltaOnHand, deltaInTransit: x.deltaInTransit, deltaConsumed: x.deltaConsumed })),
        deltaOnHand: sum('deltaOnHand'),
        deltaInTransit: sum('deltaInTransit'),
        deltaConsumed: sum('deltaConsumed'),
      };
    });
  }

  /** Tasa de arancel (IGI) de los SKU del contenedor; se guarda en el SKU porque depende de su fracción arancelaria. */
  async setDutyRates(id: string, body: unknown, actor: Actor) {
    const data = parse(
      z.object({
        items: z
          .array(z.object({ skuId: z.string().uuid(), dutyRate: z.coerce.number().min(0, 'No puede ser negativa').max(1, 'Usa fracción: 0.25 = 25%').nullable() }))
          .min(1)
          .max(500),
      }),
      body,
    );
    return this.db.transaction(async (tx) => {
      const c = await this.container(tx, id, true);
      this.assertOpen(c);
      const before = await tx.select({ id: masterSkus.id, code: masterSkus.skuCode, dutyRate: masterSkus.dutyRate }).from(masterSkus).where(inArray(masterSkus.id, data.items.map((i) => i.skuId)));
      const prev = new Map(before.map((b) => [b.id, b]));
      let changed = 0;
      for (const it of data.items) {
        const b = prev.get(it.skuId);
        if (!b) throw new NotFoundException('SKU no encontrado.');
        const next = it.dutyRate === null ? null : it.dutyRate.toFixed(4);
        if ((b.dutyRate ?? null) === next) continue;
        await tx.update(masterSkus).set({ dutyRate: next, updatedById: actor.id }).where(eq(masterSkus.id, it.skuId));
        await this.audit.log(tx, actor, {
          action: 'EDITAR',
          module: 'productos',
          entity: 'master_skus',
          entityId: it.skuId,
          summary: `Arancel (IGI) de ${b.code}: ${b.dutyRate ?? 'sin capturar'} → ${next ?? 'sin capturar'} (costeo de ${c.code})`,
          oldValues: { dutyRate: b.dutyRate },
          newValues: { dutyRate: next },
        });
        changed++;
      }
      return { changed };
    });
  }

  async reopen(id: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const c = await this.container(tx, id, true);
      if (c.costStatus !== 'CERRADO') throw new ConflictException('El costeo no está cerrado.');
      await tx.update(importContainers).set({ costStatus: 'ABIERTO', costClosedAt: null, costClosedById: null, updatedById: actor.id }).where(eq(importContainers.id, id));
      await this.audit.log(tx, actor, { action: 'EDITAR', module: 'compras', entity: 'import_containers', entityId: id, summary: `Reabrió el costeo de ${c.code}` });
      return { ok: true };
    });
  }

  /**
   * Costo con que entra cada SKU al recibir el contenedor: el del costeo cerrado (FINAL); si sigue abierto, el
   * estimado con precios y gastos capturados (PROVISIONAL); si no hay precio, el costo capturado en el renglón (FINAL)
   * o 0 (PROVISIONAL, como antes).
   */
  async receiptCosts(tx: DbOrTx, c: { id: string; fxRate: string | null; dutyFxRate: string | null; costStatus: string }, qtyBy: Map<string, number>) {
    const lines = await this.lines(tx, c.id, false);
    const expenses = await this.expensesOf(tx, c.id);
    const r = this.compute(lines, expenses, c, qtyBy);
    const bad = new Set(r.issues.filter((i) => i.lineId && (i.code === 'SIN_PRECIO' || i.code === 'SIN_TIPO_CAMBIO')).map((i) => i.lineId!));
    const calc = new Map(r.lines.map((l) => [l.id, l]));
    return new Map(
      lines.map((l) => {
        if (c.costStatus === 'CERRADO' && l.unitCost !== null) return [l.id, { cost: Number(l.unitCost), final: true }];
        const x = calc.get(l.id);
        if (x && !bad.has(l.id)) return [l.id, { cost: x.unitCost, final: false }];
        if (l.unitCost !== null) return [l.id, { cost: Number(l.unitCost), final: true }];
        return [l.id, { cost: 0, final: false }];
      }),
    );
  }
}
