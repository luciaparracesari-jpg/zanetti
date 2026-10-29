import { eq, inArray, isNull, sql } from 'drizzle-orm';
import { channelListings, channels, masterSkus, salesLines, skuAliases, unmappedCodes, type DbOrTx, type Tx } from '@erp/db';
import type { ApplyContext, RowMessage, ValidatedRow } from '../types';

/** Un renglón del reporte del canal ya convertido a piezas de SKU maestro. */
export interface SalePlan {
  channel: 'AMAZON' | 'LIVERPOOL' | 'SHOPIFY';
  origin: string;
  saleDate: string;
  kind: 'VENTA' | 'DEVOLUCION';
  externalCode: string;
  externalSku: string | null;
  orderRef: string | null;
  amount: string | null;
  /** Una línea por SKU maestro (un código puede equivaler a varios SKU, p. ej. un bundle). */
  lines: { skuId: string | null; skuCode: string | null; qty: number; listingId: string | null; sourceKey: string }[];
  label: string;
}

/** Fecha del reporte: 2026-03-31, 2026-03-31+00:00, 2026-03-31T10:00, 31/03/2026 o número de serie de Excel. */
export function parseSaleDate(v: string | null): string | null {
  if (!v) return null;
  const s = v.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86_400_000);
    return d.toISOString().slice(0, 10);
  }
  return null;
}

export function parseNumber(v: string | null): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[$,\s]/g, '');
  if (s === '' || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

const up = (v: string | null | undefined) => (v ? v.trim().toUpperCase() : null);

export interface Resolution {
  lines: { skuId: string; skuCode: string; mult: number }[];
  listingId: string | null;
  via: string;
}

/**
 * Traduce los códigos de los reportes a SKU maestro.
 * Orden: código de SKU maestro → FNSKU de una publicación → publicación del canal (ASIN o artículo) → equivalencias.
 */
export async function buildResolver(db: DbOrTx, channelCode: 'AMAZON' | 'LIVERPOOL' | 'SHOPIFY') {
  const [ch] = await db.select({ id: channels.id }).from(channels).where(eq(channels.code, channelCode));
  const skus = await db.select({ id: masterSkus.id, code: masterSkus.skuCode }).from(masterSkus);
  const byCode = new Map(skus.map((s) => [s.code.toUpperCase(), s]));
  const codeOf = new Map(skus.map((s) => [s.id, s.code]));
  const listings = await db
    .select({ id: channelListings.id, channelId: channelListings.channelId, externalId: channelListings.externalId, externalSku: channelListings.externalSku, fnsku: channelListings.fnsku, skuId: channelListings.masterSkuId })
    .from(channelListings)
    .where(isNull(channelListings.validTo));
  const byFnsku = new Map<string, (typeof listings)[number]>();
  const byExternal = new Map<string, (typeof listings)[number]>();
  for (const l of listings) {
    if (l.fnsku) byFnsku.set(l.fnsku.toUpperCase(), l);
    if (ch && l.channelId === ch.id) {
      // Si un artículo de Liverpool tiene oferta FBL y Vendor, ambas apuntan al mismo SKU.
      if (!byExternal.has(l.externalId.toUpperCase())) byExternal.set(l.externalId.toUpperCase(), l);
      if (l.externalSku && !byExternal.has(l.externalSku.toUpperCase())) byExternal.set(l.externalSku.toUpperCase(), l);
    }
  }
  const aliases = await db.select({ code: skuAliases.code, skuId: skuAliases.masterSkuId, mult: skuAliases.multiplier }).from(skuAliases);
  const byAlias = new Map<string, { skuId: string; mult: number }[]>();
  for (const a of aliases) byAlias.set(a.code.toUpperCase(), [...(byAlias.get(a.code.toUpperCase()) ?? []), { skuId: a.skuId, mult: a.mult }]);

  const one = (skuId: string, listingId: string | null, via: string): Resolution => ({ lines: [{ skuId, skuCode: codeOf.get(skuId)!, mult: 1 }], listingId, via });
  const asSku = (code: string | null): Resolution | null => {
    const c = up(code);
    if (!c) return null;
    const s = byCode.get(c);
    if (s) return one(s.id, null, 'SKU');
    const f = byFnsku.get(c);
    if (f) return one(f.skuId, f.id, 'FNSKU');
    return null;
  };
  const asListing = (code: string | null): Resolution | null => {
    const c = up(code);
    const l = c ? byExternal.get(c) : undefined;
    return l ? one(l.skuId, l.id, 'PUBLICACION') : null;
  };
  const asAlias = (code: string | null): Resolution | null => {
    const c = up(code);
    const a = c ? byAlias.get(c) : undefined;
    return a ? { lines: a.map((x) => ({ skuId: x.skuId, skuCode: codeOf.get(x.skuId)!, mult: x.mult })), listingId: null, via: 'EQUIVALENCIA' } : null;
  };
  return { channelId: ch?.id ?? null, asSku, asListing, asAlias };
}

/** Llaves que ya existen en ventas (para marcar renglones ya importados). */
export async function existingKeys(db: DbOrTx, keys: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < keys.length; i += 2000) {
    const part = keys.slice(i, i + 2000);
    if (!part.length) continue;
    const rows = await db.select({ k: salesLines.sourceKey }).from(salesLines).where(inArray(salesLines.sourceKey, part));
    for (const r of rows) out.add(r.k);
  }
  return out;
}

/** Numera los renglones repetidos dentro del archivo (dos piezas iguales del mismo pedido). */
export function occurrence() {
  const seen = new Map<string, number>();
  return (base: string) => {
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return `${base}#${n}`;
  };
}

/** Arma el plan de un renglón, revisa duplicados contra la base y deja mensajes. */
export function finishRow(
  rowNumber: number,
  messages: RowMessage[],
  plan: SalePlan | null,
  existing: Set<string>,
  ignoredReason: string | null,
): ValidatedRow<SalePlan> {
  if (ignoredReason) {
    messages.push({ level: 'info', message: ignoredReason });
    return { rowNumber, messages, action: 'SIN_CAMBIOS', plan: null };
  }
  if (!plan || messages.some((m) => m.level === 'error')) return { rowNumber, messages, action: null, plan: null };
  if (plan.lines.every((l) => existing.has(l.sourceKey))) {
    messages.push({ level: 'info', message: 'Ya estaba importado.' });
    return { rowNumber, messages, action: 'SIN_CAMBIOS', plan: null };
  }
  return { rowNumber, messages, action: 'CREAR', plan };
}

/** Inserta las ventas (sin duplicar) y registra los códigos que no se pudieron ligar. */
export async function applySales(tx: Tx, rows: { rowNumber: number; plan: SalePlan }[], ctx: ApplyContext) {
  const counts = { ventas: 0, devoluciones: 0, piezasVendidas: 0, piezasDevueltas: 0, sinSku: 0, yaImportados: 0 };
  if (!rows.length) return counts;
  const chs = await tx.select({ id: channels.id, code: channels.code }).from(channels);
  const chId = new Map(chs.map((c) => [c.code, c.id]));
  const values: (typeof salesLines.$inferInsert)[] = [];
  const unmapped = new Map<string, { channelId: string; externalId: string; title: string; n: number }>();
  for (const { plan } of rows) {
    const channelId = chId.get(plan.channel)!;
    for (const l of plan.lines) {
      values.push({
        channelId,
        origin: plan.origin,
        saleDate: plan.saleDate,
        masterSkuId: l.skuId,
        listingId: l.listingId,
        externalCode: plan.externalCode,
        externalSku: plan.externalSku,
        orderRef: plan.orderRef,
        qty: l.qty,
        kind: plan.kind,
        amount: plan.lines.length === 1 ? plan.amount : null,
        source: 'IMPORTACION',
        sourceKey: l.sourceKey,
        importBatchId: ctx.batchId,
      });
      if (!l.skuId) {
        const k = `${channelId}|${plan.externalCode.toUpperCase()}`;
        const u = unmapped.get(k) ?? { channelId, externalId: plan.externalCode, title: plan.label, n: 0 };
        u.n++;
        unmapped.set(k, u);
      }
    }
  }
  for (let i = 0; i < values.length; i += 1000) {
    const inserted = await tx.insert(salesLines).values(values.slice(i, i + 1000)).onConflictDoNothing({ target: salesLines.sourceKey }).returning({ qty: salesLines.qty, kind: salesLines.kind, skuId: salesLines.masterSkuId });
    for (const r of inserted) {
      if (r.kind === 'VENTA') {
        counts.ventas++;
        counts.piezasVendidas += r.qty;
      } else {
        counts.devoluciones++;
        counts.piezasDevueltas += -r.qty;
      }
      if (!r.skuId) counts.sinSku++;
    }
    counts.yaImportados += values.slice(i, i + 1000).length - inserted.length;
  }
  for (const u of unmapped.values()) {
    await tx
      .insert(unmappedCodes)
      .values({ channelId: u.channelId, externalId: u.externalId, externalSku: '', title: u.title.slice(0, 200), occurrences: u.n })
      .onConflictDoUpdate({
        target: [unmappedCodes.channelId, unmappedCodes.externalId, unmappedCodes.externalSku],
        set: { lastSeenAt: sql`now()`, occurrences: sql`${unmappedCodes.occurrences} + ${u.n}` },
      });
  }
  await ctx.audit.log(tx, ctx.actor, {
    action: 'IMPORTAR',
    module: 'pedidos',
    entity: 'sales_lines',
    entityId: ctx.batchId,
    summary: `Importó ${counts.ventas} ventas y ${counts.devoluciones} devoluciones (${ctx.batchLabel})`,
    newValues: counts,
  });
  return counts;
}

