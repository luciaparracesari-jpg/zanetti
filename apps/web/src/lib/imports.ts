export type Level = 'error' | 'warning' | 'info';

export interface ImportMessage {
  field?: string;
  level: Level;
  message: string;
}

export interface ImportTemplateInfo {
  key: string;
  label: string;
  description: string;
  allowed: boolean;
  columns: { field: string; header: string; required?: boolean; help: string; example?: string }[];
}

export interface ImportBatch {
  id: string;
  fileName: string;
  sheetName: string | null;
  status: 'VALIDADO' | 'APLICADO' | 'CANCELADO';
  totalRows: number;
  fileMessages: ImportMessage[];
  result: Record<string, number> | null;
  createdAt: string;
  createdByName: string | null;
  appliedAt: string | null;
  validatedAt: string;
  template: { key: string; label: string; columns: { field: string; header: string; inFile: boolean }[] };
  summary: { valid: number; warning: number; error: number; skipped: number; toCreate: number; toUpdate: number; unchanged: number };
}

export interface ImportRow {
  id: number;
  rowNumber: number;
  values: Record<string, string | null>;
  raw: Record<string, string | null>;
  edits: Record<string, string | null> | null;
  status: 'VALIDO' | 'ADVERTENCIA' | 'ERROR' | 'OMITIDO';
  action: 'CREAR' | 'ACTUALIZAR' | 'SIN_CAMBIOS' | null;
  skipped: boolean;
  messages: ImportMessage[];
  plan: SkuPlan | { label: string } | null;
}

export interface SkuPlan {
  skuCode: string;
  existingSkuId: string | null;
  name: string;
  nameChange: { from: string; to: string } | null;
  barcode: { code: string; type: string } | null;
  listings: { channel: string; label: string }[];
  package: { code: string; units: number; mode: string } | null;
  priceChange: boolean;
  costChange: boolean;
  leadTimeDays?: number | null;
  leadTimeChange?: boolean;
  safetyDays?: number | null;
  safetyChange?: boolean;
  categoryAssign?: { productId: string; path: string } | null;
}

/** Etiquetas del resultado al aplicar. */
export const RESULT_LABELS: Record<string, string> = {
  skusCreados: 'SKU creados',
  skusActualizados: 'SKU actualizados',
  productosCreados: 'Productos creados',
  marcasCreadas: 'Marcas creadas',
  categoriasCreadas: 'Categorías creadas',
  codigosBarras: 'Códigos de barras',
  publicaciones: 'Publicaciones',
  cajas: 'Cajas master',
  renglonesAplicados: 'Renglones aplicados',
  renglonesOmitidos: 'Renglones omitidos',
  sinCambios: 'Sin cambios',
  piezas: 'Piezas cargadas',
  lotes: 'Lotes',
  movimientos: 'Movimientos de inventario',
  kitsCreados: 'Kits creados',
  kitsActualizados: 'Kits definidos',
  componentes: 'Componentes',
  fnskuGuardados: 'FNSKU guardados',
  ventas: 'Renglones de venta',
  devoluciones: 'Devoluciones',
  piezasVendidas: 'Piezas vendidas',
  piezasDevueltas: 'Piezas devueltas',
  sinSku: 'Sin SKU ligado',
  yaImportados: 'Ya importados',
  contenedoresCreados: 'Contenedores creados',
  contenedoresActualizados: 'Contenedores actualizados',
  lineas: 'Líneas',
  proveedoresCreados: 'Proveedores creados',
};

/** Resumen de una línea de lo que hará el renglón. */
export function planSummary(plan: SkuPlan | { label: string } | null): string {
  if (!plan) return '—';
  if (!('listings' in plan)) return plan.label;
  const p = plan;
  const parts: string[] = [];
  if (p.nameChange) parts.push(`nombre → ${p.nameChange.to}`);
  if (p.barcode) parts.push(p.barcode.type === 'UPC' ? 'UPC' : p.barcode.type === 'EAN13' ? 'EAN' : 'código');
  if (p.listings.length) {
    const by = p.listings.reduce<Record<string, number>>((a, l) => ({ ...a, [l.channel]: (a[l.channel] ?? 0) + 1 }), {});
    parts.push(...Object.entries(by).map(([c, n]) => `${n} ${c === 'AMAZON' ? 'Amazon' : c === 'LIVERPOOL' ? 'Liverpool' : 'Shopify'}`));
  }
  if (p.package) parts.push(`caja ×${p.package.units}`);
  if (p.priceChange) parts.push('precio');
  if (p.costChange) parts.push('costo');
  if (p.leadTimeChange) parts.push(`lead time ${p.leadTimeDays} d`);
  if (p.safetyChange) parts.push(`seguridad ${p.safetyDays} d`);
  if (p.categoryAssign) parts.push(`categoría ${p.categoryAssign.path}`);
  return parts.join(' · ') || 'sin cambios';
}
