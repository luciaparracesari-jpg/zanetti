/**
 * Motor de reabasto (funciones puras, sin base de datos).
 *
 * Es la misma lógica que el libro REABASTO_ZANETTI.xlsx verificado con el usuario:
 * - Venta base: promedio de los últimos N meses, sin contar los meses que vendieron menos de un % de la mediana
 *   (meses sin inventario), × 12 / 365 × factor del almacén.
 * - Amazon FBA y Liverpool FBL: envío cuando la cobertura baja de los días de envío + colchón, hasta la cobertura objetivo.
 * - APLIN sólo surte a FBA y FBL (y Shopify); los bundles se arman en APLIN con lo que sobra de sus componentes.
 * - China: proyección día a día con los contenedores en camino (sin quedar en negativo); pedido mínimo = un ciclo + seguridad;
 *   contenedor lleno = mayor número de días de venta iguales para todos que cabe en la capacidad.
 */

export type PlanWarehouse = 'AMZ-FBA' | 'LIV-FBL' | 'APLIN';

export interface ReplParams {
  mesesHistoria: number;
  pctQuiebre: number;
  factorFba: number;
  factorFbl: number;
  factorAplin: number;
  coberturaFba: number;
  coberturaFbl: number;
  almexDias: number;
  dhlDias: number;
  colchonFba: number;
  envioFblDias: number;
  colchonFbl: number;
  reservaAplinDias: number;
  redondearCajas: boolean;
  cicloDias: number;
  seguridadDias: number;
  capacidadCbm: number;
  /** Fecha del próximo pedido a China (aaaa-mm-dd). */
  fechaProximoPedido: string;
  /** Días del pedido a la llegada del contenedor (lo más lento que lleve). */
  diasContenedor: number;
}

export interface ReplSku {
  id: string;
  code: string;
  name: string;
  category: string | null;
  isKit: boolean;
  /** Piezas por caja master (null si no tiene). */
  caseUnits: number | null;
  /** CBM de la caja master (0 si no hay medidas). */
  cbmCase: number;
  leadTimeDays: number | null;
  /** false = no se incluye en el pedido a China. */
  include: boolean;
  /** Venta diaria capturada a mano (sustituye a la calculada en el pedido a China). */
  manualDailyDemand: number | null;
}

export interface ReplKitComponent {
  kitId: string;
  componentId: string;
  qty: number;
}

/** Serie mensual de ventas netas de un SKU que se surte desde un almacén (meses viejos → recientes). */
export interface ReplSeries {
  skuId: string;
  warehouse: PlanWarehouse;
  months: number[];
}

export interface ReplStock {
  aplin: number;
  fba: number;
  fbaTransit: number;
  fbl: number;
}

export interface ReplContainer {
  code: string;
  /** Llegada estimada a APLIN (aaaa-mm-dd). */
  eta: string;
  lines: { skuId: string; qty: number }[];
}

export interface ReplInput {
  today: string;
  params: ReplParams;
  /** Días que cubren los meses de la historia (para el promedio de todo el periodo). */
  historyDays: number;
  skus: ReplSku[];
  kits: ReplKitComponent[];
  series: ReplSeries[];
  stock: Record<string, ReplStock>;
  containers: ReplContainer[];
}

export interface ChannelRow {
  skuId: string;
  isKit: boolean;
  caseUnits: number | null;
  demandFba: number;
  demandFbl: number;
  demandAplin: number;
  demandTotal: number;
  /** En kits: los que se pueden armar con lo que sobra de componentes. */
  aplin: number;
  fba: number;
  fbaTransit: number;
  fbl: number;
  coverFba: number | null;
  stockoutFba: string | null;
  idealFba: number;
  suggestFba: number;
  via: 'DHL' | 'ALMEX' | null;
  coverFbl: number | null;
  idealFbl: number;
  suggestFbl: number;
  reserve: number;
  available: number;
  sendFba: number;
  sendFbl: number;
  shortfall: number;
  minAplin: number | null;
  aplinAfterContainer: number | null;
}

export interface ChinaRow {
  skuId: string;
  category: string | null;
  caseUnits: number | null;
  demandCalc: number;
  demandHistory: number;
  demand: number;
  physical: number;
  byContainer: Record<string, number>;
  onTheWay: number;
  position: number;
  coverTotal: number | null;
  stockoutDate: string | null;
  nextArrival: string | null;
  leadTime: number;
  newOrderArrival: string;
  daysWithout: number | null;
  projectedAtArrival: number;
  need: number;
  minOrder: number;
  minCases: number | null;
  minCbm: number;
  fullOrder: number;
  fullCases: number | null;
  fullCbm: number;
  daysAtArrival: number | null;
  include: boolean;
  alert: 'SIN_VENTA_EN_CAMINO' | 'SIN_VENTA_RECIENTE' | 'SE_AGOTA_ANTES_DE_LLEGADA' | 'SE_AGOTA_SIN_PEDIDO' | null;
}

export interface ReplResult {
  channels: ChannelRow[];
  china: ChinaRow[];
  containers: { code: string; eta: string; qty: number; cbm: number }[];
  fill: { days: number; cbm: number; minCbm: number; capacity: number; minDays: number };
}

// ───────────────────────────── utilidades ─────────────────────────────

const DAY = 86_400_000;
const toTime = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const addDays = (d: string, n: number) => new Date(toTime(d) + Math.round(n * DAY)).toISOString().slice(0, 10);
/** Fecha con fracción de día (como Excel): para mostrar sólo la parte de la fecha. */
const addDaysFrac = (d: string, n: number) => new Date(toTime(d) + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => (toTime(b) - toTime(a)) / DAY;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Venta diaria base de una serie mensual. */
export function baseDailyDemand(months: number[], lastN: number, pctQuiebre: number): number {
  const last = months.slice(-lastN);
  const thr = pctQuiebre * median(months);
  const sel = last.filter((v) => v >= thr);
  const avg = sel.length ? sel.reduce((a, b) => a + b, 0) / sel.length : 0;
  return (avg * 12) / 365;
}

/** Redondeo hacia arriba a cajas completas (o a piezas). */
function roundUp(q: number, caseUnits: number | null, toCases: boolean): number {
  if (q <= 0) return 0;
  if (toCases && caseUnits && caseUnits > 0) return Math.ceil(q / caseUnits) * caseUnits;
  return Math.ceil(q);
}

// ───────────────────────────── cálculo ─────────────────────────────

export function computeReplenishment(input: ReplInput): ReplResult {
  const { params: P, today } = input;
  const skuById = new Map(input.skus.map((s) => [s.id, s]));
  const stockOf = (id: string): ReplStock => input.stock[id] ?? { aplin: 0, fba: 0, fbaTransit: 0, fbl: 0 };
  const factor: Record<PlanWarehouse, number> = { 'AMZ-FBA': P.factorFba, 'LIV-FBL': P.factorFbl, APLIN: P.factorAplin };

  // Venta diaria por SKU y almacén; promedio de todo el periodo.
  const demand = new Map<string, Record<PlanWarehouse, number>>();
  const history = new Map<string, number>();
  for (const s of input.series) {
    const d = demand.get(s.skuId) ?? { 'AMZ-FBA': 0, 'LIV-FBL': 0, APLIN: 0 };
    d[s.warehouse] += baseDailyDemand(s.months, P.mesesHistoria, P.pctQuiebre) * factor[s.warehouse];
    demand.set(s.skuId, d);
    history.set(s.skuId, (history.get(s.skuId) ?? 0) + s.months.reduce((a, b) => a + b, 0) / input.historyDays);
  }
  const dem = (id: string) => demand.get(id) ?? { 'AMZ-FBA': 0, 'LIV-FBL': 0, APLIN: 0 };

  const kitsOf = new Map<string, ReplKitComponent[]>();
  for (const k of input.kits) kitsOf.set(k.kitId, [...(kitsOf.get(k.kitId) ?? []), k]);
  // Por componente: venta de kits (todos los canales), venta de kits que sale de APLIN, kits físicos.
  const kitDemand = new Map<string, number>();
  const kitAplinDemand = new Map<string, number>();
  const kitHistory = new Map<string, number>();
  const kitPhysical = new Map<string, number>();
  for (const k of input.kits) {
    const d = dem(k.kitId);
    const st = stockOf(k.kitId);
    kitDemand.set(k.componentId, (kitDemand.get(k.componentId) ?? 0) + (d['AMZ-FBA'] + d['LIV-FBL'] + d.APLIN) * k.qty);
    kitAplinDemand.set(k.componentId, (kitAplinDemand.get(k.componentId) ?? 0) + d.APLIN * k.qty);
    kitHistory.set(k.componentId, (kitHistory.get(k.componentId) ?? 0) + (history.get(k.kitId) ?? 0) * k.qty);
    kitPhysical.set(k.componentId, (kitPhysical.get(k.componentId) ?? 0) + (st.aplin + st.fba + st.fbaTransit + st.fbl) * k.qty);
  }

  // ── Canales ──
  const channelRow = (sku: ReplSku, aplin: number, reserve: number): ChannelRow => {
    const d = dem(sku.id);
    const st = stockOf(sku.id);
    const coverFba = d['AMZ-FBA'] > 0 ? (st.fba + st.fbaTransit) / d['AMZ-FBA'] : null;
    const idealFba = Math.round(d['AMZ-FBA'] * P.coberturaFba);
    const suggestFba =
      coverFba !== null && coverFba < P.almexDias + P.colchonFba ? roundUp(idealFba - (st.fba + st.fbaTransit), sku.caseUnits, P.redondearCajas) : 0;
    const coverFbl = d['LIV-FBL'] > 0 ? st.fbl / d['LIV-FBL'] : null;
    const idealFbl = Math.round(d['LIV-FBL'] * P.coberturaFbl);
    const suggestFbl = coverFbl !== null && coverFbl < P.envioFblDias + P.colchonFbl ? roundUp(idealFbl - st.fbl, sku.caseUnits, P.redondearCajas) : 0;
    const available = Math.max(0, aplin - reserve);
    const sendFba = Math.min(suggestFba, available);
    const sendFbl = Math.min(suggestFbl, Math.max(0, available - sendFba));
    return {
      skuId: sku.id,
      isKit: sku.isKit,
      caseUnits: sku.caseUnits,
      demandFba: d['AMZ-FBA'],
      demandFbl: d['LIV-FBL'],
      demandAplin: d.APLIN,
      demandTotal: d['AMZ-FBA'] + d['LIV-FBL'] + d.APLIN,
      aplin,
      fba: st.fba,
      fbaTransit: st.fbaTransit,
      fbl: st.fbl,
      coverFba,
      stockoutFba: coverFba !== null ? addDaysFrac(today, coverFba) : null,
      idealFba,
      suggestFba,
      via: sendFba === 0 ? null : coverFba! < P.almexDias ? 'DHL' : 'ALMEX',
      coverFbl,
      idealFbl,
      suggestFbl,
      reserve,
      available,
      sendFba,
      sendFbl,
      shortfall: suggestFba - sendFba + (suggestFbl - sendFbl),
      minAplin: null,
      aplinAfterContainer: null,
    };
  };
  const comps = input.skus.filter((s) => !s.isKit);
  const kitSkus = input.skus.filter((s) => s.isKit);
  const channels: ChannelRow[] = [];
  const chByComp = new Map<string, ChannelRow>();
  for (const s of comps) {
    const reserve = Math.round((dem(s.id).APLIN + (kitAplinDemand.get(s.id) ?? 0)) * P.reservaAplinDias);
    const row = channelRow(s, stockOf(s.id).aplin, reserve);
    channels.push(row);
    chByComp.set(s.id, row);
  }
  for (const k of kitSkus) {
    const parts = kitsOf.get(k.id) ?? [];
    const fit = parts.length
      ? Math.min(
          ...parts.map((p) => {
            const c = chByComp.get(p.componentId);
            const left = c ? Math.max(0, c.available - c.sendFba - c.sendFbl) : 0;
            return Math.floor(left / p.qty);
          }),
        )
      : 0;
    channels.push(channelRow(k, fit, 0));
  }

  // ── Contenedores en camino (en orden de llegada) ──
  const conts = [...input.containers].sort((a, b) => (a.eta < b.eta ? -1 : a.eta > b.eta ? 1 : a.code.localeCompare(b.code)));
  const qtyIn = new Map<string, Map<string, number>>();
  for (const c of conts) {
    const m = new Map<string, number>();
    for (const l of c.lines) m.set(l.skuId, (m.get(l.skuId) ?? 0) + l.qty);
    qtyIn.set(c.code, m);
  }

  // ── China ──
  const newArrival = addDays(P.fechaProximoPedido, P.diasContenedor);
  const china: ChinaRow[] = comps.map((s) => {
    const ch = chByComp.get(s.id)!;
    const st = stockOf(s.id);
    const demandCalc = ch.demandTotal + (kitDemand.get(s.id) ?? 0);
    const demandHistory = (history.get(s.id) ?? 0) + (kitHistory.get(s.id) ?? 0);
    const H = s.manualDailyDemand ?? demandCalc;
    const physical = st.aplin + st.fba + st.fbaTransit + st.fbl + (kitPhysical.get(s.id) ?? 0);
    const byContainer: Record<string, number> = {};
    let onTheWay = 0;
    let level = physical;
    let prev = today;
    let nextArrival: string | null = null;
    for (const c of conts) {
      const q = qtyIn.get(c.code)!.get(s.id) ?? 0;
      byContainer[c.code] = q;
      onTheWay += q;
      level = Math.max(0, level - H * Math.max(0, daysBetween(prev, c.eta))) + q;
      prev = c.eta;
      if (q > 0 && !nextArrival) nextArrival = c.eta;
    }
    const projectedAtArrival = Math.max(0, level - H * Math.max(0, daysBetween(prev, newArrival)));
    const position = physical + onTheWay;
    const stockoutDate = H > 0 ? addDaysFrac(today, physical / H) : null;
    const daysWithout = H > 0 ? Math.max(0, daysBetween(today, nextArrival ?? newArrival) - physical / H) : null;
    const need = H * (P.cicloDias + P.seguridadDias);
    const minOrder = s.include ? roundUp(need - projectedAtArrival, s.caseUnits, P.redondearCajas) : 0;
    const unit = P.redondearCajas && s.caseUnits && s.caseUnits > 0 ? s.caseUnits : 1;
    const cbmUnit = P.redondearCajas && s.caseUnits && s.caseUnits > 0 ? s.cbmCase : s.caseUnits && s.caseUnits > 0 ? s.cbmCase / s.caseUnits : 0;
    let alert: ChinaRow['alert'] = null;
    if (H === 0 && onTheWay > 0) alert = 'SIN_VENTA_EN_CAMINO';
    else if (H === 0 && demandHistory > 0) alert = 'SIN_VENTA_RECIENTE';
    else if (daysWithout !== null && daysWithout > 0) alert = nextArrival ? 'SE_AGOTA_ANTES_DE_LLEGADA' : 'SE_AGOTA_SIN_PEDIDO';
    return {
      skuId: s.id,
      category: s.category,
      caseUnits: s.caseUnits,
      demandCalc,
      demandHistory,
      demand: H,
      physical,
      byContainer,
      onTheWay,
      position,
      coverTotal: H > 0 ? position / H : null,
      stockoutDate,
      nextArrival,
      leadTime: s.leadTimeDays ?? P.diasContenedor,
      newOrderArrival: newArrival,
      daysWithout,
      projectedAtArrival,
      need,
      minOrder,
      minCases: s.caseUnits ? minOrder / s.caseUnits : null,
      minCbm: (minOrder / unit) * cbmUnit,
      fullOrder: 0,
      fullCases: null,
      fullCbm: 0,
      daysAtArrival: null,
      include: s.include,
      alert,
      // auxiliares para el llenado
      _unit: unit,
      _cbmUnit: cbmUnit,
    } as ChinaRow & { _unit: number; _cbmUnit: number };
  });

  // ── Llenado del contenedor: mayor número de días (0…400) que cabe en la capacidad ──
  const units = (r: ChinaRow & { _unit: number }, t: number) => {
    if (!r.include) return 0;
    const x = r.demand * t - r.projectedAtArrival;
    return x > 0 ? Math.ceil(x / r._unit) : 0;
  };
  const cbmAt = (t: number) => china.reduce((a, r) => a + units(r as never, t) * (r as unknown as { _cbmUnit: number })._cbmUnit, 0);
  let days = 0;
  for (let t = 0; t <= 400; t++) if (cbmAt(t) <= P.capacidadCbm + 1e-9) days = t;
  for (const r of china as (ChinaRow & { _unit: number; _cbmUnit: number })[]) {
    const n = units(r, days);
    r.fullOrder = n * r._unit;
    r.fullCases = r.caseUnits ? r.fullOrder / r.caseUnits : null;
    r.fullCbm = n * r._cbmUnit;
    r.daysAtArrival = r.demand > 0 ? (r.projectedAtArrival + r.fullOrder) / r.demand : null;
    delete (r as Partial<typeof r>)._unit;
    delete (r as Partial<typeof r>)._cbmUnit;
  }

  // Cuánto tener en APLIN (componentes)
  const chinaById = new Map(china.map((r) => [r.skuId, r]));
  for (const c of channels) {
    const r = chinaById.get(c.skuId);
    if (!r) continue;
    c.minAplin = Math.round(r.demand * P.seguridadDias);
    c.aplinAfterContainer = Math.round(r.demand * (P.cicloDias + P.seguridadDias));
  }

  const cbmOfSku = (id: string) => {
    const s = skuById.get(id);
    return s && s.caseUnits && s.caseUnits > 0 ? s.cbmCase / s.caseUnits : 0;
  };
  return {
    channels,
    china,
    containers: conts.map((c) => ({
      code: c.code,
      eta: c.eta,
      qty: c.lines.reduce((a, l) => a + l.qty, 0),
      cbm: c.lines.reduce((a, l) => a + l.qty * cbmOfSku(l.skuId), 0),
    })),
    fill: {
      days,
      cbm: china.reduce((a, r) => a + r.fullCbm, 0),
      minCbm: china.reduce((a, r) => a + r.minCbm, 0),
      capacity: P.capacidadCbm,
      minDays: P.cicloDias + P.seguridadDias,
    },
  };
}
