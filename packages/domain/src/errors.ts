export type InventoryErrorCode =
  | 'SKU_NO_ENCONTRADO'
  | 'SKU_ES_KIT'
  | 'ALMACEN_NO_ENCONTRADO'
  | 'ALMACEN_INACTIVO'
  | 'UBICACION_INVALIDA'
  | 'LOTE_INVALIDO'
  | 'LOTE_DUPLICADO'
  | 'MOVIMIENTO_INVALIDO'
  | 'STOCK_INSUFICIENTE'
  | 'DOCUMENTO_INVALIDO';

/**
 * Error de una regla de inventario. La API lo convierte en 409 (conflicto de negocio)
 * con `code` y `details` para que la pantalla muestre, p. ej., cuánto hay disponible.
 */
export class InventoryError extends Error {
  constructor(
    public readonly code: InventoryErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'InventoryError';
  }
}

export const isInventoryError = (e: unknown): e is InventoryError => e instanceof InventoryError;
