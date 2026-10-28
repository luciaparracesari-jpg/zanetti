/** Etiquetas en español para los valores de catálogo que se muestran en pantalla. */

export const USER_STATUS = { ACTIVO: 'Activo', BLOQUEADO: 'Bloqueado', INACTIVO: 'Inactivo' } as const;
export const RECORD_STATUS = { ACTIVO: 'Activo', INACTIVO: 'Inactivo' } as const;
export const SKU_STATUS = {
  BORRADOR: 'Borrador',
  ACTIVO: 'Activo',
  DESCONTINUADO: 'Descontinuado',
  INACTIVO: 'Inactivo',
} as const;
export const COST_METHOD = { FIFO: 'FIFO', PROMEDIO: 'Costo promedio ponderado' } as const;
export const BARCODE_TYPE = { EAN13: 'EAN-13', UPC: 'UPC', CODE128: 'Code 128', INTERNO: 'Interno' } as const;
export const CHANNEL_TYPE = {
  MARKETPLACE: 'Marketplace',
  TIENDA_PROPIA: 'Tienda propia',
  DIRECTO: 'Venta directa',
} as const;
export const CHANNEL_STATUS = { ACTIVO: 'Activo', PAUSADO: 'En pausa', INACTIVO: 'Inactivo' } as const;
export const WAREHOUSE_TYPE = {
  PROPIO: 'Propio',
  OPERADOR_LOGISTICO: 'Operador logístico',
  FULFILLMENT_CANAL: 'Fulfillment del canal',
  CONSIGNACION: 'Consignación',
} as const;
export const LOCATION_TYPE = {
  RECEPCION: 'Recepción',
  ALMACENAJE: 'Almacenaje',
  PICKING: 'Picking',
  CUARENTENA: 'Cuarentena',
  EMBARQUE: 'Embarque',
  MERMA: 'Merma',
} as const;
export const FULFILLMENT_MODEL = {
  BODEGA_PROPIA: 'Desde bodega propia',
  FULFILLMENT_CANAL: 'Fulfillment del canal',
} as const;
export const LISTING_STATUS = { ACTIVA: 'Activa', PAUSADA: 'En pausa', INACTIVA: 'Inactiva' } as const;
export const FEE_TYPE = {
  COMISION: 'Comisión',
  ENVIO: 'Envío',
  ALMACENAJE: 'Almacenaje',
  OTRO: 'Otro',
} as const;
export const FEE_BASE = {
  VENTA_CON_IVA: 'Venta con IVA antes de descuento',
  VENTA_NETA: 'Venta neta sin IVA',
  DESPUES_DESCUENTO: 'Venta después de descuento',
} as const;
export const UNMAPPED_STATUS = { PENDIENTE: 'Pendiente', MAPEADO: 'Mapeado', IGNORADO: 'Ignorado' } as const;

export type LabelMap = Record<string, string>;
export const keysOf = <T extends LabelMap>(m: T) => Object.keys(m) as [keyof T & string, ...(keyof T & string)[]];

export const PACKAGE_TYPE = { CAJA_MASTER: 'Caja master', CAJA_INTERIOR: 'Caja interior', TARIMA: 'Tarima' } as const;
export const IMPORT_ROW_STATUS = { VALIDO: 'Válido', ADVERTENCIA: 'Con advertencia', ERROR: 'Con error', OMITIDO: 'Omitido' } as const;
export const IMPORT_ROW_ACTION = { CREAR: 'Crear', ACTUALIZAR: 'Actualizar', SIN_CAMBIOS: 'Sin cambios' } as const;
export const IMPORT_BATCH_STATUS = { VALIDADO: 'Por confirmar', APLICADO: 'Aplicado', CANCELADO: 'Cancelado' } as const;
