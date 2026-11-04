import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { attachmentKind, attachments, importContainers, purchaseOrders, type Db, type DbOrTx } from '@erp/db';
import { z } from 'zod';
import { can, type Actor } from '../common/actor';
import { InjectDb } from '../common/db';
import { parse } from '../common/zod';
import { AuditService } from '../audit/audit.service';

export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
export const ENTITY_TYPES = ['PURCHASE_ORDER', 'CONTAINER'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];
type Kind = (typeof attachmentKind.enumValues)[number];

/** Tipos de archivo permitidos (por extensión) y el tipo MIME con que se guardan y descargan. */
const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  xml: 'application/xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  zip: 'application/zip',
  txt: 'text/plain',
};

interface UploadedFile {
  buffer: Buffer;
  originalname: string;
  size: number;
}

/** Nombre seguro para guardar y para el encabezado de descarga. */
function cleanName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'archivo';
  const n = base.normalize('NFC').replace(/[\u0000-\u001f"<>|:*?]+/g, '_').trim();
  return (n || 'archivo').slice(0, 180);
}

@Injectable()
export class AttachmentsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** Las órdenes y los contenedores se ven y editan con los permisos de compras. */
  private assertPerm(actor: Actor, write: boolean) {
    if (!can(actor, write ? 'compras.editar' : 'compras.ver')) throw new ForbiddenException('No tienes permiso para esta acción.');
  }

  private async entityLabel(tx: DbOrTx, type: EntityType, id: string): Promise<string> {
    if (type === 'PURCHASE_ORDER') {
      const [po] = await tx.select({ folio: purchaseOrders.folio }).from(purchaseOrders).where(eq(purchaseOrders.id, id));
      if (!po) throw new NotFoundException('Orden de compra no encontrada.');
      return `la orden ${po.folio}`;
    }
    const [c] = await tx.select({ code: importContainers.code }).from(importContainers).where(eq(importContainers.id, id));
    if (!c) throw new NotFoundException('Contenedor no encontrado.');
    return `el contenedor ${c.code}`;
  }

  async list(type: string, id: string, actor: Actor) {
    this.assertPerm(actor, false);
    const t = parse(z.enum(ENTITY_TYPES), type);
    return this.db
      .select({
        id: attachments.id,
        kind: attachments.kind,
        fileName: attachments.fileName,
        mimeType: attachments.mimeType,
        sizeBytes: attachments.sizeBytes,
        notes: attachments.notes,
        createdAt: attachments.createdAt,
        createdBy: sql<string | null>`(SELECT u.name FROM users u WHERE u.id = ${attachments.createdById})`,
      })
      .from(attachments)
      .where(and(eq(attachments.entityType, t), eq(attachments.entityId, id)))
      .orderBy(desc(attachments.createdAt));
  }

  /** Guarda un archivo dentro de una transacción existente (lo usa también la carga de renglones). */
  async store(tx: DbOrTx, input: { entityType: EntityType; entityId: string; kind: Kind; file: UploadedFile; notes?: string | null }, actor: Actor) {
    const name = cleanName(input.file.originalname);
    const ext = name.toLowerCase().split('.').pop() ?? '';
    const mime = MIME[ext];
    if (!mime) throw new BadRequestException(`Tipo de archivo no permitido (.${ext}). Usa PDF, Excel, Word, CSV, XML, imagen o ZIP.`);
    if (!input.file.size || input.file.size > MAX_ATTACHMENT_BYTES) throw new BadRequestException('El archivo debe pesar menos de 15 MB.');
    const label = await this.entityLabel(tx, input.entityType, input.entityId);
    const [row] = await tx
      .insert(attachments)
      .values({
        entityType: input.entityType,
        entityId: input.entityId,
        kind: input.kind,
        fileName: name,
        mimeType: mime,
        sizeBytes: input.file.size,
        sha256: createHash('sha256').update(input.file.buffer).digest('hex'),
        data: input.file.buffer,
        notes: input.notes ?? null,
        createdById: actor.id,
      })
      .returning({ id: attachments.id, fileName: attachments.fileName, kind: attachments.kind, sizeBytes: attachments.sizeBytes });
    await this.audit.log(tx, actor, { action: 'CREAR', module: 'compras', entity: 'attachments', entityId: row.id, summary: `Adjuntó ${name} a ${label}` });
    return row;
  }

  async upload(body: unknown, file: UploadedFile | undefined, actor: Actor) {
    this.assertPerm(actor, true);
    if (!file) throw new BadRequestException('Elige el archivo.');
    const data = parse(
      z.object({
        entityType: z.enum(ENTITY_TYPES),
        entityId: z.string().uuid(),
        kind: z.enum(attachmentKind.enumValues).default('OTRO'),
        notes: z.string().trim().max(300).nullish().transform((v) => v || null),
      }),
      body,
    );
    return this.db.transaction((tx) => this.store(tx, { ...data, file }, actor));
  }

  async download(id: string, actor: Actor) {
    this.assertPerm(actor, false);
    const [a] = await this.db.select().from(attachments).where(eq(attachments.id, id));
    if (!a) throw new NotFoundException('Archivo no encontrado.');
    return a;
  }

  async remove(id: string, actor: Actor) {
    this.assertPerm(actor, true);
    return this.db.transaction(async (tx) => {
      const [a] = await tx
        .delete(attachments)
        .where(eq(attachments.id, id))
        .returning({ id: attachments.id, fileName: attachments.fileName, entityType: attachments.entityType, entityId: attachments.entityId });
      if (!a) throw new NotFoundException('Archivo no encontrado.');
      const label = await this.entityLabel(tx, a.entityType as EntityType, a.entityId).catch(() => 'un documento borrado');
      await this.audit.log(tx, actor, { action: 'ELIMINAR', module: 'compras', entity: 'attachments', entityId: id, summary: `Borró el archivo ${a.fileName} de ${label}` });
      return { ok: true };
    });
  }
}
