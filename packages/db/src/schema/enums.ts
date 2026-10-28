import { pgEnum } from 'drizzle-orm/pg-core';

export const userStatus = pgEnum('user_status', ['ACTIVO', 'BLOQUEADO', 'INACTIVO']);
export const recordStatus = pgEnum('record_status', ['ACTIVO', 'INACTIVO']);
export const skuStatus = pgEnum('sku_status', ['BORRADOR', 'ACTIVO', 'DESCONTINUADO', 'INACTIVO']);
export const costMethod = pgEnum('cost_method', ['FIFO', 'PROMEDIO']);
export const barcodeType = pgEnum('barcode_type', ['EAN13', 'UPC', 'CODE128', 'INTERNO']);
export const channelType = pgEnum('channel_type', ['MARKETPLACE', 'TIENDA_PROPIA', 'DIRECTO']);
export const channelStatus = pgEnum('channel_status', ['ACTIVO', 'PAUSADO', 'INACTIVO']);
export const warehouseType = pgEnum('warehouse_type', [
  'PROPIO',
  'OPERADOR_LOGISTICO',
  'FULFILLMENT_CANAL',
  'CONSIGNACION',
]);
export const locationType = pgEnum('location_type', [
  'RECEPCION',
  'ALMACENAJE',
  'PICKING',
  'CUARENTENA',
  'EMBARQUE',
  'MERMA',
]);
export const fulfillmentModel = pgEnum('fulfillment_model', ['BODEGA_PROPIA', 'FULFILLMENT_CANAL']);
export const listingStatus = pgEnum('listing_status', ['ACTIVA', 'PAUSADA', 'INACTIVA']);
export const feeType = pgEnum('fee_type', ['COMISION', 'ENVIO', 'ALMACENAJE', 'OTRO']);
export const feeBase = pgEnum('fee_base', ['VENTA_CON_IVA', 'VENTA_NETA', 'DESPUES_DESCUENTO']);
export const unmappedStatus = pgEnum('unmapped_status', ['PENDIENTE', 'MAPEADO', 'IGNORADO']);
export const packageType = pgEnum('package_type', ['CAJA_MASTER', 'CAJA_INTERIOR', 'TARIMA']);
export const importBatchStatus = pgEnum('import_batch_status', ['VALIDADO', 'APLICADO', 'CANCELADO']);
export const importRowStatus = pgEnum('import_row_status', ['VALIDO', 'ADVERTENCIA', 'ERROR', 'OMITIDO']);
export const importRowAction = pgEnum('import_row_action', ['CREAR', 'ACTUALIZAR', 'SIN_CAMBIOS']);
