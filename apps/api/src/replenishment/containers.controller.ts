import { BadRequestException, Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { importContainerLines, importContainers, masterSkus, suppliers, type Db } from '@erp/db';
import { postMovement, refreshAvgCost, defaultLocationId } from '@erp/domain';
import { z } from 'zod';
import { Perm } from '../auth/decorators';
import { CurrentActor, type Actor } from '../common/actor';
import { InjectDb } from '../common/db';
import { diff } from '../common/diff';
import { parse } from '../common/zod';
import { AuditService } from '../audit/audit.service';
import { ReplenishmentService } from './replenishment.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD');
const STATUS = ['PLANEADO', 'EN_PRODUCCION', 'EN_NAVIERA', 'EN_ADUANA', 'PERDIDO', 'CANCELADO'] as const;

/** Contenedores de importación: lo pedido a China que está en producción, en el mar o en aduana. */
@Controller('containers')
export class ContainersController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly svc: ReplenishmentService,
    private readonly audit: AuditService,
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
    const extra = await this.db
      .select({ id: importContainerLines.id, skuId: importContainerLines.masterSkuId, name: masterSkus.name, supplier: suppliers.name, unitCost: importContainerLines.unitCost, notes: importContainerLines.notes })
      .from(importContainerLines)
      .innerJoin(masterSkus, eq(masterSkus.id, importContainerLines.masterSkuId))
      .leftJoin(suppliers, eq(suppliers.id, importContainerLines.supplierId))
      .where(eq(importContainerLines.containerId, id));
    const byLine = new Map(extra.map((e) => [e.skuId + e.id, e]));
    return {
      ...c,
      lines: c.lines.map((l, i) => {
        const e = extra.filter((x) => x.skuId === l.skuId)[0] ?? byLine.get(l.skuId);
        return { ...l, n: i + 1, name: e?.name ?? null, supplier: e?.supplier ?? null, cbm: l.caseUnits && l.cbmCase ? (l.qty / l.caseUnits) * Number(l.cbmCase) : 0 };
      }),
    };
  }

  @Patch(':id')
  @Perm('compras.editar')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentActor() actor: Actor) {
    const data = parse(
      z.object({
        status: z.enum(STATUS).optional(),
        etd: isoDate.nullable().optional(),
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
      let pieces = 0;
      let lineNo = 0;
      for (const l of lines) {
        lineNo++;
        const q = qtyOf.has(l.id) ? qtyOf.get(l.id)! : l.qty;
        if (q <= 0) continue;
        await postMovement(tx, {
          type: 'ENTRADA_IMPORTACION',
          masterSkuId: l.masterSkuId,
          warehouseId: aplin.id,
          locationId: location,
          qty: q,
          unitCost: l.unitCost ?? 0,
          lot: { code: c.code, receivedAt, supplierId: l.supplierId, costStatus: l.unitCost ? 'FINAL' : 'PROVISIONAL' },
          document: { type: 'IMPORTACION', id: c.id, folio: c.code, line: lineNo },
          userId: actor.id,
          notes: q !== l.qty ? `Pedidas ${l.qty}, recibidas ${q}` : null,
          occurredAt: receivedAt,
          idempotencyKey: `CONT:${c.id}:${l.id}`,
        });
        pieces += q;
      }
      await refreshAvgCost(tx, lines.map((l) => l.masterSkuId));
      await tx.update(importContainers).set({ status: 'RECIBIDO', receivedAt, updatedById: actor.id }).where(eq(importContainers.id, id));
      await this.audit.log(tx, actor, { action: 'RECIBIR', module: 'recepciones', entity: 'import_containers', entityId: id, summary: `Recibió el contenedor ${c.code} en APLIN: ${pieces} piezas` });
      return { ok: true, pieces };
    });
  }
}
