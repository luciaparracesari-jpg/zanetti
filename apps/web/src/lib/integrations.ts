export interface Connection {
  id: string;
  code: string;
  name: string;
  provider: 'APLIN' | 'SHOPIFY' | 'AMAZON_SP_API' | 'MERCADO_LIBRE' | 'LIVERPOOL';
  credentialsRef: string;
  credentialsOk: boolean;
  status: 'ACTIVA' | 'PAUSADA';
  lastSyncAt: string | null;
  lastSyncOk: boolean | null;
  lastError: string | null;
}

export type OrderKind = 'ENVIO_FBA' | 'ENVIO_FBL' | 'LIVERPOOL_VENDOR' | 'SHOPIFY_ZANETTI' | 'SHOPIFY_LEANTRAVEL' | 'OTRO';

export const ORDER_KIND: Record<OrderKind, string> = {
  ENVIO_FBA: 'Envío a Amazon FBA',
  ENVIO_FBL: 'Envío a Liverpool FBL',
  LIVERPOOL_VENDOR: 'Liverpool Vendor',
  SHOPIFY_ZANETTI: 'Shopify Zanetti',
  SHOPIFY_LEANTRAVEL: 'Shopify LeanTravel',
  OTRO: 'Otro',
};

export const PROVIDER: Record<Connection['provider'], string> = {
  APLIN: 'APLIN',
  SHOPIFY: 'Shopify',
  AMAZON_SP_API: 'Amazon',
  MERCADO_LIBRE: 'Mercado Libre',
  LIVERPOOL: 'Liverpool',
};

export interface StockRow {
  skuId: string | null;
  skuCode: string | null;
  skuName: string | null;
  skuStatus: string | null;
  externalSku: string | null;
  matchedBy: string | null;
  aplinOnHand: number | null;
  aplinAvailable: number | null;
  aplinCommitted: number | null;
  aplinBooked: number | null;
  aplinUnavailable: number | null;
  erpOnHand: number | null;
  erpAvailable: number | null;
  difference: number | null;
  state: 'CUADRA' | 'DIFERENCIA' | 'SIN_LIGAR' | 'NO_ESTA_EN_APLIN';
}

export interface StockResult {
  syncedAt: string | null;
  totals: { skus: number; cuadran: number; conDiferencia: number; sinLigar: number; noEstanEnAplin: number; aplinOnHand: number; erpOnHand: number };
  items: StockRow[];
}

export interface OrderRow {
  id: string;
  orderNumber: string;
  kind: OrderKind;
  type: string | null;
  status: string | null;
  substatus: string | null;
  source: string | null;
  stockOk: boolean | null;
  pieces: number;
  total: string | null;
  externalCreatedAt: string | null;
  open: boolean;
  lines: { sku: string; skuCode: string | null; quantity: number; price: string | null }[];
}

export interface SyncRun {
  id: string;
  resource: string;
  status: 'EN_CURSO' | 'OK' | 'ERROR';
  startedAt: string;
  finishedAt: string | null;
  stats: Record<string, unknown> | null;
  error: string | null;
}

export interface Summary {
  byKind: { kind: OrderKind; orders: number; pieces: number; open: number; blocked: number }[];
  vendorLast30: { skuCode: string | null; externalSku: string; orders: number; pieces: number; last: string }[];
}
