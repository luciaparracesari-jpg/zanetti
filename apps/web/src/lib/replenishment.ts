import { useQuery } from '@tanstack/react-query';
import { get, qs } from './api';

export interface ReplParams {
  mesesHistoria: number;
  pctQuiebre: number;
  factorFba: number;
  factorFbl: number;
  factorAplin: number;
  almexDias: number;
  dhlDias: number;
  colchonFba: number;
  envioFblDias: number;
  colchonFbl: number;
  reservaAplinDias: number;
  redondearCajas: boolean;
  navieraDias: number;
  aduanaDias: number;
  cicloDias: number;
  seguridadDias: number;
  capacidadCbm: number;
  fechaProximoPedido: string | null;
  origenAlmacen: Record<string, 'AMZ-FBA' | 'LIV-FBL' | 'APLIN'>;
  /** Mínimo de producción por SKU según su categoría (piezas). */
  minimoProduccion: Record<string, number>;
}

interface Named {
  skuId: string;
  skuCode: string;
  skuName: string;
  category: string | null;
  /** ACTIVO, DESCONTINUADO… */
  skuStatus: string;
  /** Nota del ajuste de reabasto (p. ej. "En revisión"). */
  note: string | null;
}

export interface ChannelRow extends Named {
  isKit: boolean;
  caseUnits: number | null;
  demandFba: number;
  demandFbl: number;
  demandAplin: number;
  demandTotal: number;
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

export type ChinaAlert = 'SIN_VENTA_EN_CAMINO' | 'SIN_VENTA_RECIENTE' | 'SE_AGOTA_ANTES_DE_LLEGADA' | 'SE_AGOTA_SIN_PEDIDO' | null;

export interface ChinaRow extends Named {
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
  /** Mínimo de producción en piezas, redondeado a cajas (0 = sin mínimo). */
  moq: number;
  /** El mínimo de producción subió el pedido mínimo / el del contenedor lleno. */
  moqMin: boolean;
  moqFull: boolean;
  alert: ChinaAlert;
}

export interface ReplResult {
  today: string;
  months: string[];
  historyMonths: string[];
  params: ReplParams & { coberturaFba: number; coberturaFbl: number; diasContenedor: number; fechaProximoPedido: string; guardados: ReplParams };
  containers: { id: string; code: string; status: string; eta: string | null; etaSource: string; etd: string | null; portEta: string | null; qty: number; skus: number; cbm: number }[];
  channels: ChannelRow[];
  china: ChinaRow[];
  fill: { days: number; cbm: number; minCbm: number; capacity: number; minDays: number; arrival: string };
  byCategory: { category: string; orderBy: string; minQty: number; minCbm: number; fullQty: number; fullCases: number; fullCbm: number }[];
  summary: {
    demandFba: number;
    demandFbl: number;
    demandAplin: number;
    demandTotal: number;
    urgentCount: number;
    fbaUrgent: number;
    noRecentSales: number;
    newWithoutSales: number;
    suggestFba: number;
    sendFba: number;
    suggestFbl: number;
    sendFbl: number;
  };
  urgent: { skuId: string; skuCode: string; skuName: string; stockoutDate: string | null; nextArrival: string | null; daysWithout: number | null; demand: number; onTheWay: number; minOrder: number }[];
}

export const useReplenishment = (fecha?: string) =>
  useQuery({ queryKey: ['replenishment', fecha ?? ''], queryFn: () => get<ReplResult>(`/replenishment${qs({ fecha: fecha || undefined })}`) });

export const CONTAINER_STATUS: Record<string, string> = {
  PLANEADO: 'Planeado',
  EN_PRODUCCION: 'En producción',
  EN_NAVIERA: 'En naviera',
  EN_ADUANA: 'En puerto / aduana',
  RECIBIDO: 'Recibido',
  PERDIDO: 'Perdido',
  CANCELADO: 'Cancelado',
};

export const ALERT_LABEL: Record<Exclude<ChinaAlert, null>, string> = {
  SIN_VENTA_EN_CAMINO: 'Viene en camino sin venta registrada: pon una venta estimada',
  SIN_VENTA_RECIENTE: 'Sin venta reciente: ¿sin inventario o descontinuado?',
  SE_AGOTA_ANTES_DE_LLEGADA: 'Se agota antes del siguiente contenedor',
  SE_AGOTA_SIN_PEDIDO: 'Se agota y no viene en ningún contenedor',
};

export const fmtDays = (v: number | null | undefined) => (v === null || v === undefined ? '—' : Math.round(v).toLocaleString('es-MX'));
export const fmtDec = (v: number | null | undefined, d = 1) =>
  v === null || v === undefined ? '—' : v.toLocaleString('es-MX', { minimumFractionDigits: d, maximumFractionDigits: d });
