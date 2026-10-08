/** Campos que nunca se guardan en la bitácora. */
const SECRET_FIELDS = new Set(['passwordHash', 'tokenHash', 'credentials', 'credentialsEncrypted']);
const IGNORED_FIELDS = new Set(['updatedAt', 'createdAt', 'updatedById', 'createdById']);

const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : v ?? null);

/** Devuelve sólo los campos que cambiaron, con su valor anterior y nuevo. */
export function diff(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): { oldValues: Record<string, unknown> | null; newValues: Record<string, unknown> | null } {
  if (!before && !after) return { oldValues: null, newValues: null };
  if (!before) return { oldValues: null, newValues: clean(after!) };
  if (!after) return { oldValues: clean(before), newValues: null };
  const oldValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (IGNORED_FIELDS.has(k) || SECRET_FIELDS.has(k)) continue;
    if (!(k in after)) continue;
    const a = norm(before[k]);
    const b = norm(after[k]);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      oldValues[k] = a;
      newValues[k] = b;
    }
  }
  return Object.keys(newValues).length ? { oldValues, newValues } : { oldValues: null, newValues: null };
}

export function clean(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_FIELDS.has(k) || IGNORED_FIELDS.has(k)) continue;
    out[k] = norm(v);
  }
  return out;
}
