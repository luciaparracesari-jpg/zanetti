import { ConflictException } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { channelListings, channels, kitComponents, masterSkus, products, type DbOrTx, type Tx } from '@erp/db';
import { SKU_CODE_REGEX } from '@erp/shared';
import type { Actor } from '../../common/actor';
import type { ImportTemplate, InputRow, RowMessage, ValidatedRow } from '../types';

export interface KitRowPlan {
  kitCode: string;
  kitId: string | null;
  kitName: string;
  fnsku: string | null;
  componentId: string;
  componentCode: string;
  qty: number;
  label: string;
}

const up = (v: string | null) => (v ? v.replace(/\s+/g, '').toUpperCase() : null);
const FNSKU_REGEX = /^X00[0-9A-Z]{7}$/;

/**
 * Kits (bundles): un renglón por componente. El kit no tiene existencia propia; su disponible
 * se calcula con sus componentes. Si el SKU del kit no existe se crea (requiere NOMBRE).
 */
export const kitsTemplate: ImportTemplate<KitRowPlan> = {
  key: 'kits',
  label: 'Kits (bundles)',
  description:
    'Define qué SKU componen cada kit o bundle (un renglón por componente). Si el kit no existe se crea; si existe se marca como kit y sus componentes se reemplazan por los del archivo. Un kit no puede tener existencia propia.',
  permissions: ['productos.crear', 'productos.editar'],
  columns: [
    { field: 'kitCode', header: 'SKU KIT', aliases: ['SKU DEL KIT', 'KIT', 'SKU BUNDLE', 'BUNDLE'], required: true, example: 'QR4R-TOBAN', help: 'SKU maestro del kit. Si no existe se crea.' },
    { field: 'kitName', header: 'NOMBRE', aliases: ['DESCRIPCION', 'NOMBRE DEL KIT'], example: 'Bundle: 5 piezas + Utensilios Gris', help: 'Obligatorio sólo si el kit es nuevo.' },
    { field: 'fnsku', header: 'FNSKU', aliases: ['FNSKU KIT', 'SKU MASTER AMAZON'], example: 'X004OM33UZ', help: 'Etiqueta FBA del kit. Se guarda en su publicación de Amazon si existe.' },
    { field: 'componentCode', header: 'COMPONENTE', aliases: ['SKU COMPONENTE', 'FNSKU COMPONENTE'], required: true, example: 'X004E4QR4R', help: 'SKU maestro de un componente (no puede ser kit).' },
    { field: 'qty', header: 'CANTIDAD', aliases: ['PIEZAS', 'PIEZAS POR KIT'], example: '1', help: 'Piezas de ese componente en un kit. Si falta, 1.' },
  ],

  async validate(db: DbOrTx, rows: InputRow[], _actor: Actor): Promise<ValidatedRow<KitRowPlan>[]> {
    const active = rows.filter((r) => !r.skipped);
    const v = (r: InputRow, f: string) => r.values[f] ?? null;
    const codes = [...new Set(active.flatMap((r) => [up(v(r, 'kitCode')), up(v(r, 'componentCode'))]).filter((x): x is string => Boolean(x)))];
    const skus = codes.length
      ? await db
          .select({ id: masterSkus.id, skuCode: masterSkus.skuCode, name: masterSkus.name, isKit: masterSkus.isKit })
          .from(masterSkus)
          .where(inArray(sql`upper(${masterSkus.skuCode})`, codes))
      : [];
    const byCode = new Map(skus.map((s) => [s.skuCode.toUpperCase(), s]));
    const ids = skus.map((s) => s.id);
    // Existencia y uso como componente de los SKU involucrados.
    const stock = ids.length
      ? (
          await db.execute<{ id: string; qty: number }>(
            sql`SELECT master_sku_id AS id, sum(abs(qty))::int AS qty FROM inventory_balances WHERE master_sku_id IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}) GROUP BY master_sku_id`,
          )
        ).rows
      : [];
    const hasStock = new Map(stock.map((s) => [s.id, Number(s.qty)]));
    const usedAsComponent = ids.length
      ? new Set((await db.select({ id: kitComponents.componentSkuId }).from(kitComponents).where(inArray(kitComponents.componentSkuId, ids))).map((x) => x.id))
      : new Set<string>();
    const current = ids.length
      ? await db.select().from(kitComponents).where(inArray(kitComponents.kitSkuId, ids))
      : [];

    const kitCodesInFile = new Set(active.map((r) => up(v(r, 'kitCode'))).filter(Boolean));
    const pairIdx = new Map<string, number[]>();
    for (const r of active) {
      const k = `${up(v(r, 'kitCode'))}|${up(v(r, 'componentCode'))}`;
      pairIdx.set(k, [...(pairIdx.get(k) ?? []), r.rowNumber]);
    }
    // Nombre y FNSKU por kit: el primero que aparezca.
    const kitName = new Map<string, string>();
    const kitFnsku = new Map<string, string>();
    for (const r of active) {
      const k = up(v(r, 'kitCode'));
      if (!k) continue;
      const n = v(r, 'kitName')?.trim();
      if (n && !kitName.has(k)) kitName.set(k, n);
      const f = up(v(r, 'fnsku'));
      if (f && !kitFnsku.has(k)) kitFnsku.set(k, f);
    }
    // Componentes del archivo por kit, para saber si cambia algo.
    const fileComps = new Map<string, Map<string, number>>();
    for (const r of active) {
      const k = up(v(r, 'kitCode'));
      const c = byCode.get(up(v(r, 'componentCode')) ?? '');
      if (!k || !c) continue;
      const q = Number(v(r, 'qty') ?? 1) || 1;
      if (!fileComps.has(k)) fileComps.set(k, new Map());
      fileComps.get(k)!.set(c.id, q);
    }

    return rows.map((r): ValidatedRow<KitRowPlan> => {
      const m: RowMessage[] = [];
      const err = (field: string, message: string) => m.push({ field, level: 'error', message });
      const kitCode = up(v(r, 'kitCode'));
      const compCode = up(v(r, 'componentCode'));
      const kit = kitCode ? byCode.get(kitCode) : undefined;
      const comp = compCode ? byCode.get(compCode) : undefined;
      if (!kitCode) err('kitCode', 'Falta el SKU del kit.');
      else if (!SKU_CODE_REGEX.test(kitCode)) err('kitCode', 'SKU inválido: letras, números, punto, guion o guion bajo (2 a 40).');
      const name = kitCode ? (kitName.get(kitCode) ?? kit?.name ?? null) : null;
      if (kitCode && !kit && !name) err('kitName', `El kit ${kitCode} no existe: escribe su NOMBRE para crearlo.`);
      if (kit && !kit.isKit) {
        if (hasStock.get(kit.id)) err('kitCode', `${kit.skuCode} tiene existencia propia: ajústala a 0 antes de convertirlo en kit.`);
        else if (usedAsComponent.has(kit.id)) err('kitCode', `${kit.skuCode} es componente de otro kit; no puede ser kit.`);
        else m.push({ field: 'kitCode', level: 'warning', message: `${kit.skuCode} se convertirá en kit: en bodega propia su disponible se calculará con sus componentes.` });
      }
      if (!compCode) err('componentCode', 'Falta el componente.');
      else if (!comp) err('componentCode', `El componente ${compCode} no existe en el SKU maestro.`);
      else if (comp.isKit || kitCodesInFile.has(compCode)) err('componentCode', `${comp.skuCode} es un kit; un kit no puede ser componente de otro.`);
      else if (compCode === kitCode) err('componentCode', 'Un kit no puede contenerse a sí mismo.');
      const qRaw = v(r, 'qty');
      const qty = qRaw ? Number(qRaw.replace(/,/g, '')) : 1;
      if (!Number.isInteger(qty) || qty < 1 || qty > 10_000) err('qty', 'La cantidad debe ser un entero de 1 en adelante.');
      const fnsku = kitCode ? (kitFnsku.get(kitCode) ?? null) : null;
      if (fnsku && !FNSKU_REGEX.test(fnsku)) m.push({ field: 'fnsku', level: 'warning', message: `${fnsku} no parece un FNSKU (X00 + 7 caracteres).` });
      if (!r.skipped && kitCode && compCode) {
        const dups = (pairIdx.get(`${kitCode}|${compCode}`) ?? []).filter((n) => n !== r.rowNumber);
        if (dups.length) err('componentCode', `El componente se repite en el kit (renglones ${dups.join(', ')}); súmalo en CANTIDAD.`);
      }
      if (m.some((x) => x.level === 'error') || !kitCode || !comp) return { rowNumber: r.rowNumber, messages: m, action: null, plan: null };

      let action: 'CREAR' | 'ACTUALIZAR' | 'SIN_CAMBIOS' = kit ? 'ACTUALIZAR' : 'CREAR';
      if (kit?.isKit) {
        const now = new Map(current.filter((c) => c.kitSkuId === kit.id).map((c) => [c.componentSkuId, c.quantity]));
        const file = fileComps.get(kitCode) ?? new Map();
        const same = now.size === file.size && [...file].every(([id, q]) => now.get(id) === q);
        if (same) action = 'SIN_CAMBIOS';
      }
      return {
        rowNumber: r.rowNumber,
        messages: m,
        action,
        plan: {
          kitCode,
          kitId: kit?.id ?? null,
          kitName: name ?? kitCode,
          fnsku,
          componentId: comp.id,
          componentCode: comp.skuCode,
          qty,
          label: `${kit ? '' : 'Nuevo kit · '}${kitCode} ⟵ ${qty} × ${comp.skuCode}`,
        },
      };
    });
  },

  async apply(tx: Tx, rows, ctx) {
    const { actor, audit } = ctx;
    const byKit = new Map<string, KitRowPlan[]>();
    for (const { plan } of rows) byKit.set(plan.kitCode, [...(byKit.get(plan.kitCode) ?? []), plan]);
    const counts = { kitsCreados: 0, kitsActualizados: 0, componentes: 0, fnskuGuardados: 0 };
    const [amazon] = await tx.select({ id: channels.id }).from(channels).where(eq(channels.code, 'AMAZON'));

    for (const [kitCode, plans] of byKit) {
      const first = plans[0];
      let kitId = first.kitId;
      if (!kitId) {
        const [p] = await tx.insert(products).values({ name: first.kitName, createdById: actor.id, updatedById: actor.id }).returning({ id: products.id });
        const [s] = await tx
          .insert(masterSkus)
          .values({ skuCode: kitCode, productId: p.id, name: first.kitName, isKit: true, status: 'ACTIVO', createdById: actor.id, updatedById: actor.id })
          .returning({ id: masterSkus.id });
        kitId = s.id;
        counts.kitsCreados++;
      } else {
        const [{ n }] = (
          await tx.execute<{ n: number }>(sql`SELECT coalesce(sum(abs(qty)), 0)::int AS n FROM inventory_balances WHERE master_sku_id = ${kitId}::uuid`)
        ).rows;
        if (Number(n) > 0) throw new ConflictException(`${kitCode} tiene existencia propia; ajústala a 0 antes de convertirlo en kit.`);
        await tx.update(masterSkus).set({ isKit: true, updatedById: actor.id }).where(eq(masterSkus.id, kitId));
        counts.kitsActualizados++;
      }
      await tx.delete(kitComponents).where(eq(kitComponents.kitSkuId, kitId));
      await tx.insert(kitComponents).values(plans.map((p) => ({ kitSkuId: kitId!, componentSkuId: p.componentId, quantity: p.qty })));
      counts.componentes += plans.length;
      if (first.fnsku && amazon) {
        const updated = await tx
          .update(channelListings)
          .set({ fnsku: first.fnsku })
          .where(
            and(
              eq(channelListings.masterSkuId, kitId),
              eq(channelListings.channelId, amazon.id),
              isNull(channelListings.validTo),
              sql`(${channelListings.fnsku} IS NULL OR ${channelListings.fnsku} <> ${first.fnsku})`,
              sql`NOT EXISTS (SELECT 1 FROM channel_listings o WHERE o.fnsku = ${first.fnsku} AND o.master_sku_id <> ${kitId}::uuid AND o.valid_to IS NULL)`,
            ),
          )
          .returning({ id: channelListings.id });
        counts.fnskuGuardados += updated.length;
      }
      await audit.log(tx, actor, {
        action: first.kitId ? 'EDITAR' : 'CREAR',
        module: 'productos',
        entity: 'master_skus',
        entityId: kitId,
        summary: `${first.kitId ? 'Definió' : 'Creó'} el kit ${kitCode}: ${plans.map((p) => `${p.qty} × ${p.componentCode}`).join(' + ')}`,
        newValues: { components: plans.map((p) => ({ sku: p.componentCode, qty: p.qty })), fnsku: first.fnsku },
      });
    }
    return counts;
  },
};

