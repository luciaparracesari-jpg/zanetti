import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { ApiError } from './api';

/**
 * La validación vive en la API (esquemas zod compartidos en @erp/shared).
 * Esta función pinta los errores 422 en los campos del formulario y devuelve el mensaje general.
 */
export function applyServerErrors<T extends FieldValues>(
  err: unknown,
  setError: UseFormSetError<T>,
  pathMap: Record<string, string> = {},
): string {
  if (err instanceof ApiError) {
    for (const e of err.errors) {
      if (e.path) setError((pathMap[e.path] ?? e.path) as Path<T>, { type: 'server', message: e.message });
    }
    return err.message;
  }
  return 'No se pudo completar la operación.';
}

/** Convierte cadenas vacías del formulario a null antes de enviar. */
export function emptyToNull<T extends Record<string, unknown>>(v: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) out[k] = val === '' ? null : val;
  return out as T;
}
