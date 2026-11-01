import type { AplinCredentials } from '../credentials';

/** Página de la API de APLIN: { data: [...], meta: { totalPages, currentPage } }. */
interface Page<T> {
  data: T[];
  meta?: { total?: number; totalPages?: number; currentPage?: number; pageSize?: number };
}

export class AplinError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * Cliente de la API de APLIN (APLIN OS) de SÓLO CONSULTA.
 * El código de organización también permite crear, cancelar y despachar pedidos, así que este cliente
 * sólo expone POST /org/token (para obtener el token) y GET. No hay forma de escribir desde el ERP.
 * El token se pide al empezar cada sincronización y se renueva si APLIN responde 401.
 */
export class AplinClient {
  private token: string | null = null;

  constructor(
    private readonly creds: AplinCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
  ) {
    const u = new URL(creds.baseUrl);
    const local = ['localhost', '127.0.0.1', '::1'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(local && process.env.NODE_ENV !== 'production')) {
      throw new AplinError('La URL de APLIN debe ser https.');
    }
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown, auth = true): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.creds.baseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(auth && this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new AplinError(`No se pudo conectar con APLIN (${(e as Error).name === 'AbortError' ? 'tiempo agotado' : 'red'}).`);
    } finally {
      clearTimeout(timer);
    }
  }

  async authenticate(): Promise<void> {
    const r = await this.call('POST', '/org/token', { code: this.creds.orgCode, time: 30000 }, false);
    if (!r.ok) throw new AplinError(r.status === 401 || r.status === 403 ? 'APLIN rechazó el código de organización.' : `APLIN respondió ${r.status} al pedir el token.`, r.status);
    const j = (await r.json().catch(() => null)) as { data?: { token?: string } } | null;
    const t = j?.data?.token;
    if (!t) throw new AplinError('APLIN no devolvió un token.');
    this.token = t;
  }

  /** GET con reintento: renueva el token ante 401 y espera ante 429/5xx (hasta 3 intentos). */
  async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const full = qs ? `${path}?${qs}` : path;
    if (!this.token) await this.authenticate();
    for (let attempt = 1; ; attempt++) {
      const r = await this.call('GET', full);
      if (r.ok) return (await r.json()) as T;
      if (r.status === 401 && attempt === 1) {
        await this.authenticate();
        continue;
      }
      if ((r.status === 429 || r.status >= 500) && attempt < 3) {
        await new Promise((res) => setTimeout(res, 1000 * attempt));
        continue;
      }
      throw new AplinError(`APLIN respondió ${r.status} en ${path}.`, r.status);
    }
  }

  /** Recorre todas las páginas de un listado. */
  async all<T>(path: string, query: Record<string, string | number | undefined> = {}, pageSize = 100, maxPages = 500): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const p = await this.get<Page<T> | T[]>(path, { ...query, page, limit: pageSize });
      const rows = Array.isArray(p) ? p : (p.data ?? []);
      out.push(...rows);
      const totalPages = Array.isArray(p) ? 1 : (p.meta?.totalPages ?? (rows.length < pageSize ? page : page + 1));
      if (page >= totalPages || rows.length === 0) break;
    }
    return out;
  }
}
