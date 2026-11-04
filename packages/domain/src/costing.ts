/**
 * Costeo de un contenedor: costo puesto en bodega = precio del proveedor × tipo de cambio + arancel (IGI) del SKU +
 * gastos del contenedor repartidos entre sus renglones (por piezas, CBM o valor). Función pura: no toca la base.
 *
 * Arancel (P&L Cont. 49 del negocio): precio del proveedor × tipo de cambio del pedimento × tasa de la fracción del SKU
 * (15% o 25%).
 *
 * Método del negocio (hoja de costeo de contenedor): total de gastos ÷ piezas del contenedor = gasto por pieza, que se
 * suma al precio del proveedor convertido a pesos.
 */

export type AllocationBasis = 'PIEZAS' | 'CBM' | 'VALOR';

export interface CostingLine {
  id: string;
  skuId: string;
  skuCode?: string;
  /** Piezas del renglón (las recibidas si el contenedor ya llegó). */
  qty: number;
  /** Precio unitario del proveedor en `currency`; null = sin precio capturado. */
  unitPrice: number | null;
  currency: string | null;
  /** Tipo de cambio del renglón (el de su orden); si falta se usa el del contenedor. */
  fxRate: number | null;
  /** CBM del renglón completo (para repartir por volumen). */
  cbm: number | null;
  /** Tasa de arancel (IGI) del SKU: 0.25 = 25%; null = sin capturar (se toma 0 y se avisa). */
  dutyRate?: number | null;
}

export interface CostingExpense {
  id: string;
  concept?: string;
  amount: number;
  currency: string;
  fxRate: number | null;
  basis: AllocationBasis;
}

export interface CostingIssue {
  code: 'SIN_PRECIO' | 'SIN_TIPO_CAMBIO' | 'SIN_MEDIDAS' | 'SIN_PIEZAS' | 'SIN_VALOR' | 'SIN_ARANCEL';
  message: string;
  lineId?: string;
  expenseId?: string;
}

export interface CostedLine {
  id: string;
  skuId: string;
  qty: number;
  fxRate: number | null;
  /** Precio del proveedor en pesos por pieza. */
  merchUnit: number;
  merchTotal: number;
  /** Arancel (IGI) por pieza y del renglón. */
  dutyUnit: number;
  dutyTotal: number;
  /** Gastos del contenedor asignados al renglón. */
  expenseTotal: number;
  expenseUnit: number;
  /** Costo puesto en bodega por pieza (4 decimales). */
  unitCost: number;
  total: number;
}

export interface CostedExpense {
  id: string;
  fxRate: number | null;
  amountMxn: number;
  basis: AllocationBasis;
}

export interface CostingResult {
  lines: CostedLine[];
  expenses: CostedExpense[];
  totals: {
    pieces: number;
    cbm: number;
    merchMxn: number;
    dutyMxn: number;
    expensesMxn: number;
    /** Gastos ÷ piezas: lo que suma cada pieza al costo cuando todo se reparte por piezas. */
    expensePerPiece: number;
    total: number;
  };
  /** Bloquean el cierre. */
  issues: CostingIssue[];
  /** Avisos que no bloquean (p. ej. SKU sin arancel capturado). */
  warnings: CostingIssue[];
}

const round = (n: number, d: number) => {
  const f = 10 ** d;
  return Math.round((n + Number.EPSILON) * f) / f;
};

/** Reparte `amount` (en centavos exactos) según los pesos, con el método del residuo mayor: la suma cuadra al centavo. */
export function allocate(amount: number, weights: number[]): number[] {
  const cents = Math.round(amount * 100);
  const total = weights.reduce((a, w) => a + (w > 0 ? w : 0), 0);
  if (cents === 0 || total <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => ((w > 0 ? w : 0) / total) * cents);
  const base = raw.map((r) => Math.floor(r));
  let left = cents - base.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) base[order[k].i]++;
  return base.map((c) => c / 100);
}

/** Tipo de cambio efectivo: 1 en pesos; el propio o el del contenedor en otra moneda. */
export function effectiveFx(currency: string | null, own: number | null, container: number | null): number | null {
  if (!currency || currency === 'MXN') return 1;
  return own && own > 0 ? own : container && container > 0 ? container : null;
}

export function computeContainerCost(
  lines: CostingLine[],
  expenses: CostingExpense[],
  containerFx: number | null,
  opts: { dutyFx?: number | null } = {},
): CostingResult {
  const issues: CostingIssue[] = [];
  const warnings: CostingIssue[] = [];
  const costed = lines.map((l) => {
    const label = l.skuCode ?? l.skuId;
    const fx = l.unitPrice === null ? null : effectiveFx(l.currency, l.fxRate, containerFx);
    if (l.qty <= 0) issues.push({ code: 'SIN_PIEZAS', message: `${label}: sin piezas.`, lineId: l.id });
    if (l.unitPrice === null) issues.push({ code: 'SIN_PRECIO', message: `${label}: falta el precio del proveedor (lígalo a una orden de compra con precio).`, lineId: l.id });
    else if (fx === null) issues.push({ code: 'SIN_TIPO_CAMBIO', message: `${label}: falta el tipo de cambio (${l.currency}) en la orden o en el contenedor.`, lineId: l.id });
    const merchUnit = l.unitPrice !== null && fx !== null ? l.unitPrice * fx : 0;
    // Arancel con el tipo de cambio del pedimento (si no hay, el mismo de la mercancía).
    const dutyFx = l.unitPrice === null ? null : !l.currency || l.currency === 'MXN' ? 1 : (opts.dutyFx && opts.dutyFx > 0 ? opts.dutyFx : fx);
    if (l.unitPrice !== null && (l.dutyRate === null || l.dutyRate === undefined))
      warnings.push({ code: 'SIN_ARANCEL', message: `${label}: sin tasa de arancel (IGI) capturada; se toma 0%.`, lineId: l.id });
    const dutyUnit = l.unitPrice !== null && dutyFx !== null && l.dutyRate ? l.unitPrice * dutyFx * l.dutyRate : 0;
    return { l, fx, merchUnit, merchTotal: round(merchUnit * l.qty, 4), dutyUnit, dutyTotal: round(dutyUnit * l.qty, 2) };
  });

  const alloc = costed.map(() => 0);
  const costedExpenses: CostedExpense[] = [];
  for (const e of expenses) {
    const fx = effectiveFx(e.currency, e.fxRate, containerFx);
    if (fx === null) {
      issues.push({ code: 'SIN_TIPO_CAMBIO', message: `Gasto "${e.concept ?? e.id}": falta el tipo de cambio (${e.currency}).`, expenseId: e.id });
      costedExpenses.push({ id: e.id, fxRate: null, amountMxn: 0, basis: e.basis });
      continue;
    }
    const amountMxn = round(e.amount * fx, 2);
    costedExpenses.push({ id: e.id, fxRate: fx, amountMxn, basis: e.basis });
    let weights: number[];
    if (e.basis === 'CBM') {
      const missing = costed.filter((c) => !c.l.cbm || c.l.cbm <= 0);
      if (missing.length && amountMxn > 0)
        issues.push({
          code: 'SIN_MEDIDAS',
          message: `Gasto "${e.concept ?? e.id}" se reparte por CBM pero ${missing.map((c) => c.l.skuCode ?? c.l.skuId).join(', ')} no tiene medidas de caja.`,
          expenseId: e.id,
        });
      weights = costed.map((c) => c.l.cbm ?? 0);
    } else if (e.basis === 'VALOR') {
      weights = costed.map((c) => c.merchTotal);
      if (amountMxn > 0 && weights.every((w) => w <= 0))
        issues.push({ code: 'SIN_VALOR', message: `Gasto "${e.concept ?? e.id}" se reparte por valor pero no hay precios capturados.`, expenseId: e.id });
    } else weights = costed.map((c) => c.l.qty);
    allocate(amountMxn, weights).forEach((a, i) => (alloc[i] += a));
  }

  const out: CostedLine[] = costed.map((c, i) => {
    const expenseTotal = round(alloc[i], 2);
    const expenseUnit = c.l.qty > 0 ? expenseTotal / c.l.qty : 0;
    const unitCost = round(c.merchUnit + c.dutyUnit + expenseUnit, 4);
    return {
      id: c.l.id,
      skuId: c.l.skuId,
      qty: c.l.qty,
      fxRate: c.fx,
      merchUnit: round(c.merchUnit, 4),
      merchTotal: round(c.merchTotal, 2),
      dutyUnit: round(c.dutyUnit, 4),
      dutyTotal: c.dutyTotal,
      expenseTotal,
      expenseUnit: round(expenseUnit, 4),
      unitCost,
      total: round(c.merchTotal + c.dutyTotal + expenseTotal, 2),
    };
  });
  const pieces = lines.reduce((a, l) => a + Math.max(l.qty, 0), 0);
  const merchMxn = round(out.reduce((a, l) => a + l.merchTotal, 0), 2);
  const dutyMxn = round(out.reduce((a, l) => a + l.dutyTotal, 0), 2);
  const expensesMxn = round(costedExpenses.reduce((a, e) => a + e.amountMxn, 0), 2);
  return {
    lines: out,
    expenses: costedExpenses,
    totals: {
      pieces,
      cbm: round(lines.reduce((a, l) => a + (l.cbm ?? 0), 0), 3),
      merchMxn,
      dutyMxn,
      expensesMxn,
      expensePerPiece: pieces > 0 ? round(expensesMxn / pieces, 4) : 0,
      total: round(merchMxn + dutyMxn + expensesMxn, 2),
    },
    issues,
    warnings,
  };
}

/** Conceptos del costeo del negocio (hoja "COMO SACAR COSTEO DE CONTENEDOR", CONT 17), en su orden. */
export const DEFAULT_COST_CONCEPTS: { concept: string; currency: 'MXN' | 'USD' }[] = [
  { concept: 'Recolección en fábrica y flete marítimo', currency: 'USD' },
  { concept: 'Flete nacional', currency: 'MXN' },
  { concept: 'Maniobras puerto', currency: 'MXN' },
  { concept: 'Trámite de documentación', currency: 'MXN' },
  { concept: 'Reconocimiento aduanero', currency: 'MXN' },
  { concept: 'Entrega lleno, camión', currency: 'MXN' },
  { concept: 'Recepción contenedor vacío', currency: 'MXN' },
  { concept: 'Honorarios agente aduanal', currency: 'MXN' },
  { concept: 'Maniobras adicionales', currency: 'MXN' },
  { concept: 'DTA', currency: 'MXN' },
  { concept: 'Prevalidación', currency: 'MXN' },
  { concept: 'PRV', currency: 'MXN' },
  { concept: 'IGI incrementables', currency: 'MXN' },
];
