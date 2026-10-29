import type { DbOrTx, Tx } from '@erp/db';
import type { Actor } from '../../common/actor';
import type { ApplyContext, ImportTemplate, InputRow, RowMessage, ValidatedRow } from '../types';
import { applySales, buildResolver, existingKeys, finishRow, occurrence, parseNumber, parseSaleDate, type SalePlan } from './sales-common';

/**
 * "Detalle de ventas Liverpool" (hoja Sheet1): FBL y Vendor juntos. Cantidad negativa = devolución.
 * El SKU sale de la columna sku del reporte; si no está, del número de artículo (publicación).
 */
export const salesLiverpoolTemplate: ImportTemplate<SalePlan> = {
  key: 'ventas-liverpool',
  label: 'Ventas de Liverpool',
  description: 'Detalle de ventas de Liverpool (FBL y Vendor) tal como lo descargas. Volver a cargarlo no duplica ventas.',
  permissions: ['pedidos.crear'],
  maxRows: 30000,
  quietIgnoredColumns: true,
  columns: [
    { field: 'store', header: 'Almacén', aliases: ['ALMACEN', 'TIENDA'], help: 'Tienda de Liverpool donde se registró la venta.' },
    { field: 'date', header: 'Fecha', required: true, help: 'Fecha de la venta.' },
    { field: 'article', header: 'Artículo', aliases: ['ARTICULO'], required: true, help: 'Número de artículo de Liverpool.' },
    { field: 'sku', header: 'sku', aliases: ['SKU MAESTRO'], help: 'SKU (si el reporte lo trae).' },
    { field: 'doc', header: 'Nº documento', aliases: ['N DOCUMENTO', 'NO DOCUMENTO', 'NUMERO DE DOCUMENTO'], help: '95… venta, 96… devolución.' },
    { field: 'ref', header: 'Referencia', help: 'Referencia del renglón.' },
    { field: 'amount', header: 'Venta con descuento', help: 'Venta con IVA después del descuento.' },
    { field: 'qty', header: 'cant', aliases: ['CANTIDAD', 'CANT.'], required: true, help: 'Piezas; negativas en devoluciones.' },
  ],

  async validate(db: DbOrTx, rows: InputRow[], _actor: Actor): Promise<ValidatedRow<SalePlan>[]> {
    const r = await buildResolver(db, 'LIVERPOOL');
    const occ = occurrence();
    const pre = rows.map((row) => {
      const v = row.values;
      const messages: RowMessage[] = [];
      const article = (v.article ?? '').toUpperCase();
      if (!article) return { row, messages, plan: null as SalePlan | null, ignored: 'Renglón sin artículo (totales del reporte).' };
      const date = parseSaleDate(v.date);
      if (!date) messages.push({ field: 'date', level: 'error', message: `Fecha inválida: “${v.date ?? ''}”.` });
      const qty = parseNumber(v.qty);
      if (qty === null || !Number.isInteger(qty)) messages.push({ field: 'qty', level: 'error', message: `Cantidad inválida: “${v.qty ?? ''}”.` });
      if (qty === 0) return { row, messages, plan: null, ignored: 'Cantidad en cero.' };
      const res = r.asSku(v.sku) ?? r.asAlias(v.sku) ?? r.asListing(article) ?? r.asAlias(article);
      if (!res) messages.push({ field: 'article', level: 'warning', message: `El artículo ${article}${v.sku ? ` (${v.sku})` : ''} no está ligado a un SKU maestro: se guarda y entra al cálculo cuando lo ligues.` });
      const q = qty ?? 0;
      const base = occ(`LIV|${v.doc ?? ''}|${v.ref ?? ''}|${article}|${q}`);
      const amount = parseNumber(v.amount);
      const plan: SalePlan = {
        channel: 'LIVERPOOL',
        origin: 'LIVERPOOL',
        saleDate: date ?? '',
        kind: q > 0 ? 'VENTA' : 'DEVOLUCION',
        externalCode: article,
        externalSku: v.sku,
        orderRef: v.doc,
        amount: amount === null ? null : (amount / 1.16).toFixed(2),
        lines: res
          ? res.lines.map((l) => ({ skuId: l.skuId, skuCode: l.skuCode, qty: q * l.mult, listingId: res.listingId, sourceKey: res.lines.length > 1 ? `${base}|${l.skuCode}` : base }))
          : [{ skuId: null, skuCode: null, qty: q, listingId: null, sourceKey: base }],
        label: `${q > 0 ? 'Venta' : 'Devolución'} Liverpool ${date ?? ''} · artículo ${article}${res ? ` → ${res.lines.map((l) => (l.mult > 1 ? `${l.mult}×${l.skuCode}` : l.skuCode)).join(' + ')}` : ''}`,
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
