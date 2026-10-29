import { eq, inArray, sql } from 'drizzle-orm';
import { importContainerLines, importContainers, masterSkus, suppliers, type DbOrTx, type Tx } from '@erp/db';
import type { Actor } from '../../common/actor';
import type { ApplyContext, ImportTemplate, InputRow, RowMessage, ValidatedRow } from '../types';
import { parseNumber, parseSaleDate } from './sales-common';

type ContainerStatus = 'PLANEADO' | 'EN_PRODUCCION' | 'EN_NAVIERA' | 'EN_ADUANA' | 'RECIBIDO' | 'PERDIDO' | 'CANCELADO';
const STATUS_ORDER: ContainerStatus[] = ['PLANEADO', 'EN_PRODUCCION', 'EN_NAVIERA', 'EN_ADUANA'];

export interface ContainerLinePlan {
  containerCode: string;
  skuId: string;
  skuCode: string;
  qty: number;
  orderDate: string;
  status: ContainerStatus;
  etd: string | null;
  eta: string | null;
  supplierName: string | null;
  unitCost: string | null;
  notes: string | null;
  label: string;
}

function parseStatus(v: string | null): ContainerStatus | null {
  if (!v) return 'EN_PRODUCCION';
  const s = v
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase();
  if (s.includes('PRODUCC')) return 'EN_PRODUCCION';
  if (s.includes('NAVIER') || s.includes('BARCO') || s.includes('MAR')) return 'EN_NAVIERA';
  if (s.includes('ADUANA') || s.includes('PUERTO') || s.includes('TRASLADO')) return 'EN_ADUANA';
  if (s.includes('PLANE')) return 'PLANEADO';
  if (s.includes('PERDID')) return 'PERDIDO';
  if (s.includes('CANCEL')) return 'CANCELADO';
  return null;
}

/** Pedidos a China en camino, por contenedor (hoja «Pedidos en camino» o similar). */
export const containersTemplate: ImportTemplate<ContainerLinePlan> = {
  key: 'contenedores',
  label: 'Contenedores en camino',
  description: 'Mercancía pedida a China que no ha llegado: un renglón por SKU y contenedor. Las líneas de cada contenedor del archivo reemplazan a las que tenía.',
  permissions: ['compras.crear', 'compras.editar'],
  columns: [
    { field: 'container', header: 'CONTENEDOR', aliases: ['PEDIDO / CONTENEDOR', 'PEDIDO', 'CONT'], required: true, example: 'CONT-53', help: 'Clave del contenedor.' },
    { field: 'sku', header: 'SKU', aliases: ['SKU MAESTRO'], required: true, example: 'X004I913HJ', help: 'SKU maestro.' },
    { field: 'qty', header: 'PIEZAS', aliases: ['CANTIDAD'], required: true, example: '660', help: 'Piezas pedidas.' },
    { field: 'orderDate', header: 'FECHA DEL PEDIDO', aliases: ['FECHA PEDIDO'], required: true, example: '2026-11-05', help: 'Fecha en que se hizo el pedido al proveedor.' },
    { field: 'status', header: 'ESTADO', example: 'EN PRODUCCION', help: 'EN PRODUCCION, EN NAVIERA, EN ADUANA, PERDIDO o CANCELADO.' },
    { field: 'etd', header: 'ETD', aliases: ['ETD (SALIDA DEL BARCO)', 'SALIDA DEL BARCO'], help: 'Salida del barco, si ya se conoce.' },
    { field: 'eta', header: 'FECHA ESTIMADA EN APLIN', aliases: ['LLEGADA A APLIN', 'ETA'], help: 'Llegada a APLIN, si se conoce (tiene prioridad sobre el cálculo).' },
    { field: 'supplier', header: 'PROVEEDOR', help: 'Zanetti, Lean Travel… (se crea si no existe).' },
    { field: 'unitCost', header: 'COSTO UNITARIO', help: 'Costo puesto en almacén sin IVA (opcional).' },
    { field: 'notes', header: 'NOTAS', help: 'Notas (los renglones con EJEMPLO se ignoran).' },
  ],

  async validate(db: DbOrTx, rows: InputRow[], _actor: Actor): Promise<ValidatedRow<ContainerLinePlan>[]> {
    const codes = [...new Set(rows.map((r) => (r.values.sku ?? '').trim().toUpperCase()).filter(Boolean))];
    const skus = codes.length ? await db.select({ id: masterSkus.id, code: masterSkus.skuCode, isKit: masterSkus.isKit }).from(masterSkus).where(inArray(sql`upper(${masterSkus.skuCode})`, codes)) : [];
    const skuBy = new Map(skus.map((s) => [s.code.toUpperCase(), s]));
    const conts = [...new Set(rows.map((r) => (r.values.container ?? '').trim().toUpperCase()).filter(Boolean))];
    const existing = conts.length
      ? await db
          .select({ id: importContainers.id, code: importContainers.code, status: importContainers.status, lines: sql<number>`(select count(*)::int from import_container_lines l where l.container_id = ${importContainers.id})` })
          .from(importContainers)
          .where(inArray(sql`upper(${importContainers.code})`, conts))
      : [];
    const contBy = new Map(existing.map((c) => [c.code.toUpperCase(), c]));
    const warned = new Set<string>();
    return rows.map((row) => {
      const v = row.values;
      const messages: RowMessage[] = [];
      const err = (field: string, message: string) => messages.push({ field, level: 'error', message });
      if ((v.notes ?? '').trim().toUpperCase() === 'EJEMPLO') {
        messages.push({ level: 'info', message: 'Renglón de ejemplo: se ignora.' });
        return { rowNumber: row.rowNumber, messages, action: 'SIN_CAMBIOS', plan: null };
      }
      const code = (v.container ?? '').trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9 ._-]{0,30}$/.test(code)) err('container', `Clave de contenedor inválida: “${v.container ?? ''}”.`);
      const sku = skuBy.get((v.sku ?? '').trim().toUpperCase());
      if (!sku) err('sku', `El SKU ${v.sku ?? ''} no existe: dalo de alta primero en el SKU maestro.`);
      else if (sku.isKit) err('sku', `${sku.code} es un kit: captura sus componentes.`);
      const qty = parseNumber(v.qty);
      if (qty === null || !Number.isInteger(qty) || qty <= 0) err('qty', `Piezas inválidas: “${v.qty ?? ''}”.`);
      const orderDate = parseSaleDate(v.orderDate);
      if (!orderDate) err('orderDate', `Fecha del pedido inválida: “${v.orderDate ?? ''}”.`);
      const status = parseStatus(v.status);
      if (!status) err('status', `Estado no reconocido: “${v.status}”.`);
      const etd = v.etd ? parseSaleDate(v.etd) : null;
      if (v.etd && !etd) err('etd', `ETD inválido: “${v.etd}”.`);
      const eta = v.eta ? parseSaleDate(v.eta) : null;
      if (v.eta && !eta) err('eta', `Fecha estimada inválida: “${v.eta}”.`);
      const cost = parseNumber(v.unitCost);
      if (v.unitCost && (cost === null || cost < 0)) err('unitCost', `Costo inválido: “${v.unitCost}”.`);
      const ex = contBy.get(code);
      if (ex && ex.status === 'RECIBIDO') err('container', `El contenedor ${code} ya se recibió; no se modifica.`);
      else if (ex && ex.lines > 0 && !warned.has(code)) {
        warned.add(code);
        messages.push({ field: 'container', level: 'warning', message: `${code} ya tiene ${ex.lines} líneas: se reemplazan por las del archivo.` });
      }
      if (messages.some((m) => m.level === 'error')) return { rowNumber: row.rowNumber, messages, action: null, plan: null };
      return {
        rowNumber: row.rowNumber,
        messages,
        action: ex ? 'ACTUALIZAR' : 'CREAR',
        plan: {
          containerCode: code,
          skuId: sku!.id,
          skuCode: sku!.code,
          qty: qty!,
          orderDate: orderDate!,
          status: status!,
          etd,
          eta,
          supplierName: v.supplier?.trim() || null,
          unitCost: cost === null ? null : cost.toFixed(4),
          notes: v.notes?.trim() || null,
          label: `${code} · ${sku!.code} × ${qty}`,
        },
      };
    });
  },

  async apply(tx: Tx, rows: { rowNumber: number; plan: ContainerLinePlan }[], ctx: ApplyContext) {
    const counts = { contenedoresCreados: 0, contenedoresActualizados: 0, lineas: 0, piezas: 0, proveedoresCreados: 0 };
    const byCont = new Map<string, ContainerLinePlan[]>();
    for (const { plan } of rows) byCont.set(plan.containerCode, [...(byCont.get(plan.containerCode) ?? []), plan]);
    const supplierId = new Map<string, string>();
    const supplierOf = async (name: string | null) => {
      if (!name) return null;
      const k = name.toLowerCase();
      if (supplierId.has(k)) return supplierId.get(k)!;
      let [s] = await tx.select({ id: suppliers.id }).from(suppliers).where(sql`lower(${suppliers.name}) = ${k}`);
      if (!s) {
        [s] = await tx.insert(suppliers).values({ name, country: 'CN', currencyCode: 'USD' }).returning({ id: suppliers.id });
        counts.proveedoresCreados++;
      }
      supplierId.set(k, s.id);
      return s.id;
    };
    for (const [code, lines] of byCont) {
      const statuses = lines.map((l) => l.status);
      const terminal = statuses.find((s) => s === 'PERDIDO' || s === 'CANCELADO');
      const status = terminal ?? STATUS_ORDER.find((s) => statuses.includes(s)) ?? 'EN_PRODUCCION';
      const etd = lines.map((l) => l.etd).filter(Boolean).sort().pop() ?? null;
      const eta = lines.map((l) => l.eta).filter(Boolean).sort().pop() ?? null;
      let [c] = await tx.select({ id: importContainers.id }).from(importContainers).where(sql`upper(${importContainers.code}) = ${code}`);
      if (c) {
        await tx.update(importContainers).set({ status, etd, etaOverride: eta, updatedById: ctx.actor.id }).where(eq(importContainers.id, c.id));
        await tx.delete(importContainerLines).where(eq(importContainerLines.containerId, c.id));
        counts.contenedoresActualizados++;
      } else {
        [c] = await tx
          .insert(importContainers)
          .values({ code, status, etd, etaOverride: eta, createdById: ctx.actor.id, updatedById: ctx.actor.id })
          .returning({ id: importContainers.id });
        counts.contenedoresCreados++;
      }
      for (const l of lines) {
        await tx.insert(importContainerLines).values({
          containerId: c.id,
          masterSkuId: l.skuId,
          supplierId: await supplierOf(l.supplierName),
          qty: l.qty,
          orderDate: l.orderDate,
          unitCost: l.unitCost,
          notes: l.notes,
        });
        counts.lineas++;
        counts.piezas += l.qty;
      }
      await ctx.audit.log(tx, ctx.actor, {
        action: 'IMPORTAR',
        module: 'compras',
        entity: 'import_containers',
        entityId: c.id,
        summary: `Cargó el contenedor ${code}: ${lines.length} líneas, ${lines.reduce((a, l) => a + l.qty, 0)} piezas (${ctx.batchLabel})`,
      });
    }
    return counts;
  },
};
