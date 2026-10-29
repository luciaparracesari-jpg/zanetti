import type { DbOrTx, Tx } from '@erp/db';
import type { Actor } from '../../common/actor';
import type { ApplyContext, ImportTemplate, InputRow, RowMessage, ValidatedRow } from '../types';
import { applySales, buildResolver, existingKeys, finishRow, occurrence, parseNumber, parseSaleDate, type SalePlan } from './sales-common';

/**
 * Reporte mensual de Amazon (MonthlyCombinedTax / "Detalle de Ventas Amazon"), tal como se descarga.
 * Cada pieza vendida es un renglón OUR_PRICE con Transaction_Type SHIPMENT; RETURN es una devolución.
 * Los renglones de envío, regalo, promociones sin producto y cargos se ignoran.
 */
export const salesAmazonTemplate: ImportTemplate<SalePlan> = {
  key: 'ventas-amazon',
  label: 'Ventas de Amazon',
  description: 'Reporte mensual de Amazon (MonthlyCombinedTax) tal como lo descargas. Volver a cargarlo no duplica ventas.',
  permissions: ['pedidos.crear'],
  maxRows: 30000,
  quietIgnoredColumns: true,
  columns: [
    { field: 'orderId', header: 'Order_ID', aliases: ['ORDER ID'], help: 'Pedido de Amazon.' },
    { field: 'shipmentId', header: 'Shipment_ID', aliases: ['SHIPMENT ID'], help: 'Envío.' },
    { field: 'shipmentDate', header: 'Shipment_Date', aliases: ['SHIPMENT DATE'], required: true, help: 'Fecha de envío (define el día de la venta).' },
    { field: 'postedDate', header: 'Posted_Date', aliases: ['POSTED DATE'], help: 'Fecha de registro (si falta la de envío).' },
    { field: 'fulfillment', header: 'Fulfillment', required: true, help: 'AFN = Amazon FBA; MFN = enviado desde APLIN.' },
    { field: 'asin', header: 'ASIN', required: true, help: 'ASIN vendido.' },
    { field: 'sellerSku', header: 'SKU', help: 'SKU de vendedor en Amazon.' },
    { field: 'type', header: 'Transaction_Type', aliases: ['TRANSACTION TYPE'], required: true, help: 'SHIPMENT o RETURN.' },
    { field: 'component', header: 'Financial_Component', aliases: ['FINANCIAL COMPONENT'], required: true, help: 'Sólo OUR_PRICE es una pieza.' },
    { field: 'quantity', header: 'Quantity', help: 'Piezas (siempre 1 en este reporte).' },
    { field: 'total', header: 'Total', help: 'Venta neta sin IVA.' },
  ],

  async validate(db: DbOrTx, rows: InputRow[], _actor: Actor): Promise<ValidatedRow<SalePlan>[]> {
    const r = await buildResolver(db, 'AMAZON');
    const occ = occurrence();
    const pre = rows.map((row) => {
      const v = row.values;
      const messages: RowMessage[] = [];
      const type = (v.type ?? '').toUpperCase();
      const comp = (v.component ?? '').toUpperCase();
      if (comp !== 'OUR_PRICE' || (type !== 'SHIPMENT' && type !== 'RETURN')) {
        return { row, messages, plan: null as SalePlan | null, ignored: `No es una pieza vendida (${type || 'sin tipo'} · ${comp || 'sin componente'}).` };
      }
      const asin = (v.asin ?? '').toUpperCase();
      if (!asin) return { row, messages, plan: null, ignored: 'Renglón sin ASIN (promoción o cargo sin producto).' };
      const date = parseSaleDate(v.shipmentDate) ?? parseSaleDate(v.postedDate);
      if (!date) messages.push({ field: 'shipmentDate', level: 'error', message: `Fecha inválida: “${v.shipmentDate ?? ''}”.` });
      const qty = Math.abs(parseNumber(v.quantity) ?? 1) || 1;
      const sign = type === 'RETURN' ? -1 : 1;
      const res = r.asListing(asin) ?? r.asAlias(asin) ?? r.asSku(v.sellerSku) ?? r.asAlias(v.sellerSku);
      if (!res) messages.push({ field: 'asin', level: 'warning', message: `El ASIN ${asin} no está ligado a un SKU maestro: se guarda y entra al cálculo cuando lo ligues.` });
      const origin = (v.fulfillment ?? '').toUpperCase() === 'MFN' ? 'AMZ-MFN' : 'AMZ-FBA';
      const base = occ(`AMZ|${v.orderId ?? ''}|${v.shipmentId ?? ''}|${asin}|${type}|${date ?? ''}`);
      const total = parseNumber(v.total);
      const plan: SalePlan = {
        channel: 'AMAZON',
        origin,
        saleDate: date ?? '',
        kind: sign > 0 ? 'VENTA' : 'DEVOLUCION',
        externalCode: asin,
        externalSku: v.sellerSku,
        orderRef: v.orderId,
        amount: total === null ? null : total.toFixed(2),
        lines: res
          ? res.lines.map((l) => ({ skuId: l.skuId, skuCode: l.skuCode, qty: sign * qty * l.mult, listingId: res.listingId, sourceKey: res.lines.length > 1 ? `${base}|${l.skuCode}` : base }))
          : [{ skuId: null, skuCode: null, qty: sign * qty, listingId: null, sourceKey: base }],
        label: `${sign > 0 ? 'Venta' : 'Devolución'} ${origin} ${date ?? ''} · ${asin}${res ? ` → ${res.lines.map((l) => (l.mult > 1 ? `${l.mult}×${l.skuCode}` : l.skuCode)).join(' + ')}` : ''}`,
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
