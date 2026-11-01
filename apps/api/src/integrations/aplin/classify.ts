import type { channelOrderKind } from '@erp/db';

export type OrderKind = (typeof channelOrderKind.enumValues)[number];

/**
 * Qué representa una orden de APLIN según su número (confirmado con el negocio el 30-oct-2026):
 * - FBA… (ID de envío de Amazon) → envío de APLIN a Amazon FBA.
 * - LIV_NN (consecutivo propio) → envío de APLIN a Liverpool FBL.
 * - 10 dígitos ("Directo al cliente") → pedido Liverpool Vendor surtido desde APLIN.
 * - #NNNN-ZT → tienda Shopify Zanetti; #NNNN → tienda Shopify LeanTravel.
 */
export function classifyAplinOrder(orderNumber: string): OrderKind {
  const n = orderNumber.trim().toUpperCase();
  if (/^FBA[0-9A-Z]{6,}$/.test(n)) return 'ENVIO_FBA';
  if (/^LIV[_-]?\d+$/.test(n)) return 'ENVIO_FBL';
  if (/^\d{10}$/.test(n)) return 'LIVERPOOL_VENDOR';
  if (/^#\d+-ZT$/.test(n)) return 'SHOPIFY_ZANETTI';
  if (/^#\d+$/.test(n)) return 'SHOPIFY_LEANTRAVEL';
  return 'OTRO';
}
