import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { containerCosts, importContainers, type Db } from '@erp/db';
import { effectiveFx } from '@erp/domain';
import { InjectDb } from '../common/db';
import { ContainerCostingService } from './costing.service';

const ON_THE_WAY = ['EN_PRODUCCION', 'EN_NAVIERA', 'EN_ADUANA'] as const;

type LotRow = {
  lot_code: string;
  wh: string;
  skus: number;
  qty: number;
  value: string;
  provisional: number;
  no_cost: number;
};

/**
 * Valor del inventario por contenedor (lote): lo que hay en cada almacén y en camino entre almacenes, al costo de
 * cada lote; más lo que viene de China (contenedores en camino y órdenes aún sin contenedor) al costo estimado.
 */
@Injectable()
export class ValuationService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly costing: ContainerCostingService,
  ) {}

  async byContainer() {
    const onHand = (
      await this.db.execute<LotRow>(sql`
        SELECT l.lot_code, w.code wh, count(DISTINCT l.master_sku_id)::int skus, sum(b.qty)::int qty,
               sum(b.qty * l.unit_cost)::numeric(16, 2) value,
               sum(b.qty) FILTER (WHERE l.cost_status = 'PROVISIONAL')::int provisional,
               sum(b.qty) FILTER (WHERE l.cost_status = 'PROVISIONAL' AND l.unit_cost = 0)::int no_cost
          FROM inventory_balances b
          JOIN inventory_lots l ON l.id = b.lot_id
          JOIN warehouses w ON w.id = b.warehouse_id
         WHERE b.qty > 0
         GROUP BY l.lot_code, w.code`)
    ).rows;
    const transit = (
      await this.db.execute<{ lot_code: string; qty: number; value: string }>(sql`
        SELECT l.lot_code, sum(il.qty - il.qty_received)::int qty, sum((il.qty - il.qty_received) * il.unit_cost)::numeric(16, 2) value
          FROM stock_transfer_item_lots il JOIN inventory_lots l ON l.id = il.lot_id
         WHERE il.qty > il.qty_received
         GROUP BY l.lot_code`)
    ).rows;
    const containers = await this.db.select().from(importContainers);
    const contByCode = new Map(containers.map((c) => [c.code.toUpperCase(), c]));
    const warehouses = [...new Set(onHand.map((r) => r.wh))].sort((a, b) => (a === 'APLIN' ? -1 : b === 'APLIN' ? 1 : a.localeCompare(b)));

    type Row = { lot: string; container: boolean; costStatus: string | null; skus: number; byWarehouse: Record<string, { qty: number; value: number }>; transitQty: number; transitValue: number; qty: number; value: number; provisional: number; noCost: number };
    const rows = new Map<string, Row>();
    // Un lote es de contenedor si su código es el de un contenedor registrado o tiene la forma CONT-NN (inventario inicial).
    const key = (code: string) => (contByCode.has(code.toUpperCase()) || /^CONT[-\s]?\d+/i.test(code) ? code.toUpperCase() : 'OTROS');
    const get = (code: string) => {
      const k = key(code);
      let r = rows.get(k);
      if (!r) {
        const c = contByCode.get(k);
        r = { lot: k, container: k !== 'OTROS', costStatus: c ? c.costStatus : null, skus: 0, byWarehouse: {}, transitQty: 0, transitValue: 0, qty: 0, value: 0, provisional: 0, noCost: 0 };
        rows.set(k, r);
      }
      return r;
    };
    const skuSets = new Map<string, number>();
    for (const x of onHand) {
      const r = get(x.lot_code);
      const w = (r.byWarehouse[x.wh] ??= { qty: 0, value: 0 });
      w.qty += x.qty;
      w.value += Number(x.value);
      r.qty += x.qty;
      r.value += Number(x.value);
      r.provisional += x.provisional ?? 0;
      r.noCost += x.no_cost ?? 0;
      skuSets.set(r.lot, Math.max(skuSets.get(r.lot) ?? 0, x.skus));
    }
    for (const x of transit) {
      const r = get(x.lot_code);
      r.transitQty += x.qty;
      r.transitValue += Number(x.value);
    }
    for (const r of rows.values()) r.skus = skuSets.get(r.lot) ?? 0;
    const lotRows = [...rows.values()].sort((a, b) => {
      if (a.lot === 'OTROS') return 1;
      if (b.lot === 'OTROS') return -1;
      return Number(b.lot.replace(/\D/g, '')) - Number(a.lot.replace(/\D/g, ''));
    });

    // Contenedores en camino, al costo estimado de hoy.
    const active = containers.filter((c) => (ON_THE_WAY as readonly string[]).includes(c.status));
    const onTheWay = [];
    for (const c of active.sort((a, b) => a.code.localeCompare(b.code))) {
      const lines = await this.costing.lines(this.db, c.id, false);
      const expenses = await this.db.select().from(containerCosts).where(eq(containerCosts.containerId, c.id));
      const r = this.costing.compute(lines, expenses, c);
      onTheWay.push({
        id: c.id,
        code: c.code,
        status: c.status,
        costStatus: c.costStatus,
        pieces: r.totals.pieces,
        merchMxn: r.totals.merchMxn.toFixed(2),
        dutyMxn: r.totals.dutyMxn.toFixed(2),
        expensesMxn: r.totals.expensesMxn.toFixed(2),
        total: r.totals.total.toFixed(2),
        unpricedPieces: lines.filter((l) => l.unitPrice === null).reduce((a, l) => a + l.qty, 0),
        issues: r.issues.length,
      });
    }

    // Órdenes con piezas que aún no están en un contenedor.
    const open = (
      await this.db.execute<Record<string, unknown>>(sql`
        SELECT po.id, po.folio, s.name supplier, po.status, po.currency, po.fx_rate,
               sum(greatest(i.qty - coalesce(cl.qty, 0), 0))::int pending,
               sum(greatest(i.qty - coalesce(cl.qty, 0), 0) * i.unit_price)::numeric(16, 2) pending_value,
               count(*) FILTER (WHERE i.unit_price IS NULL AND i.qty > coalesce(cl.qty, 0))::int unpriced,
               (SELECT sum(p.amount) FROM purchase_order_payments p WHERE p.po_id = po.id)::numeric(16, 2) paid,
               (SELECT sum(p.amount * coalesce(p.fx_rate, po.fx_rate, CASE WHEN po.currency = 'MXN' THEN 1 END)) FROM purchase_order_payments p WHERE p.po_id = po.id)::numeric(16, 2) paid_mxn
          FROM purchase_orders po
          JOIN suppliers s ON s.id = po.supplier_id
          JOIN purchase_order_items i ON i.po_id = po.id
          LEFT JOIN LATERAL (SELECT sum(l.qty) qty FROM import_container_lines l JOIN import_containers c ON c.id = l.container_id
                              WHERE l.po_item_id = i.id AND c.status <> 'CANCELADO') cl ON true
         WHERE po.status NOT IN ('CANCELADA', 'RECIBIDA')
         GROUP BY po.id, s.name
        HAVING sum(greatest(i.qty - coalesce(cl.qty, 0), 0)) > 0
         ORDER BY po.order_date, po.folio`)
    ).rows;
    const openOrders = open.map((o) => {
      const fx = effectiveFx(o.currency as string, o.fx_rate === null ? null : Number(o.fx_rate), null);
      return {
        id: o.id,
        folio: o.folio,
        supplier: o.supplier,
        status: o.status,
        currency: o.currency,
        pending: o.pending,
        pendingValue: o.pending_value ?? '0.00',
        pendingMxn: fx !== null && o.pending_value !== null ? (Number(o.pending_value) * fx).toFixed(2) : null,
        unpriced: o.unpriced,
        paid: o.paid ?? '0.00',
        paidMxn: o.paid_mxn ?? null,
      };
    });

    const totalOnHand = lotRows.reduce((a, r) => a + r.value, 0);
    const totalTransit = lotRows.reduce((a, r) => a + r.transitValue, 0);
    const totalOnTheWay = onTheWay.reduce((a, r) => a + Number(r.total), 0);
    const totalOpen = openOrders.reduce((a, r) => a + Number(r.pendingMxn ?? 0), 0);
    return {
      warehouses,
      lots: lotRows.map((r) => ({
        ...r,
        value: r.value.toFixed(2),
        transitValue: r.transitValue.toFixed(2),
        byWarehouse: Object.fromEntries(Object.entries(r.byWarehouse).map(([k, v]) => [k, { qty: v.qty, value: v.value.toFixed(2) }])),
      })),
      onTheWay,
      openOrders,
      totals: {
        onHandQty: lotRows.reduce((a, r) => a + r.qty, 0),
        onHand: totalOnHand.toFixed(2),
        transitQty: lotRows.reduce((a, r) => a + r.transitQty, 0),
        transit: totalTransit.toFixed(2),
        onTheWayQty: onTheWay.reduce((a, r) => a + r.pieces, 0),
        onTheWay: totalOnTheWay.toFixed(2),
        openOrdersQty: openOrders.reduce((a, r) => a + Number(r.pending), 0),
        openOrders: totalOpen.toFixed(2),
        provisionalQty: lotRows.reduce((a, r) => a + r.provisional, 0),
        noCostQty: lotRows.reduce((a, r) => a + r.noCost, 0),
        inventory: (totalOnHand + totalTransit).toFixed(2),
        all: (totalOnHand + totalTransit + totalOnTheWay + totalOpen).toFixed(2),
      },
    };
  }
}
