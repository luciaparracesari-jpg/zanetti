import { BadGatewayException, Injectable, Logger, NotFoundException, UnprocessableEntityException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { and, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import {
  channelCatalogItems,
  channelOrderLines,
  channelOrders,
  integrationConnections,
  integrationSyncRuns,
  masterSkus,
  skuAliases,
  skuBarcodes,
  warehouses,
  type Db,
  type DbOrTx,
} from '@erp/db';
import { z } from 'zod';
import type { Actor } from '../common/actor';
import { InjectDb } from '../common/db';
import { parse } from '../common/zod';
import { AuditService } from '../audit/audit.service';
import { aplinCredentials, detectedAplinRefs } from './credentials';
import { AplinClient, AplinError } from './aplin/aplin.client';
import { classifyAplinOrder, type OrderKind } from './aplin/classify';

/** Producto de APLIN tal como lo devuelve GET /products (sólo los campos que usa el ERP). */
interface AplinProduct {
  id: number | string;
  sku: string;
  name?: string | null;
  defaultBarcode?: string | null;
  barcodes?: { value: string; isDefault?: boolean }[];
  piecesPerBox?: number | null;
  onHand?: number | null;
  available?: number | null;
  committed?: number | null;
  booked?: number | null;
  unavailable?: number | null;
}

/** Orden de APLIN (GET /orders). El comprador y la dirección no se leen ni se guardan. */
interface AplinOrder {
  id: number | string;
  orderNumber: string;
  status?: string | null;
  substatus?: string | null;
  type?: string | null;
  source?: string | null;
  price?: number | string | null;
  fulfillmentStatus?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  deleted?: boolean;
  orderLines?: {
    id: number | string;
    quantity: number;
    price?: number | string | null;
    bookedQuantity?: number | null;
    packedQuantity?: number | null;
    sku?: string | null;
    product?: { sku?: string | null } | null;
  }[];
}

const createSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{1,30}$/, 'Usa letras, números, guion o guion bajo'),
  name: z.string().trim().min(2).max(80),
  provider: z.literal('APLIN'),
  credentialsRef: z.string().trim().toUpperCase(),
});
const updateSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  status: z.enum(['ACTIVA', 'PAUSADA']).optional(),
});

const OPEN_STATUSES = new Set(['OPEN', 'PROCESSING', 'ABIERTO', 'EN PROCESO', 'EN_PROCESO']);
const int = (v: unknown) => (v === null || v === undefined || v === '' ? null : Math.round(Number(v)));
const money = (v: unknown) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v).toFixed(2));
const when = (v: string | null | undefined) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v) : null);

/**
 * Integraciones con sistemas externos. Fase 1: APLIN de sólo consulta.
 * - Las credenciales viven en variables de entorno; la base guarda sólo el prefijo.
 * - Sincronizar trae el catálogo con existencias y las órdenes (sin datos personales) a tablas espejo.
 *   No mueve el inventario del ERP: compara y avisa.
 */
@Injectable()
export class IntegrationsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Integraciones');
  private timer: NodeJS.Timeout | null = null;
  private running = new Set<string>();

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** Sincronización automática cada INTEGRATIONS_SYNC_MINUTES (apagada si no está definida). */
  onModuleInit() {
    const minutes = Number(process.env.INTEGRATIONS_SYNC_MINUTES ?? 0);
    if (minutes > 0) {
      this.timer = setInterval(() => void this.syncAll(), minutes * 60_000);
      this.log.log(`Sincronización automática cada ${minutes} min.`);
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async syncAll() {
    const conns = await this.db.select().from(integrationConnections).where(eq(integrationConnections.status, 'ACTIVA'));
    for (const c of conns) {
      if (!aplinCredentials(c.credentialsRef)) continue;
      try {
        await this.sync(c.id, null);
      } catch (e) {
        this.log.warn(`${c.code}: ${(e as Error).message}`);
      }
    }
  }

  // ───────────────────────────── Conexiones ─────────────────────────────

  async list() {
    const rows = await this.db.select().from(integrationConnections).orderBy(integrationConnections.code);
    return rows.map((c) => this.present(c));
  }

  private present(c: typeof integrationConnections.$inferSelect) {
    return {
      id: c.id,
      code: c.code,
      name: c.name,
      provider: c.provider,
      credentialsRef: c.credentialsRef,
      credentialsOk: aplinCredentials(c.credentialsRef) !== null,
      status: c.status,
      lastSyncAt: c.lastSyncAt,
      lastSyncOk: c.lastSyncOk,
      lastError: c.lastError,
    };
  }

  async get(id: string) {
    const [c] = await this.db.select().from(integrationConnections).where(eq(integrationConnections.id, id));
    if (!c) throw new NotFoundException('Conexión no encontrada.');
    return c;
  }

  credentialRefs() {
    return { aplin: detectedAplinRefs() };
  }

  async create(body: unknown, actor: Actor) {
    const data = parse(createSchema, body);
    if (!detectedAplinRefs().includes(data.credentialsRef)) {
      throw new UnprocessableEntityException(`El servidor no tiene credenciales con el prefijo ${data.credentialsRef} (${data.credentialsRef}_BASE_URL y ${data.credentialsRef}_ORG_CODE).`);
    }
    const [aplin] = await this.db.select({ id: warehouses.id }).from(warehouses).where(eq(warehouses.code, 'APLIN'));
    return this.db.transaction(async (tx) => {
      const [dup] = await tx.select({ id: integrationConnections.id }).from(integrationConnections).where(sql`upper(${integrationConnections.code}) = ${data.code}`);
      if (dup) throw new UnprocessableEntityException(`Ya existe la conexión ${data.code}.`);
      const [c] = await tx
        .insert(integrationConnections)
        .values({ ...data, warehouseId: aplin?.id ?? null, createdById: actor.id, updatedById: actor.id })
        .returning();
      await this.audit.log(tx, actor, {
        action: 'CREAR', module: 'integraciones', entity: 'integration_connections', entityId: c.id,
        summary: `Creó la conexión ${c.code} (${c.provider})`, newValues: { code: c.code, name: c.name, provider: c.provider, credentialsRef: c.credentialsRef },
      });
      return this.present(c);
    });
  }

  async update(id: string, body: unknown, actor: Actor) {
    const data = parse(updateSchema, body);
    const before = await this.get(id);
    return this.db.transaction(async (tx) => {
      const [c] = await tx.update(integrationConnections).set({ ...data, updatedById: actor.id }).where(eq(integrationConnections.id, id)).returning();
      await this.audit.log(tx, actor, {
        action: 'EDITAR', module: 'integraciones', entity: 'integration_connections', entityId: id,
        summary: `Editó la conexión ${c.code}`, oldValues: { name: before.name, status: before.status }, newValues: data,
      });
      return this.present(c);
    });
  }

  // ───────────────────────────── Sincronización ─────────────────────────────

  async sync(id: string, actor: Actor | null) {
    const c = await this.get(id);
    if (c.provider !== 'APLIN') throw new UnprocessableEntityException('Por ahora sólo se sincroniza APLIN.');
    const creds = aplinCredentials(c.credentialsRef);
    if (!creds) throw new UnprocessableEntityException(`Faltan ${c.credentialsRef}_BASE_URL o ${c.credentialsRef}_ORG_CODE en el servidor.`);
    if (this.running.has(id)) throw new UnprocessableEntityException('Ya hay una sincronización en curso.');
    this.running.add(id);
    const client = new AplinClient(creds);
    const result: Record<string, unknown> = {};
    try {
      result.productos = await this.run(c.id, 'productos', actor, () => this.syncProducts(c.id, client));
      result.ordenes = await this.run(c.id, 'ordenes', actor, () => this.syncOrders(c.id, client));
      await this.db.update(integrationConnections).set({ lastSyncAt: new Date(), lastSyncOk: true, lastError: null }).where(eq(integrationConnections.id, id));
      if (actor) {
        await this.audit.log(this.db, actor, {
          action: 'SINCRONIZAR', module: 'integraciones', entity: 'integration_connections', entityId: id,
          summary: `Sincronizó ${c.code}`, newValues: result,
        });
      }
      return result;
    } catch (e) {
      const msg = e instanceof AplinError ? e.message : `Error al sincronizar: ${(e as Error).message}`;
      await this.db.update(integrationConnections).set({ lastSyncAt: new Date(), lastSyncOk: false, lastError: msg }).where(eq(integrationConnections.id, id));
      if (e instanceof AplinError) throw new BadGatewayException(msg);
      throw e;
    } finally {
      this.running.delete(id);
    }
  }

  private async run<T extends Record<string, unknown>>(connectionId: string, resource: string, actor: Actor | null, fn: () => Promise<T>): Promise<T> {
    const [r] = await this.db.insert(integrationSyncRuns).values({ connectionId, resource, triggeredById: actor?.id ?? null }).returning({ id: integrationSyncRuns.id });
    try {
      const stats = await fn();
      await this.db.update(integrationSyncRuns).set({ status: 'OK', finishedAt: new Date(), stats }).where(eq(integrationSyncRuns.id, r.id));
      return stats;
    } catch (e) {
      await this.db.update(integrationSyncRuns).set({ status: 'ERROR', finishedAt: new Date(), error: (e as Error).message }).where(eq(integrationSyncRuns.id, r.id));
      throw e;
    }
  }

  /** Liga un SKU externo con el SKU maestro: SKU igual → equivalencia de una sola pieza → código de barras. */
  private async matcher(db: DbOrTx) {
    const skus = await db.select({ id: masterSkus.id, code: masterSkus.skuCode }).from(masterSkus);
    const byCode = new Map(skus.map((s) => [s.code.toUpperCase(), s.id]));
    const aliases = await db.select({ code: skuAliases.code, skuId: skuAliases.masterSkuId, mult: skuAliases.multiplier }).from(skuAliases);
    const byAlias = new Map<string, { skuId: string; mult: number }[]>();
    for (const a of aliases) byAlias.set(a.code.toUpperCase(), [...(byAlias.get(a.code.toUpperCase()) ?? []), { skuId: a.skuId, mult: a.mult }]);
    const codes = await db.select({ barcode: skuBarcodes.barcode, skuId: skuBarcodes.masterSkuId }).from(skuBarcodes);
    const byBarcode = new Map(codes.map((b) => [b.barcode, b.skuId]));
    return (sku: string | null | undefined, barcode?: string | null): { skuId: string; by: string } | null => {
      const k = (sku ?? '').trim().toUpperCase();
      if (k && byCode.has(k)) return { skuId: byCode.get(k)!, by: 'SKU' };
      const al = k ? byAlias.get(k) : undefined;
      if (al && al.length === 1 && al[0].mult === 1) return { skuId: al[0].skuId, by: 'EQUIVALENCIA' };
      const bc = (barcode ?? '').trim();
      if (bc && byBarcode.has(bc)) return { skuId: byBarcode.get(bc)!, by: 'CODIGO_BARRAS' };
      return null;
    };
  }

  private async syncProducts(connectionId: string, client: AplinClient) {
    const products = await client.all<AplinProduct>('/products', {});
    const match = await this.matcher(this.db);
    let matched = 0;
    await this.db.transaction(async (tx) => {
      const now = new Date();
      for (const p of products) {
        const barcode = p.defaultBarcode ?? p.barcodes?.find((b) => b.isDefault)?.value ?? p.barcodes?.[0]?.value ?? null;
        const m = match(p.sku, barcode);
        if (m) matched++;
        const values = {
          connectionId,
          externalId: String(p.id),
          externalSku: String(p.sku ?? ''),
          name: p.name ?? null,
          barcode,
          piecesPerBox: int(p.piecesPerBox),
          masterSkuId: m?.skuId ?? null,
          matchedBy: m?.by ?? null,
          onHand: int(p.onHand),
          available: int(p.available),
          committed: int(p.committed),
          booked: int(p.booked),
          unavailable: int(p.unavailable),
          syncedAt: now,
        };
        await tx
          .insert(channelCatalogItems)
          .values(values)
          .onConflictDoUpdate({ target: [channelCatalogItems.connectionId, channelCatalogItems.externalId], set: values });
      }
      // Lo que ya no existe en APLIN sale del espejo.
      const ids = products.map((p) => String(p.id));
      await tx
        .delete(channelCatalogItems)
        .where(and(eq(channelCatalogItems.connectionId, connectionId), ids.length ? notInArray(channelCatalogItems.externalId, ids) : undefined));
    });
    return { productos: products.length, ligados: matched, sinLigar: products.length - matched };
  }

  private async syncOrders(connectionId: string, client: AplinClient) {
    const orders = (await client.all<AplinOrder>('/orders', {})).filter((o) => !o.deleted);
    const match = await this.matcher(this.db);
    const byKind: Partial<Record<OrderKind, number>> = {};
    let lines = 0;
    await this.db.transaction(async (tx) => {
      const now = new Date();
      for (const o of orders) {
        const kind = classifyAplinOrder(o.orderNumber ?? '');
        byKind[kind] = (byKind[kind] ?? 0) + 1;
        const ls = o.orderLines ?? [];
        const values = {
          connectionId,
          externalId: String(o.id),
          orderNumber: String(o.orderNumber ?? ''),
          kind,
          type: o.type ?? null,
          status: o.status ?? null,
          substatus: o.substatus ?? null,
          source: o.source ?? null,
          stockOk: o.fulfillmentStatus ? o.fulfillmentStatus.toUpperCase() === 'OK' : null,
          pieces: ls.reduce((a, l) => a + (Number(l.quantity) || 0), 0),
          total: money(o.price),
          externalCreatedAt: when(o.createdAt),
          externalUpdatedAt: when(o.updatedAt),
          syncedAt: now,
        };
        const [row] = await tx
          .insert(channelOrders)
          .values(values)
          .onConflictDoUpdate({ target: [channelOrders.connectionId, channelOrders.externalId], set: values })
          .returning({ id: channelOrders.id });
        await tx.delete(channelOrderLines).where(eq(channelOrderLines.orderId, row.id));
        if (ls.length) {
          await tx.insert(channelOrderLines).values(
            ls.map((l) => {
              const sku = String(l.product?.sku ?? l.sku ?? '');
              return {
                orderId: row.id,
                externalLineId: String(l.id),
                externalSku: sku,
                masterSkuId: match(sku)?.skuId ?? null,
                quantity: Number(l.quantity) || 0,
                bookedQuantity: int(l.bookedQuantity),
                packedQuantity: int(l.packedQuantity),
                price: money(l.price),
              };
            }),
          );
          lines += ls.length;
        }
      }
    });
    return { ordenes: orders.length, lineas: lines, porTipo: byKind };
  }

  // ───────────────────────────── Consultas ─────────────────────────────

  async runs(id: string) {
    await this.get(id);
    return this.db.select().from(integrationSyncRuns).where(eq(integrationSyncRuns.connectionId, id)).orderBy(desc(integrationSyncRuns.startedAt)).limit(50);
  }

  /**
   * Existencia de APLIN contra la del ERP, por SKU. APLIN es la fuente de verdad del inventario físico;
   * la diferencia es lo que habría que ajustar en el ERP (no se ajusta solo).
   */
  async stock(id: string) {
    const c = await this.get(id);
    const rows = await this.db.execute<{
      sku_id: string | null; sku_code: string | null; sku_name: string | null; sku_status: string | null;
      external_sku: string | null; external_name: string | null; matched_by: string | null;
      aplin_on_hand: number | null; aplin_available: number | null; aplin_committed: number | null; aplin_booked: number | null; aplin_unavailable: number | null;
      erp_on_hand: number | null; erp_available: number | null; synced_at: string | null;
    }>(sql`
      with a as (
        select master_sku_id, string_agg(external_sku, ', ') external_sku, max(name) external_name, max(matched_by) matched_by,
               sum(on_hand)::int on_hand, sum(available)::int available, sum(committed)::int committed, sum(booked)::int booked,
               sum(unavailable)::int unavailable, max(synced_at) synced_at
          from channel_catalog_items where connection_id = ${id}::uuid and master_sku_id is not null group by master_sku_id
        union all
        select null, external_sku, name, null, on_hand, available, committed, booked, unavailable, synced_at
          from channel_catalog_items where connection_id = ${id}::uuid and master_sku_id is null
      ),
      e as (select master_sku_id, on_hand, available from inventory_stock where warehouse_id = ${c.warehouseId}::uuid)
      select coalesce(a.master_sku_id, e.master_sku_id) sku_id, s.sku_code, s.name sku_name, s.status sku_status,
             a.external_sku, a.external_name, a.matched_by,
             a.on_hand aplin_on_hand, a.available aplin_available, a.committed aplin_committed, a.booked aplin_booked, a.unavailable aplin_unavailable,
             e.on_hand erp_on_hand, e.available erp_available, a.synced_at
        from a full join e on e.master_sku_id = a.master_sku_id
        left join master_skus s on s.id = coalesce(a.master_sku_id, e.master_sku_id)
       where a.external_sku is not null or coalesce(e.on_hand, 0) <> 0
       order by s.sku_code nulls first, a.external_sku`);
    const items = rows.rows.map((r) => {
      const aplin = r.aplin_on_hand;
      const erp = r.erp_on_hand ?? 0;
      return {
        skuId: r.sku_id,
        skuCode: r.sku_code,
        skuName: r.sku_name ?? r.external_name,
        skuStatus: r.sku_status,
        externalSku: r.external_sku,
        matchedBy: r.matched_by,
        aplinOnHand: aplin,
        aplinAvailable: r.aplin_available,
        aplinCommitted: r.aplin_committed,
        aplinBooked: r.aplin_booked,
        aplinUnavailable: r.aplin_unavailable,
        erpOnHand: r.erp_on_hand,
        erpAvailable: r.erp_available,
        /** APLIN − ERP (físico). Nulo si APLIN no reporta el SKU. */
        difference: aplin === null ? null : aplin - erp,
        state: !r.sku_id ? 'SIN_LIGAR' : r.external_sku === null ? 'NO_ESTA_EN_APLIN' : aplin === erp ? 'CUADRA' : 'DIFERENCIA',
      };
    });
    return {
      syncedAt: await this.lastRunAt(id, 'productos'),
      totals: {
        skus: items.length,
        cuadran: items.filter((r) => r.state === 'CUADRA').length,
        conDiferencia: items.filter((r) => r.state === 'DIFERENCIA').length,
        sinLigar: items.filter((r) => r.state === 'SIN_LIGAR').length,
        noEstanEnAplin: items.filter((r) => r.state === 'NO_ESTA_EN_APLIN').length,
        aplinOnHand: items.reduce((a, r) => a + (r.aplinOnHand ?? 0), 0),
        erpOnHand: items.reduce((a, r) => a + (r.erpOnHand ?? 0), 0),
      },
      items,
    };
  }

  private async lastRunAt(id: string, resource: string) {
    const [r] = await this.db
      .select({ at: integrationSyncRuns.finishedAt })
      .from(integrationSyncRuns)
      .where(and(eq(integrationSyncRuns.connectionId, id), eq(integrationSyncRuns.resource, resource), eq(integrationSyncRuns.status, 'OK')))
      .orderBy(desc(integrationSyncRuns.finishedAt))
      .limit(1);
    return r?.at ? r.at.toISOString() : null;
  }

  /** Órdenes clasificadas con sus líneas; `alert=1` deja sólo las abiertas sin existencia para surtir. */
  async orders(id: string, q: { kind?: string; alert?: string; q?: string; limit?: string }) {
    await this.get(id);
    const kinds = (q.kind ?? '').split(',').filter(Boolean) as OrderKind[];
    const limit = Math.min(Math.max(Number(q.limit) || 300, 1), 2000);
    const term = (q.q ?? '').trim();
    const rows = await this.db
      .select()
      .from(channelOrders)
      .where(
        and(
          eq(channelOrders.connectionId, id),
          kinds.length ? inArray(channelOrders.kind, kinds) : undefined,
          q.alert === '1' ? sql`${channelOrders.stockOk} = false and upper(coalesce(${channelOrders.status}, '')) in ('OPEN', 'PROCESSING', 'ABIERTO', 'EN PROCESO', 'EN_PROCESO')` : undefined,
          term ? sql`${channelOrders.orderNumber} ilike ${`%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`}` : undefined,
        ),
      )
      .orderBy(desc(channelOrders.externalCreatedAt))
      .limit(limit);
    const lines = rows.length
      ? await this.db
          .select({ orderId: channelOrderLines.orderId, sku: channelOrderLines.externalSku, skuCode: masterSkus.skuCode, quantity: channelOrderLines.quantity, price: channelOrderLines.price })
          .from(channelOrderLines)
          .leftJoin(masterSkus, eq(masterSkus.id, channelOrderLines.masterSkuId))
          .where(inArray(channelOrderLines.orderId, rows.map((r) => r.id)))
      : [];
    return rows.map((o) => ({
      ...o,
      open: OPEN_STATUSES.has((o.status ?? '').toUpperCase()),
      lines: lines.filter((l) => l.orderId === o.id).map(({ orderId: _o, ...l }) => l),
    }));
  }

  /** Resumen: órdenes por tipo, envíos detenidos por falta de existencia y ventas Vendor recientes (señal de faltante en FBL). */
  async summary(id: string) {
    await this.get(id);
    const byKind = await this.db.execute<{ kind: OrderKind; orders: number; pieces: number; open: number; blocked: number }>(sql`
      select kind, count(*)::int orders, coalesce(sum(pieces), 0)::int pieces,
             count(*) filter (where upper(coalesce(status, '')) in ('OPEN', 'PROCESSING', 'ABIERTO', 'EN PROCESO', 'EN_PROCESO'))::int open,
             count(*) filter (where stock_ok = false and upper(coalesce(status, '')) in ('OPEN', 'PROCESSING', 'ABIERTO', 'EN PROCESO', 'EN_PROCESO'))::int blocked
        from channel_orders where connection_id = ${id}::uuid group by kind order by kind`);
    const vendor = await this.db.execute<{ sku_code: string | null; external_sku: string; orders: number; pieces: number; last: string }>(sql`
      select s.sku_code, l.external_sku, count(distinct o.id)::int orders, sum(l.quantity)::int pieces, max(o.external_created_at) last
        from channel_orders o join channel_order_lines l on l.order_id = o.id left join master_skus s on s.id = l.master_sku_id
       where o.connection_id = ${id}::uuid and o.kind = 'LIVERPOOL_VENDOR' and o.external_created_at >= now() - interval '30 days'
       group by 1, 2 order by 4 desc`);
    return {
      byKind: byKind.rows,
      vendorLast30: vendor.rows.map((r) => ({ skuCode: r.sku_code, externalSku: r.external_sku, orders: r.orders, pieces: r.pieces, last: r.last })),
    };
  }
}
