import { Controller, Get } from '@nestjs/common';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { auditLogs, channelListings, channels, masterSkus, products, unmappedCodes, warehouses, type Db } from '@erp/db';
import { Perm } from '../auth/decorators';
import { InjectDb } from '../common/db';

/**
 * Resumen de la entrega 1 (catálogo y configuración).
 * Ventas, inventario, reabasto y compras se agregan conforme llegan sus módulos.
 */
@Controller('dashboard')
export class DashboardController {
  constructor(@InjectDb() private readonly db: Db) {}

  @Get('summary')
  @Perm('dashboard.ver')
  async summary() {
    const [skuStats] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        activos: sql<number>`count(*) filter (where ${masterSkus.status} = 'ACTIVO')::int`,
        kits: sql<number>`count(*) filter (where ${masterSkus.isKit})::int`,
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

    return {
      skus: skuStats,
      productos,
      codigosSinMapear: pendientes,
      publicacionesPorCanal: porCanal,
      almacenesActivos: almacenes,
      actividadReciente: actividad,
      publicacionesVigentes: porCanal.reduce((a, c) => a + c.publicaciones, 0),
      pendientesPorEntrega: [
        { entrega: 2, indicadores: ['Inventario total', 'Valor del inventario', 'Inventario por canal'] },
        { entrega: 3, indicadores: ['Compras pendientes', 'Mercancía en tránsito'] },
        { entrega: 4, indicadores: ['Ventas del día, mes y año', 'Pedidos', 'Ticket promedio', 'Ventas por canal'] },
        { entrega: 5, indicadores: ['Stock bajo', 'Agotados', 'Sobreinventario', 'Reabasto próximo'] },
      ],
    };
  }
}

