const TZ = 'America/Mexico_City';

const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });
const money4 = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 4 });
const int = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 });
const dateFmt = new Intl.DateTimeFormat('es-MX', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('es-MX', {
  timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});

export const fmtMoney = (v: string | number | null | undefined) =>
  v === null || v === undefined || v === '' ? '—' : money.format(Number(v));
export const fmtCost = (v: string | number | null | undefined) =>
  v === null || v === undefined || v === '' ? '—' : money4.format(Number(v));
export const fmtInt = (v: number | string | null | undefined) =>
  v === null || v === undefined || v === '' ? '—' : int.format(Number(v));
export const fmtPct = (v: number | string | null | undefined, digits = 1) =>
  v === null || v === undefined || v === '' ? '—' : `${Number(v).toFixed(digits)} %`;
/** Tasa guardada como fracción (0.19) → "19.00 %". */
export const fmtRate = (v: string | number | null | undefined) =>
  v === null || v === undefined || v === '' ? '—' : `${(Number(v) * 100).toFixed(2)} %`;

/** Fechas "AAAA-MM-DD" (sin hora) se muestran tal cual, sin correr el día por zona horaria. */
export function fmtDate(v: string | Date | null | undefined): string {
  if (!v) return '—';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split('-');
    return `${d}/${m}/${y}`;
  }
  return dateFmt.format(new Date(v));
}
export const fmtDateTime = (v: string | Date | null | undefined) => (v ? dateTimeFmt.format(new Date(v)) : '—');

export function fmtDims(l?: number | null, w?: number | null, h?: number | null): string {
  if (!l && !w && !h) return '—';
  const cm = (x?: number | null) => (x ? (x / 10).toLocaleString('es-MX', { maximumFractionDigits: 1 }) : '?');
  return `${cm(l)} × ${cm(w)} × ${cm(h)} cm`;
}
export const fmtWeight = (g?: number | null) =>
  g ? (g >= 1000 ? `${(g / 1000).toLocaleString('es-MX', { maximumFractionDigits: 2 })} kg` : `${g} g`) : '—';
