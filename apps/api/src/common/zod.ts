import type { ZodType } from 'zod';

/** Valida y transforma con un esquema zod; el filtro global traduce los errores a 422. */
export function parse<T extends ZodType>(schema: T, data: unknown) {
  return schema.parse(data) as T['_output'];
}
