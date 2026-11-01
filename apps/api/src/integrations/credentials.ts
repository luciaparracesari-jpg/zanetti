/**
 * Credenciales de integraciones: viven sólo en variables de entorno del servidor (archivo .env del VPS).
 * La base de datos guarda el prefijo (`credentials_ref`), nunca el valor, y la API nunca los devuelve.
 *
 * APLIN, prefijo APLIN → APLIN_BASE_URL y APLIN_ORG_CODE.
 */
export interface AplinCredentials {
  baseUrl: string;
  orgCode: string;
}

const REF = /^[A-Z][A-Z0-9_]{1,40}$/;

export function aplinCredentials(ref: string): AplinCredentials | null {
  if (!REF.test(ref)) return null;
  const baseUrl = process.env[`${ref}_BASE_URL`]?.trim();
  const orgCode = process.env[`${ref}_ORG_CODE`]?.trim();
  if (!baseUrl || !orgCode) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ''), orgCode };
}

/** Prefijos con credenciales completas de APLIN en el servidor (sólo los nombres). */
export function detectedAplinRefs(): string[] {
  return Object.keys(process.env)
    .map((k) => /^([A-Z][A-Z0-9_]*)_ORG_CODE$/.exec(k)?.[1])
    .filter((r): r is string => Boolean(r) && aplinCredentials(r!) !== null)
    .sort();
}
