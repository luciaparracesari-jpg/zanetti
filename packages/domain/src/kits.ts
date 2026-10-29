import { asc, eq, inArray } from 'drizzle-orm';
import { type DbOrTx, kitComponents, masterSkus } from '@erp/db';
import { InventoryError } from './errors';
import { type DocumentRef, lockSkuWarehouse, postMovement, refreshAvgCost } from './inventory';
import { fix4 } from './numbers';

export interface KitAssemblyInput {
  kitId: string;
  warehouseId: string;
  /** Kits a armar o desarmar. */
  qty: number;
  mode: 'ARMAR' | 'DESARMAR';
  /** Dónde queda el kit armado (o de dónde sale al desarmar). Los componentes salen FIFO de las ubicaciones vendibles. */
  locationId?: string | null;
  document: DocumentRef;
  userId?: string | null;
  notes?: string | null;
  negativeAuthorizedById?: string | null;
}

export interface KitAssemblyResult {
  kitCost: string;
  unitCost: string;
  components: { skuId: string; skuCode: string; qty: number; totalCost: string }[];
}

/**
 * Armado de kits: salen los componentes (FIFO) y entra el kit con un lote cuyo costo es la suma de lo que salió.
 * Desarmado: sale el kit (FIFO) y entran los componentes; el costo del kit se reparte en proporción al costo
 * promedio de cada componente. El valor del inventario no cambia en ninguno de los dos.
 */
export async function assembleKits(tx: DbOrTx, input: KitAssemblyInput): Promise<KitAssemblyResult> {
  if (!Number.isInteger(input.qty) || input.qty <= 0) throw new InventoryError('MOVIMIENTO_INVALIDO', 'La cantidad de kits debe ser un entero positivo.');
  const [kit] = await tx.select({ id: masterSkus.id, skuCode: masterSkus.skuCode, isKit: masterSkus.isKit }).from(masterSkus).where(eq(masterSkus.id, input.kitId));
  if (!kit) throw new InventoryError('SKU_NO_ENCONTRADO', 'El kit no existe.');
  if (!kit.isKit) throw new InventoryError('MOVIMIENTO_INVALIDO', `${kit.skuCode} no es un kit.`);
  const comps = await tx
    .select({ skuId: kitComponents.componentSkuId, qty: kitComponents.quantity, skuCode: masterSkus.skuCode, avgCost: masterSkus.avgCost, currentCost: masterSkus.currentCost })
    .from(kitComponents)
    .innerJoin(masterSkus, eq(masterSkus.id, kitComponents.componentSkuId))
    .where(eq(kitComponents.kitSkuId, kit.id))
    .orderBy(asc(kitComponents.componentSkuId));
  if (comps.length === 0) throw new InventoryError('MOVIMIENTO_INVALIDO', `${kit.skuCode} no tiene componentes definidos.`);

  // Candados en orden estable (kit y componentes) para no interbloquear con otras operaciones.
  for (const id of [kit.id, ...comps.map((c) => c.skuId)].sort()) await lockSkuWarehouse(tx, id, input.warehouseId);

  const base = { warehouseId: input.warehouseId, document: input.document, userId: input.userId, notes: input.notes, negativeAuthorizedById: input.negativeAuthorizedById };
  const out: KitAssemblyResult['components'] = [];
  let total = 0;

  if (input.mode === 'ARMAR') {
    for (const c of comps) {
      const r = await postMovement(tx, { ...base, type: 'ARMADO_KIT', masterSkuId: c.skuId, qty: -(c.qty * input.qty) });
      const cost = -Number(r.totalCost);
      total += cost;
      out.push({ skuId: c.skuId, skuCode: c.skuCode, qty: -(c.qty * input.qty), totalCost: fix4(-cost) });
    }
    await postMovement(tx, {
      ...base,
      type: 'ARMADO_KIT',
      masterSkuId: kit.id,
      locationId: input.locationId,
      qty: input.qty,
      unitCost: fix4(total / input.qty),
      lot: { code: null, costStatus: total > 0 ? 'FINAL' : 'PROVISIONAL' },
    });
  } else {
    const r = await postMovement(tx, { ...base, type: 'DESARMADO_KIT', masterSkuId: kit.id, locationId: input.locationId, qty: -input.qty });
    total = -Number(r.totalCost);
    const weights = comps.map((c) => c.qty * Number(c.avgCost ?? c.currentCost ?? 0));
    const sumW = weights.reduce((a, b) => a + b, 0);
    for (const [i, c] of comps.entries()) {
      const share = sumW > 0 ? weights[i] / sumW : (c.qty / comps.reduce((a, x) => a + x.qty, 0));
      const units = c.qty * input.qty;
      const cost = total * share;
      await postMovement(tx, {
        ...base,
        type: 'DESARMADO_KIT',
        masterSkuId: c.skuId,
        qty: units,
        unitCost: fix4(cost / units),
        lot: { code: null, costStatus: total > 0 ? 'FINAL' : 'PROVISIONAL' },
      });
      out.push({ skuId: c.skuId, skuCode: c.skuCode, qty: units, totalCost: fix4(cost) });
    }
  }
  await refreshAvgCost(tx, [kit.id, ...comps.map((c) => c.skuId)]);
  return { kitCost: fix4(total), unitCost: fix4(total / input.qty), components: out };
}

/** Componentes de varios kits (para calcular su disponible). */
export async function kitComponentsOf(tx: DbOrTx, kitIds: string[]) {
  if (kitIds.length === 0) return [];
  return tx.select({ kitId: kitComponents.kitSkuId, skuId: kitComponents.componentSkuId, qty: kitComponents.quantity }).from(kitComponents).where(inArray(kitComponents.kitSkuId, kitIds));
}
