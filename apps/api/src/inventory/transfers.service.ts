import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { aliasedTable, and, asc, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import {
  inventoryLots,
  masterSkus,
  skuPackages,
  stockTransferItemLots,
  stockTransferItems,
  stockTransfers,
  users,
  warehouseLocations,
  warehouses,
  type Db,
  type Tx,
} from '@erp/db';
import { closeReservations, nextFolio, postMovement, refreshAvgCost, reserve } from '@erp/domain';
import { transferReceiveSchema, transferSchema, transferShipSchema, type TransferInput } from '@erp/shared';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../common/actor';
import { InjectDb } from '../common/db';
import { countSql, likePattern, readListQuery } from '../common/listing';
import { parse } from '../common/zod';
import { assertWarehouse, negativeAuth, rowErrors, showCosts, skusById } from './common';

const origin = aliasedTable(warehouses, 'origin');
const destination = aliasedTable(warehouses, 'destination');

type Transfer = typeof stockTransfers.$inferSelect;
type Item = typeof stockTransferItems.$inferSelect;

@Injectable()
export class TransfersService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private scope(actor: Actor): SQL | undefined {
    if (!actor.warehouseIds) return undefined;
    const ids = actor.warehouseIds.length ? actor.warehouseIds : ['00000000-0000-0000-0000-000000000000'];
    return or(inArray(stockTransfers.originWarehouseId, ids), inArray(stockTransfers.destinationWarehouseId, ids));
  }

  /** El usuario debe tener acceso al origen o al destino (y al origen para enviar, al destino para recibir). */
  private assertAny(actor: Actor, t: Pick<Transfer, 'originWarehouseId' | 'destinationWarehouseId'>) {
    if (!actor.warehouseIds) return;
    if (!actor.warehouseIds.includes(t.originWarehouseId) && !actor.warehouseIds.includes(t.destinationWarehouseId))
      assertWarehouse(actor, t.originWarehouseId);
  }

  async list(query: Record<string, string>, actor: Actor) {
    const lq = readListQuery(query, actor, 'transferencias');
    const conds: SQL[] = [];
    const scope = this.scope(actor);
    if (scope) conds.push(scope);
    if (query.status === 'ABIERTAS') conds.push(sql`${stockTransfers.status} IN ('BORRADOR', 'AUTORIZADA', 'ENVIADA')`);
    else if (query.status) conds.push(sql`${stockTransfers.status} = ${query.status}`);
    const uuid = (v?: string) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : undefined);
    if (uuid(query.originId)) conds.push(eq(stockTransfers.originWarehouseId, query.originId));
    if (uuid(query.destinationId)) conds.push(eq(stockTransfers.destinationWarehouseId, query.destinationId));
    if (lq.q) {
      const p = likePattern(lq.q);
      conds.push(sql`(${stockTransfers.folio} ILIKE ${p} OR ${stockTransfers.reference} ILIKE ${p} OR EXISTS (
        SELECT 1 FROM stock_transfer_items i JOIN master_skus s ON s.id = i.master_sku_id
         WHERE i.transfer_id = "stock_transfers"."id" AND s.sku_code ILIKE ${p}))`);
    }
    const where = conds.length ? and(...conds) : undefined;
    const [{ total }] = await this.db.select({ total: countSql }).from(stockTransfers).where(where);
    const agg = (expr: string) => sql<number>`(select ${sql.raw(expr)} from stock_transfer_items i where i.transfer_id = "stock_transfers"."id")`;
    const items = await this.db
      .select({
        id: stockTransfers.id,
        folio: stockTransfers.folio,
        status: stockTransfers.status,
        reference: stockTransfers.reference,
        originCode: origin.code,
        destinationCode: destination.code,
        createdAt: stockTransfers.createdAt,
        shippedAt: stockTransfers.shippedAt,
        receivedAt: stockTransfers.receivedAt,
        createdByName: users.name,
        lines: agg('count(*)::int'),
        qtyRequested: agg('coalesce(sum(qty_requested), 0)::int'),
        qtyShipped: agg('coalesce(sum(qty_shipped), 0)::int'),
        qtyReceived: agg('coalesce(sum(qty_received), 0)::int'),
      })
      .from(stockTransfers)
      .innerJoin(origin, eq(origin.id, stockTransfers.originWarehouseId))
      .innerJoin(destination, eq(destination.id, stockTransfers.destinationWarehouseId))
      .leftJoin(users, eq(users.id, stockTransfers.createdById))
      .where(where)
      .orderBy(desc(stockTransfers.createdAt))
      .limit(lq.pageSize)
      .offset((lq.page - 1) * lq.pageSize);
    return { items, total, page: lq.page, pageSize: lq.pageSize };
  }

  async get(id: string, actor: Actor) {
    const [row] = await this.db
      .select({
        t: stockTransfers,
        originCode: origin.code,
        originName: origin.name,
        destinationCode: destination.code,
        destinationName: destination.name,
        destinationType: destination.type,
      })
      .from(stockTransfers)
      .innerJoin(origin, eq(origin.id, stockTransfers.originWarehouseId))
      .innerJoin(destination, eq(destination.id, stockTransfers.destinationWarehouseId))
      .where(eq(stockTransfers.id, id));
    if (!row) throw new NotFoundException('Transferencia no encontrada.');
    this.assertAny(actor, row.t);
    const costs = showCosts(actor);
    const items = await this.db
      .select({
        id: stockTransferItems.id,
        lineNo: stockTransferItems.lineNo,
        masterSkuId: stockTransferItems.masterSkuId,
        skuCode: masterSkus.skuCode,
        skuName: masterSkus.name,
        qtyRequested: stockTransferItems.qtyRequested,
        packageId: stockTransferItems.packageId,
        packageCode: skuPackages.code,
        packageUnits: skuPackages.unitsPerPackage,
        packageQty: stockTransferItems.packageQty,
        qtyShipped: stockTransferItems.qtyShipped,
        qtyReceived: stockTransferItems.qtyReceived,
        notes: stockTransferItems.notes,
        originAvailable: sql<number>`coalesce((select available from inventory_stock st where st.master_sku_id = ${stockTransferItems.masterSkuId} and st.warehouse_id = ${row.t.originWarehouseId}::uuid), 0)`,
      })
      .from(stockTransferItems)
      .innerJoin(masterSkus, eq(masterSkus.id, stockTransferItems.masterSkuId))
      .leftJoin(skuPackages, eq(skuPackages.id, stockTransferItems.packageId))
      .where(eq(stockTransferItems.transferId, id))
      .orderBy(asc(stockTransferItems.lineNo));
    const lots = items.length
      ? await this.db
          .select({
            itemId: stockTransferItemLots.itemId,
            lotId: stockTransferItemLots.lotId,
            lotCode: inventoryLots.lotCode,
            qty: stockTransferItemLots.qty,
            qtyReceived: stockTransferItemLots.qtyReceived,
            unitCost: stockTransferItemLots.unitCost,
          })
          .from(stockTransferItemLots)
          .leftJoin(inventoryLots, eq(inventoryLots.id, stockTransferItemLots.lotId))
          .where(inArray(stockTransferItemLots.itemId, items.map((i) => i.id)))
          .orderBy(asc(stockTransferItemLots.id))
      : [];
    const names = await this.userNames([row.t.createdById, row.t.authorizedById, row.t.shippedById, row.t.receivedById]);
    const value = lots.reduce((a, l) => a + l.qty * Number(l.unitCost), 0);
    return {
      ...row.t,
      originCode: row.originCode,
      originName: row.originName,
      destinationCode: row.destinationCode,
      destinationName: row.destinationName,
      destinationType: row.destinationType,
      createdByName: names.get(row.t.createdById ?? ''),
      authorizedByName: names.get(row.t.authorizedById ?? ''),
      shippedByName: names.get(row.t.shippedById ?? ''),
      receivedByName: names.get(row.t.receivedById ?? ''),
      ...(costs ? { shippedValue: value.toFixed(2) } : {}),
      items: items.map((i) => ({
        ...i,
        lots: lots.filter((l) => l.itemId === i.id).map((l) => (costs ? l : { ...l, unitCost: null })),
      })),
    };
  }

  private async userNames(ids: (string | null)[]) {
    const list = ids.filter((x): x is string => Boolean(x));
    if (!list.length) return new Map<string, string>();
    const rows = await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, list));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /** Valida almacenes, SKU y cajas; convierte cajas a piezas. */
  private async prepare(tx: Tx, data: TransferInput, actor: Actor) {
    assertWarehouse(actor, data.originWarehouseId);
    const whs = await tx.select().from(warehouses).where(inArray(warehouses.id, [data.originWarehouseId, data.destinationWarehouseId]));
    const o = whs.find((w) => w.id === data.originWarehouseId);
    const d = whs.find((w) => w.id === data.destinationWarehouseId);
    if (!o || !d) throw new NotFoundException('Almacén no encontrado.');
    if (o.status !== 'ACTIVO' || d.status !== 'ACTIVO') throw new ConflictException('Los dos almacenes deben estar activos.');
    const skus = await skusById(tx, data.items.map((i) => i.masterSkuId));
    const pkgIds = data.items.map((i) => i.packageId).filter((x): x is string => Boolean(x));
    const pkgs = pkgIds.length ? await tx.select().from(skuPackages).where(inArray(skuPackages.id, pkgIds)) : [];
    const errors: { path: string; message: string }[] = [];
    const lines = data.items.map((it, i) => {
      const s = skus.get(it.masterSkuId);
      if (!s) errors.push({ path: `items.${i}.masterSkuId`, message: 'SKU no encontrado' });
      else if (s.isKit) errors.push({ path: `items.${i}.masterSkuId`, message: 'Un kit no se transfiere; agrega sus componentes' });
      let qty = it.qtyRequested ?? 0;
      if (it.packageId) {
        const p = pkgs.find((x) => x.id === it.packageId);
        if (!p || p.masterSkuId !== it.masterSkuId) errors.push({ path: `items.${i}.packageId`, message: 'La caja no es de este SKU' });
        else qty = p.unitsPerPackage * (it.packageQty ?? 0);
      }
      if (qty <= 0) errors.push({ path: `items.${i}.qtyRequested`, message: 'Indica las piezas' });
      return { ...it, qty };
    });
    if (errors.length) throw rowErrors(errors);
    return { o, d, lines };
  }

  async create(body: unknown, actor: Actor) {
    const data = parse(transferSchema, body);
    return this.db.transaction(async (tx) => {
      const { o, d, lines } = await this.prepare(tx, data, actor);
      const folio = await nextFolio(tx, 'TR');
      const [t] = await tx
        .insert(stockTransfers)
        .values({ folio, originWarehouseId: o.id, destinationWarehouseId: d.id, reference: data.reference, notes: data.notes, createdById: actor.id })
        .returning();
      await this.insertItems(tx, t.id, lines);
      await this.audit.log(tx, actor, {
        action: 'CREAR', module: 'transferencias', entity: 'stock_transfers', entityId: t.id,
        summary: `Creó la transferencia ${folio} de ${o.code} a ${d.code} (${lines.length} SKU, ${lines.reduce((a, l) => a + l.qty, 0)} pzas)`,
        newValues: { originWarehouseId: o.id, destinationWarehouseId: d.id, reference: data.reference, items: lines.length },
      });
      return { id: t.id, folio };
    });
  }

  private async insertItems(tx: Tx, transferId: string, lines: { masterSkuId: string; qty: number; packageId: string | null; packageQty: number | null; notes: string | null }[]) {
    await tx.insert(stockTransferItems).values(
      lines.map((l, i) => ({
        transferId,
        lineNo: i + 1,
        masterSkuId: l.masterSkuId,
        qtyRequested: l.qty,
        packageId: l.packageId,
        packageQty: l.packageId ? l.packageQty : null,
        notes: l.notes,
      })),
    );
  }

  private async lock(tx: Tx, id: string, actor: Actor) {
    const [t] = await tx.select().from(stockTransfers).where(eq(stockTransfers.id, id)).for('update');
    if (!t) throw new NotFoundException('Transferencia no encontrada.');
    this.assertAny(actor, t);
    return t;
  }

  async update(id: string, body: unknown, actor: Actor) {
    const data = parse(transferSchema, body);
    return this.db.transaction(async (tx) => {
      const t = await this.lock(tx, id, actor);
      if (t.status !== 'BORRADOR') throw new ConflictException('Sólo se edita una transferencia en borrador.');
      const { o, d, lines } = await this.prepare(tx, data, actor);
      await tx.delete(stockTransferItems).where(eq(stockTransferItems.transferId, id));
      await this.insertItems(tx, id, lines);
      await tx
        .update(stockTransfers)
        .set({ originWarehouseId: o.id, destinationWarehouseId: d.id, reference: data.reference, notes: data.notes })
        .where(eq(stockTransfers.id, id));
      await this.audit.log(tx, actor, {
        action: 'EDITAR', module: 'transferencias', entity: 'stock_transfers', entityId: id,
        summary: `Editó la transferencia ${t.folio} (${lines.length} SKU)`,
        oldValues: { originWarehouseId: t.originWarehouseId, destinationWarehouseId: t.destinationWarehouseId, reference: t.reference },
        newValues: { originWarehouseId: o.id, destinationWarehouseId: d.id, reference: data.reference },
      });
      return { id, folio: t.folio };
    });
  }

  /** Autoriza: aparta (compromete) la existencia del origen para que no se venda ni se use en otra transferencia. */
  async authorize(id: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const t = await this.lock(tx, id, actor);
      assertWarehouse(actor, t.originWarehouseId);
      if (t.status !== 'BORRADOR') throw new ConflictException('Sólo se autoriza una transferencia en borrador.');
      const items = await this.items(tx, id);
      for (const it of [...items].sort((a, b) => a.masterSkuId.localeCompare(b.masterSkuId))) {
        await reserve(tx, {
          masterSkuId: it.masterSkuId,
          warehouseId: t.originWarehouseId,
          qty: it.qtyRequested,
          sourceType: 'TRANSFERENCIA',
          sourceId: t.id,
          sourceLine: it.lineNo,
        });
      }
      await tx.update(stockTransfers).set({ status: 'AUTORIZADA', authorizedById: actor.id, authorizedAt: new Date() }).where(eq(stockTransfers.id, id));
      await this.audit.log(tx, actor, {
        action: 'AUTORIZAR', module: 'transferencias', entity: 'stock_transfers', entityId: id,
        summary: `Autorizó la transferencia ${t.folio}: apartó ${items.reduce((a, i) => a + i.qtyRequested, 0)} pzas en el origen`,
      });
      return { id, status: 'AUTORIZADA' as const };
    });
  }

  private items(tx: Tx, transferId: string) {
    return tx.select().from(stockTransferItems).where(eq(stockTransferItems.transferId, transferId)).orderBy(asc(stockTransferItems.lineNo));
  }

  /** Envía: saca la mercancía del origen (FIFO) y la deja en tránsito hacia el destino con el costo de sus lotes. */
  async ship(id: string, body: unknown, actor: Actor) {
    const data = parse(transferShipSchema, body ?? {});
    const negative = negativeAuth(actor, data.authorizeNegative);
    return this.db.transaction(async (tx) => {
      const t = await this.lock(tx, id, actor);
      assertWarehouse(actor, t.originWarehouseId);
      if (t.status !== 'AUTORIZADA') throw new ConflictException('Sólo se envía una transferencia autorizada.');
      const items = await this.items(tx, id);
      const given = new Map(data.items.map((i) => [i.itemId, i.qtyShipped]));
      for (const k of given.keys()) if (!items.some((i) => i.id === k)) throw new BadRequestException('Renglón de otra transferencia.');
      const errors: { path: string; message: string }[] = [];
      const plan = items.map((it) => {
        const q = given.get(it.id) ?? it.qtyRequested;
        if (q > it.qtyRequested) errors.push({ path: `items.${it.lineNo - 1}.qtyShipped`, message: `No puede exceder lo autorizado (${it.qtyRequested})` });
        return { it, q };
      });
      if (errors.length) throw rowErrors(errors);
      if (plan.every((p) => p.q === 0)) throw new BadRequestException('Indica al menos una pieza enviada.');

      await closeReservations(tx, 'TRANSFERENCIA', t.id, 'CONSUMIDA');
      let units = 0;
      for (const { it, q } of [...plan].sort((a, b) => a.it.masterSkuId.localeCompare(b.it.masterSkuId))) {
        await tx.update(stockTransferItems).set({ qtyShipped: q }).where(eq(stockTransferItems.id, it.id));
        if (q === 0) continue;
        const r = await postMovement(tx, {
          type: 'TRANSFER_SALIDA',
          masterSkuId: it.masterSkuId,
          warehouseId: t.originWarehouseId,
          qty: -q,
          document: { type: 'TRANSFERENCIA', id: t.id, folio: t.folio, line: it.lineNo },
          userId: actor.id,
          notes: data.reference ?? t.reference,
          idempotencyKey: `TR:${t.id}:S:${it.lineNo}`,
          negativeAuthorizedById: negative,
        });
        // Lotes que salieron, agrupados, para que entren al destino con el mismo costo.
        const byLot = new Map<string, { lotId: string | null; qty: number; unitCost: string }>();
        for (const l of r.lines) {
          const k = `${l.lotId ?? '-'}|${l.unitCost}`;
          const cur = byLot.get(k) ?? { lotId: l.lotId, qty: 0, unitCost: l.unitCost };
          cur.qty += -l.qty;
          byLot.set(k, cur);
        }
        await tx.insert(stockTransferItemLots).values([...byLot.values()].map((l) => ({ itemId: it.id, ...l })));
        units += q;
      }
      await tx
        .update(stockTransfers)
        .set({ status: 'ENVIADA', shippedById: actor.id, shippedAt: new Date(), reference: data.reference ?? t.reference })
        .where(eq(stockTransfers.id, id));
      await refreshAvgCost(tx, items.map((i) => i.masterSkuId));
      await this.audit.log(tx, actor, {
        action: 'ENVIAR', module: 'transferencias', entity: 'stock_transfers', entityId: id,
        summary: `Envió la transferencia ${t.folio}: ${units} pzas en tránsito${data.reference ? ` (ref. ${data.reference})` : ''}`,
        newValues: { units, reference: data.reference ?? t.reference },
      });
      return { id, status: 'ENVIADA' as const, units };
    });
  }

  /**
   * Recibe (total o parcial). Cada recepción suma a las anteriores; los lotes entran con su costo de origen.
   * Queda "Recibida" cuando llega todo lo enviado, o "Recibida con diferencias" si se cierra con faltantes.
   */
  async receive(id: string, body: unknown, actor: Actor) {
    const data = parse(transferReceiveSchema, body);
    return this.db.transaction(async (tx) => {
      const t = await this.lock(tx, id, actor);
      assertWarehouse(actor, t.destinationWarehouseId);
      if (t.status !== 'ENVIADA') throw new ConflictException('Sólo se recibe una transferencia en tránsito.');
      if (data.locationId) {
        const [loc] = await tx
          .select({ id: warehouseLocations.id })
          .from(warehouseLocations)
          .where(and(eq(warehouseLocations.id, data.locationId), eq(warehouseLocations.warehouseId, t.destinationWarehouseId)));
        if (!loc) throw rowErrors([{ path: 'locationId', message: 'La ubicación no es del almacén destino' }]);
      }
      const items = await this.items(tx, id);
      const errors: { path: string; message: string }[] = [];
      const plan: { it: Item; q: number }[] = [];
      for (const r of data.items) {
        const it = items.find((i) => i.id === r.itemId);
        if (!it) throw new BadRequestException('Renglón de otra transferencia.');
        const pending = (it.qtyShipped ?? 0) - (it.qtyReceived ?? 0);
        if (r.qty > pending) errors.push({ path: `items.${it.lineNo - 1}.qty`, message: `Sólo faltan ${pending} pzas por recibir` });
        if (r.qty > 0) plan.push({ it, q: r.qty });
      }
      if (errors.length) throw rowErrors(errors);
      if (plan.length === 0 && !data.close) throw new BadRequestException('Captura las piezas recibidas.');

      let units = 0;
      for (const { it, q } of plan.sort((a, b) => a.it.masterSkuId.localeCompare(b.it.masterSkuId))) {
        const lots = await tx.select().from(stockTransferItemLots).where(eq(stockTransferItemLots.itemId, it.id)).orderBy(asc(stockTransferItemLots.id));
        let remaining = q;
        for (const l of lots) {
          if (remaining === 0) break;
          const take = Math.min(l.qty - l.qtyReceived, remaining);
          if (take <= 0) continue;
          await postMovement(tx, {
            type: 'TRANSFER_ENTRADA',
            masterSkuId: it.masterSkuId,
            warehouseId: t.destinationWarehouseId,
            locationId: data.locationId,
            lotId: l.lotId,
            qty: take,
            unitCost: l.unitCost,
            lot: l.lotId ? undefined : { code: null, costStatus: 'PROVISIONAL' },
            document: { type: 'TRANSFERENCIA', id: t.id, folio: t.folio, line: it.lineNo },
            userId: actor.id,
            notes: data.notes,
          });
          await tx.update(stockTransferItemLots).set({ qtyReceived: l.qtyReceived + take }).where(eq(stockTransferItemLots.id, l.id));
          remaining -= take;
        }
        await tx.update(stockTransferItems).set({ qtyReceived: (it.qtyReceived ?? 0) + q }).where(eq(stockTransferItems.id, it.id));
        it.qtyReceived = (it.qtyReceived ?? 0) + q;
        units += q;
      }
      const complete = items.every((i) => (i.qtyReceived ?? 0) >= (i.qtyShipped ?? 0));
      const status = complete ? 'RECIBIDA' : data.close ? 'RECIBIDA_CON_DIFERENCIAS' : 'ENVIADA';
      if (status !== 'ENVIADA') {
        // Renglones sin recibir quedan en 0 para cerrar el tránsito.
        for (const i of items) if (i.qtyReceived === null) await tx.update(stockTransferItems).set({ qtyReceived: 0 }).where(eq(stockTransferItems.id, i.id));
        await tx.update(stockTransfers).set({ status, receivedById: actor.id, receivedAt: new Date() }).where(eq(stockTransfers.id, id));
      }
      if (units) await refreshAvgCost(tx, plan.map((p) => p.it.masterSkuId));
      const missing = items.reduce((a, i) => a + Math.max((i.qtyShipped ?? 0) - (i.qtyReceived ?? 0), 0), 0);
      await this.audit.log(tx, actor, {
        action: 'RECIBIR', module: 'transferencias', entity: 'stock_transfers', entityId: id,
        summary:
          `Recibió ${units} pzas de la transferencia ${t.folio}` +
          (status === 'RECIBIDA' ? ' (completa)' : status === 'RECIBIDA_CON_DIFERENCIAS' ? `; cerró con ${missing} pzas faltantes` : `; faltan ${missing} pzas`),
        newValues: { units, status, missing },
      });
      return { id, status, units, missing };
    });
  }

  async cancel(id: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const t = await this.lock(tx, id, actor);
      if (!['BORRADOR', 'AUTORIZADA'].includes(t.status))
        throw new ConflictException('Una transferencia enviada no se cancela: recíbela o ciérrala con diferencias.');
      const released = await closeReservations(tx, 'TRANSFERENCIA', t.id, 'LIBERADA');
      await tx.update(stockTransfers).set({ status: 'CANCELADA', cancelledAt: new Date() }).where(eq(stockTransfers.id, id));
      await this.audit.log(tx, actor, {
        action: 'CANCELAR', module: 'transferencias', entity: 'stock_transfers', entityId: id,
        summary: `Canceló la transferencia ${t.folio}${released ? ' y liberó lo apartado' : ''}`,
      });
      return { id, status: 'CANCELADA' as const };
    });
  }
}
