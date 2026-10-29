'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { ApiError, del, get, post } from '@/lib/api';
import { Can, useSession } from '@/lib/session';
import { AsyncCombobox } from '@/components/combobox';
import { LocalTable, type LocalColumn } from '@/components/local-table';
import { useToast } from '@/components/toast';
import { Button, Dialog, ErrorBox, Field, Input, PageHeader, Spinner } from '@/components/ui';

interface Alias { id: string; code: string; multiplier: number; notes: string | null; skuId: string; skuCode: string; skuName: string }

export default function AliasesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useSession();
  const q = useQuery({ queryKey: ['/sku-aliases'], queryFn: () => get<Alias[]>('/sku-aliases') });
  const [open, setOpen] = useState(false);
  async function remove(a: Alias) {
    if (!window.confirm(`¿Borrar la equivalencia ${a.code} → ${a.skuCode}? Las ventas ya ligadas no cambian.`)) return;
    try {
      await del(`/sku-aliases/${a.id}`);
      qc.invalidateQueries({ queryKey: ['/sku-aliases'] });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'No se pudo borrar.');
    }
  }
  const cols: LocalColumn<Alias>[] = [
    { id: 'code', header: 'Código en el reporte', cell: (a) => <span className="font-mono text-xs">{a.code}</span>, value: (a) => a.code },
    { id: 'sku', header: 'SKU maestro', cell: (a) => <Link href={`/productos/skus/${a.skuId}`} className="font-mono text-xs whitespace-nowrap text-brand hover:underline">{a.skuCode}</Link>, value: (a) => a.skuCode },
    { id: 'name', header: 'Nombre', cell: (a) => <span className="text-xs">{a.skuName}</span>, value: (a) => a.skuName },
    { id: 'mult', header: 'Piezas por unidad', align: 'right', cell: (a) => a.multiplier, value: (a) => a.multiplier },
    { id: 'notes', header: 'Notas', cell: (a) => <span className="text-xs text-ink-soft">{a.notes ?? ''}</span>, value: (a) => a.notes },
    { id: 'del', header: '', cell: (a) => (can('productos.editar') ? <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => remove(a)} title="Borrar" /> : null) },
  ];
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Productos' }, { label: 'Equivalencias de códigos' }]}
        title="Equivalencias de códigos"
        subtitle="Cómo leer los códigos de los reportes que no son SKU maestro ni publicación: X002XDSCUD-26 → X002XDSCUD, un ASIN de bundle → su kit, “Bundle: 2XF13” → 2 piezas de X002XDYF13. Un código puede equivaler a varios SKU."
        actions={
          <Can perm="productos.editar">
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>Nueva equivalencia</Button>
          </Can>
        }
      />
      {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : <LocalTable rows={q.data!} columns={cols} rowKey={(a) => a.id} search={(a) => `${a.code} ${a.skuCode} ${a.skuName}`} searchPlaceholder="Buscar código o SKU…" csvName="equivalencias" />}
      {open && <NewAlias onClose={() => setOpen(false)} />}
    </>
  );
}

function NewAlias({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [skuId, setSkuId] = useState<string | null>(null);
  const [mult, setMult] = useState('1');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit() {
    setBusy(true);
    try {
      const r = await post<{ linkedSales: number }>('/sku-aliases', { code: code.trim(), masterSkuId: skuId, multiplier: Number(mult) || 1, notes: notes || null });
      toast.ok(r.linkedSales ? `Equivalencia creada; se ligaron ${r.linkedSales} ventas.` : 'Equivalencia creada.');
      qc.invalidateQueries({ queryKey: ['/sku-aliases'] });
      qc.invalidateQueries({ queryKey: ['/sales/unmapped'] });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e);
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title="Nueva equivalencia de código"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={busy} disabled={!code.trim() || !skuId} onClick={submit}>Guardar</Button>
        </>
      }
    >
      <div className="grid gap-3">
        <ErrorBox error={error} />
        <Field label="Código como viene en el reporte" required>
          <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="X002XDSCUD-26, B0CF2SQ8PR, 1129586792…" />
        </Field>
        <Field label="SKU maestro" required>
          <AsyncCombobox<{ id: string; skuCode: string; name: string }> value={skuId} onChange={(v) => setSkuId(v)} fetchPath="/skus/options" map={(s) => ({ value: s.id, label: s.skuCode, hint: s.name })} placeholder="Buscar SKU…" />
        </Field>
        <Field label="Piezas del SKU por cada unidad del código" hint="2 si el código es un paquete de dos.">
          <Input inputMode="numeric" value={mult} onChange={(e) => setMult(e.target.value.replace(/[^\d]/g, ''))} />
        </Field>
        <Field label="Notas">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
