import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import {
  inventoryAdjustmentItems,
  inventoryAdjustments,
  inventoryLots,
  masterSkus,
  users,
  warehouseLocations,
  warehouses,
  type Db,
  type Tx,
} from '@erp/db';
import { fix2, nextFolio, postMovement, refreshAvgCost } from '@erp/domain';
import { ADJUSTMENT_REASON, adjustmentSchema, applySchema, type AdjustmentInput } from '@erp/shared';
import { AuditService } from '../audit/audit.service';
import { can, type Actor } from '../common/actor';
import { InjectDb } from '../common/db';
import { countSql, likePattern, readListQuery } from '../common/listing';
import { parse } from '../common/zod';
import { assertWarehouse, locationsOf, negativeAuth, numericParam, rowErrors, showCosts, skusById, whScope } from './common';

const THRESHOLD_KEY = 'ajustes.umbral_autorizacion_mxn';

@Injectable()
export class AdjustmentsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async list(query: Record<string, string>, actor: Actor) {
    const lq = readListQuery(query, actor, 'ajustes');
    const conds: SQL[] = [];
    const scope = whScope(actor, inventoryAdjustments.warehouseId);
    if (scope) conds.push(scope);
    if (query.status) conds.push(sql`${inventoryAdjustments.status} = ${query.status}`);
    if (query.reason) conds.push(sql`${inventoryAdjustments.reason} = ${query.reason}`);
    if (query.warehouseId && /^[0-9a-f-]{36}$/i.test(query.warehouseId)) conds.push(eq(inventoryAdjustments.warehouseId, query.warehouseId));
    if (lq.q) {
      const p = likePattern(lq.q);
      conds.push(sql`(${inventoryAdjustments.folio} ILIKE ${p} OR ${inventoryAdjustments.notes} ILIKE ${p} OR EXISTS (
        SELECT 1 FROM inventory_adjustment_items i JOIN master_skus s ON s.id = i.master_sku_id
         WHERE i.adjustment_id = "inventory_adjustments"."id" AND s.sku_code ILIKE ${p}))`);
    }
    const where = conds.length ? and(...conds) : undefined;
    const [{ total }] = await this.db.select({ total: countSql }).from(inventoryAdjustments).where(where);
    const rows = await this.db
      .select({
        id: inventoryAdjustments.id,
        folio: inventoryAdjustments.folio,
        warehouseId: inventoryAdjustments.warehouseId,
        warehouseCode: warehouses.code,
        reason: inventoryAdjustments.reason,
        status: inventoryAdjustments.status,
        notes: inventoryAdjustments.notes,
        totalValue: inventoryAdjustments.totalValue,
        createdAt: inventoryAdjustments.createdAt,
        appliedAt: inventoryAdjustments.appliedAt,
        createdByName: users.name,
        lines: sql<number>`(select count(*)::int from inventory_adjustment_items i where i.adjustment_id = "inventory_adjustments"."id")`,
        unitsIn: sql<number>`(select coalesce(sum(qty) filter (where qty > 0), 0)::int from inventory_adjustment_items i where i.adjustment_id = "inventory_adjustments"."id")`,
        unitsOut: sql<number>`(select coalesce(-sum(qty) filter (where qty < 0), 0)::int from inventory_adjustment_items i where i.adjustment_id = "inventory_adjustments"."id")`,
      })
      .from(inventoryAdjustments)
      .innerJoin(warehouses, eq(warehouses.id, inventoryAdjustments.warehouseId))
      .leftJoin(users, eq(users.id, inventoryAdjustments.createdById))
      .where(where)
      .orderBy(desc(inventoryAdjustments.createdAt))
      .limit(lq.pageSize)
      .offset((lq.page - 1) * lq.pageSize);
    const costs = showCosts(actor);
    return { items: rows.map((r) => (costs ? r : { ...r, totalValue: null })), total, page: lq.page, pageSize: lq.pageSize };
  }

  async get(id: string, actor: Actor) {
    const [h] = await this.db
      .select({
        adj: inventoryAdjustments,
        warehouseCode: warehouses.code,
        warehouseName: warehouses.name,
        createdByName: sql<string | null>`(select name from users where id = "inventory_adjustments"."created_by_id")`,
        authorizedByName: sql<string | null>`(select name from users where id = "inventory_adjustments"."authorized_by_id")`,
        appliedByName: sql<string | null>`(select name from users where id = "inventory_adjustments"."applied_by_id")`,
      })
      .from(inventoryAdjustments)
      .innerJoin(warehouses, eq(warehouses.id, inventoryAdjustments.warehouseId))
      .where(eq(inventoryAdjustments.id, id));
    if (!h) throw new NotFoundException('Ajuste no encontrado.');
    assertWarehouse(actor, h.adj.warehouseId);
    const costs = showCosts(actor);
    const items = await this.db
      .select({
        id: inventoryAdjustmentItems.id,
        lineNo: inventoryAdjustmentItems.lineNo,
        masterSkuId: inventoryAdjustmentItems.masterSkuId,
        skuCode: masterSkus.skuCode,
        skuName: masterSkus.name,
        locationId: inventoryAdjustmentItems.locationId,
        locationCode: warehouseLocations.code,
        lotId: inventoryAdjustmentItems.lotId,
        lotCode: inventoryLots.lotCode,
        qty: inventoryAdjustmentItems.qty,
        unitCost: inventoryAdjustmentItems.unitCost,
        avgCost: masterSkus.avgCost,
        notes: inventoryAdjustmentItems.notes,
        available: sql<number>`coalesce((select available from inventory_stock st where st.master_sku_id = ${inventoryAdjustmentItems.masterSkuId} and st.warehouse_id = ${h.adj.warehouseId}::uuid), 0)`,
      })
      .from(inventoryAdjustmentItems)
      .innerJoin(masterSkus, eq(masterSkus.id, inventoryAdjustmentItems.masterSkuId))
      .leftJoin(warehouseLocations, eq(warehouseLocations.id, inventoryAdjustmentItems.locationId))
      .leftJoin(inventoryLots, eq(inventoryLots.id, inventoryAdjustmentItems.lotId))
      .where(eq(inventoryAdjustmentItems.adjustmentId, id))
      .orderBy(asc(inventoryAdjustmentItems.lineNo));
    const threshold = await numericParam(this.db, THRESHOLD_KEY);
    return {
      ...h.adj,
      totalValue: costs ? h.adj.totalValue : null,
      warehouseCode: h.warehouseCode,
      warehouseName: h.warehouseName,
      createdByName: h.createdByName,
      authorizedByName: h.authorizedByName,
      appliedByName: h.appliedByName,
      threshold: costs ? threshold : null,
      items: items.map((i) => (costs ? i : { ...i, unitCost: null, avgCost: null })),
    };
  }

  /** Valida SKU, ubicaciones, lotes y el permiso de costos de los renglones. */
  private async validate(tx: Tx, data: AdjustmentInput, actor: Actor) {
    assertWarehouse(actor, data.warehouseId);
    const [wh] = await tx.select().from(warehouses).where(eq(warehouses.id, data.warehouseId));
    if (!wh) throw new NotFoundException('Almacén no encontrado.');
    if (wh.status !== 'ACTIVO') throw new ConflictException(`El almacén ${wh.code} está inactivo.`);
    if (data.items.some((i) => i.unitCost !== null) && !can(actor, 'costos.ver'))
      throw new ForbiddenException('No tienes permiso para capturar costos.');
    const skus = await skusById(tx, data.items.map((i) => i.masterSkuId));
    const locs = new Map((await locationsOf(tx, data.warehouseId)).map((l) => [l.id, l]));
    const errors: { path: string; message: string }[] = [];
    for (const [i, it] of data.items.entries()) {
      const s = skus.get(it.masterSkuId);
      if (!s) errors.push({ path: `items.${i}.masterSkuId`, message: 'SKU no encontrado' });
      else if (s.isKit) errors.push({ path: `items.${i}.masterSkuId`, message: 'Un kit no tiene inventario propio; ajusta sus componentes' });
      if (it.locationId && !locs.has(it.locationId)) errors.push({ path: `items.${i}.locationId`, message: 'La ubicación no es de este almacén' });
      if (it.lotId) {
        const [lot] = await tx.select({ sku: inventoryLots.masterSkuId }).from(inventoryLots).where(eq(inventoryLots.id, it.lotId));
        if (!lot || lot.sku !== it.masterSkuId) errors.push({ path: `items.${i}.lotId`, message: 'El lote no es de este SKU' });
        if (it.qty > 0) errors.push({ path: `items.${i}.lotId`, message: 'Las entradas crean un lote nuevo; no indiques lote' });
      }
    }
    if (errors.length) throw rowErrors(errors);
    return { wh, skus };
  }

  /** Valor estimado (MXN): entradas a su costo capturado o promedio; salidas al costo promedio. */
  private estimate(data: Pick<AdjustmentInput, 'items'>, skus: Awaited<ReturnType<typeof skusById>>) {
    let v = 0;
    for (const it of data.items) {
      const s = skus.get(it.masterSkuId);
      const cost = Number(it.unitCost ?? s?.avgCost ?? s?.currentCost ?? 0);
      v += Math.abs(it.qty) * cost;
    }
    return fix2(v);
  }

  async create(body: unknown, actor: Actor) {
    const data = parse(adjustmentSchema, body);
    return this.db.transaction(async (tx) => {
      const { wh, skus } = await this.validate(tx, data, actor);
      const folio = await nextFolio(tx, 'AJ');
      const [row] = await tx
        .insert(inventoryAdjustments)
        .values({ folio, warehouseId: data.warehouseId, reason: data.reason, notes: data.notes, totalValue: this.estimate(data, skus), createdById: actor.id })
        .returning();
      await this.insertItems(tx, row.id, data);
      await this.audit.log(tx, actor, {
        action: 'CREAR', module: 'ajustes', entity: 'inventory_adjustments', entityId: row.id,
        summary: `Creó el ajuste ${folio} en ${wh.code} (${ADJUSTMENT_REASON[data.reason]}, ${data.items.length} renglones)`,
        newValues: { ...data, items: data.items.length },
      });
      return { id: row.id, folio };
    });
  }

  private async insertItems(tx: Tx, adjustmentId: string, data: AdjustmentInput) {
    await tx.insert(inventoryAdjustmentItems).values(
      data.items.map((it, i) => ({
        adjustmentId,
        lineNo: i + 1,
        masterSkuId: it.masterSkuId,
        qty: it.qty,
        locationId: it.locationId,
        lotId: it.lotId,
        unitCost: it.qty > 0 ? it.unitCost : null,
        notes: it.notes,
      })),
    );
  }

  async update(id: string, body: unknown, actor: Actor) {
    const data = parse(adjustmentSchema, body);
    return this.db.transaction(async (tx) => {
      const before = await this.lock(tx, id, actor);
      if (before.status !== 'BORRADOR') throw new ConflictException('Sólo se puede editar un ajuste en borrador.');
      if (data.warehouseId !== before.warehouseId) throw new BadRequestException('No se puede cambiar el almacén de un ajuste; crea uno nuevo.');
      const { skus } = await this.validate(tx, data, actor);
      await tx.delete(inventoryAdjustmentItems).where(eq(inventoryAdjustmentItems.adjustmentId, id));
      await this.insertItems(tx, id, data);
      await tx
        .update(inventoryAdjustments)
        .set({ reason: data.reason, notes: data.notes, totalValue: this.estimate(data, skus) })
        .where(eq(inventoryAdjustments.id, id));
      await this.audit.log(tx, actor, {
        action: 'EDITAR', module: 'ajustes', entity: 'inventory_adjustments', entityId: id,
        summary: `Editó el ajuste ${before.folio} (${data.items.length} renglones)`,
        oldValues: { reason: before.reason, notes: before.notes }, newValues: { reason: data.reason, notes: data.notes, items: data.items.length },
      });
      return { id, folio: before.folio };
    });
  }

  private async lock(tx: Tx, id: string, actor: Actor) {
    const [row] = await tx.select().from(inventoryAdjustments).where(eq(inventoryAdjustments.id, id)).for('update');
    if (!row) throw new NotFoundException('Ajuste no encontrado.');
    assertWarehouse(actor, row.warehouseId);
    return row;
  }

  /**
   * Aplica un ajuste en borrador. Si su valor supera el umbral `ajustes.umbral_autorizacion_mxn`
   * y el usuario no puede autorizar, queda "Por autorizar".
   */
  async apply(id: string, body: unknown, actor: Actor) {
    const opts = parse(applySchema, body ?? {});
    const negative = negativeAuth(actor, opts.authorizeNegative);
    return this.db.transaction(async (tx) => {
      const adj = await this.lock(tx, id, actor);
      if (adj.status !== 'BORRADOR') throw new ConflictException('El ajuste ya no está en borrador.');
      const items = await tx.select().from(inventoryAdjustmentItems).where(eq(inventoryAdjustmentItems.adjustmentId, id));
      const skus = await skusById(tx, items.map((i) => i.masterSkuId));
      const value = this.estimate({ items: items.map((i) => ({ ...i, unitCost: i.unitCost, notes: null })) }, skus);
      const threshold = await numericParam(tx, THRESHOLD_KEY);
      if (threshold !== null && Number(value) > threshold && !can(actor, 'ajustes.autorizar')) {
        await tx.update(inventoryAdjustments).set({ status: 'POR_AUTORIZAR', totalValue: value }).where(eq(inventoryAdjustments.id, id));
        await this.audit.log(tx, actor, {
          action: 'SOLICITAR_AUTORIZACION', module: 'ajustes', entity: 'inventory_adjustments', entityId: id,
          summary: `Envió a autorización el ajuste ${adj.folio} (valor estimado ${value} MXN, umbral ${threshold})`,
        });
        return { id, folio: adj.folio, status: 'POR_AUTORIZAR' as const };
      }
      return this.post(tx, adj, items, actor, negative, false);
    });
  }

  async authorize(id: string, body: unknown, actor: Actor) {
    const opts = parse(applySchema, body ?? {});
    const negative = negativeAuth(actor, opts.authorizeNegative);
    return this.db.transaction(async (tx) => {
      const adj = await this.lock(tx, id, actor);
      if (adj.status !== 'POR_AUTORIZAR') throw new ConflictException('El ajuste no está pendiente de autorización.');
      const items = await tx.select().from(inventoryAdjustmentItems).where(eq(inventoryAdjustmentItems.adjustmentId, id));
      return this.post(tx, adj, items, actor, negative, true);
    });
  }

  private async post(
    tx: Tx,
    adj: typeof inventoryAdjustments.$inferSelect,
    items: (typeof inventoryAdjustmentItems.$inferSelect)[],
    actor: Actor,
    negativeAuthorizedById: string | null,
    authorized: boolean,
  ) {
    // Orden estable por SKU (evita interbloqueos) y entradas antes que salidas.
    const ordered = [...items].sort((a, b) => a.masterSkuId.localeCompare(b.masterSkuId) || b.qty - a.qty);
    let total = 0;
    let shortage = 0;
    for (const it of ordered) {
      const r = await postMovement(tx, {
        type: it.qty > 0 ? 'AJUSTE_ENTRADA' : 'AJUSTE_SALIDA',
        masterSkuId: it.masterSkuId,
        warehouseId: adj.warehouseId,
        locationId: it.locationId,
        lotId: it.qty < 0 ? it.lotId : null,
        qty: it.qty,
        unitCost: it.unitCost,
        lot: it.qty > 0 ? { code: null } : undefined,
        document: { type: 'AJUSTE', id: adj.id, folio: adj.folio, line: it.lineNo },
        userId: actor.id,
        notes: it.notes ?? adj.notes,
        idempotencyKey: `AJ:${adj.id}:${it.lineNo}`,
        negativeAuthorizedById,
      });
      total += Math.abs(Number(r.totalCost));
      shortage += r.shortage;
    }
    await refreshAvgCost(tx, items.map((i) => i.masterSkuId));
    const now = new Date();
    await tx
      .update(inventoryAdjustments)
      .set({
        status: 'APLICADO',
        totalValue: fix2(total),
        appliedAt: now,
        appliedById: actor.id,
        ...(authorized ? { authorizedAt: now, authorizedById: actor.id } : {}),
      })
      .where(eq(inventoryAdjustments.id, adj.id));
    await this.audit.log(tx, actor, {
      action: authorized ? 'AUTORIZAR' : 'APLICAR', module: 'ajustes', entity: 'inventory_adjustments', entityId: adj.id,
      summary: `${authorized ? 'Autorizó y aplicó' : 'Aplicó'} el ajuste ${adj.folio} (${items.length} renglones, ${fix2(total)} MXN)${shortage ? `; ${shortage} pzas quedaron en negativo con autorización` : ''}`,
      newValues: { status: 'APLICADO', totalValue: fix2(total), shortage },
    });
    return { id: adj.id, folio: adj.folio, status: 'APLICADO' as const, shortage };
  }

  async cancel(id: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const adj = await this.lock(tx, id, actor);
      if (!['BORRADOR', 'POR_AUTORIZAR'].includes(adj.status)) throw new ConflictException('Sólo se cancela un ajuste en borrador o por autorizar.');
      if (adj.status === 'POR_AUTORIZAR' && adj.createdById !== actor.id && !can(actor, 'ajustes.autorizar'))
        throw new ForbiddenException('Sólo quien lo creó o quien autoriza puede rechazar el ajuste.');
      await tx.update(inventoryAdjustments).set({ status: 'CANCELADO', cancelledAt: new Date() }).where(eq(inventoryAdjustments.id, id));
      await this.audit.log(tx, actor, {
        action: adj.status === 'POR_AUTORIZAR' ? 'RECHAZAR' : 'CANCELAR', module: 'ajustes', entity: 'inventory_adjustments', entityId: id,
        summary: `${adj.status === 'POR_AUTORIZAR' ? 'Rechazó' : 'Canceló'} el ajuste ${adj.folio}`,
      });
      return { id, status: 'CANCELADO' as const };
    });
  }
}
