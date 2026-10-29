import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { masterSkus, skuPackages, type DbOrTx, type Tx } from '@erp/db';
import type { Actor } from '../../common/actor';
import type { ApplyContext, ImportTemplate, InputRow, RowMessage, ValidatedRow } from '../types';
import { parseNumber } from './sales-common';

export interface MeasurePlan {
  packageId: string;
  packageCode: string;
  skuCode: string;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  grossWeightG: number | null;
  cbm: number;
  label: string;
}

/** Medidas y peso de la caja master; el CBM se calcula con largo × ancho × alto. */
export const measuresTemplate: ImportTemplate<MeasurePlan> = {
  key: 'medidas',
  label: 'Medidas de caja master',
  description: 'Largo, ancho y alto (cm) y peso bruto (kg) de la caja master de cada SKU. Con esto se calcula el CBM para llenar contenedores.',
  permissions: ['productos.editar'],
  columns: [
    { field: 'sku', header: 'SKU MAESTRO', aliases: ['SKU'], required: true, example: 'X003XQ0AE5', help: 'SKU maestro con caja master registrada.' },
    { field: 'length', header: 'LARGO (CM)', aliases: ['LENGTH', 'LARGO'], required: true, example: '47', help: 'Largo de la caja en centímetros.' },
    { field: 'width', header: 'ANCHO (CM)', aliases: ['WIDTH', 'ANCHO'], required: true, example: '28', help: 'Ancho en centímetros.' },
    { field: 'height', header: 'ALTO (CM)', aliases: ['HEIGHT', 'ALTO'], required: true, example: '37', help: 'Alto en centímetros.' },
    { field: 'weight', header: 'PESO BRUTO (KG)', aliases: ['G.W(KG)', 'GW KG', 'PESO BRUTO'], example: '19', help: 'Peso bruto de la caja (opcional).' },
    { field: 'cbm', header: 'CBM', aliases: ['CBM/CARTOM', 'CBM/CARTON', 'CBM POR CAJA'], help: 'Opcional: sólo se compara contra las medidas.' },
  ],

  async validate(db: DbOrTx, rows: InputRow[], _actor: Actor): Promise<ValidatedRow<MeasurePlan>[]> {
    const codes = [...new Set(rows.map((r) => (r.values.sku ?? '').trim().toUpperCase()).filter(Boolean))];
    const pk = codes.length
      ? await db
          .select({ id: skuPackages.id, code: skuPackages.code, units: skuPackages.unitsPerPackage, sku: masterSkus.skuCode })
          .from(skuPackages)
          .innerJoin(masterSkus, eq(masterSkus.id, skuPackages.masterSkuId))
          .where(and(inArray(sql`upper(${masterSkus.skuCode})`, codes), eq(skuPackages.type, 'CAJA_MASTER')))
          .orderBy(asc(skuPackages.unitsPerPackage))
      : [];
    const bySku = new Map<string, (typeof pk)[number]>();
    for (const p of pk) bySku.set(p.sku.toUpperCase(), p); // la de más piezas si hay varias
    const known = codes.length ? await db.select({ code: masterSkus.skuCode }).from(masterSkus).where(inArray(sql`upper(${masterSkus.skuCode})`, codes)) : [];
    const exists = new Set(known.map((k) => k.code.toUpperCase()));
    return rows.map((row) => {
      const v = row.values;
      const messages: RowMessage[] = [];
      const err = (field: string, message: string) => messages.push({ field, level: 'error', message });
      const code = (v.sku ?? '').trim().toUpperCase();
      const L = parseNumber(v.length);
      const W = parseNumber(v.width);
      const H = parseNumber(v.height);
      if (!v.length && !v.width && !v.height) {
        messages.push({ level: 'info', message: 'Sin medidas: se deja como está.' });
        return { rowNumber: row.rowNumber, messages, action: 'SIN_CAMBIOS', plan: null };
      }
      if (!exists.has(code)) err('sku', `El SKU ${v.sku ?? ''} no existe.`);
      const p = bySku.get(code);
      if (exists.has(code) && !p) err('sku', `${code} no tiene caja master registrada; agrégala en el SKU (código y piezas).`);
      for (const [f, n] of [['length', L], ['width', W], ['height', H]] as const) if (n === null || n <= 0 || n > 500) err(f, `Medida inválida: “${v[f] ?? ''}” (centímetros).`);
      let weight = parseNumber(v.weight);
      if (v.weight && weight === null) err('weight', `Peso inválido: “${v.weight}”.`);
      if (weight !== null && weight > 200) {
        messages.push({ field: 'weight', level: 'warning', message: `Peso bruto de ${weight} kg por caja no parece correcto: no se guarda.` });
        weight = null;
      }
      if (messages.some((m) => m.level === 'error')) return { rowNumber: row.rowNumber, messages, action: null, plan: null };
      const cbm = (L! * W! * H!) / 1_000_000;
      const fileCbm = parseNumber(v.cbm);
      if (fileCbm !== null && fileCbm > 0 && Math.abs(fileCbm / cbm - 1) > 0.02) {
        messages.push({ field: 'cbm', level: 'warning', message: `El CBM del archivo (${fileCbm}) no coincide con las medidas (${cbm.toFixed(5)}); se usan las medidas.` });
      }
      return {
        rowNumber: row.rowNumber,
        messages,
        action: 'ACTUALIZAR',
        plan: {
          packageId: p!.id,
          packageCode: p!.code,
          skuCode: code,
          lengthMm: Math.round(L! * 10),
          widthMm: Math.round(W! * 10),
          heightMm: Math.round(H! * 10),
          grossWeightG: weight === null ? null : Math.round(weight * 1000),
          cbm,
          label: `${p!.code}: ${L}×${W}×${H} cm = ${cbm.toFixed(4)} CBM (${p!.units} pzas)`,
        },
      };
    });
  },

  async apply(tx: Tx, rows: { rowNumber: number; plan: MeasurePlan }[], ctx: ApplyContext) {
    let cajas = 0;
    for (const { plan } of rows) {
      await tx
        .update(skuPackages)
        .set({ lengthMm: plan.lengthMm, widthMm: plan.widthMm, heightMm: plan.heightMm, ...(plan.grossWeightG !== null ? { grossWeightG: plan.grossWeightG } : {}) })
        .where(eq(skuPackages.id, plan.packageId));
      cajas++;
    }
    await ctx.audit.log(tx, ctx.actor, {
      action: 'IMPORTAR',
      module: 'productos',
      entity: 'sku_packages',
      entityId: ctx.batchId,
      summary: `Actualizó medidas de ${cajas} cajas master (${ctx.batchLabel})`,
    });
    return { cajas };
  },
};
