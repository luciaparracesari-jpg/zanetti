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

// ── Inventario (entrega 2) ──
export const movementType = pgEnum('movement_type', [
  'INVENTARIO_INICIAL',
  'ENTRADA_COMPRA',
  'ENTRADA_IMPORTACION',
  'SALIDA_VENTA',
  'DEVOLUCION_CLIENTE',
  'DEVOLUCION_PROVEEDOR',
  'AJUSTE_ENTRADA',
  'AJUSTE_SALIDA',
  'CONTEO_AJUSTE',
  'TRANSFER_SALIDA',
  'TRANSFER_ENTRADA',
  'REUBICACION',
  'ARMADO_KIT',
  'DESARMADO_KIT',
  'REVALUACION_COSTO',
]);
export const lotCostStatus = pgEnum('lot_cost_status', ['PROVISIONAL', 'FINAL']);
export const reservationSource = pgEnum('reservation_source', ['PEDIDO', 'TRANSFERENCIA']);
export const reservationStatus = pgEnum('reservation_status', ['ACTIVA', 'CONSUMIDA', 'LIBERADA']);
export const transferStatus = pgEnum('transfer_status', [
  'BORRADOR',
  'AUTORIZADA',
  'ENVIADA',
  'RECIBIDA',
  'RECIBIDA_CON_DIFERENCIAS',
  'CANCELADA',
]);
export const adjustmentStatus = pgEnum('adjustment_status', ['BORRADOR', 'POR_AUTORIZAR', 'APLICADO', 'CANCELADO']);
export const adjustmentReason = pgEnum('adjustment_reason', [
  'MERMA',
  'DANO',
  'ROBO',
  'CADUCIDAD',
  'ERROR_CAPTURA',
  'CONCILIACION_CANAL',
  'INVENTARIO_INICIAL',
  'OTRO',
]);
export const countStatus = pgEnum('count_status', ['ABIERTO', 'CERRADO', 'CANCELADO']);
