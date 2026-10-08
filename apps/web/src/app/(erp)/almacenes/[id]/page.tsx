'use client';

import { use, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { LOCATION_TYPE, RECORD_STATUS, WAREHOUSE_TYPE } from '@erp/shared';
import { get, patch, post } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { Can } from '@/lib/session';
import { WarehouseDialog, type WarehouseRow } from '@/components/warehouse-dialog';
import { useToast } from '@/components/toast';
import { Badge, Button, Dialog, Empty, ErrorBox, Field, Input, PageHeader, Panel, Select, Spinner, Stat, StatusBadge } from '@/components/ui';

interface Loc { id: string; code: string; name: string | null; type: string; status: string }
interface Detail extends WarehouseRow { channel: { id: string; code: string; name: string } | null; locations: Loc[] }

export default function WarehousePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['warehouse', id], queryFn: () => get<Detail>(`/warehouses/${id}`) });
  const [edit, setEdit] = useState(false);
  const [loc, setLoc] = useState<{ open: boolean; row: Loc | null }>({ open: false, row: null });
  const [msg, setMsg] = useState<string | null>(null);
  const { register, handleSubmit, reset, setError, formState } = useForm<{ code: string; name: string; type: string; status: string }>();

  useEffect(() => {
    if (loc.open) {
      reset({ code: loc.row?.code ?? '', name: loc.row?.name ?? '', type: loc.row?.type ?? 'ALMACENAJE', status: loc.row?.status ?? 'ACTIVO' });
      setMsg(null);
    }
  }, [loc, reset]);

  async function onSubmit(v: { code: string; name: string; type: string; status: string }) {
    try {
      if (loc.row) await patch(`/locations/${loc.row.id}`, { name: v.name || null, type: v.type, status: v.status });
      else await post(`/warehouses/${id}/locations`, { ...v, name: v.name || null });
      toast.ok('Ubicación guardada.');
      qc.invalidateQueries({ queryKey: ['warehouse', id] });
      setLoc({ open: false, row: null });
    } catch (e) {
      setMsg(applyServerErrors(e, setError));
    }
  }

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const w = q.data!;
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Almacenes', href: '/almacenes' }, { label: w.code }]}
        title={<span><span className="font-mono">{w.code}</span> · {w.name}</span>}
        subtitle={<span className="flex items-center gap-2"><StatusBadge value={w.status} labels={RECORD_STATUS} />{WAREHOUSE_TYPE[w.type as keyof typeof WAREHOUSE_TYPE]}{w.channel && ` · ${w.channel.name}`}</span>}
        actions={<Can perm="almacenes.editar"><Button onClick={() => setEdit(true)}>Editar almacén</Button></Can>}
      />
      <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="Ubicaciones" value={w.locations.length} />
        <Stat label="Inventario negativo" value={w.allowNegative ? 'Permitido' : 'Bloqueado'} />
        <Stat label="Dirección" value={<span className="text-sm font-normal">{[w.address, w.city, w.state, w.zip].filter(Boolean).join(', ') || '—'}</span>} />
        <Stat label="Existencias" value={<span className="text-sm font-normal text-ink-soft">Entrega 2</span>} />
      </div>
      <Panel
        title="Ubicaciones"
        bodyClassName="p-0"
        actions={<Can perm="almacenes.crear"><Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setLoc({ open: true, row: null })}>Nueva ubicación</Button></Can>}
      >
        {w.locations.length === 0 ? <Empty>Sin ubicaciones.</Empty> : (
          <table className="w-full text-sm">
            <thead className="bg-page text-xs text-ink-soft">
              <tr><th className="px-3 py-1.5 text-left">Código</th><th className="px-3 py-1.5 text-left">Nombre</th><th className="px-3 py-1.5 text-left">Tipo</th><th className="px-3 py-1.5 text-left">Estado</th><th /></tr>
            </thead>
            <tbody>
              {w.locations.map((l) => (
                <tr key={l.id} className="border-t border-line">
                  <td className="px-3 py-1.5 font-mono">{l.code}</td>
                  <td className="px-3 py-1.5">{l.name ?? '—'}</td>
                  <td className="px-3 py-1.5">
                    <Badge tone={l.type === 'CUARENTENA' || l.type === 'MERMA' ? 'warn' : 'neutral'}>{LOCATION_TYPE[l.type as keyof typeof LOCATION_TYPE]}</Badge>
                  </td>
                  <td className="px-3 py-1.5"><StatusBadge value={l.status} labels={RECORD_STATUS} /></td>
                  <td className="px-3 py-1.5 text-right"><Can perm="almacenes.editar"><Button size="sm" variant="ghost" onClick={() => setLoc({ open: true, row: l })}>Editar</Button></Can></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <WarehouseDialog open={edit} row={w} onClose={() => setEdit(false)} />
      <Dialog
        open={loc.open}
        onClose={() => setLoc({ open: false, row: null })}
        title={loc.row ? `Editar ubicación ${loc.row.code}` : 'Nueva ubicación'}
        width="sm"
        footer={
          <>
            <Button onClick={() => setLoc({ open: false, row: null })}>Cancelar</Button>
            <Button variant="primary" loading={formState.isSubmitting} onClick={handleSubmit(onSubmit)}>Guardar</Button>
          </>
        }
      >
        <form className="flex flex-col gap-3" onSubmit={handleSubmit(onSubmit)}>
          {msg && <ErrorBox error={msg} />}
          <Field label="Código" required hint="Ej. A-01-03 (pasillo-rack-nivel)" error={formState.errors.code?.message}>
            <Input {...register('code')} disabled={Boolean(loc.row)} className="font-mono uppercase" />
          </Field>
          <Field label="Nombre" error={formState.errors.name?.message}><Input {...register('name')} /></Field>
          <Field label="Tipo">
            <Select {...register('type')}>
              {Object.entries(LOCATION_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </Field>
          <Field label="Estado">
            <Select {...register('status')}>
              {Object.entries(RECORD_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </Field>
        </form>
      </Dialog>
    </>
  );
}
