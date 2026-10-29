import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  channels,
  importContainerLines,
  importContainers,
  masterSkus,
  replenishmentOverrides,
  systemParameters,
  warehouses,
  type Db,
} from '@erp/db';
import { addDays, computeReplenishment, type PlanWarehouse, type ReplContainer, type ReplParams, type ReplStock } from '@erp/domain';
import { z } from 'zod';
import type { Actor } from '../common/actor';
import { InjectDb } from '../common/db';
import { parse } from '../common/zod';
import { AuditService } from '../audit/audit.service';
import { TransfersService } from '../inventory/transfers.service';

const PARAM_KEY = 'reabasto.parametros';
const ACTIVE_CONTAINER = ['EN_PRODUCCION', 'EN_NAVIERA', 'EN_ADUANA'] as const;
const CAT_ORDER: Record<string, number> = { Sartenes: 0, Viaje: 1, Cocina: 2 };

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD');
const warehouseCode = z.enum(['AMZ-FBA', 'LIV-FBL', 'APLIN']);

export const paramsSchema = z.object({
  mesesHistoria: z.number().int().min(1).max(12),
  pctQuiebre: z.number().min(0).max(1),
  factorFba: z.number().min(0).max(10),
  factorFbl: z.number().min(0).max(10),
  factorAplin: z.number().min(0).max(10),
  almexDias: z.number().int().min(1).max(120),
  dhlDias: z.number().int().min(1).max(120),
  colchonFba: z.number().int().min(0).max(120),
  envioFblDias: z.number().int().min(1).max(120),
  colchonFbl: z.number().int().min(0).max(120),
  reservaAplinDias: z.number().int().min(0).max(365),
  redondearCajas: z.boolean(),
  navieraDias: z.number().int().min(1).max(180),
  aduanaDias: z.number().int().min(0).max(120),
  cicloDias: z.number().int().min(1).max(365),
  seguridadDias: z.number().int().min(0).max(365),
  capacidadCbm: z.number().min(1).max(200),
  fechaProximoPedido: isoDate.nullable(),
  origenAlmacen: z.record(z.string(), warehouseCode),
});
export type StoredParams = z.infer<typeof paramsSchema>;

export const DEFAULT_PARAMS: StoredParams = {
  mesesHistoria: 3,
  pctQuiebre: 0.3,
  factorFba: 1,
  factorFbl: 1,
  factorAplin: 1,
  almexDias: 33,
  dhlDias: 17,
  colchonFba: 7,
  envioFblDias: 10,
  colchonFbl: 5,
  reservaAplinDias: 30,
  redondearCajas: true,
  navieraDias: 40,
  aduanaDias: 15,
  cicloDias: 45,
  seguridadDias: 21,
  capacidadCbm: 68,
  fechaProximoPedido: null,
  origenAlmacen: { 'AMZ-FBA': 'AMZ-FBA', 'AMZ-MFN': 'AMZ-FBA', LIVERPOOL: 'LIV-FBL', SHOPIFY: 'APLIN' },
};

/** Fecha de hoy en la Ciudad de México (AAAA-MM-DD). */
export function todayMx(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const maxDate = (xs: (string | null)[]) => xs.filter((x): x is string => Boolean(x)).sort().pop() ?? null;

@Injectable()
export class ReplenishmentService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly transfers: TransfersService,
  ) {}

  // ───────────────────────────── Parámetros ─────────────────────────────

  async storedParams(): Promise<StoredParams> {
    const [row] = await this.db.select({ value: systemParameters.value }).from(systemParameters).where(eq(systemParameters.key, PARAM_KEY));
    const merged = { ...DEFAULT_PARAMS, ...((row?.value as object) ?? {}) };
    const ok = paramsSchema.safeParse(merged);
    return ok.success ? ok.data : DEFAULT_PARAMS;
  }

  async updateParams(body: unknown, actor: Actor) {
    const patch = parse(paramsSchema.partial(), body);
    const before = await this.storedParams();
    const after = { ...before, ...patch };
    await this.db.transaction(async (tx) => {
      await tx
        .insert(systemParameters)
        .values({ key: PARAM_KEY, value: after, updatedById: actor.id })
        .onConflictDoUpdate({ target: systemParameters.key, set: { value: after, updatedById: actor.id, updatedAt: new Date() } });
      await this.audit.log(tx, actor, {
        action: 'EDITAR', module: 'reabasto', entity: 'system_parameters', entityId: PARAM_KEY,
        summary: 'Editó los parámetros del reabasto', oldValues: before, newValues: after,
      });
    });
    return after;
  }

  async updateSku(id: string, body: unknown, actor: Actor) {
    const data = parse(
      z.object({
        includeInOrders: z.boolean().optional(),
        manualDailyDemand: z.number().min(0).max(100000).nullable().optional(),
        notes: z.string().trim().max(500).nullable().optional(),
      }),
      body,
    );
    const [sku] = await this.db.select({ id: masterSkus.id, code: masterSkus.skuCode }).from(masterSkus).where(eq(masterSkus.id, id));
    if (!sku) throw new NotFoundException('SKU no encontrado.');
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(replenishmentOverrides).where(eq(replenishmentOverrides.masterSkuId, id));
      const values = {
        includeInOrders: data.includeInOrders ?? before?.includeInOrders ?? true,
        manualDailyDemand: data.manualDailyDemand === undefined ? before?.manualDailyDemand ?? null : data.manualDailyDemand === null ? null : String(data.manualDailyDemand),
        notes: data.notes === undefined ? before?.notes ?? null : data.notes,
        updatedById: actor.id,
      };
      await tx
        .insert(replenishmentOverrides)
        .values({ masterSkuId: id, ...values })
        .onConflictDoUpdate({ target: replenishmentOverrides.masterSkuId, set: { ...values, updatedAt: new Date() } });
      await this.audit.log(tx, actor, {
        action: 'EDITAR', module: 'reabasto', entity: 'replenishment_overrides', entityId: id,
        summary: `Ajustó el reabasto de ${sku.code}`, oldValues: before ?? null, newValues: values,
      });
      return { masterSkuId: id, ...values };
    });
  }

  // ───────────────────────────── Contenedores ─────────────────────────────

  /**
   * Contenedores con su llegada estimada a APLIN: captura manual > llegada a puerto + aduana > ETD + naviera + aduana >
   * pedido + lead time (lo más lento).
   */
  async containers(p: StoredParams, statuses: readonly string[] | null) {
    const rows = await this.db
      .select()
      .from(importContainers)
      .where(statuses ? inArray(importContainers.status, statuses as never) : undefined);
    if (!rows.length) return [];
    const lines = await this.db
      .select({
        containerId: importContainerLines.containerId,
        skuId: importContainerLines.masterSkuId,
        skuCode: masterSkus.skuCode,
        qty: importContainerLines.qty,
        orderDate: importContainerLines.orderDate,
        lead: masterSkus.leadTimeDays,
        caseUnits: sql<number | null>`(select max(p.units_per_package) from sku_packages p where p.master_sku_id = ${masterSkus.id} and p.type = 'CAJA_MASTER')`,
        cbmCase: sql<number | null>`(select p.length_mm::numeric * p.width_mm * p.height_mm / 1e9 from sku_packages p where p.master_sku_id = ${masterSkus.id} and p.type = 'CAJA_MASTER' order by p.units_per_package desc limit 1)`,
      })
      .from(importContainerLines)
      .innerJoin(masterSkus, eq(masterSkus.id, importContainerLines.masterSkuId))
      .where(inArray(importContainerLines.containerId, rows.map((r) => r.id)));
    return rows.map((c) => {
      const ls = lines.filter((l) => l.containerId === c.id);
      const byLines = maxDate(ls.map((l) => addDays(l.orderDate, l.lead ?? 115)));
      const eta =
        c.etaOverride ?? (c.portEta ? addDays(c.portEta, p.aduanaDias) : c.etd ? addDays(c.etd, p.navieraDias + p.aduanaDias) : byLines);
      const cbm = ls.reduce((a, l) => a + (l.caseUnits && l.cbmCase ? (l.qty / l.caseUnits) * Number(l.cbmCase) : 0), 0);
      return {
        ...c,
        eta,
        etaSource: c.etaOverride ? 'MANUAL' : c.portEta ? 'PUERTO' : c.etd ? 'ETD' : 'PEDIDO',
        lastOrderDate: maxDate(ls.map((l) => l.orderDate)),
        qty: ls.reduce((a, l) => a + l.qty, 0),
        skus: new Set(ls.map((l) => l.skuId)).size,
        cbm,
        lines: ls,
      };
    });
  }

  // ───────────────────────────── Cálculo ─────────────────────────────

  async compute(opts: { fecha?: string } = {}) {
    if (opts.fecha && !/^\d{4}-\d{2}-\d{2}$/.test(opts.fecha)) throw new BadRequestException('Fecha inválida (AAAA-MM-DD).');
    const today = opts.fecha ?? todayMx();
    const p = await this.storedParams();
    const chs = await this.db.select({ code: channels.code, coverage: channels.coverageDays }).from(channels);
    const coverage = (code: string, d: number) => chs.find((c) => c.code === code)?.coverage ?? d;

    // SKU con su caja master, CBM y ajustes
    const skus = await this.db.execute<{
      id: string; code: string; name: string; is_kit: boolean; lead: number | null; category: string | null;
      case_units: number | null; cbm_case: string | null; include: boolean | null; manual: string | null;
    }>(sql`
      select s.id, s.sku_code code, s.name, s.is_kit, s.lead_time_days lead, c.name category,
             pk.units_per_package case_units, (pk.length_mm::numeric * pk.width_mm * pk.height_mm / 1e9) cbm_case,
             o.include_in_orders include, o.manual_daily_demand manual
        from master_skus s
        join products pr on pr.id = s.product_id
        left join categories c on c.id = pr.category_id
        left join lateral (select * from sku_packages p where p.master_sku_id = s.id and p.type = 'CAJA_MASTER'
                            order by p.units_per_package desc limit 1) pk on true
        left join replenishment_overrides o on o.master_sku_id = s.id
       where s.status <> 'INACTIVO'`);
    const kitRows = await this.db.execute<{ kit: string; comp: string; qty: number }>(sql`select kit_sku_id kit, component_sku_id comp, quantity qty from kit_components`);

    // Ventana de historia: meses completos hasta el mes anterior a hoy, máximo 12, desde el primer mes con ventas.
    const [y, m] = today.split('-').map(Number);
    const lastMonthStart = new Date(Date.UTC(y, m - 2, 1));
    const windowStart = new Date(Date.UTC(y, m - 13, 1));
    const [first] = (
      await this.db.execute<{ d: string | null }>(sql`select to_char(min(sale_date), 'YYYY-MM-01') d from sales_lines where sale_date >= ${windowStart.toISOString().slice(0, 10)}`)
    ).rows;
    const start = first?.d && first.d > windowStart.toISOString().slice(0, 10) ? first.d : windowStart.toISOString().slice(0, 10);
    const months: string[] = [];
    for (let d = new Date(`${start}T00:00:00Z`); d <= lastMonthStart; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) months.push(d.toISOString().slice(0, 7));
    const endExclusive = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10);
    const historyDays = months.length ? (Date.parse(`${endExclusive}T00:00:00Z`) - Date.parse(`${months[0]}-01T00:00:00Z`)) / 86_400_000 : 1;
    const sales = months.length
      ? (
          await this.db.execute<{ sku: string; origin: string; skey: string; m: string; q: number }>(sql`
            select master_sku_id sku, origin, case when origin = 'LIVERPOOL' then external_code else '' end skey,
                   to_char(sale_date, 'YYYY-MM') m, sum(qty)::int q
              from sales_lines
             where master_sku_id is not null and sale_date >= ${`${months[0]}-01`} and sale_date < ${endExclusive}
             group by 1, 2, 3, 4`)
        ).rows
      : [];
    const seriesMap = new Map<string, { skuId: string; warehouse: PlanWarehouse; months: number[] }>();
    for (const s of sales) {
      const wh = (p.origenAlmacen[s.origin] ?? 'APLIN') as PlanWarehouse;
      const key = `${s.sku}|${s.origin}|${s.skey}`;
      const ser = seriesMap.get(key) ?? { skuId: s.sku, warehouse: wh, months: months.map(() => 0) };
      ser.months[months.indexOf(s.m)] += s.q;
      seriesMap.set(key, ser);
    }

    // Existencias
    const st = await this.db.execute<{ sku: string; code: string; on_hand: number; in_transit: number }>(sql`
      select st.master_sku_id sku, w.code, st.on_hand, st.in_transit from inventory_stock st join warehouses w on w.id = st.warehouse_id`);
    const stock: Record<string, ReplStock> = {};
    for (const r of st.rows) {
      const s = (stock[r.sku] ??= { aplin: 0, fba: 0, fbaTransit: 0, fbl: 0 });
      if (r.code === 'APLIN') s.aplin += num(r.on_hand);
      else if (r.code === 'AMZ-FBA') {
        s.fba += num(r.on_hand);
        s.fbaTransit += num(r.in_transit);
      } else if (r.code === 'LIV-FBL' || r.code === 'LIV-99MIN') s.fbl += num(r.on_hand) + num(r.in_transit);
    }

    const conts = await this.containers(p, ACTIVE_CONTAINER);
    const containers: ReplContainer[] = conts.filter((c) => c.eta).map((c) => ({ code: c.code, eta: c.eta!, lines: c.lines.map((l) => ({ skuId: l.skuId, qty: l.qty })) }));
    const lastOrder = maxDate(conts.map((c) => c.lastOrderDate));
    const suggestedOrder = lastOrder ? addDays(lastOrder, p.cicloDias) : today;
    const fechaProximoPedido = p.fechaProximoPedido ?? (suggestedOrder > today ? suggestedOrder : today);
    const skuList = skus.rows.map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      category: s.is_kit ? 'Kit' : s.category,
      isKit: s.is_kit,
      caseUnits: s.case_units,
      cbmCase: s.cbm_case === null ? 0 : Number(s.cbm_case),
      leadTimeDays: s.lead,
      include: s.include ?? true,
      manualDailyDemand: s.manual === null ? null : Number(s.manual),
    }));
    skuList.sort((a, b) => (CAT_ORDER[a.category ?? ''] ?? 9) - (CAT_ORDER[b.category ?? ''] ?? 9) || a.code.localeCompare(b.code));
    const leads = skuList.filter((s) => !s.isKit && s.leadTimeDays).map((s) => s.leadTimeDays!);
    const params: ReplParams = {
      ...p,
      coberturaFba: coverage('AMAZON', 90),
      coberturaFbl: coverage('LIVERPOOL', 45),
      fechaProximoPedido,
      diasContenedor: leads.length ? Math.max(...leads) : 115,
    };
    const result = computeReplenishment({
      today,
      params,
      historyDays,
      skus: skuList,
      kits: kitRows.rows.map((k) => ({ kitId: k.kit, componentId: k.comp, qty: k.qty })),
      series: [...seriesMap.values()],
      stock,
      containers,
    });
    const info = new Map(skuList.map((s) => [s.id, s]));
    const named = <T extends { skuId: string }>(r: T) => ({ ...r, skuCode: info.get(r.skuId)!.code, skuName: info.get(r.skuId)!.name, category: info.get(r.skuId)!.category });
    const china = result.china.map(named);
    const channelsOut = result.channels.map(named);
    const urgent = china
      .filter((r) => r.daysWithout !== null && r.daysWithout > 0 && r.demand >= 0.1)
      .sort((a, b) => (a.stockoutDate ?? '').localeCompare(b.stockoutDate ?? ''));
    const lt = (cat: string) => {
      const xs = skuList.filter((s) => s.category === cat && s.leadTimeDays).map((s) => s.leadTimeDays!);
      return xs.length ? Math.max(...xs) : params.diasContenedor;
    };
    const byCat = ['Sartenes', 'Viaje', 'Cocina'].map((cat) => {
      const rows = china.filter((r) => r.category === cat);
      return {
        category: cat,
        orderBy: addDays(fechaProximoPedido, params.diasContenedor - lt(cat)),
        minQty: rows.reduce((a, r) => a + r.minOrder, 0),
        minCbm: rows.reduce((a, r) => a + r.minCbm, 0),
        fullQty: rows.reduce((a, r) => a + r.fullOrder, 0),
        fullCases: rows.reduce((a, r) => a + (r.fullCases ?? 0), 0),
        fullCbm: rows.reduce((a, r) => a + r.fullCbm, 0),
      };
    });
    return {
      today,
      months,
      historyMonths: months.slice(-p.mesesHistoria),
      params: { ...params, guardados: p, fechaProximoPedidoSugerida: fechaProximoPedido },
      containers: conts.map((c) => ({ id: c.id, code: c.code, status: c.status, eta: c.eta, etaSource: c.etaSource, etd: c.etd, portEta: c.portEta, qty: c.qty, skus: c.skus, cbm: c.cbm })),
      channels: channelsOut,
      china,
      fill: { ...result.fill, arrival: addDays(fechaProximoPedido, params.diasContenedor) },
      byCategory: byCat,
      summary: {
        demandFba: channelsOut.reduce((a, r) => a + r.demandFba, 0),
        demandFbl: channelsOut.reduce((a, r) => a + r.demandFbl, 0),
        demandAplin: channelsOut.reduce((a, r) => a + r.demandAplin, 0),
        demandTotal: china.reduce((a, r) => a + r.demand, 0),
        urgentCount: urgent.length,
        fbaUrgent: channelsOut.filter((r) => r.coverFba !== null && r.coverFba < p.dhlDias).length,
        noRecentSales: china.filter((r) => r.alert === 'SIN_VENTA_RECIENTE').length,
        newWithoutSales: china.filter((r) => r.alert === 'SIN_VENTA_EN_CAMINO').length,
        suggestFba: channelsOut.reduce((a, r) => a + r.suggestFba, 0),
        sendFba: channelsOut.reduce((a, r) => a + r.sendFba, 0),
        suggestFbl: channelsOut.reduce((a, r) => a + r.suggestFbl, 0),
        sendFbl: channelsOut.reduce((a, r) => a + r.sendFbl, 0),
      },
      urgent: urgent.slice(0, 30).map((r) => ({ skuId: r.skuId, skuCode: r.skuCode, skuName: r.skuName, stockoutDate: r.stockoutDate, nextArrival: r.nextArrival ?? r.newOrderArrival, daysWithout: r.daysWithout, demand: r.demand, onTheWay: r.onTheWay, minOrder: r.minOrder })),
    };
  }

  // ───────────────────────────── Acciones ─────────────────────────────

  /** Crea una transferencia en borrador de APLIN a FBA o FBL con los envíos elegidos (sólo piezas sueltas; los kits se arman antes). */
  async createShipment(body: unknown, actor: Actor) {
    const data = parse(
      z.object({
        destination: z.enum(['AMZ-FBA', 'LIV-FBL']),
        reference: z.string().trim().max(100).nullish(),
        items: z.array(z.object({ masterSkuId: z.string().uuid(), qty: z.number().int().positive() })).min(1).max(500),
      }),
      body,
    );
    const whs = await this.db.select({ id: warehouses.id, code: warehouses.code }).from(warehouses).where(inArray(warehouses.code, ['APLIN', data.destination]));
    const o = whs.find((w) => w.code === 'APLIN');
    const d = whs.find((w) => w.code === data.destination);
    if (!o || !d) throw new BadRequestException('Faltan los almacenes APLIN o destino.');
    const kits = await this.db.select({ id: masterSkus.id, code: masterSkus.skuCode }).from(masterSkus).where(and(inArray(masterSkus.id, data.items.map((i) => i.masterSkuId)), eq(masterSkus.isKit, true)));
    if (kits.length) throw new BadRequestException(`Los kits (${kits.map((k) => k.code).join(', ')}) se arman primero en APLIN y se agregan a la transferencia.`);
    return this.transfers.create(
      {
        originWarehouseId: o.id,
        destinationWarehouseId: d.id,
        reference: data.reference ?? `Reabasto ${todayMx()}`,
        notes: 'Creada desde Reabasto con los envíos sugeridos.',
        items: data.items.map((i) => ({ masterSkuId: i.masterSkuId, qtyRequested: i.qty })),
      },
      actor,
    );
  }

  /** Guarda el pedido sugerido como contenedor PLANEADO (no cuenta como "en camino" hasta pasarlo a EN PRODUCCIÓN). */
  async createOrder(body: unknown, actor: Actor) {
    const data = parse(
      z.object({
        code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9 ._-]{0,30}$/, 'Clave inválida'),
        mode: z.enum(['MINIMO', 'LLENO']),
        fecha: isoDate.optional(),
      }),
      body,
    );
    const r = await this.compute({ fecha: data.fecha });
    const lines = r.china.filter((c) => (data.mode === 'LLENO' ? c.fullOrder : c.minOrder) > 0);
    if (!lines.length) throw new BadRequestException('No hay nada que pedir con los parámetros actuales.');
    const [dup] = await this.db.select({ id: importContainers.id }).from(importContainers).where(sql`upper(${importContainers.code}) = ${data.code}`);
    if (dup) throw new BadRequestException(`Ya existe el contenedor ${data.code}.`);
    return this.db.transaction(async (tx) => {
      const [c] = await tx
        .insert(importContainers)
        .values({ code: data.code, status: 'PLANEADO', capacityCbm: String(r.fill.capacity), notes: `Pedido ${data.mode === 'LLENO' ? 'con el contenedor lleno' : 'mínimo'} sugerido por Reabasto.`, createdById: actor.id, updatedById: actor.id })
        .returning({ id: importContainers.id });
      await tx.insert(importContainerLines).values(
        lines.map((l) => ({ containerId: c.id, masterSkuId: l.skuId, qty: data.mode === 'LLENO' ? l.fullOrder : l.minOrder, orderDate: r.params.fechaProximoPedido })),
      );
      const qty = lines.reduce((a, l) => a + (data.mode === 'LLENO' ? l.fullOrder : l.minOrder), 0);
      await this.audit.log(tx, actor, {
        action: 'CREAR', module: 'compras', entity: 'import_containers', entityId: c.id,
        summary: `Planeó el contenedor ${data.code}: ${lines.length} SKU, ${qty} piezas`,
      });
      return { id: c.id, code: data.code, skus: lines.length, qty };
    });
  }
}
