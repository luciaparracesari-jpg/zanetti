'use client';

import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Eye, Paperclip, Trash2, Upload } from 'lucide-react';
import { api, del, get } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { ATTACHMENT_KIND, fmtSize, type AttachmentRow } from '@/lib/purchasing';
import { useSession } from '@/lib/session';
import { useToast } from './toast';
import { Button, Empty, ErrorBox, Field, Input, Panel, Select, Spinner } from './ui';

/** Archivos de una orden de compra o de un contenedor: subir, ver, descargar y borrar. */
export function Attachments({ entityType, entityId, kinds }: { entityType: 'PURCHASE_ORDER' | 'CONTAINER'; entityId: string; kinds: string[] }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['/attachments', entityType, entityId];
  const q = useQuery({ queryKey: key, queryFn: () => get<AttachmentRow[]>(`/attachments?entityType=${entityType}&entityId=${entityId}`) });
  const [kind, setKind] = useState(kinds[0]);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const input = useRef<HTMLInputElement>(null);
  const editable = can('compras.editar');

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const f of Array.from(files)) {
        const fd = new FormData();
        fd.append('entityType', entityType);
        fd.append('entityId', entityId);
        fd.append('kind', kind);
        if (notes) fd.append('notes', notes);
        fd.append('file', f);
        await api('/attachments', { method: 'POST', body: fd });
      }
      toast.ok(files.length === 1 ? 'Archivo guardado.' : `${files.length} archivos guardados.`);
      setNotes('');
      qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  async function remove(a: AttachmentRow) {
    if (!window.confirm(`¿Borrar ${a.fileName}?`)) return;
    try {
      await del(`/attachments/${a.id}`);
      qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      setError(e);
    }
  }

  return (
    <Panel title={<span className="flex items-center gap-1.5"><Paperclip className="h-4 w-4" /> Archivos</span>}>
      <ErrorBox error={error} />
      {editable && (
        <div className="mb-3 grid items-end gap-2 md:grid-cols-[12rem_1fr_auto]">
          <Field label="Tipo de documento">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {kinds.map((k) => <option key={k} value={k}>{ATTACHMENT_KIND[k]}</option>)}
            </Select>
          </Field>
          <Field label="Nota (opcional)">
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ej. factura del flete marítimo" />
          </Field>
          <div>
            <input ref={input} type="file" multiple className="hidden" accept=".pdf,.xlsx,.xls,.csv,.docx,.doc,.xml,.png,.jpg,.jpeg,.webp,.zip,.txt" onChange={(e) => upload(e.target.files)} />
            <Button icon={<Upload className="h-4 w-4" />} loading={busy} onClick={() => input.current?.click()}>Subir archivo</Button>
          </div>
        </div>
      )}
      {q.isLoading ? (
        <Spinner />
      ) : !q.data?.length ? (
        <Empty>Sin archivos. Sube PDF, Excel, Word, XML o imágenes de hasta 15 MB.</Empty>
      ) : (
        <ul className="divide-y divide-line">
          {q.data.map((a) => {
            const href = `/api/v1/attachments/${a.id}/file`;
            const viewable = a.mimeType === 'application/pdf' || a.mimeType.startsWith('image/');
            return (
              <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="font-medium break-all">{a.fileName}</span>
                  <span className="ml-2 text-xs text-ink-soft">{ATTACHMENT_KIND[a.kind] ?? a.kind} · {fmtSize(a.sizeBytes)} · {fmtDateTime(a.createdAt)}{a.createdBy ? ` · ${a.createdBy}` : ''}</span>
                  {a.notes && <span className="block text-xs text-ink-soft">{a.notes}</span>}
                </span>
                <span className="flex gap-1">
                  {viewable && <a href={`${href}?inline=1`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-brand hover:bg-brand-soft"><Eye className="h-3.5 w-3.5" /> Ver</a>}
                  <a href={href} className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-brand hover:bg-brand-soft"><Download className="h-3.5 w-3.5" /> Descargar</a>
                  {editable && <button onClick={() => remove(a)} className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-bad hover:bg-bad-soft"><Trash2 className="h-3.5 w-3.5" /> Borrar</button>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
