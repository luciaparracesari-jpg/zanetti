/** Redondeos de costos: 4 decimales en unitarios y totales (las columnas son numeric(14|16, 4)). */
export const toNum = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export const fix4 = (n: number): string => (Math.round(n * 10_000) / 10_000).toFixed(4);
export const fix2 = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);
