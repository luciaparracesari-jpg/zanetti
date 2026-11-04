import { Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { channels, containerCosts, importContainers, skuChannelEconomics, type Db } from '@erp/db';
import { IVA, unitPl, type CommissionBase, type PlParams, type PlUnitCost } from '@erp/domain';
import { z } from 'zod';
import type { Actor } from '../common/actor';
import { InjectDb } from '../common/db';
import { parse } from '../common/zod';
import { AuditService } from '../audit/audit.service';
import { ContainerCostingService } from './costing.service';

/** Supuestos del canal para el P&L (en `channels.settings.pl`). */
export interface ChannelPlSettings {
  /** Comisión si el canal no tiene una regla de comisión vigente (Configuración → Canales). */
  commissionRate: number | null;
  commissionBase: CommissionBase;
  fulfillmentPerUnit: number;
  adsRate: number;
  storagePerUnit: number;
  inboundPerBox: number;
}

const DEFAULTS: ChannelPlSettings = { commissionRate: null, commissionBase: 'VENTA_NETA', fulfillmentPerUnit: 0, adsRate: 0, storagePerUnit: 0, inboundPerBox: 0 };
const money = z.coerce.number().min(0, 'No puede ser negativo').max(1_000_000);
const rate = z.coerce.number().min(0, 'No puede ser negativo').max(1, 'Usa fracción: 0.10 = 10%');

type CostSource = 'CONTENEDOR' | 'ESTIMADO' | 'ULTIMO_COSTEO' | 'PROMEDIO' | 'SIN_COSTO';
interface SkuCost extends PlUnitCost {
  source: CostSource;
  container: string | null;
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

@Injectable()
export class ProfitabilityService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly costing: ContainerCostingService,
  ) {}

  private settingsOf(settings: unknown): ChannelPlSettings {
    const pl = (settings as { pl?: Partial<ChannelPlSettings> } | null)?.pl ?? {};
    return { ...DEFAULTS, ...pl };
  }

  /** Canales y contenedores para los filtros de la pantalla. */
  async options() {
    const chs = await this.db.select({ id: channels.id, code: channels.code, name: channels.name, status: channels.status, settings: channels.settings }).from(channels).orderBy(channels.sortOrder);
    const conts = (
      await this.db.execute<{ id: string; code: string; status: string; cost_status: string }>(sql`
        SELECT c.id, c.code, c.status, c.cost_status FROM import_containers c
         WHERE c.status NOT IN ('CANCELADO') AND EXISTS (SELECT 1 FROM import_container_lines l WHERE l.container_id = c.id)
         ORDER BY nullif(regexp_replace(c.code, '\\D', '', 'g'), '')::numeric DESC NULLS LAST, c.code DESC`)
    ).rows;
    return {
      channels: chs.filter((c) => c.status !== 'INACTIVO').map((c) => ({ id: c.id, code: c.code, name: c.name, settings: this.settingsOf(c.settings) })),
      containers: conts.map((c) => ({ id: c.id, code: c.code, status: c.status, costStatus: c.cost_status })),
    };
  }

  /** Costo por pieza de cada SKU en un contenedor (cerrado: lo guardado; abierto: el estimado de hoy). */
  private async containerCosts(containerId: string) {
    const [c] = await this.db.select().from(importContainers).where(eq(importContainers.id, containerId));
    if (!c) throw new NotFoundException('Contenedor no encontrado.');
    const lines = await this.costing.lines(this.db, c.id, c.status === 'RECIBIDO');
    const out = new Map<string, SkuCost & { qty: number }>();
    const add = (skuId: string, qty: number, p: number, d: number, e: number, source: CostSource) => {
      const x = out.get(skuId) ?? { product: 0, duty: 0, importExpenses: 0, qty: 0, source, container: c.code };
      const t = x.qty + qty;
      if (t > 0) {
        x.product = (x.product * x.qty + p * qty) / t;
        x.duty = (x.duty * x.qty + d * qty) / t;
        x.importExpenses = (x.importExpenses * x.qty + e * qty) / t;
      }
      x.qty = t;
      out.set(skuId, x);
    };
    if (c.costStatus === 'CERRADO') {
      for (const l of lines)
        if (l.unitCost !== null) add(l.skuId, l.qtyCosted, num(l.merchUnitCost) ?? Number(l.unitCost), num(l.dutyUnitCost) ?? 0, num(l.expenseUnitCost) ?? 0, 'CONTENEDOR');
    } else {
      const expenses = await this.db.select().from(containerCosts).where(eq(containerCosts.containerId, c.id));
      const r = this.costing.compute(lines, expenses, c);
      const priced = new Set(lines.filter((l) => l.unitPrice !== null).map((l) => l.id));
      for (const x of r.lines) if (priced.has(x.id)) add(x.skuId, x.qty, x.merchUnit, x.dutyUnit, x.expenseUnit, 'ESTIMADO');
    }
    return { container: c, costs: out, skuIds: [...new Set(lines.map((l) => l.skuId))] };
  }

  /**
   * P&L por pieza de cada SKU en un canal con el último precio de venta del canal (o el capturado si aún no se vende
   * ahí). El costo es el del contenedor elegido; sin contenedor, el del último costeo cerrado de cada SKU.
   */
  async skuPl(query: Record<string, unknown>) {
    const q = parse(
      z.object({
        channelId: z.string().uuid('Elige el canal'),
        containerId: z.string().uuid().optional().or(z.literal('').transform(() => undefined)),
        months: z.coerce.number().int().min(1).max(12).default(3),
      }),
      query,
    );
    const [ch] = await this.db.select().from(channels).where(eq(channels.id, q.channelId));
    if (!ch) throw new NotFoundException('Canal no encontrado.');
    const settings = this.settingsOf(ch.settings);
    const chosen = q.containerId ? await this.containerCosts(q.containerId) : null;

    // Último precio de venta (día más reciente con venta) y piezas vendidas en los últimos meses.
    const sales = (
      await this.db.execute<{ sku_id: string; last_date: string; net_unit: string; units: number; first_month: string; last_month: string; days: number }>(sql`
        WITH s AS (
          SELECT master_sku_id, sale_date, qty, amount, kind FROM sales_lines WHERE channel_id = ${ch.id}::uuid AND master_sku_id IS NOT NULL
        ), last AS (
          SELECT master_sku_id, max(sale_date) d FROM s WHERE kind = 'VENTA' AND amount IS NOT NULL AND qty > 0 AND amount > 0 GROUP BY 1
        ), horizon AS (
          SELECT (date_trunc('month', max(sale_date)) - make_interval(months => ${q.months - 1}))::date AS since, max(sale_date) AS until FROM s
        )
        SELECT l.master_sku_id sku_id, l.d::text last_date,
               (SELECT sum(x.amount) / sum(x.qty) FROM s x WHERE x.master_sku_id = l.master_sku_id AND x.sale_date = l.d AND x.kind = 'VENTA' AND x.amount > 0 AND x.qty > 0) net_unit,
               (SELECT coalesce(sum(x.qty), 0) FROM s x, horizon h WHERE x.master_sku_id = l.master_sku_id AND x.sale_date BETWEEN h.since AND h.until)::int units,
               (SELECT since::text FROM horizon) first_month, (SELECT until::text FROM horizon) last_month, (SELECT (until - since + 1)::int FROM horizon) days
          FROM last l`)
    ).rows;
    const saleBySku = new Map(sales.map((s) => [s.sku_id, s]));
    const inputs = await this.db.select().from(skuChannelEconomics).where(eq(skuChannelEconomics.channelId, ch.id));
    const inputBySku = new Map(inputs.map((i) => [i.masterSkuId, i]));

    const skuIds = chosen ? chosen.skuIds : [...new Set([...sales.map((s) => s.sku_id), ...inputs.map((i) => i.masterSkuId)])];
    if (!skuIds.length) return { channel: { id: ch.id, code: ch.code, name: ch.name }, settings, container: null, rows: [], period: null };
    const idList = sql.join(skuIds.map((id) => sql`${id}::uuid`), sql`, `);

    const skus = (
      await this.db.execute<{ id: string; code: string; name: string; is_kit: boolean; category_id: string | null; category: string | null; avg_cost: string | null; case_units: number | null }>(sql`
        SELECT s.id, s.sku_code code, s.name, s.is_kit, p.category_id, c.name category, s.avg_cost,
               (SELECT max(k.units_per_package) FROM sku_packages k WHERE k.master_sku_id = s.id AND k.type = 'CAJA_MASTER') case_units
          FROM master_skus s JOIN products p ON p.id = s.product_id LEFT JOIN categories c ON c.id = p.category_id
         WHERE s.id IN (${idList})`)
    ).rows;
    const kits = (
      await this.db.execute<{ kit: string; comp: string; qty: number }>(sql`SELECT kit_sku_id kit, component_sku_id comp, quantity qty FROM kit_components WHERE kit_sku_id IN (${idList})`)
    ).rows;
    // Último costeo cerrado de cada SKU (y de los componentes de los kits).
    const lastClosed = (
      await this.db.execute<{ sku_id: string; code: string; merch: string | null; duty: string | null; exp: string | null; unit: string }>(sql`
        SELECT DISTINCT ON (l.master_sku_id) l.master_sku_id sku_id, c.code, l.merch_unit_cost merch, l.duty_unit_cost duty, l.expense_unit_cost exp, l.unit_cost unit
          FROM import_container_lines l JOIN import_containers c ON c.id = l.container_id
         WHERE c.cost_status = 'CERRADO' AND l.unit_cost IS NOT NULL
         ORDER BY l.master_sku_id, c.cost_closed_at DESC NULLS LAST, c.code DESC`)
    ).rows;
    const closedBySku = new Map(lastClosed.map((r) => [r.sku_id, r]));
    const avgCosts = new Map(
      (await this.db.execute<{ id: string; avg_cost: string | null }>(sql`SELECT id, avg_cost FROM master_skus WHERE avg_cost IS NOT NULL`)).rows.map((r) => [r.id, Number(r.avg_cost)]),
    );
    const costOf = (skuId: string): SkuCost => {
      const c = chosen?.costs.get(skuId);
      if (c) return c;
      const l = closedBySku.get(skuId);
      if (l) return { product: num(l.merch) ?? Number(l.unit), duty: num(l.duty) ?? 0, importExpenses: num(l.exp) ?? 0, source: 'ULTIMO_COSTEO', container: l.code };
      const avg = avgCosts.get(skuId);
      if (avg) return { product: avg, duty: 0, importExpenses: 0, source: 'PROMEDIO', container: null };
      return { product: 0, duty: 0, importExpenses: 0, source: 'SIN_COSTO', container: null };
    };

    // Comisión vigente: la del SKU, si no la de su categoría, si no la del canal; si no hay regla, la del P&L del canal.
    const fees = (
      await this.db.execute<{ category_id: string | null; master_sku_id: string | null; rate: string | null; fixed_amount: string | null; base: string; name: string }>(sql`
        SELECT category_id, master_sku_id, rate, fixed_amount, base, name FROM fee_rules
         WHERE channel_id = ${ch.id}::uuid AND fee_type = 'COMISION'
           AND valid_from <= (now() AT TIME ZONE 'America/Mexico_City')::date
           AND (valid_to IS NULL OR valid_to >= (now() AT TIME ZONE 'America/Mexico_City')::date)`)
    ).rows;
    const commissionFor = (skuId: string, categoryId: string | null) => {
      const f = fees.find((x) => x.master_sku_id === skuId) ?? fees.find((x) => categoryId && x.category_id === categoryId && !x.master_sku_id) ?? fees.find((x) => !x.category_id && !x.master_sku_id);
      if (f) return { rate: num(f.rate) ?? 0, fixed: num(f.fixed_amount) ?? 0, base: f.base as CommissionBase, source: f.name };
      if (settings.commissionRate !== null) return { rate: settings.commissionRate, fixed: 0, base: settings.commissionBase, source: 'Supuesto del canal' };
      return null;
    };

    const rows = skus
      .map((s) => {
        let cost: SkuCost;
        if (s.is_kit) {
          const comps = kits.filter((k) => k.kit === s.id);
          const parts = comps.map((k) => ({ k, c: costOf(k.comp) }));
          cost = {
            product: parts.reduce((a, p) => a + p.c.product * p.k.qty, 0),
            duty: parts.reduce((a, p) => a + p.c.duty * p.k.qty, 0),
            importExpenses: parts.reduce((a, p) => a + p.c.importExpenses * p.k.qty, 0),
            source: parts.length === 0 || parts.some((p) => p.c.source === 'SIN_COSTO') ? 'SIN_COSTO' : parts.some((p) => p.c.source === 'PROMEDIO') ? 'PROMEDIO' : 'ULTIMO_COSTEO',
            container: [...new Set(parts.map((p) => p.c.container).filter(Boolean))].join(', ') || null,
          };
        } else cost = costOf(s.id);
        const sale = saleBySku.get(s.id);
        const input = inputBySku.get(s.id);
        const commission = commissionFor(s.id, s.category_id);
        const listPrice = num(input?.listPrice);
        const lastPrice = sale?.net_unit ? Math.round(Number(sale.net_unit) * (1 + IVA) * 100) / 100 : null;
        const price = lastPrice ?? listPrice;
        const params: PlParams = {
          commissionRate: commission?.rate ?? 0,
          commissionBase: commission?.base ?? 'VENTA_NETA',
          commissionFixed: commission?.fixed ?? 0,
          fulfillmentPerUnit: num(input?.fulfillmentPerUnit) ?? settings.fulfillmentPerUnit,
          adsRate: num(input?.adsRate) ?? settings.adsRate,
          storagePerUnit: num(input?.storagePerUnit) ?? settings.storagePerUnit,
          inboundPerBox: settings.inboundPerBox,
          caseUnits: s.case_units,
        };
        const pl = price !== null && cost.source !== 'SIN_COSTO' ? unitPl(price, cost, params) : null;
        const containerQty = chosen?.costs.get(s.id)?.qty ?? null;
        return {
          skuId: s.id,
          skuCode: s.code,
          name: s.name,
          category: s.category,
          isKit: s.is_kit,
          caseUnits: s.case_units,
          cost: { source: cost.source, container: cost.container, product: cost.product.toFixed(4), duty: cost.duty.toFixed(4), importExpenses: cost.importExpenses.toFixed(4) },
          price: { used: price, source: lastPrice !== null ? 'ULTIMA_VENTA' : listPrice !== null ? 'CAPTURADO' : null, lastSale: lastPrice, lastSaleDate: sale?.last_date ?? null, list: listPrice },
          commission: commission ? { rate: commission.rate, fixed: commission.fixed, base: commission.base, source: commission.source } : null,
          inputs: {
            listPrice: input?.listPrice ?? null,
            fulfillmentPerUnit: input?.fulfillmentPerUnit ?? null,
            storagePerUnit: input?.storagePerUnit ?? null,
            adsRate: input?.adsRate ?? null,
            notes: input?.notes ?? null,
          },
          units: sale?.units ?? 0,
          // Piezas por mes con los días reales del periodo (el último mes puede venir incompleto).
          unitsPerMonth: sale && sale.days > 0 ? Math.round(((sale.units ?? 0) * 30.4375 * 10) / sale.days) / 10 : 0,
          containerQty,
          pl,
          containerEbitda: pl && containerQty ? Math.round(pl.ebitda * containerQty * 100) / 100 : null,
        };
      })
      .sort((a, b) => a.skuCode.localeCompare(b.skuCode));
    const period = sales[0] ? { from: sales[0].first_month, to: sales[0].last_month, months: q.months } : null;
    return {
      channel: { id: ch.id, code: ch.code, name: ch.name },
      settings,
      container: chosen ? { id: chosen.container.id, code: chosen.container.code, costStatus: chosen.container.costStatus } : null,
      period,
      rows,
    };
  }

  async saveSkuInputs(skuId: string, channelId: string, body: unknown, actor: Actor) {
    const data = parse(
      z.object({
        listPrice: money.nullable(),
        fulfillmentPerUnit: money.nullable(),
        storagePerUnit: money.nullable(),
        adsRate: rate.nullable(),
        notes: z.string().trim().max(300).nullish().transform((v) => v || null),
      }),
      body,
    );
    return this.db.transaction(async (tx) => {
      const [sku] = (await tx.execute<{ code: string }>(sql`SELECT sku_code code FROM master_skus WHERE id = ${skuId}::uuid`)).rows;
      const [ch] = await tx.select({ code: channels.code }).from(channels).where(eq(channels.id, channelId));
      if (!sku || !ch) throw new NotFoundException('SKU o canal no encontrado.');
      const values = {
        listPrice: data.listPrice === null ? null : data.listPrice.toFixed(2),
        fulfillmentPerUnit: data.fulfillmentPerUnit === null ? null : data.fulfillmentPerUnit.toFixed(2),
        storagePerUnit: data.storagePerUnit === null ? null : data.storagePerUnit.toFixed(2),
        adsRate: data.adsRate === null ? null : data.adsRate.toFixed(4),
        notes: data.notes,
        updatedById: actor.id,
      };
      const [before] = await tx.select().from(skuChannelEconomics).where(and(eq(skuChannelEconomics.masterSkuId, skuId), eq(skuChannelEconomics.channelId, channelId)));
      await tx
        .insert(skuChannelEconomics)
        .values({ masterSkuId: skuId, channelId, ...values })
        .onConflictDoUpdate({ target: [skuChannelEconomics.masterSkuId, skuChannelEconomics.channelId], set: values });
      await this.audit.log(tx, actor, {
        action: 'EDITAR',
        module: 'canales',
        entity: 'sku_channel_economics',
        entityId: skuId,
        summary: `Supuestos del P&L de ${sku.code} en ${ch.code}`,
        oldValues: before ? { listPrice: before.listPrice, fulfillmentPerUnit: before.fulfillmentPerUnit, storagePerUnit: before.storagePerUnit, adsRate: before.adsRate } : null,
        newValues: { listPrice: values.listPrice, fulfillmentPerUnit: values.fulfillmentPerUnit, storagePerUnit: values.storagePerUnit, adsRate: values.adsRate },
      });
      return { ok: true };
    });
  }

  async saveChannelSettings(channelId: string, body: unknown, actor: Actor) {
    const data = parse(
      z.object({
        commissionRate: rate.nullable(),
        commissionBase: z.enum(['VENTA_CON_IVA', 'VENTA_NETA', 'DESPUES_DESCUENTO']).default('VENTA_NETA'),
        fulfillmentPerUnit: money.default(0),
        adsRate: rate.default(0),
        storagePerUnit: money.default(0),
        inboundPerBox: money.default(0),
      }),
      body,
    );
    return this.db.transaction(async (tx) => {
      const [ch] = await tx.select().from(channels).where(eq(channels.id, channelId)).for('update');
      if (!ch) throw new NotFoundException('Canal no encontrado.');
      const before = this.settingsOf(ch.settings);
      const settings = { ...((ch.settings as Record<string, unknown> | null) ?? {}), pl: data };
      await tx.update(channels).set({ settings }).where(eq(channels.id, channelId));
      await this.audit.log(tx, actor, { action: 'EDITAR', module: 'canales', entity: 'channels', entityId: channelId, summary: `Supuestos del P&L del canal ${ch.code}`, oldValues: { ...before }, newValues: { ...data } });
      return { ok: true, settings: data };
    });
  }
}
