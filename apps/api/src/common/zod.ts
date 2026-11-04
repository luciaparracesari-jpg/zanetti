import type { ZodType } from 'zod';

/** Valida y transforma con un esquema zod; el filtro global traduce los errores a 422. */
export function parse<T extends ZodType>(schema: T, data: unknown) {
  return schema.parse(data) as T['_output'];
}

/**
 * En una edición parcial deja sólo los campos que venían en el cuerpo: zod 4 aplica `default` y las transformaciones
 * de los campos `nullish` aunque falten, y eso borraría o cambiaría datos que el usuario no tocó.
 */
export function onlyPresent<T extends object>(data: T, body: unknown): Partial<T> {
  const keys = new Set(body && typeof body === 'object' ? Object.keys(body) : []);
  return Object.fromEntries(Object.entries(data).filter(([k]) => keys.has(k))) as Partial<T>;
}
