import type { DbOrTx, Tx } from '@erp/db';
import type { Actor } from '../../common/actor';
import type { ApplyContext, ImportTemplate, InputRow, RowMessage, ValidatedRow } from '../types';
import { applySales, buildResolver, existingKeys, finishRow, occurrence, parseNumber, parseSaleDate, type SalePlan } from './sales-common';

/** Exportación de pedidos de Shopify (orders_export). Los pedidos cancelados, reembolsados o anulados no cuentan. */
export const salesShopifyTemplate: ImportTemplate<SalePlan> = {
  key: 'ventas-shopify',
  label: 'Ventas de Shopify',
  description: 'Exportación de pedidos de Shopify (orders_export) tal como la descargas. Volver a cargarla no duplica ventas.',
  permissions: ['pedidos.crear'],
  maxRows: 30000,
  quietIgnoredColumns: true,
  columns: [
    { field: 'name', header: 'Name', required: true, help: 'Número de pedido (#1393).' },
    { field: 'financialStatus', header: 'Financial Status', help: 'paid, refunded, voided…' },
    { field: 'createdAt', header: 'Created at', required: true, help: 'Fecha del pedido.' },
    { field: 'qty', header: 'Lineitem quantity', required: true, help: 'Piezas.' },
    { field: 'itemName', header: 'Lineitem name', help: 'Producto.' },
    { field: 'price', header: 'Lineitem price', help: 'Precio con IVA.' },
    { field: 'sku', header: 'Lineitem sku', required: true, help: 'SKU del producto.' },
    { field: 'cancelledAt', header: 'Cancelled at', help: 'Si tiene fecha, el pedido se canceló.' },
  ],

  async validate(db: DbOrTx, rows: InputRow[], _actor: Actor): Promise<ValidatedRow<SalePlan>[]> {
    const r = await buildResolver(db, 'SHOPIFY');
    const occ = occurrence();
    // El estado y la fecha vienen sólo en el primer renglón de cada pedido.
    const status = new Map<string, string>();
    const created = new Map<string, string>();
    const cancelled = new Set<string>();
    for (const row of rows) {
      const n = row.values.name;
      if (!n) continue;
      if (row.values.financialStatus && !status.has(n)) status.set(n, row.values.financialStatus.toLowerCase());
      if (row.values.createdAt && !created.has(n)) created.set(n, row.values.createdAt);
      if (row.values.cancelledAt) cancelled.add(n);
    }
    const pre = rows.map((row) => {
      const v = row.values;
      const messages: RowMessage[] = [];
      const name = v.name ?? '';
      if (!v.sku && !v.itemName) return { row, messages, plan: null as SalePlan | null, ignored: 'Renglón sin producto.' };
      if (cancelled.has(name)) return { row, messages, plan: null, ignored: 'Pedido cancelado.' };
      const st = status.get(name) ?? '';
      if (st === 'refunded' || st === 'voided') return { row, messages, plan: null, ignored: `Pedido ${st === 'refunded' ? 'reembolsado' : 'anulado'}.` };
      const date = parseSaleDate(v.createdAt ?? created.get(name) ?? null);
      if (!date) messages.push({ field: 'createdAt', level: 'error', message: `Fecha inválida: “${v.createdAt ?? ''}”.` });
      const qty = parseNumber(v.qty);
      if (qty === null || !Number.isInteger(qty) || qty <= 0) messages.push({ field: 'qty', level: 'error', message: `Cantidad inválida: “${v.qty ?? ''}”.` });
      const code = (v.sku ?? '').toUpperCase();
      const res = r.asSku(code) ?? r.asListing(code) ?? r.asAlias(code);
      if (!res) messages.push({ field: 'sku', level: 'warning', message: `El SKU “${v.sku ?? v.itemName}” no está ligado a un SKU maestro: se guarda y entra al cálculo cuando lo ligues.` });
      const q = qty ?? 0;
      const base = occ(`SHP|${name}|${code}`);
      const price = parseNumber(v.price);
      const plan: SalePlan = {
        channel: 'SHOPIFY',
        origin: 'SHOPIFY',
        saleDate: date ?? '',
        kind: 'VENTA',
        externalCode: code || (v.itemName ?? '').slice(0, 60),
        externalSku: v.sku,
        orderRef: name,
        amount: price === null ? null : ((price * q) / 1.16).toFixed(2),
        lines: res
          ? res.lines.map((l) => ({ skuId: l.skuId, skuCode: l.skuCode, qty: q * l.mult, listingId: res.listingId, sourceKey: res.lines.length > 1 ? `${base}|${l.skuCode}` : base }))
          : [{ skuId: null, skuCode: null, qty: q, listingId: null, sourceKey: base }],
        label: `Venta Shopify ${date ?? ''} · ${name} · ${code}`,
      };
      return { row, messages, plan, ignored: null as string | null };
    });
    const existing = await existingKeys(db, pre.flatMap((p) => p.plan?.lines.map((l) => l.sourceKey) ?? []));
    return pre.map((p) => finishRow(p.row.rowNumber, p.messages, p.plan, existing, p.ignored));
  },

  apply(tx: Tx, rows: { rowNumber: number; plan: SalePlan }[], ctx: ApplyContext) {
    return applySales(tx, rows, ctx);
  },
};
