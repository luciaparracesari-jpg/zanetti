import { Controller, Get, Query } from '@nestjs/common';
import { and, asc, desc, eq, gte, ilike, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { channels, masterSkus, salesLines, type Db } from '@erp/db';
import { Perm } from '../auth/decorators';
import { CurrentActor, type Actor } from '../common/actor';
import { InjectDb } from '../common/db';
import { countSql, likePattern, orderFrom, readListQuery, str } from '../common/listing';

const isDate = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);

/** Ventas importadas de los canales (base de la demanda del reabasto). */
@Controller('sales')
export class SalesController {
  constructor(@InjectDb() private readonly db: Db) {}

  @Get()
  @Perm('pedidos.ver')
  async list(@Query() q: Record<string, string>, @CurrentActor() actor: Actor) {
    const lq = readListQuery(q, actor, 'pedidos');
    const conds: SQL[] = [];
    if (isDate(q.from)) conds.push(gte(salesLines.saleDate, q.from));
    if (isDate(q.to)) conds.push(lte(salesLines.saleDate, q.to));
    if (str(q.channel)) conds.push(eq(channels.code, q.channel));
    if (str(q.origin)) conds.push(eq(salesLines.origin, q.origin));
    if (q.kind === 'VENTA' || q.kind === 'DEVOLUCION') conds.push(eq(salesLines.kind, q.kind));
    if (q.unmapped === '1') conds.push(isNull(salesLines.masterSkuId));
    if (str(q.skuId)) conds.push(eq(salesLines.masterSkuId, q.skuId));
    if (lq.q) {
      const p = likePattern(lq.q);
      conds.push(or(ilike(masterSkus.skuCode, p), ilike(salesLines.externalCode, p), ilike(salesLines.orderRef, p), ilike(masterSkus.name, p))!);
    }
    const where = conds.length ? and(...conds) : undefined;
    const base = this.db
      .select({
        id: salesLines.id,
        saleDate: salesLines.saleDate,
        channelCode: channels.code,
        origin: salesLines.origin,
        kind: salesLines.kind,
        qty: salesLines.qty,
        amount: salesLines.amount,
        externalCode: salesLines.externalCode,
        externalSku: salesLines.externalSku,
        orderRef: salesLines.orderRef,
        skuId: salesLines.masterSkuId,
        skuCode: masterSkus.skuCode,
        skuName: masterSkus.name,
      })
      .from(salesLines)
      .innerJoin(channels, eq(channels.id, salesLines.channelId))
      .leftJoin(masterSkus, eq(masterSkus.id, salesLines.masterSkuId))
      .where(where);
    const items = await base
      .orderBy(...orderFrom(lq.sort, { saleDate: salesLines.saleDate, qty: salesLines.qty, skuCode: masterSkus.skuCode, channel: channels.code }, desc(salesLines.saleDate)), asc(salesLines.id))
      .limit(lq.pageSize)
      .offset((lq.page - 1) * lq.pageSize);
    const [{ total, pieces }] = await this.db
      .select({ total: countSql, pieces: sql<number>`coalesce(sum(${salesLines.qty}), 0)::int` })
      .from(salesLines)
      .innerJoin(channels, eq(channels.id, salesLines.channelId))
      .leftJoin(masterSkus, eq(masterSkus.id, salesLines.masterSkuId))
      .where(where);
    return { items, total, page: lq.page, pageSize: lq.pageSize, pieces };
  }

  /** Piezas netas por SKU y mes (y por canal), para ver la tendencia. */
  @Get('monthly')
  @Perm('pedidos.ver')
  async monthly(@Query('months') monthsQ?: string, @Query('channel') channel?: string) {
    const months = Math.min(Math.max(Number(monthsQ) || 12, 1), 24);
    const rows = await this.db.execute<{ sku: string | null; code: string | null; name: string | null; ch: string; m: string; q: number }>(sql`
      select l.master_sku_id sku, s.sku_code code, s.name, c.code ch, to_char(l.sale_date, 'YYYY-MM') m, sum(l.qty)::int q
        from sales_lines l join channels c on c.id = l.channel_id left join master_skus s on s.id = l.master_sku_id
       where l.sale_date >= (date_trunc('month', now() at time zone 'America/Mexico_City') - make_interval(months => ${months}))::date
         ${channel ? sql`and c.code = ${channel}` : sql``}
       group by 1, 2, 3, 4, 5`);
    const monthSet = [...new Set(rows.rows.map((r) => r.m))].sort();
    const bySku = new Map<string, { skuId: string | null; skuCode: string; skuName: string; total: number; byMonth: Record<string, number>; byChannel: Record<string, number> }>();
    const totals: Record<string, Record<string, number>> = {};
    for (const r of rows.rows) {
      const k = r.sku ?? 'SIN SKU';
      const e = bySku.get(k) ?? { skuId: r.sku, skuCode: r.code ?? 'Sin SKU', skuName: r.name ?? 'Códigos sin ligar', total: 0, byMonth: {}, byChannel: {} };
      e.total += r.q;
      e.byMonth[r.m] = (e.byMonth[r.m] ?? 0) + r.q;
      e.byChannel[r.ch] = (e.byChannel[r.ch] ?? 0) + r.q;
      bySku.set(k, e);
      totals[r.ch] ??= {};
      totals[r.ch][r.m] = (totals[r.ch][r.m] ?? 0) + r.q;
    }
    return { months: monthSet, totalsByChannel: totals, skus: [...bySku.values()].sort((a, b) => b.total - a.total) };
  }

  /** Códigos de los reportes que no están ligados a un SKU maestro. */
  @Get('unmapped')
  @Perm('pedidos.ver')
  async unmapped() {
    const rows = await this.db.execute<{ channel: string; code: string; sku: string | null; lines: number; qty: number; first: string; last: string }>(sql`
      select c.code channel, l.external_code code, max(l.external_sku) sku, count(*)::int lines, sum(l.qty)::int qty,
             min(l.sale_date)::text first, max(l.sale_date)::text last
        from sales_lines l join channels c on c.id = l.channel_id
       where l.master_sku_id is null group by 1, 2 order by qty desc`);
    return rows.rows;
  }
}
