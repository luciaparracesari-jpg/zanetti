import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import {
  channelListings,
  channels,
  kitComponents,
  masterSkus,
  warehouseLocations,
  warehouses,
  type Db,
} from '@erp/db';
import { assembleKits, refreshAvgCost, relocate } from '@erp/domain';
import { kitAssemblySchema, relocationSchema, type Paged } from '@erp/shared';
import { Perm } from '../auth/decorators';
import { AuditService } from '../audit/audit.service';
import { CurrentActor, type Actor } from '../common/actor';
import { InjectDb } from '../common/db';
import { likePattern, readListQuery, str } from '../common/listing';
import { parse } from '../common/zod';
import { assertWarehouse, negativeAuth, showCosts, whScope, whScopeSql } from './common';

const isUuid = (v: string | undefined) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : undefined);
const isDate = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
/** Fechas del filtro en hora de la Ciudad de México. */
const fromTs = (d: string) => `${d}T00:00:00-06:00`;
const toTs = (d: string) => `${d}T23:59:59.999-06:00`;

type Row = Record<string, unknown>;

@Controller('inventory')
export class InventoryController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /**
   * Existencias por SKU (un renglón por SKU, con desglose por almacén).
   * Filtros: q, warehouseId, brandId, categoryId, stock = CON | SIN | NEGATIVO | TODOS.
   */
  @Get('stock')
  @Perm('inventario.ver')
  async stock(@Query() query: Record<string, string>, @CurrentActor() actor: Actor) {
    const lq = readListQuery(query, actor, 'inventario');
    const costs = showCosts(actor);
    const wh = isUuid(query.warehouseId);
    if (wh) assertWarehouse(actor, wh);
    const filter = (str(query.stock) ?? 'CON').toUpperCase();

    const stConds: SQL[] = [whScopeSql(actor, sql`st.warehouse_id`)];
    if (wh) stConds.push(sql`st.warehouse_id = ${wh}::uuid`);
    // Los kits sólo aparecen cuando tienen piezas armadas (su disponible por armar está en la ficha del SKU).
    const skuConds: SQL[] = [sql`(s.is_kit = false OR EXISTS (SELECT 1 FROM inventory_balances kb WHERE kb.master_sku_id = s.id AND kb.qty <> 0))`];
    if (lq.q) {
      const p = likePattern(lq.q);
      skuConds.push(sql`(s.sku_code ILIKE ${p} OR s.name ILIKE ${p} OR p.name ILIKE ${p}
        OR EXISTS (SELECT 1 FROM sku_barcodes bc WHERE bc.master_sku_id = s.id AND bc.barcode ILIKE ${p})
        OR EXISTS (SELECT 1 FROM channel_listings cl WHERE cl.master_sku_id = s.id AND (cl.external_id ILIKE ${p} OR cl.external_sku ILIKE ${p})))`);
    }
    const brand = isUuid(query.brandId);
    if (brand) skuConds.push(sql`p.brand_id = ${brand}::uuid`);
    const cat = isUuid(query.categoryId);
    if (cat) skuConds.push(sql`p.category_id = ${cat}::uuid`);
    if (query.status) skuConds.push(sql`s.status = ${query.status}`);
    else skuConds.push(sql`s.status <> 'INACTIVO'`);

    const having =
      filter === 'SIN'
        ? sql`coalesce(sum(st.on_hand), 0) = 0 AND coalesce(sum(st.in_transit), 0) = 0`
        : filter === 'NEGATIVO'
          ? sql`bool_or(st.on_hand < 0) OR bool_or(st.available < 0)`
          : filter === 'TODOS'
            ? sql`true`
            : sql`coalesce(sum(st.on_hand), 0) <> 0 OR coalesce(sum(st.in_transit), 0) <> 0 OR coalesce(sum(st.reserved + st.committed), 0) <> 0`;

    const base = sql`
      SELECT s.id, s.sku_code, s.name, s.status, s.is_kit, p.name AS product_name, b.name AS brand_name,
             coalesce(sum(st.on_hand), 0)::int AS on_hand,
             coalesce(sum(st.blocked), 0)::int AS blocked,
             coalesce(sum(st.reserved), 0)::int AS reserved,
             coalesce(sum(st.committed), 0)::int AS committed,
             coalesce(sum(st.in_transit), 0)::int AS in_transit,
             coalesce(sum(st.available), 0)::int AS available,
             coalesce(sum(st.value), 0)::numeric(16, 2) AS value,
             coalesce(sum(st.in_transit_value), 0)::numeric(16, 2) AS in_transit_value,
             s.avg_cost,
             coalesce(json_agg(json_build_object(
               'warehouseId', st.warehouse_id, 'code', w.code, 'onHand', st.on_hand, 'available', st.available,
               'inTransit', st.in_transit, 'reserved', st.reserved + st.committed
             ) ORDER BY w.code) FILTER (WHERE st.warehouse_id IS NOT NULL), '[]') AS by_warehouse
        FROM master_skus s
        JOIN products p ON p.id = s.product_id
        LEFT JOIN brands b ON b.id = p.brand_id
        LEFT JOIN inventory_stock st ON st.master_sku_id = s.id AND ${sql.join(stConds, sql` AND `)}
        LEFT JOIN warehouses w ON w.id = st.warehouse_id
       WHERE ${sql.join(skuConds, sql` AND `)}
       GROUP BY s.id, p.name, b.name
      HAVING ${having}`;

    const SORTS: Record<string, string> = {
      skuCode: 'sku_code',
      name: 'name',
      onHand: 'on_hand',
      available: 'available',
      inTransit: 'in_transit',
      reserved: 'reserved',
      ...(costs ? { value: 'value' } : {}),
    };
    const [field, dir] = (lq.sort ?? 'skuCode:asc').split(':');
    const col = SORTS[field] ?? 'sku_code';
    const order = sql.raw(`${col} ${dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, sku_code ASC`);

    const [totals] = (
      await this.db.execute<Row>(sql`SELECT count(*)::int AS total, coalesce(sum(on_hand), 0)::int AS on_hand,
        coalesce(sum(available), 0)::int AS available, coalesce(sum(in_transit), 0)::int AS in_transit,
        coalesce(sum(reserved + committed), 0)::int AS reserved, coalesce(sum(value), 0)::numeric(16, 2) AS value,
        coalesce(sum(in_transit_value), 0)::numeric(16, 2) AS in_transit_value
        FROM (${base}) x`)
    ).rows;
    const rows = (await this.db.execute<Row>(sql`${base} ORDER BY ${order} LIMIT ${lq.pageSize} OFFSET ${(lq.page - 1) * lq.pageSize}`)).rows;

    const items = rows.map((r) => ({
      id: r.id as string,
      skuCode: r.sku_code as string,
      name: r.name as string,
      status: r.status as string,
      isKit: Boolean(r.is_kit),
      productName: r.product_name as string,
      brandName: (r.brand_name as string | null) ?? null,
      onHand: r.on_hand as number,
      blocked: r.blocked as number,
      reserved: (r.reserved as number) + (r.committed as number),
      inTransit: r.in_transit as number,
      available: r.available as number,
      byWarehouse: r.by_warehouse as { warehouseId: string; code: string; onHand: number; available: number; inTransit: number; reserved: number }[],
      ...(costs ? { value: r.value as string, avgCost: (r.avg_cost as string | null) ?? null } : {}),
    }));
    return {
      items,
      total: totals.total as number,
      page: lq.page,
      pageSize: lq.pageSize,
      totals: {
        onHand: totals.on_hand as number,
        available: totals.available as number,
        inTransit: totals.in_transit as number,
        reserved: totals.reserved as number,
        ...(costs ? { value: totals.value as string, inTransitValue: totals.in_transit_value as string } : {}),
      },
    };
  }

  /** Detalle de existencias de un SKU: por almacén, por ubicación y lote, y stock virtual por publicación. */
  @Get('stock/:skuId')
  @Perm('inventario.ver')
  async skuStock(@Param('skuId', ParseUUIDPipe) skuId: string, @CurrentActor() actor: Actor) {
    const costs = showCosts(actor);
    const [sku] = await this.db
      .select({ id: masterSkus.id, skuCode: masterSkus.skuCode, name: masterSkus.name, isKit: masterSkus.isKit, avgCost: masterSkus.avgCost, currentCost: masterSkus.currentCost })
      .from(masterSkus)
      .where(eq(masterSkus.id, skuId));
    if (!sku) throw new NotFoundException('SKU no encontrado.');

    const whRows = await this.db
      .select({ id: warehouses.id, code: warehouses.code, name: warehouses.name, type: warehouses.type, channelId: warehouses.channelId })
      .from(warehouses)
      .where(and(eq(warehouses.status, 'ACTIVO'), whScope(actor, warehouses.id)))
      .orderBy(asc(warehouses.code));

    // Kit: existencia física (kits ya armados, p. ej. bundles en FBA) + en bodega propia, los que se pueden armar
    // con los componentes disponibles: mínimo de (disponible del componente ÷ piezas por kit).
    // En almacenes del canal (FBA, FBL) el canal no arma kits: sólo cuenta lo físico.
    const components = sku.isKit
      ? await this.db
          .select({ componentId: kitComponents.componentSkuId, qty: kitComponents.quantity, skuCode: masterSkus.skuCode, name: masterSkus.name })
          .from(kitComponents)
          .innerJoin(masterSkus, eq(masterSkus.id, kitComponents.componentSkuId))
          .where(eq(kitComponents.kitSkuId, skuId))
      : [];
    const ids = [skuId, ...components.map((c) => c.componentId)];
    const stockRows = (
      await this.db.execute<Row>(sql`SELECT * FROM inventory_stock st WHERE st.master_sku_id IN (${sql.join(
        ids.map((i) => sql`${i}::uuid`),
        sql`, `,
      )}) AND ${whScopeSql(actor, sql`st.warehouse_id`)}`)
    ).rows;
    const stockKey = (s: string, w: string) => stockRows.find((r) => r.master_sku_id === s && r.warehouse_id === w);
    const assemblesHere = (type: string) => type === 'PROPIO' || type === 'OPERADOR_LOGISTICO';

    const byWarehouse = whRows.map((w) => {
      const r = stockKey(skuId, w.id);
      const assemblable =
        sku.isKit && components.length && assemblesHere(w.type)
          ? Math.min(...components.map((c) => Math.floor(Math.max(Number(stockKey(c.componentId, w.id)?.available ?? 0), 0) / c.qty)))
          : 0;
      return {
        warehouseId: w.id,
        code: w.code,
        name: w.name,
        type: w.type,
        onHand: Number(r?.on_hand ?? 0),
        blocked: Number(r?.blocked ?? 0),
        reserved: Number(r?.reserved ?? 0),
        committed: Number(r?.committed ?? 0),
        inTransit: Number(r?.in_transit ?? 0),
        /** Kits que se pueden armar con los componentes de este almacén (sólo bodega propia). */
        assemblable,
        available: Number(r?.available ?? 0) + assemblable,
        value: costs ? String(r?.value ?? '0.00') : null,
      };
    });

    const balances = (
      await this.db.execute<Row>(sql`
        SELECT b.warehouse_id, w.code AS warehouse_code, b.location_id, wl.code AS location_code, wl.type AS location_type,
               b.lot_id, l.lot_code, l.received_at, l.unit_cost, l.cost_status, b.qty
          FROM inventory_balances b
          JOIN warehouses w ON w.id = b.warehouse_id
          JOIN warehouse_locations wl ON wl.id = b.location_id
          LEFT JOIN inventory_lots l ON l.id = b.lot_id
         WHERE b.master_sku_id = ${skuId}::uuid AND b.qty <> 0 AND ${whScopeSql(actor, sql`b.warehouse_id`)}
         ORDER BY w.code, l.received_at NULLS LAST, wl.code`)
    ).rows.map((r) => ({
      warehouseId: r.warehouse_id as string,
      warehouseCode: r.warehouse_code as string,
      locationId: r.location_id as string,
      locationCode: r.location_code as string,
      locationType: r.location_type as string,
      lotId: (r.lot_id as string | null) ?? null,
      lotCode: (r.lot_code as string | null) ?? null,
      receivedAt: (r.received_at as string | null) ?? null,
      qty: r.qty as number,
      ...(costs ? { unitCost: (r.unit_cost as string | null) ?? sku.avgCost ?? null, costStatus: (r.cost_status as string | null) ?? null } : {}),
    }));

    // Stock virtual de cada publicación: disponible en su almacén ÷ unidades por publicación.
    const listings = await this.db
      .select({
        id: channelListings.id,
        channelCode: channels.code,
        channelName: channels.name,
        externalId: channelListings.externalId,
        externalSku: channelListings.externalSku,
        unitsPerListing: channelListings.unitsPerListing,
        fulfillmentModel: channelListings.fulfillmentModel,
        warehouseId: channelListings.fulfillmentWarehouseId,
        status: channelListings.status,
      })
      .from(channelListings)
      .innerJoin(channels, eq(channels.id, channelListings.channelId))
      .where(and(eq(channelListings.masterSkuId, skuId), sql`${channelListings.validTo} IS NULL`))
      .orderBy(asc(channels.sortOrder), asc(channelListings.externalId));
    const virtual = listings.map((l) => {
      const w = byWarehouse.find((x) => x.warehouseId === l.warehouseId);
      return {
        ...l,
        warehouseCode: w?.code ?? null,
        virtualStock: w ? Math.max(Math.floor(w.available / Math.max(l.unitsPerListing, 1)), 0) : null,
      };
    });

    const total = byWarehouse.reduce(
      (a, w) => ({
        onHand: a.onHand + w.onHand,
        available: a.available + w.available,
        inTransit: a.inTransit + w.inTransit,
        reserved: a.reserved + w.reserved + w.committed,
        assemblable: a.assemblable + w.assemblable,
      }),
      { onHand: 0, available: 0, inTransit: 0, reserved: 0, assemblable: 0 },
    );
    return {
      sku: { id: sku.id, skuCode: sku.skuCode, name: sku.name, isKit: sku.isKit, ...(costs ? { avgCost: sku.avgCost, currentCost: sku.currentCost } : {}) },
      total: { ...total, ...(costs ? { value: byWarehouse.reduce((a, w) => a + Number(w.value ?? 0), 0).toFixed(2) } : {}) },
      byWarehouse,
      balances,
      listings: virtual,
      components,
    };
  }

  /** Movimientos de inventario (todas las entradas y salidas), más recientes primero. */
  @Get('movements')
  @Perm('inventario.ver')
  async movements(@Query() query: Record<string, string>, @CurrentActor() actor: Actor) {
    const lq = readListQuery(query, actor, 'inventario');
    const where = this.movementFilters(query, actor, lq.q);
    const [{ total }] = (await this.db.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM inventory_movements m JOIN master_skus s ON s.id = m.master_sku_id WHERE ${where}`)).rows;
    const rows = (
      await this.db.execute<Row>(sql`
        SELECT m.id, m.occurred_at, m.type, m.master_sku_id, s.sku_code, s.name AS sku_name, m.warehouse_id, w.code AS warehouse_code,
               wl.code AS location_code, l.lot_code, m.qty, m.unit_cost, m.total_cost, m.document_type, m.document_id, m.document_folio,
               m.document_line, m.notes, u.name AS user_name, (m.negative_authorized_by_id IS NOT NULL) AS negative_authorized
          FROM inventory_movements m
          JOIN master_skus s ON s.id = m.master_sku_id
          JOIN warehouses w ON w.id = m.warehouse_id
          JOIN warehouse_locations wl ON wl.id = m.location_id
          LEFT JOIN inventory_lots l ON l.id = m.lot_id
          LEFT JOIN users u ON u.id = m.user_id
         WHERE ${where}
         ORDER BY m.occurred_at ${sql.raw(lq.sort === 'occurredAt:asc' ? 'ASC' : 'DESC')}, m.id ${sql.raw(lq.sort === 'occurredAt:asc' ? 'ASC' : 'DESC')}
         LIMIT ${lq.pageSize} OFFSET ${(lq.page - 1) * lq.pageSize}`)
    ).rows;
    return { items: rows.map((r) => this.mapMovement(r, actor)), total, page: lq.page, pageSize: lq.pageSize };
  }

  /**
   * Kardex de un SKU: saldo inicial antes de `from`, cada movimiento con su saldo acumulado
   * y saldo final. Se muestra del más reciente al más antiguo.
   */
  @Get('kardex')
  @Perm('inventario.ver')
  async kardex(@Query() query: Record<string, string>, @CurrentActor() actor: Actor) {
    const skuId = isUuid(query.skuId);
    if (!skuId) throw new BadRequestException('Indica el SKU.');
    const lq = readListQuery(query, actor, 'inventario');
    const costs = showCosts(actor);
    const wh = isUuid(query.warehouseId);
    if (wh) assertWarehouse(actor, wh);
    const from = isDate(query.from);
    const to = isDate(query.to);
    const scope: SQL[] = [sql`m.master_sku_id = ${skuId}::uuid`, whScopeSql(actor, sql`m.warehouse_id`)];
    if (wh) scope.push(sql`m.warehouse_id = ${wh}::uuid`);
    const scopeSql = sql.join(scope, sql` AND `);

    const [opening] = (
      await this.db.execute<{ qty: number; value: string }>(sql`SELECT coalesce(sum(m.qty), 0)::int AS qty, coalesce(sum(m.total_cost), 0)::numeric(16, 2) AS value
        FROM inventory_movements m WHERE ${scopeSql} ${from ? sql`AND m.occurred_at < ${fromTs(from)}::timestamptz` : sql`AND false`}`)
    ).rows;
    const range: SQL[] = [scopeSql];
    if (from) range.push(sql`m.occurred_at >= ${fromTs(from)}::timestamptz`);
    if (to) range.push(sql`m.occurred_at <= ${toTs(to)}::timestamptz`);
    const rangeSql = sql.join(range, sql` AND `);
    const [{ total, ins, outs, value }] = (
      await this.db.execute<{ total: number; ins: number; outs: number; value: string }>(sql`SELECT count(*)::int AS total,
          coalesce(sum(m.qty) FILTER (WHERE m.qty > 0), 0)::int AS ins, coalesce(-sum(m.qty) FILTER (WHERE m.qty < 0), 0)::int AS outs,
          coalesce(sum(m.total_cost), 0)::numeric(16, 2) AS value
        FROM inventory_movements m WHERE ${rangeSql}`)
    ).rows;
    const rows = (
      await this.db.execute<Row>(sql`
        SELECT * FROM (
          SELECT m.id, m.occurred_at, m.type, m.master_sku_id, s.sku_code, s.name AS sku_name, m.warehouse_id, w.code AS warehouse_code,
                 wl.code AS location_code, l.lot_code, m.qty, m.unit_cost, m.total_cost, m.document_type, m.document_id, m.document_folio,
                 m.document_line, m.notes, u.name AS user_name, (m.negative_authorized_by_id IS NOT NULL) AS negative_authorized,
                 ${opening.qty}::int + sum(m.qty) OVER (ORDER BY m.occurred_at, m.id) AS balance,
                 ${opening.value}::numeric + sum(m.total_cost) OVER (ORDER BY m.occurred_at, m.id) AS balance_value
            FROM inventory_movements m
            JOIN master_skus s ON s.id = m.master_sku_id
            JOIN warehouses w ON w.id = m.warehouse_id
            JOIN warehouse_locations wl ON wl.id = m.location_id
            LEFT JOIN inventory_lots l ON l.id = m.lot_id
            LEFT JOIN users u ON u.id = m.user_id
           WHERE ${rangeSql}
        ) k
        ORDER BY k.occurred_at DESC, k.id DESC
        LIMIT ${lq.pageSize} OFFSET ${(lq.page - 1) * lq.pageSize}`)
    ).rows;
    const closing = opening.qty + ins - outs;
    return {
      items: rows.map((r) => ({ ...this.mapMovement(r, actor), balance: Number(r.balance), ...(costs ? { balanceValue: Number(r.balance_value).toFixed(2) } : {}) })),
      total,
      page: lq.page,
      pageSize: lq.pageSize,
      summary: {
        openingQty: opening.qty,
        ins,
        outs,
        closingQty: closing,
        ...(costs ? { openingValue: opening.value, closingValue: (Number(opening.value) + Number(value)).toFixed(2) } : {}),
      },
    };
  }

  /** Lotes con su existencia actual (FIFO: los más antiguos salen primero). */
  @Get('lots')
  @Perm('inventario.ver')
  async lots(@Query() query: Record<string, string>, @CurrentActor() actor: Actor) {
    const lq = readListQuery(query, actor, 'inventario');
    const costs = showCosts(actor);
    const conds: SQL[] = [];
    const skuId = isUuid(query.skuId);
    if (skuId) conds.push(sql`l.master_sku_id = ${skuId}::uuid`);
    if (lq.q) {
      const p = likePattern(lq.q);
      conds.push(sql`(l.lot_code ILIKE ${p} OR s.sku_code ILIKE ${p} OR s.name ILIKE ${p})`);
    }
    const wh = isUuid(query.warehouseId);
    if (wh) assertWarehouse(actor, wh);
    const balScope = sql.join([whScopeSql(actor, sql`b.warehouse_id`), wh ? sql`b.warehouse_id = ${wh}::uuid` : sql`true`], sql` AND `);
    const withStock = query.withStock !== '0';
    const base = sql`
      SELECT l.id, l.lot_code, l.received_at, l.initial_qty, l.unit_cost, l.cost_status, l.source_type, l.source_id,
             s.id AS sku_id, s.sku_code, s.name AS sku_name, sup.name AS supplier_name,
             coalesce(sum(b.qty), 0)::int AS on_hand,
             coalesce(json_agg(json_build_object('code', w.code, 'location', wl.code, 'qty', b.qty) ORDER BY w.code, wl.code)
               FILTER (WHERE b.qty <> 0), '[]') AS by_location
        FROM inventory_lots l
        JOIN master_skus s ON s.id = l.master_sku_id
        LEFT JOIN suppliers sup ON sup.id = l.supplier_id
        LEFT JOIN inventory_balances b ON b.lot_id = l.id AND ${balScope}
        LEFT JOIN warehouses w ON w.id = b.warehouse_id
        LEFT JOIN warehouse_locations wl ON wl.id = b.location_id
       ${conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``}
       GROUP BY l.id, s.id, sup.name
       ${withStock ? sql`HAVING coalesce(sum(b.qty), 0) <> 0` : sql``}`;
    const [{ total }] = (await this.db.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM (${base}) x`)).rows;
    const rows = (
      await this.db.execute<Row>(sql`${base} ORDER BY s.sku_code, l.received_at, l.created_at LIMIT ${lq.pageSize} OFFSET ${(lq.page - 1) * lq.pageSize}`)
    ).rows;
    const items = rows.map((r) => ({
      id: r.id as string,
      lotCode: r.lot_code as string,
      receivedAt: r.received_at as string,
      initialQty: r.initial_qty as number,
      onHand: r.on_hand as number,
      sourceType: r.source_type as string,
      skuId: r.sku_id as string,
      skuCode: r.sku_code as string,
      skuName: r.sku_name as string,
      supplierName: (r.supplier_name as string | null) ?? null,
      byLocation: r.by_location as { code: string; location: string; qty: number }[],
      ...(costs ? { unitCost: r.unit_cost as string, costStatus: r.cost_status as string, value: (Number(r.unit_cost) * Number(r.on_hand)).toFixed(2) } : {}),
    }));
    return { items, total, page: lq.page, pageSize: lq.pageSize } satisfies Paged<unknown>;
  }

  /**
   * Código escaneado o tecleado → SKU. Acepta SKU maestro, código de barras, caja master
   * (devuelve las piezas de la caja), ASIN, artículo de Liverpool o FNSKU.
   */
  @Get('resolve')
  @Perm('inventario.ver')
  async resolve(@Query('code') raw: string | undefined) {
    const code = (raw ?? '').trim();
    if (!code) return { sku: null };
    const r = (
      await this.db.execute<Row>(sql`
        SELECT * FROM (
          SELECT s.id, s.sku_code, s.name, s.is_kit, 1 AS units, NULL::uuid AS package_id, NULL::text AS package_code, 'SKU' AS via, 1 AS prio
            FROM master_skus s WHERE upper(s.sku_code) = upper(${code})
          UNION ALL
          SELECT s.id, s.sku_code, s.name, s.is_kit, 1, NULL, NULL, 'CODIGO_BARRAS', 2
            FROM sku_barcodes b JOIN master_skus s ON s.id = b.master_sku_id WHERE b.barcode = ${code}
          UNION ALL
          SELECT s.id, s.sku_code, s.name, s.is_kit, p.units_per_package, p.id, p.code, 'CAJA', 3
            FROM sku_packages p JOIN master_skus s ON s.id = p.master_sku_id WHERE upper(p.code) = upper(${code})
          UNION ALL
          SELECT s.id, s.sku_code, s.name, s.is_kit, l.units_per_listing, NULL, NULL, 'PUBLICACION', 4
            FROM channel_listings l JOIN master_skus s ON s.id = l.master_sku_id
           WHERE l.valid_to IS NULL AND (upper(l.external_id) = upper(${code}) OR upper(l.external_sku) = upper(${code}) OR upper(l.fnsku) = upper(${code}))
        ) x ORDER BY prio LIMIT 1`)
    ).rows[0];
    if (!r) return { sku: null };
    return {
      sku: { id: r.id as string, skuCode: r.sku_code as string, name: r.name as string, isKit: Boolean(r.is_kit) },
      units: Number(r.units),
      packageId: (r.package_id as string | null) ?? null,
      packageCode: (r.package_code as string | null) ?? null,
      via: r.via as string,
    };
  }

  /** Datos para capturar renglones: existencia en el almacén, cajas master y costo promedio. */
  @Get('sku-info')
  @Perm('inventario.ver')
  async skuInfo(@Query('warehouseId') warehouseId: string | undefined, @Query('ids') idsRaw: string | undefined, @CurrentActor() actor: Actor) {
    const ids = (idsRaw ?? '').split(',').map((x) => x.trim()).filter((x) => isUuid(x)).slice(0, 500);
    if (ids.length === 0) return [];
    const wh = isUuid(warehouseId);
    if (wh) assertWarehouse(actor, wh);
    const costs = showCosts(actor);
    const idList = sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);
    const rows = (
      await this.db.execute<Row>(sql`
        SELECT s.id, s.sku_code, s.name, s.is_kit, s.avg_cost, s.current_cost,
               coalesce(st.on_hand, 0)::int AS on_hand, coalesce(st.available, 0)::int AS available,
               coalesce((SELECT json_agg(json_build_object('id', p.id, 'code', p.code, 'type', p.type, 'units', p.units_per_package) ORDER BY p.units_per_package DESC)
                           FROM sku_packages p WHERE p.master_sku_id = s.id), '[]') AS packages,
               coalesce((SELECT json_agg(json_build_object('locationId', b.location_id, 'locationCode', wl.code, 'lotId', b.lot_id, 'lotCode', l.lot_code, 'qty', b.qty) ORDER BY l.received_at NULLS LAST, wl.code)
                           FROM inventory_balances b JOIN warehouse_locations wl ON wl.id = b.location_id LEFT JOIN inventory_lots l ON l.id = b.lot_id
                          WHERE b.master_sku_id = s.id AND b.warehouse_id = ${wh ?? null}::uuid AND b.qty <> 0), '[]') AS balances
          FROM master_skus s
          LEFT JOIN inventory_stock st ON st.master_sku_id = s.id AND st.warehouse_id = ${wh ?? null}::uuid
         WHERE s.id IN (${idList})`)
    ).rows;
    return rows.map((r) => ({
      id: r.id as string,
      skuCode: r.sku_code as string,
      name: r.name as string,
      isKit: Boolean(r.is_kit),
      onHand: r.on_hand as number,
      available: r.available as number,
      packages: r.packages as { id: string; code: string; type: string; units: number }[],
      balances: r.balances as { locationId: string; locationCode: string; lotId: string | null; lotCode: string | null; qty: number }[],
      ...(costs ? { avgCost: (r.avg_cost as string | null) ?? (r.current_cost as string | null) ?? null } : {}),
    }));
  }

  /** Ubicaciones de un almacén para capturas de inventario. */
  @Get('locations')
  @Perm('inventario.ver')
  async locations(@Query('warehouseId', ParseUUIDPipe) warehouseId: string, @CurrentActor() actor: Actor) {
    assertWarehouse(actor, warehouseId);
    return this.db
      .select({ id: warehouseLocations.id, code: warehouseLocations.code, name: warehouseLocations.name, type: warehouseLocations.type })
      .from(warehouseLocations)
      .where(and(eq(warehouseLocations.warehouseId, warehouseId), eq(warehouseLocations.status, 'ACTIVO')))
      .orderBy(asc(warehouseLocations.code));
  }

  /** Almacenes activos a los que el usuario tiene acceso (filtros de inventario). */
  @Get('warehouses')
  @Perm('inventario.ver')
  warehouses(@CurrentActor() actor: Actor) {
    return this.db
      .select({ id: warehouses.id, code: warehouses.code, name: warehouses.name, type: warehouses.type, channelId: warehouses.channelId })
      .from(warehouses)
      .where(and(eq(warehouses.status, 'ACTIVO'), whScope(actor, warehouses.id)))
      .orderBy(asc(warehouses.code));
  }

  /** Reubicación dentro de un almacén (p. ej. de recepción a GEN o a cuarentena). */
  @Post('relocations')
  @Perm('transferencias.crear')
  async relocateStock(@Body() body: unknown, @CurrentActor() actor: Actor) {
    const data = parse(relocationSchema, body);
    assertWarehouse(actor, data.warehouseId);
    return this.db.transaction(async (tx) => {
      const ref = `RU-${Date.now().toString(36).toUpperCase()}`;
      const r = await relocate(tx, {
        masterSkuId: data.masterSkuId,
        warehouseId: data.warehouseId,
        fromLocationId: data.fromLocationId,
        toLocationId: data.toLocationId,
        qty: data.qty,
        lotId: data.lotId,
        document: { type: 'REUBICACION', id: ref, folio: ref },
        userId: actor.id,
        notes: data.notes,
      });
      const [s] = await tx.select({ skuCode: masterSkus.skuCode }).from(masterSkus).where(eq(masterSkus.id, data.masterSkuId));
      const locs = await tx
        .select({ id: warehouseLocations.id, code: warehouseLocations.code })
        .from(warehouseLocations)
        .where(sql`${warehouseLocations.id} IN (${data.fromLocationId}::uuid, ${data.toLocationId}::uuid)`);
      const code = (id: string) => locs.find((l) => l.id === id)?.code ?? '?';
      await this.audit.log(tx, actor, {
        action: 'REUBICAR', module: 'inventario', entity: 'inventory_movements', entityId: ref,
        summary: `Reubicó ${data.qty} pzas de ${s?.skuCode} de ${code(data.fromLocationId)} a ${code(data.toLocationId)}`,
        newValues: data,
      });
      return { folio: ref, lines: r.lines.length };
    });
  }

  /**
   * Armar o desarmar kits en un almacén. Armar: salen los componentes y entra el kit con su costo
   * (para mandar bundles a FBA o FBL). Desarmar: sale el kit y regresan los componentes.
   */
  @Post('kit-assembly')
  @Perm('transferencias.crear')
  async kitAssembly(@Body() body: unknown, @CurrentActor() actor: Actor) {
    const data = parse(kitAssemblySchema, body);
    assertWarehouse(actor, data.warehouseId);
    const negative = negativeAuth(actor, data.authorizeNegative);
    return this.db.transaction(async (tx) => {
      const ref = `AK-${Date.now().toString(36).toUpperCase()}`;
      const r = await assembleKits(tx, {
        kitId: data.kitId,
        warehouseId: data.warehouseId,
        qty: data.qty,
        mode: data.mode,
        locationId: data.locationId,
        document: { type: 'ARMADO_KIT', id: ref, folio: ref },
        userId: actor.id,
        notes: data.notes,
        negativeAuthorizedById: negative,
      });
      const [kit] = await tx.select({ skuCode: masterSkus.skuCode }).from(masterSkus).where(eq(masterSkus.id, data.kitId));
      const [wh] = await tx.select({ code: warehouses.code }).from(warehouses).where(eq(warehouses.id, data.warehouseId));
      await this.audit.log(tx, actor, {
        action: data.mode === 'ARMAR' ? 'ARMAR_KIT' : 'DESARMAR_KIT', module: 'inventario', entity: 'inventory_movements', entityId: ref,
        summary: `${data.mode === 'ARMAR' ? 'Armó' : 'Desarmó'} ${data.qty} kits ${kit?.skuCode} en ${wh?.code} (${r.components.map((c) => `${Math.abs(c.qty)} × ${c.skuCode}`).join(' + ')})`,
        newValues: { ...data, kitCost: r.kitCost },
      });
      return { folio: ref, ...r, ...(showCosts(actor) ? {} : { kitCost: null, unitCost: null, components: r.components.map((c) => ({ ...c, totalCost: null })) }) };
    });
  }

  // ───────────────────────────── utilidades ─────────────────────────────

  private movementFilters(query: Record<string, string>, actor: Actor, q?: string): SQL {
    const conds: SQL[] = [whScopeSql(actor, sql`m.warehouse_id`)];
    const skuId = isUuid(query.skuId);
    if (skuId) conds.push(sql`m.master_sku_id = ${skuId}::uuid`);
    const wh = isUuid(query.warehouseId);
    if (wh) {
      assertWarehouse(actor, wh);
      conds.push(sql`m.warehouse_id = ${wh}::uuid`);
    }
    if (query.type && /^[A-Z_]+$/.test(query.type)) conds.push(sql`m.type = ${query.type}`);
    if (query.documentType && /^[A-Z_]+$/.test(query.documentType)) conds.push(sql`m.document_type = ${query.documentType}`);
    if (query.documentId) conds.push(sql`m.document_id = ${query.documentId}`);
    if (query.direction === 'IN') conds.push(sql`m.qty > 0`);
    if (query.direction === 'OUT') conds.push(sql`m.qty < 0`);
    const from = isDate(query.from);
    if (from) conds.push(sql`m.occurred_at >= ${fromTs(from)}::timestamptz`);
    const to = isDate(query.to);
    if (to) conds.push(sql`m.occurred_at <= ${toTs(to)}::timestamptz`);
    if (q) {
      const p = likePattern(q);
      conds.push(sql`(s.sku_code ILIKE ${p} OR s.name ILIKE ${p} OR m.document_folio ILIKE ${p} OR m.notes ILIKE ${p})`);
    }
    return sql.join(conds, sql` AND `);
  }

  private mapMovement(r: Row, actor: Actor) {
    const costs = showCosts(actor);
    return {
      id: Number(r.id),
      occurredAt: r.occurred_at as string,
      type: r.type as string,
      masterSkuId: r.master_sku_id as string,
      skuCode: r.sku_code as string,
      skuName: r.sku_name as string,
      warehouseId: r.warehouse_id as string,
      warehouseCode: r.warehouse_code as string,
      locationCode: r.location_code as string,
      lotCode: (r.lot_code as string | null) ?? null,
      qty: r.qty as number,
      documentType: r.document_type as string,
      documentId: r.document_id as string,
      documentFolio: (r.document_folio as string | null) ?? null,
      documentLine: (r.document_line as number | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      userName: (r.user_name as string | null) ?? null,
      negativeAuthorized: Boolean(r.negative_authorized),
      ...(costs ? { unitCost: r.unit_cost as string, totalCost: r.total_cost as string } : {}),
    };
  }

  /** Recalcula el costo promedio de todos los SKU (mantenimiento; sólo Administrador por permiso de configuración). */
  @Post('recalculate-costs')
  @Perm('configuracion.editar', 'costos.ver')
  async recalc() {
    const ids = await this.db.select({ id: masterSkus.id }).from(masterSkus);
    await this.db.transaction((tx) => refreshAvgCost(tx, ids.map((i) => i.id)));
    return { skus: ids.length };
  }
}

