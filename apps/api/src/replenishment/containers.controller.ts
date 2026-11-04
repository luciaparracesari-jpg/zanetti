import { BadRequestException, Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { importContainerLines, importContainers, type Db } from '@erp/db';
import { fix4, postMovement, refreshAvgCost, defaultLocationId } from '@erp/domain';
import { z } from 'zod';
import { Perm } from '../auth/decorators';
import { CurrentActor, type Actor } from '../common/actor';
import { InjectDb } from '../common/db';
import { diff } from '../common/diff';
import { parse } from '../common/zod';
import { AuditService } from '../audit/audit.service';
import { ReplenishmentService } from './replenishment.service';
import { ContainerCostingService } from '../purchasing/costing.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD');
const STATUS = ['PLANEADO', 'EN_PRODUCCION', 'EN_NAVIERA', 'EN_ADUANA', 'PERDIDO', 'CANCELADO'] as const;

/** Contenedores de importación: lo pedido a China que está en producción, en el mar o en aduana. */
@Controller('containers')
export class ContainersController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly svc: ReplenishmentService,
    private readonly audit: AuditService,
    private readonly costing: ContainerCostingService,
  ) {}

  @Get()
  @Perm('compras.ver')
  async list(@Query('status') status?: string) {
    const p = await this.svc.storedParams();
    const all = await this.svc.containers(p, status ? status.split(',') : null);
    return all
      .map(({ lines, ...c }) => ({ ...c, lineCount: lines.length }))
      .sort((a, b) => (b.eta ?? '').localeCompare(a.eta ?? '') || b.code.localeCompare(a.code));
  }

  @Get(':id')
  @Perm('compras.ver')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const p = await this.svc.storedParams();
    const [c] = (await this.svc.containers(p, null)).filter((x) => x.id === id);
    if (!c) throw new NotFoundException('Contenedor no encontrado.');
    const lines = await this.costing.lines(this.db, id, c.status === 'RECIBIDO');
    const lead = new Map(c.lines.map((l) => [l.skuId, l.lead]));
    const orderDate = new Map(c.lines.map((l) => [l.skuId, l.orderDate]));
    const { lines: _ignored, ...rest } = c;
    return {
      ...rest,
      lines: lines.map((l, i) => ({
        n: i + 1,
        id: l.id,
        skuId: l.skuId,
        skuCode: l.skuCode,
        name: l.name,
        supplier: l.supplier,
        qty: l.qty,
        qtyReceived: l.qtyReceived,
        orderDate: orderDate.get(l.skuId) ?? null,
        lead: lead.get(l.skuId) ?? null,
        caseUnits: l.caseUnits,
        cbm: l.caseUnits && l.cbm !== null && l.qtyCosted ? (l.cbm / l.qtyCosted) * l.qty : 0,
        poId: l.poId,
        poFolio: l.poFolio,
      })),
    };
  }

  @Patch(':id')
  @Perm('compras.editar')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    const data = parse(
      z.object({
        status: z.enum(STATUS).optional(),
        etd: isoDate.nullable().optional(),
        portEta: isoDate.nullable().optional(),
        etaOverride: isoDate.nullable().optional(),
        capacityCbm: z.number().positive().max(200).nullable().optional(),
        notes: z.string().trim().max(1000).nullable().optional(),
      }),
      body,
    );
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(importContainers).where(eq(importContainers.id, id));
      if (!before) throw new NotFoundException('Contenedor no encontrado.');
      if (before.status === 'RECIBIDO') throw new ConflictException('El contenedor ya se recibió.');
      const [after] = await tx
        .update(importContainers)
        .set({ ...data, capacityCbm: data.capacityCbm === undefined ? undefined : data.capacityCbm === null ? null : String(data.capacityCbm), updatedById: actor.id })
        .where(eq(importContainers.id, id))
        .returning();
      const d = diff(before, after);
      if (d.newValues) await this.audit.log(tx, actor, { action: 'EDITAR', module: 'compras', entity: 'import_containers', entityId: id, summary: `Editó el contenedor ${after.code}`, ...d });
      return after;
    });
  }

  @Delete(':id')
  @Perm('compras.eliminar')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: Actor) {
    return this.db.transaction(async (tx) => {
      const [c] = await tx.select().from(importContainers).where(eq(importContainers.id, id));
      if (!c) throw new NotFoundException('Contenedor no encontrado.');
      if (c.status !== 'PLANEADO') throw new ConflictException('Sólo se pueden borrar contenedores PLANEADOS; los demás se cancelan.');
      await tx.delete(importContainers).where(eq(importContainers.id, id));
      await this.audit.log(tx, actor, { action: 'ELIMINAR', module: 'compras', entity: 'import_containers', entityId: id, summary: `Borró el contenedor planeado ${c.code}` });
      return { ok: true };
    });
  }

  /**
   * Recibe el contenedor en APLIN: cada línea entra como lote (ENTRADA_IMPORTACION) con su costo; sin costo, el lote queda
   * PROVISIONAL. Se pueden indicar las piezas recibidas por línea si no llegó lo pedido.
   */
  @Post(':id/receive')
  @Perm('recepciones.crear')
  async receive(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    const data = parse(
      z.object({
        receivedAt: isoDate.optional(),
        lines: z.array(z.object({ lineId: z.string().uuid(), qtyReceived: z.number().int().min(0) })).optional(),
      }),
      body,
    );
    return this.db.transaction(async (tx) => {
      const [c] = await tx.select().from(importContainers).where(eq(importContainers.id, id)).for('update');
      if (!c) throw new NotFoundException('Contenedor no encontrado.');
      if (c.status === 'RECIBIDO') throw new ConflictException('El contenedor ya se recibió.');
      if (c.status === 'PLANEADO' || c.status === 'CANCELADO' || c.status === 'PERDIDO') throw new ConflictException(`Un contenedor ${c.status.toLowerCase()} no se puede recibir.`);
      const lines = await tx.select().from(importContainerLines).where(eq(importContainerLines.containerId, id));
      if (!lines.length) throw new BadRequestException('El contenedor no tiene líneas.');
      const [aplin] = (await tx.execute<{ id: string }>(sql`select id from warehouses where code = 'APLIN'`)).rows;
      if (!aplin) throw new BadRequestException('No existe el almacén APLIN.');
      const location = await defaultLocationId(tx, aplin.id);
      const qtyOf = new Map((data.lines ?? []).map((l) => [l.lineId, l.qtyReceived]));
      const receivedAt = new Date(`${data.receivedAt ?? new Date().toISOString().slice(0, 10)}T12:00:00Z`);
      const qtyBy = new Map(lines.map((l) => [l.id, qtyOf.has(l.id) ? qtyOf.get(l.id)! : l.qty]));
      // Costo de entrada: costeo cerrado (final), estimado con precios y gastos (provisional) o el capturado en el renglón.
      const costs = await this.costing.receiptCosts(tx, c, qtyBy);
      // Un lote por SKU: si el SKU viene en varios renglones (varias órdenes), entra con su costo promedio.
      const bySku = new Map<string, { qty: number; ordered: number; value: number; final: boolean; supplierId: string | null; line: number }>();
      let lineNo = 0;
      for (const l of lines) {
        lineNo++;
        const q = qtyBy.get(l.id)!;
        await tx.update(importContainerLines).set({ qtyReceived: q }).where(eq(importContainerLines.id, l.id));
        const cost = costs.get(l.id) ?? { cost: 0, final: false };
        const g = bySku.get(l.masterSkuId) ?? { qty: 0, ordered: 0, value: 0, final: true, supplierId: l.supplierId, line: lineNo };
        g.ordered += l.qty;
        if (q > 0) {
          g.qty += q;
          g.value += q * cost.cost;
          g.final = g.final && cost.final;
        }
        bySku.set(l.masterSkuId, g);
      }
      let pieces = 0;
      for (const [skuId, g] of bySku) {
        if (g.qty <= 0) continue;
        const unitCost = g.value / g.qty;
        await postMovement(tx, {
          type: 'ENTRADA_IMPORTACION',
          masterSkuId: skuId,
          warehouseId: aplin.id,
          locationId: location,
          qty: g.qty,
          unitCost: fix4(unitCost),
          lot: { code: c.code, receivedAt, supplierId: g.supplierId, costStatus: g.final && unitCost > 0 ? 'FINAL' : 'PROVISIONAL' },
          document: { type: 'IMPORTACION', id: c.id, folio: c.code, line: g.line },
          userId: actor.id,
          notes: g.qty !== g.ordered ? `Pedidas ${g.ordered}, recibidas ${g.qty}` : null,
          occurredAt: receivedAt,
          idempotencyKey: `CONT:${c.id}:${skuId}`,
        });
        pieces += g.qty;
      }
      await refreshAvgCost(tx, lines.map((l) => l.masterSkuId));
      await tx.update(importContainers).set({ status: 'RECIBIDO', receivedAt, updatedById: actor.id }).where(eq(importContainers.id, id));
      await this.audit.log(tx, actor, { action: 'RECIBIR', module: 'recepciones', entity: 'import_containers', entityId: id, summary: `Recibió el contenedor ${c.code} en APLIN: ${pieces} piezas` });
      return { ok: true, pieces };
    });
  }
}
