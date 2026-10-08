'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { CHANNEL_STATUS, CHANNEL_TYPE } from '@erp/shared';
import { get, patch, post } from '@/lib/api';
import { fmtRate } from '@/lib/format';
import { applyServerErrors } from '@/lib/forms';
import { Can } from '@/lib/session';
import { useToast } from '@/components/toast';
import { Button, Dialog, ErrorBox, Field, Input, PageHeader, Panel, Select, Spinner, StatusBadge } from '@/components/ui';

interface ChannelRow {
  id: string;
  code: string;
  name: string;
  type: string;
  status: string;
  coverageDays: number | null;
  sortOrder: number;
  activeListings: number;
  pendingUnmapped: number;
  warehouseCount: number;
  currentFee: string | null;
}
interface FormValues { code: string; name: string; type: string; status: string; coverageDays: string; sortOrder: string }

export default function ChannelsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['/channels'], queryFn: () => get<ChannelRow[]>('/channels') });
  const [dialog, setDialog] = useState<{ open: boolean; row: ChannelRow | null }>({ open: false, row: null });
  const [msg, setMsg] = useState<string | null>(null);
  const { register, handleSubmit, reset, setError, formState } = useForm<FormValues>();

  useEffect(() => {
    if (!dialog.open) return;
    setMsg(null);
    const r = dialog.row;
    reset({ code: r?.code ?? '', name: r?.name ?? '', type: r?.type ?? 'MARKETPLACE', status: r?.status ?? 'ACTIVO', coverageDays: r?.coverageDays?.toString() ?? '', sortOrder: r?.sortOrder?.toString() ?? '' });
  }, [dialog, reset]);

  async function onSubmit(v: FormValues) {
    const body = { ...v, coverageDays: v.coverageDays || null, sortOrder: v.sortOrder || null };
    try {
      if (dialog.row) {
        const { code: _c, ...rest } = body;
        await patch(`/channels/${dialog.row.id}`, rest);
      } else await post('/channels', body);
      toast.ok('Canal guardado.');
      qc.invalidateQueries({ queryKey: ['/channels'] });
      qc.invalidateQueries({ queryKey: ['/channels/options'] });
      setDialog({ open: false, row: null });
    } catch (e) {
      setMsg(applyServerErrors(e, setError));
    }
  }

  return (
    <>
      <PageHeader
        title="Canales y comisiones"
        subtitle="Agrega canales sin cambiar la estructura del sistema. La cobertura objetivo alimenta el reabasto por canal."
        actions={<Can perm="canales.crear"><Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setDialog({ open: true, row: null })}>Nuevo canal</Button></Can>}
      />
      <Panel bodyClassName="p-0">
        {q.isLoading ? <Spinner /> : (
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-page text-xs text-ink-soft">
                <tr>
                  {['Canal', 'Código', 'Tipo', 'Estado', 'Cobertura objetivo', 'Comisión vigente', 'Publicaciones', 'Almacenes del canal', 'Sin mapear', ''].map((h) => (
                    <th key={h} className="px-3 py-1.5 text-left whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(q.data ?? []).map((c) => (
                  <tr key={c.id} className="border-t border-line hover:bg-page">
                    <td className="px-3 py-1.5"><Link href={`/configuracion/canales/${c.id}`} className="font-medium text-brand hover:underline">{c.name}</Link></td>
                    <td className="px-3 py-1.5 font-mono text-xs">{c.code}</td>
                    <td className="px-3 py-1.5">{CHANNEL_TYPE[c.type as keyof typeof CHANNEL_TYPE]}</td>
                    <td className="px-3 py-1.5"><StatusBadge value={c.status} labels={CHANNEL_STATUS} /></td>
                    <td className="num px-3 py-1.5">{c.coverageDays ? `${c.coverageDays} días` : '—'}</td>
                    <td className="num px-3 py-1.5">{fmtRate(c.currentFee)}</td>
                    <td className="num px-3 py-1.5">{c.activeListings}</td>
                    <td className="num px-3 py-1.5">{c.warehouseCount}</td>
                    <td className="num px-3 py-1.5">{c.pendingUnmapped > 0 ? <span className="font-semibold text-warn">{c.pendingUnmapped}</span> : 0}</td>
                    <td className="px-3 py-1.5 text-right whitespace-nowrap">
                      <Link href={`/configuracion/canales/${c.id}`}><Button size="sm" variant="ghost">Comisiones</Button></Link>
                      <Can perm="canales.editar"><Button size="sm" variant="ghost" onClick={() => setDialog({ open: true, row: c })}>Editar</Button></Can>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Dialog
        open={dialog.open}
        onClose={() => setDialog({ open: false, row: null })}
        title={dialog.row ? `Editar ${dialog.row.name}` : 'Nuevo canal'}
        width="sm"
        footer={
          <>
            <Button onClick={() => setDialog({ open: false, row: null })}>Cancelar</Button>
            <Button variant="primary" loading={formState.isSubmitting} onClick={handleSubmit(onSubmit)}>Guardar</Button>
          </>
        }
      >
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={handleSubmit(onSubmit)}>
          {msg && <div className="sm:col-span-2"><ErrorBox error={msg} /></div>}
          <Field label="Código" required error={formState.errors.code?.message} hint="Ej. WALMART">
            <Input {...register('code')} disabled={Boolean(dialog.row)} className="font-mono uppercase" />
          </Field>
          <Field label="Nombre" required error={formState.errors.name?.message}><Input {...register('name')} /></Field>
          <Field label="Tipo">
            <Select {...register('type')}>{Object.entries(CHANNEL_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
          </Field>
          <Field label="Estado">
            <Select {...register('status')}>{Object.entries(CHANNEL_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
          </Field>
          <Field label="Cobertura objetivo (días)" error={formState.errors.coverageDays?.message} hint="Amazon 90, Liverpool 45">
            <Input inputMode="numeric" {...register('coverageDays')} className="num" />
          </Field>
          <Field label="Orden en listas" error={formState.errors.sortOrder?.message}>
            <Input inputMode="numeric" {...register('sortOrder')} className="num" />
          </Field>
        </form>
      </Dialog>
    </>
  );
}
