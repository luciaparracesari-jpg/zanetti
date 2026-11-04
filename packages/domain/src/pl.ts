/**
 * P&L unitario de un SKU en un canal (formato "P&L Cont. 49" del negocio), en pesos por pieza:
 *
 *   Venta neta      = precio con IVA ÷ 1.16
 *   COGS            = producto (precio proveedor × TC, sin IVA: no se divide) + arancel + gastos de importación por pieza
 *                     + envío a la bodega del canal (por caja ÷ piezas por caja)
 *   Margen operativo = neta − COGS − comisión − fulfillment (FBA/FBL) − publicidad
 *   EBITDA          = margen operativo − almacenaje
 */

export const IVA = 0.16;

export type CommissionBase = 'VENTA_CON_IVA' | 'VENTA_NETA' | 'DESPUES_DESCUENTO';

export interface PlUnitCost {
  /** Precio del proveedor en pesos por pieza. */
  product: number;
  duty: number;
  importExpenses: number;
}

export interface PlParams {
  commissionRate: number;
  commissionBase: CommissionBase;
  commissionFixed: number;
  fulfillmentPerUnit: number;
  adsRate: number;
  storagePerUnit: number;
  /** Envío de APLIN a la bodega del canal por caja master. */
  inboundPerBox: number;
  caseUnits: number | null;
}

export interface UnitPl {
  gross: number;
  net: number;
  product: number;
  duty: number;
  importExpenses: number;
  inbound: number;
  cogs: number;
  commission: number;
  fulfillment: number;
  ads: number;
  operatingMargin: number;
  storage: number;
  ebitda: number;
  /** EBITDA ÷ venta neta. */
  ebitdaPct: number | null;
  /** (Venta neta − COGS) ÷ venta neta. */
  grossMarginPct: number | null;
}

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

export function unitPl(grossPrice: number, cost: PlUnitCost, p: PlParams): UnitPl {
  const net = grossPrice / (1 + IVA);
  const product = cost.product;
  const inbound = p.inboundPerBox > 0 && p.caseUnits && p.caseUnits > 0 ? p.inboundPerBox / p.caseUnits : 0;
  const cogs = product + cost.duty + cost.importExpenses + inbound;
  const base = p.commissionBase === 'VENTA_NETA' ? net : grossPrice;
  const commission = base * p.commissionRate + p.commissionFixed;
  const ads = net * p.adsRate;
  const operatingMargin = net - cogs - commission - p.fulfillmentPerUnit - ads;
  const ebitda = operatingMargin - p.storagePerUnit;
  return {
    gross: r4(grossPrice),
    net: r4(net),
    product: r4(product),
    duty: r4(cost.duty),
    importExpenses: r4(cost.importExpenses),
    inbound: r4(inbound),
    cogs: r4(cogs),
    commission: r4(commission),
    fulfillment: r4(p.fulfillmentPerUnit),
    ads: r4(ads),
    operatingMargin: r4(operatingMargin),
    storage: r4(p.storagePerUnit),
    ebitda: r4(ebitda),
    ebitdaPct: net > 0 ? r4(ebitda / net) : null,
    grossMarginPct: net > 0 ? r4((net - cogs) / net) : null,
  };
}
