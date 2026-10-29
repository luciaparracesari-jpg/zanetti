import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  inventoryCountLines,
  inventoryCounts,
  masterSkus,
  skuBarcodes,
  skuPackages,
  users,
  warehouseLocations,
  warehouses,
  type Db,
  type Tx,
} from '@erp/db';
import { defaultLocationId, nextFolio, postMovement, refreshAvgCost } from '@erp/domain';
import { countAddLineSchema, countCaptureSchema, countCloseSchema, countCreateSchema } from '@erp/shared';
import { AuditService } from '../audit/audit.service';
import { can, type Actor } from '../common/actor';
import { InjectDb } from '../common/db';
import { countSql, likePattern, readListQuery } from '../common/listing';
import { parse } from '../common/zod';
import { assertWarehouse, negativeAuth, rowErrors, showCosts, skusById, whScope } from './common';

/**
 * Conteos físicos. Al abrir se toma la foto de la existencia ("congelada") por SKU y ubicación;
 * al cerrar se ajusta la diferencia contado − foto, así los movimientos que ocurran mientras
 * se cuenta no se pierden.
 */
@Injectable()
export class CountsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async list(query: Record<string, string>, actor: Actor) {
    const lq = readListQuery(query, actor, 'transferencias');
    const conds: SQL[] = [];
    const scope = whScope(actor, inventoryCounts.warehouseId);
    if (scope) conds.push(scope);
    if (query.status) conds.push(sql`${inventoryCounts.status} = ${query.status}`);
    if (lq.q) conds.push(sql`(${inventoryCounts.folio} ILIKE ${likePattern(lq.q)} OR ${inventoryCounts.notes} ILIKE ${likePattern(lq.q)})`);
    const where = conds.length ? and(...conds) : undefined;
    const [{ total }] = await this.db.select({ total: countSql }).from(inventoryCounts).where(where);
    const agg = (expr: string) => sql<number>`(select ${sql.raw(expr)} from inventory_count_lines l where l.count_id = "inventory_counts"."id")`;
    const items = await this.db
      .select({
        id: inventoryCounts.id,
        folio: inventoryCounts.folio,
        status: inventoryCounts.status,
        blind: inventoryCounts.blind,
        warehouseCode: warehouses.code,
        locationCode: warehouseLocations.code,
        notes: inventoryCounts.notes,
        frozenAt: inventoryCounts.frozenAt,
        closedAt: inventoryCounts.closedAt,
        createdByName: users.name,
        lines: agg('count(*)::int'),
        counted: agg('count(counted_qty)::int'),
        differences: agg('count(*) filter (where counted_qty is not null and counted_qty <> system_qty)::int'),
      })
      .from(inventoryCounts)
      .innerJoin(warehouses, eq(warehouses.id, inventoryCounts.warehouseId))
      .leftJoin(warehouseLocations, eq(warehouseLocations.id, inventoryCounts.locationId))
      .leftJoin(users, eq(users.id, inventoryCounts.createdById))
      .where(where)
      .orderBy(desc(inventoryCounts.createdAt))
      .limit(lq.pageSize)
      .offset((lq.page - 1) * lq.pageSize);
    return { items, total, page: lq.page, pageSize: lq.pageSize };
  }

  /** En un conteo ciego abierto sólo ve la existencia del sistema quien puede autorizar ajustes. */
  private seesSystem(actor: Actor, c: { blind: boolean; status: string }) {
    return !c.blind || c.status !== 'ABIERTO' || can(actor, 'ajustes.autorizar');
  }

  async get(id: string, actor: Actor) {
    const [h] = await this.db
      .select({ c: inventoryCounts, warehouseCode: warehouses.code, warehouseName: warehouses.name, locationCode: warehouseLocations.code })
      .from(inventoryCounts)
      .innerJoin(warehouses, eq(warehouses.id, inventoryCounts.warehouseId))
      .leftJoin(warehouseLocations, eq(warehouseLocations.id, inventoryCounts.locationId))
      .where(eq(inventoryCounts.id, id));
    if (!h) throw new NotFoundException('Conteo no encontrado.');
    assertWarehouse(actor, h.c.warehouseId);
    const sees = this.seesSystem(actor, h.c);
    const costs = showCosts(actor);
    const lines = await this.db
      .select({
        id: inventoryCountLines.id,
        masterSkuId: inventoryCountLines.masterSkuId,
        skuCode: masterSkus.skuCode,
        skuName: masterSkus.name,
        avgCost: masterSkus.avgCost,
        locationId: inventoryCountLines.locationId,
        locationCode: warehouseLocations.code,
        systemQty: inventoryCountLines.systemQty,
        countedQty: inventoryCountLines.countedQty,
        countedAt: inventoryCountLines.countedAt,
        countedByName: users.name,
      })
      .from(inventoryCountLines)
      .innerJoin(masterSkus, eq(masterSkus.id, inventoryCountLines.masterSkuId))
      .innerJoin(warehouseLocations, eq(warehouseLocations.id, inventoryCountLines.locationId))
      .leftJoin(users, eq(users.id, inventoryCountLines.countedById))
      .where(eq(inventoryCountLines.countId, id))
      .orderBy(asc(warehouseLocations.code), asc(masterSkus.skuCode));
    const names = await this.db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, [h.c.createdById, h.c.closedById].filter((x): x is string => Boolean(x)).concat(['00000000-0000-0000-0000-000000000000'])));
    const name = (uid: string | null) => names.find((n) => n.id === uid)?.name ?? null;
    return {
      ...h.c,
      warehouseCode: h.warehouseCode,
      warehouseName: h.warehouseName,
      locationCode: h.locationCode,
      createdByName: name(h.c.createdById),
      closedByName: name(h.c.closedById),
      showsSystem: sees,
      lines: lines.map((l) => ({
        ...l,
        systemQty: sees ? l.systemQty : null,
        difference: sees && l.countedQty !== null ? l.countedQty - l.systemQty : null,
        avgCost: costs ? l.avgCost : null,
      })),
    };
  }

  /** Abre un conteo y congela la existencia actual por SKU y ubicación. */
  async create(body: unknown, actor: Actor) {
    const data = parse(countCreateSchema, body);
    assertWarehouse(actor, data.warehouseId);
    return this.db.transaction(async (tx) => {
      const [wh] = await tx.select().from(warehouses).where(eq(warehouses.id, data.warehouseId));
      if (!wh) throw new NotFoundException('Almacén no encontrado.');
      if (wh.status !== 'ACTIVO') throw new ConflictException(`El almacén ${wh.code} está inactivo.`);
      let locCode: string | null = null;
      if (data.locationId) {
        const [loc] = await tx
          .select()
          .from(warehouseLocations)
          .where(and(eq(warehouseLocations.id, data.locationId), eq(warehouseLocations.warehouseId, wh.id)));
        if (!loc) throw rowErrors([{ path: 'locationId', message: 'La ubicación no es de este almacén' }]);
        locCode = loc.code;
      }
      const open = await tx
        .select({ folio: inventoryCounts.folio })
        .from(inventoryCounts)
        .where(
          and(
            eq(inventoryCounts.warehouseId, wh.id),
            eq(inventoryCounts.status, 'ABIERTO'),
            data.locationId ? sql`(${inventoryCounts.locationId} IS NULL OR ${inventoryCounts.locationId} = ${data.locationId}::uuid)` : sql`true`,
          ),
        );
      if (open.length) throw new ConflictException(`Ya hay un conteo abierto que cubre esa zona (${open.map((o) => o.folio).join(', ')}). Ciérralo o cancélalo primero.`);
      if (data.skuIds.length) {
        const skus = await skusById(tx, data.skuIds);
        const bad = data.skuIds.filter((s) => !skus.get(s) || skus.get(s)!.isKit);
        if (bad.length) throw rowErrors([{ path: 'skuIds', message: 'Hay SKU que no existen o son kits' }]);
      }

      const folio = await nextFolio(tx, 'CF');
      const [c] = await tx
        .insert(inventoryCounts)
        .values({ folio, warehouseId: wh.id, locationId: data.locationId, blind: data.blind, notes: data.notes, createdById: actor.id, frozenAt: sql`clock_timestamp()` })
        .returning();
      const snapshot = await tx.execute<{ master_sku_id: string; location_id: string; qty: number }>(sql`
        SELECT b.master_sku_id, b.location_id, sum(b.qty)::int AS qty
          FROM inventory_balances b
         WHERE b.warehouse_id = ${wh.id}::uuid
           ${data.locationId ? sql`AND b.location_id = ${data.locationId}::uuid` : sql``}
           ${data.skuIds.length ? sql`AND b.master_sku_id IN (${sql.join(data.skuIds.map((s) => sql`${s}::uuid`), sql`, `)})` : sql``}
         GROUP BY b.master_sku_id, b.location_id
        HAVING sum(b.qty) <> 0`);
      const rows = snapshot.rows.map((r) => ({ countId: c.id, masterSkuId: r.master_sku_id, locationId: r.location_id, systemQty: r.qty }));
      // Conteo cíclico de SKU sin existencia: se cuentan en la ubicación indicada o en la general.
      const covered = new Set(rows.map((r) => r.masterSkuId));
      const missing = data.skuIds.filter((s) => !covered.has(s));
      if (missing.length) {
        const loc = data.locationId ?? (await defaultLocationId(tx, wh.id));
        rows.push(...missing.map((s) => ({ countId: c.id, masterSkuId: s, locationId: loc, systemQty: 0 })));
      }
      if (rows.length) {
        for (let i = 0; i < rows.length; i += 1000) await tx.insert(inventoryCountLines).values(rows.slice(i, i + 1000));
      }
      await this.audit.log(tx, actor, {
        action: 'CREAR', module: 'transferencias', entity: 'inventory_counts', entityId: c.id,
        summary: `Abrió el conteo ${folio} en ${wh.code}${locCode ? `/${locCode}` : ''} (${rows.length} renglones${data.blind ? ', ciego' : ''})`,
        newValues: { warehouseId: wh.id, locationId: data.locationId, blind: data.blind, lines: rows.length },
      });
      return { id: c.id, folio, lines: rows.length };
    });
  }

  private async lock(tx: Tx, id: string, actor: Actor) {
    const [c] = await tx.select().from(inventoryCounts).where(eq(inventoryCounts.id, id)).for('update');
    if (!c) throw new NotFoundException('Conteo no encontrado.');
    assertWarehouse(actor, c.warehouseId);
    return c;
  }

  async capture(id: string, body: unknown, actor: Actor) {
    const data = parse(countCaptureSchema, body);
    return this.db.transaction(async (tx) => {
      const c = await this.lock(tx, id, actor);
      if (c.status !== 'ABIERTO') throw new ConflictException('El conteo ya está cerrado.');
      const ids = data.lines.map((l) => l.lineId);
      const own = await tx
        .select({ id: inventoryCountLines.id })
        .from(inventoryCountLines)
        .where(and(eq(inventoryCountLines.countId, id), inArray(inventoryCountLines.id, ids)));
      if (own.length !== new Set(ids).size) throw new BadRequestException('Hay renglones que no son de este conteo.');
      const now = new Date();
      for (const l of data.lines) {
        await tx
          .update(inventoryCountLines)
          .set(l.countedQty === null ? { countedQty: null, countedById: null, countedAt: null } : { countedQty: l.countedQty, countedById: actor.id, countedAt: now })
          .where(eq(inventoryCountLines.id, l.lineId));
      }
      return { saved: data.lines.length };
    });
  }

  /** Agrega un SKU encontrado en el almacén que no estaba en la foto (su existencia congelada se calcula a la fecha del conteo). */
  async addLine(id: string, body: unknown, actor: Actor) {
    const data = parse(countAddLineSchema, body);
    return this.db.transaction(async (tx) => {
      const c = await this.lock(tx, id, actor);
      if (c.status !== 'ABIERTO') throw new ConflictException('El conteo ya está cerrado.');
      if (c.locationId && c.locationId !== data.locationId) throw rowErrors([{ path: 'locationId', message: 'Este conteo es de otra ubicación' }]);
      const [loc] = await tx
        .select({ id: warehouseLocations.id })
        .from(warehouseLocations)
        .where(and(eq(warehouseLocations.id, data.locationId), eq(warehouseLocations.warehouseId, c.warehouseId)));
      if (!loc) throw rowErrors([{ path: 'locationId', message: 'La ubicación no es de este almacén' }]);
      const sku = (await skusById(tx, [data.masterSkuId])).get(data.masterSkuId);
      if (!sku) throw rowErrors([{ path: 'masterSkuId', message: 'SKU no encontrado' }]);
      if (sku.isKit) throw rowErrors([{ path: 'masterSkuId', message: 'Un kit no se cuenta; cuenta sus componentes' }]);
      const [asOf] = (
        await tx.execute<{ qty: number }>(sql`SELECT coalesce(sum(qty), 0)::int AS qty FROM inventory_movements
          WHERE master_sku_id = ${data.masterSkuId}::uuid AND warehouse_id = ${c.warehouseId}::uuid AND location_id = ${data.locationId}::uuid
            AND occurred_at <= ${c.frozenAt.toISOString()}::timestamptz`)
      ).rows;
      const [line] = await tx
        .insert(inventoryCountLines)
        .values({
          countId: id,
          masterSkuId: data.masterSkuId,
          locationId: data.locationId,
          systemQty: asOf.qty,
          ...(data.countedQty !== null ? { countedQty: data.countedQty, countedById: actor.id, countedAt: new Date() } : {}),
        })
        .returning({ id: inventoryCountLines.id });
      return { id: line.id };
    });
  }

  /** Busca por código escaneado (SKU, código de barras o caja master) los renglones del conteo. */
  async resolve(id: string, code: string, actor: Actor) {
    const [c] = await this.db.select().from(inventoryCounts).where(eq(inventoryCounts.id, id));
    if (!c) throw new NotFoundException('Conteo no encontrado.');
    assertWarehouse(actor, c.warehouseId);
    const clean = code.trim().toUpperCase();
    if (!clean) return { sku: null, units: 1, lineIds: [] };
    let sku = (await this.db.select({ id: masterSkus.id, skuCode: masterSkus.skuCode, name: masterSkus.name }).from(masterSkus).where(sql`upper(${masterSkus.skuCode}) = ${clean}`))[0];
    let units = 1;
    if (!sku) {
      const [b] = await this.db
        .select({ id: masterSkus.id, skuCode: masterSkus.skuCode, name: masterSkus.name })
        .from(skuBarcodes)
        .innerJoin(masterSkus, eq(masterSkus.id, skuBarcodes.masterSkuId))
        .where(eq(skuBarcodes.barcode, clean));
      sku = b;
    }
    if (!sku) {
      const [p] = await this.db
        .select({ id: masterSkus.id, skuCode: masterSkus.skuCode, name: masterSkus.name, units: skuPackages.unitsPerPackage })
        .from(skuPackages)
        .innerJoin(masterSkus, eq(masterSkus.id, skuPackages.masterSkuId))
        .where(sql`upper(${skuPackages.code}) = ${clean}`);
      if (p) {
        sku = { id: p.id, skuCode: p.skuCode, name: p.name };
        units = p.units;
      }
    }
    if (!sku) return { sku: null, units: 1, lineIds: [] };
    const lines = await this.db
      .select({ id: inventoryCountLines.id })
      .from(inventoryCountLines)
      .where(and(eq(inventoryCountLines.countId, id), eq(inventoryCountLines.masterSkuId, sku.id)));
    return { sku, units, lineIds: lines.map((l) => l.id) };
  }

  /** Cierra el conteo: ajusta cada diferencia (contado − existencia congelada) con un movimiento CONTEO_AJUSTE. */
  async close(id: string, body: unknown, actor: Actor) {
    const data = parse(countCloseSchema, body ?? {});
    const negative = negativeAuth(actor, data.authorizeNegative);
    return this.db.transaction(async (tx) => {
      const c = await this.lock(tx, id, actor);
      if (c.status !== 'ABIERTO') throw new ConflictException('El conteo ya está cerrado.');
      const lines = await tx.select().from(inventoryCountLines).where(eq(inventoryCountLines.countId, id));
      const pending = lines.filter((l) => l.countedQty === null);
      if (pending.length && !data.uncountedAsZero && pending.length === lines.length)
        throw new BadRequestException('No hay renglones capturados.');
      const skus = await skusById(tx, lines.map((l) => l.masterSkuId));
      let plus = 0;
      let minus = 0;
      let value = 0;
      let adjusted = 0;
      const ordered = [...lines].sort((a, b) => a.masterSkuId.localeCompare(b.masterSkuId));
      for (const [n, l] of ordered.entries()) {
        const counted = l.countedQty ?? (data.uncountedAsZero ? 0 : null);
        if (counted === null) continue;
        if (l.countedQty === null) await tx.update(inventoryCountLines).set({ countedQty: 0, countedById: actor.id, countedAt: new Date() }).where(eq(inventoryCountLines.id, l.id));
        const diff = counted - l.systemQty;
        if (diff === 0) continue;
        const s = skus.get(l.masterSkuId);
        const cost = s?.avgCost ?? s?.currentCost ?? null;
        const r = await postMovement(tx, {
          type: 'CONTEO_AJUSTE',
          masterSkuId: l.masterSkuId,
          warehouseId: c.warehouseId,
          locationId: l.locationId,
          qty: diff,
          unitCost: diff > 0 ? cost : null,
          lot: diff > 0 ? { code: null, costStatus: cost === null ? 'PROVISIONAL' : 'FINAL' } : undefined,
          document: { type: 'CONTEO', id: c.id, folio: c.folio, line: n + 1 },
          userId: actor.id,
          notes: `Conteo ${c.folio}: sistema ${l.systemQty}, contado ${counted}`,
          idempotencyKey: `CF:${c.id}:${l.id}`,
          negativeAuthorizedById: negative,
        });
        adjusted++;
        if (diff > 0) plus += diff;
        else minus += -diff;
        value += Number(r.totalCost);
      }
      await refreshAvgCost(tx, lines.map((l) => l.masterSkuId));
      await tx.update(inventoryCounts).set({ status: 'CERRADO', closedById: actor.id, closedAt: new Date() }).where(eq(inventoryCounts.id, id));
      const summary = { lines: lines.length, adjusted, unitsPlus: plus, unitsMinus: minus, value: value.toFixed(2), uncounted: data.uncountedAsZero ? 0 : pending.length };
      await this.audit.log(tx, actor, {
        action: 'CERRAR', module: 'transferencias', entity: 'inventory_counts', entityId: id,
        summary: `Cerró el conteo ${c.folio}: ${adjusted} diferencias (+${plus} / −${minus} pzas)`,
        newValues: summary,
      });
      return { id, status: 'CERRADO' as const, ...summary, ...(showCosts(actor) ? {} : { value: null }) };
    });
  }

  async cancel(id: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const c = await this.lock(tx, id, actor);
      if (c.status !== 'ABIERTO') throw new ConflictException('Sólo se cancela un conteo abierto.');
      await tx.update(inventoryCounts).set({ status: 'CANCELADO' }).where(eq(inventoryCounts.id, id));
      await this.audit.log(tx, actor, {
        action: 'CANCELAR', module: 'transferencias', entity: 'inventory_counts', entityId: id,
        summary: `Canceló el conteo ${c.folio} (sin ajustes)`,
      });
      return { id, status: 'CANCELADO' as const };
    });
  }
}

