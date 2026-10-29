import { Controller, Get } from '@nestjs/common';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { auditLogs, channelListings, channels, masterSkus, products, unmappedCodes, warehouses, type Db } from '@erp/db';
import { Perm } from '../auth/decorators';
import { CurrentActor, type Actor } from '../common/actor';
import { InjectDb } from '../common/db';
import { showCosts, whScopeSql } from '../inventory/common';

/**
 * Resumen: catálogo (entrega 1) e inventario (entrega 2).
 * Ventas, reabasto y compras se agregan conforme llegan sus módulos.
 */
@Controller('dashboard')
export class DashboardController {
  constructor(@InjectDb() private readonly db: Db) {}

  @Get('summary')
  @Perm('dashboard.ver')
  async summary(@CurrentActor() actor: Actor) {
    const [skuStats] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        activos: sql<number>`count(*) filter (where ${masterSkus.status} = 'ACTIVO')::int`,
        kits: sql<number>`count(*) filter (where ${masterSkus.isKit})::int`,
        sinNombre: sql<number>`count(*) filter (where ${masterSkus.status} = 'ACTIVO' and upper(${masterSkus.name}) = upper(${masterSkus.skuCode}))::int`,
        sinPrecio: sql<number>`count(*) filter (where ${masterSkus.basePrice} is null and ${masterSkus.status} = 'ACTIVO')::int`,
        sinCodigo: sql<number>`count(*) filter (where ${masterSkus.status} = 'ACTIVO' and not exists (select 1 from sku_barcodes b where b.master_sku_id = "master_skus"."id"))::int`,
        sinPublicacion: sql<number>`count(*) filter (where ${masterSkus.status} = 'ACTIVO' and not exists (select 1 from channel_listings l where l.master_sku_id = "master_skus"."id" and l.valid_to is null))::int`,
      })
      .from(masterSkus);
    const [{ productos }] = await this.db.select({ productos: sql<number>`count(*)::int` }).from(products);
    const [{ pendientes }] = await this.db
      .select({ pendientes: sql<number>`count(*)::int` })
      .from(unmappedCodes)
      .where(eq(unmappedCodes.status, 'PENDIENTE'));
    const porCanal = await this.db
      .select({
        code: channels.code,
        name: channels.name,
        status: channels.status,
        publicaciones: sql<number>`count(${channelListings.id})::int`,
      })
      .from(channels)
      .leftJoin(channelListings, sql`${channelListings.channelId} = ${channels.id} and ${channelListings.validTo} is null`)
      .groupBy(channels.id)
      .orderBy(asc(channels.sortOrder));
    const [{ almacenes }] = await this.db
      .select({ almacenes: sql<number>`count(*)::int` })
      .from(warehouses)
      .where(eq(warehouses.status, 'ACTIVO'));
    const actividad = await this.db
      .select({
        id: auditLogs.id,
        occurredAt: auditLogs.occurredAt,
        userEmail: auditLogs.userEmail,
        action: auditLogs.action,
        summary: auditLogs.summary,
      })
      .from(auditLogs)
      .where(sql`${auditLogs.action} not in ('LOGIN', 'LOGOUT', 'LOGIN_FALLIDO')`)
      .orderBy(desc(auditLogs.occurredAt))
      .limit(8);

    const costs = showCosts(actor);
    const scope = whScopeSql(actor, sql`w.id`);
    const porAlmacen = (
      await this.db.execute<Record<string, unknown>>(sql`
        SELECT w.id, w.code, w.name, w.type,
               coalesce(sum(st.on_hand), 0)::int AS on_hand,
               coalesce(sum(st.available), 0)::int AS available,
               coalesce(sum(st.in_transit), 0)::int AS in_transit,
               coalesce(sum(st.reserved + st.committed), 0)::int AS reserved,
               count(st.master_sku_id) FILTER (WHERE st.on_hand > 0)::int AS skus,
               coalesce(sum(st.value), 0)::numeric(16, 2) AS value,
               coalesce(sum(st.in_transit_value), 0)::numeric(16, 2) AS in_transit_value
          FROM warehouses w
          LEFT JOIN inventory_stock st ON st.warehouse_id = w.id
         WHERE w.status = 'ACTIVO' AND ${scope}
         GROUP BY w.id
         ORDER BY w.code`)
    ).rows.map((r) => ({
      id: r.id as string,
      code: r.code as string,
      name: r.name as string,
      type: r.type as string,
      onHand: r.on_hand as number,
      available: r.available as number,
      inTransit: r.in_transit as number,
      reserved: r.reserved as number,
      skus: r.skus as number,
      ...(costs ? { value: r.value as string, inTransitValue: r.in_transit_value as string } : {}),
    }));
    const [inv] = (
      await this.db.execute<Record<string, number>>(sql`
        SELECT
          (SELECT count(*)::int FROM inventory_stock st JOIN warehouses w ON w.id = st.warehouse_id WHERE (st.on_hand < 0 OR st.available < 0) AND ${scope}) AS negativos,
          (SELECT count(*)::int FROM master_skus s WHERE s.status = 'ACTIVO' AND NOT s.is_kit
              AND NOT EXISTS (SELECT 1 FROM inventory_stock st JOIN warehouses w ON w.id = st.warehouse_id WHERE st.master_sku_id = s.id AND (st.on_hand > 0 OR st.in_transit > 0) AND ${scope})) AS sin_existencia,
          (SELECT count(*)::int FROM stock_transfers t WHERE t.status = 'ENVIADA') AS transferencias_transito,
          (SELECT count(*)::int FROM stock_transfers t WHERE t.status IN ('BORRADOR', 'AUTORIZADA')) AS transferencias_por_enviar,
          (SELECT count(*)::int FROM inventory_adjustments a WHERE a.status = 'POR_AUTORIZAR') AS ajustes_por_autorizar,
          (SELECT count(*)::int FROM inventory_counts c WHERE c.status = 'ABIERTO') AS conteos_abiertos,
          (SELECT count(*)::int FROM inventory_lots l WHERE l.cost_status = 'PROVISIONAL'
              AND EXISTS (SELECT 1 FROM inventory_balances b WHERE b.lot_id = l.id AND b.qty > 0)) AS lotes_costo_provisional`)
    ).rows;
    const inventario = {
      porAlmacen,
      piezas: porAlmacen.reduce((a, w) => a + w.onHand, 0),
      disponibles: porAlmacen.reduce((a, w) => a + w.available, 0),
      enTransito: porAlmacen.reduce((a, w) => a + w.inTransit, 0),
      ...(costs
        ? {
            valor: porAlmacen.reduce((a, w) => a + Number(w.value ?? 0), 0).toFixed(2),
            valorEnTransito: porAlmacen.reduce((a, w) => a + Number(w.inTransitValue ?? 0), 0).toFixed(2),
          }
        : {}),
      negativos: inv.negativos,
      sinExistencia: inv.sin_existencia,
      transferenciasEnTransito: inv.transferencias_transito,
      transferenciasPorEnviar: inv.transferencias_por_enviar,
      ajustesPorAutorizar: inv.ajustes_por_autorizar,
      conteosAbiertos: inv.conteos_abiertos,
      lotesCostoProvisional: inv.lotes_costo_provisional,
    };

    return {
      skus: skuStats,
      inventario,
      productos,
      codigosSinMapear: pendientes,
      publicacionesPorCanal: porCanal,
      almacenesActivos: almacenes,
      actividadReciente: actividad,
      publicacionesVigentes: porCanal.reduce((a, c) => a + c.publicaciones, 0),
      pendientesPorEntrega: [
        { entrega: 3, indicadores: ['Compras pendientes', 'Mercancía en tránsito'] },
        { entrega: 4, indicadores: ['Ventas del día, mes y año', 'Pedidos', 'Ticket promedio', 'Ventas por canal'] },
        { entrega: 5, indicadores: ['Stock bajo', 'Agotados', 'Sobreinventario', 'Reabasto próximo'] },
      ],
    };
  }
}

