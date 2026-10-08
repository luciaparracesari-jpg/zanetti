/** Cliente HTTP del ERP: mismo origen, cookie de sesión y encabezado anti-CSRF. */

export interface FieldError {
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public errors: FieldError[] = [],
    public code?: string,
  ) {
    super(message);
  }
}

const BASE = '/api/v1';

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(BASE + path, {
    credentials: 'same-origin',
    ...rest,
    headers: {
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      'x-erp-client': 'web',
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const b = (body ?? {}) as { message?: string | string[]; errors?: FieldError[]; code?: string };
    const msg = Array.isArray(b.message) ? b.message.join(' ') : b.message;
    if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/auth/login')) {
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = `/login?next=${next}`;
    }
    if (b.code === 'PASSWORD_CHANGE_REQUIRED' && typeof window !== 'undefined') {
      window.location.href = '/cambiar-contrasena';
    }
    throw new ApiError(res.status, msg || `Error ${res.status}`, b.errors ?? [], b.code);
  }
  return body as T;
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, json: unknown = {}) => api<T>(path, { method: 'POST', json });
export const patch = <T>(path: string, json: unknown) => api<T>(path, { method: 'PATCH', json });
export const put = <T>(path: string, json: unknown) => api<T>(path, { method: 'PUT', json });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
