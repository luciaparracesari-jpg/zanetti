/** Tipos y etiquetas de compras, costeo de contenedores, valor del inventario y P&L por SKU. */

export const PO_STATUS: Record<string, string> = {
  BORRADOR: 'Borrador',
  ENVIADA: 'Enviada al proveedor',
  CONFIRMADA: 'Confirmada',
  RECIBIDA: 'Recibida',
  CANCELADA: 'Cancelada',
};

export const COST_STATUS: Record<string, string> = { ABIERTO: 'Costeo abierto', CERRADO: 'Costeo cerrado' };

export const BASIS: Record<string, string> = { PIEZAS: 'Por piezas', CBM: 'Por volumen (CBM)', VALOR: 'Por valor' };

export const ATTACHMENT_KIND: Record<string, string> = {
  ORDEN: 'Orden de compra',
  PROFORMA: 'Proforma',
  FACTURA: 'Factura comercial',
  PACKING_LIST: 'Packing list',
  BL: 'BL',
  PEDIMENTO: 'Pedimento',
  COMPROBANTE_PAGO: 'Comprobante de pago',
  FACTURA_GASTO: 'Factura de gasto',
  OTRO: 'Otro',
};

export const CURRENCIES = ['USD', 'MXN', 'CNY'] as const;

export interface PoRow {
  id: string;
  folio: string;
  supplierId: string;
  supplier: string;
  supplierRef: string | null;
  orderDate: string;
  expectedDate: string | null;
  currency: string;
  status: string;
  pieces: number;
  skus: number;
  containers: string | null;
  fxRate?: string | null;
  total?: string;
  unpriced?: number;
  paid?: string;
}

export interface PoItem {
  id: string;
  lineNo: number;
  skuId: string;
  skuCode: string;
  name: string;
  supplierSku: string | null;
  qty: number;
  caseUnits: number | null;
  cases: number | null;
  cbm: number | null;
  inContainers: number;
  containers: string | null;
  notes: string | null;
  unitPrice?: string | null;
  amount?: string | null;
}

export interface PoPayment {
  id: string;
  paidAt: string;
  amount: string;
  fxRate: string | null;
  amountMxn: string | null;
  reference: string | null;
  notes: string | null;
}

export interface PurchaseOrder {
  id: string;
  folio: string;
  supplierId: string;
  supplier: string;
  supplierRef: string | null;
  orderDate: string;
  expectedDate: string | null;
  currency: string;
  incoterm: string | null;
  paymentTerms: string | null;
  status: string;
  notes: string | null;
  pieces: number;
  cbm: number;
  unpriced: number;
  items: PoItem[];
  containers: { id: string; code: string; status: string; costStatus: string; pieces: number }[];
  fxRate?: string | null;
  total?: string;
  paid?: string;
  balance?: string;
  payments?: PoPayment[];
}

export interface CostIssue {
  code: string;
  message: string;
  lineId?: string;
  expenseId?: string;
}

export interface CostExpense {
  id: string;
  lineNo: number;
  concept: string;
  amount: string;
  currency: string;
  fxRate: string | null;
  fxUsed: number | null;
  amountMxn: string;
  basis: string;
  invoiceRef: string | null;
  notes: string | null;
}

export interface CostLine {
  id: string;
  skuId: string;
  skuCode: string;
  name: string;
  qty: number;
  qtyReceived: number | null;
  qtyCosted: number;
  supplier: string | null;
  poId: string | null;
  poFolio: string | null;
  unitPrice: string | null;
  currency: string | null;
  poFxRate: string | null;
  dutyRate: string | null;
  cbm: number | null;
  unitCost: string | null;
  merchUnitCost: string | null;
  dutyUnitCost: string | null;
  expenseUnitCost: string | null;
  fxUsed: number | null;
  calc: { merchUnit: string; dutyUnit: string; expenseUnit: string; unitCost: string; merchTotal: string; dutyTotal: string; expenseTotal: string; total: string } | null;
  lot: { unitCost: string; costStatus: string; onHand: number } | null;
}

export interface Costing {
  id: string;
  code: string;
  status: string;
  received: boolean;
  pedimento: string | null;
  invoiceRef: string | null;
  fxRate: string | null;
  dutyFxRate: string | null;
  costStatus: string;
  costClosedAt: string | null;
  totals: { pieces: number; cbm: number; merchMxn: number; dutyMxn: number; expensesMxn: number; expensePerPiece: number; total: number };
  issues: CostIssue[];
  warnings: CostIssue[];
  expenses: CostExpense[];
  lines: CostLine[];
  defaultConcepts: string[];
}

export interface CloseResult {
  totals: Costing['totals'];
  received: boolean;
  revalued: { skuCode: string; lotCode: string; oldCost: string; newCost: string; changed: boolean; onHand: number; inTransit: number; consumed: number; deltaOnHand: string; deltaInTransit: string; deltaConsumed: string }[];
  deltaOnHand: string;
  deltaInTransit: string;
  deltaConsumed: string;
}

export interface AttachmentRow {
  id: string;
  kind: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  notes: string | null;
  createdAt: string;
  createdBy: string | null;
}

/** Texto de tasa: "0.25" → "25 %". */
export const pctText = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? '' : String(Math.round(Number(v) * 10000) / 100));

export const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

const curFmt = new Map<string, Intl.NumberFormat>();
/** Monto en la moneda indicada (USD 7.5 → "USD 7.50"). */
export function fmtCur(v: string | number | null | undefined, currency: string, digits = 2) {
  if (v === null || v === undefined || v === '') return '—';
  const k = `${currency}:${digits}`;
  if (!curFmt.has(k)) curFmt.set(k, new Intl.NumberFormat('es-MX', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: digits }));
  return curFmt.get(k)!.format(Number(v));
}
