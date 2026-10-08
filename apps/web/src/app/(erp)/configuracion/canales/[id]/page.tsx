'use client';

import { use, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { CHANNEL_STATUS, FEE_BASE, FEE_TYPE } from '@erp/shared';
import { del, get, patch, post } from '@/lib/api';
import { fmtDate, fmtMoney, fmtRate } from '@/lib/format';
import { applyServerErrors } from '@/lib/forms';
import { Can } from '@/lib/session';
import { useOptions } from '@/components/data-table';
import { useToast } from '@/components/toast';
import { Badge, Button, Dialog, Empty, ErrorBox, Field, Input, PageHeader, Panel, Select, Spinner, StatusBadge, Textarea } from '@/components/ui';

interface Fee {
  id: string;
  name: string;
  feeType: string;
  rate: string | null;
  fixedAmount: string | null;
  base: string;
  validFrom: string;
  validTo: string | null;
  notes: string | null;
  categoryId: string | null;
  categoryName: string | null;
  masterSkuId: string | null;
  skuCode: string | null;
}
interface Channel { id: string; code: string; name: string; status: string; coverageDays: number | null }
interface FormValues { name: string; feeType: string; ratePct: string; fixedAmount: string; base: string; validFrom: string; validTo: string; categoryId: string; notes: string }

const todayMx = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());

export default function ChannelFeesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const toast = useToast();
  const channel = useQuery({ queryKey: ['/channels'], queryFn: () => get<Channel[]>('/channels'), select: (rows) => rows.find((r) => r.id === id) });
  const fees = useQuery({ queryKey: ['fees', id], queryFn: () => get<Fee[]>(`/channels/${id}/fee-rules`) });
  const cats = useOptions<{ id: string; path: string }>('/categories', (c) => c.path);
  const [dialog, setDialog] = useState<{ open: boolean; row: Fee | null }>({ open: false, row: null });
  const [msg, setMsg] = useState<string | null>(null);
  const { register, handleSubmit, reset, setError, formState } = useForm<FormValues>();

  useEffect(() => {
    if (!dialog.open) return;
    setMsg(null);
    const r = dialog.row;
    reset({
      name: r?.name ?? 'Comisión general',
      feeType: r?.feeType ?? 'COMISION',
      ratePct: r?.rate ? String(+(Number(r.rate) * 100).toFixed(4)) : '',
      fixedAmount: r?.fixedAmount ?? '',
      base: r?.base ?? 'VENTA_CON_IVA',
      validFrom: r?.validFrom ?? todayMx(),
      validTo: r?.validTo ?? '',
      categoryId: r?.categoryId ?? '',
      notes: r?.notes ?? '',
    });
  }, [dialog, reset]);

  async function onSubmit(v: FormValues) {
    const body = {
      name: v.name,
      feeType: v.feeType,
      rate: v.ratePct ? (Number(v.ratePct.replace(',', '.')) / 100).toFixed(4) : null,
      fixedAmount: v.fixedAmount || null,
      base: v.base,
      validFrom: v.validFrom,
      validTo: v.validTo || null,
      categoryId: v.categoryId || null,
      notes: v.notes || null,
    };
    try {
      if (dialog.row) await patch(`/fee-rules/${dialog.row.id}`, body);
      else await post(`/channels/${id}/fee-rules`, body);
      toast.ok('Regla guardada.');
      qc.invalidateQueries({ queryKey: ['fees', id] });
      qc.invalidateQueries({ queryKey: ['/channels'] });
      setDialog({ open: false, row: null });
    } catch (e) {
      setMsg(applyServerErrors(e, setError, { rate: 'ratePct' }));
    }
  }

  async function remove(f: Fee) {
    if (!confirm(`¿Eliminar la regla "${f.name}" (${fmtDate(f.validFrom)} – ${f.validTo ? fmtDate(f.validTo) : 'vigente'})?`)) return;
    try {
      await del(`/fee-rules/${f.id}`);
      qc.invalidateQueries({ queryKey: ['fees', id] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const today = todayMx();
  const c = channel.data;
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Configuración' }, { label: 'Canales', href: '/configuracion/canales' }, { label: c?.name ?? '' }]}
        title={`Comisiones · ${c?.name ?? ''}`}
        subtitle={c && <span className="flex items-center gap-2"><StatusBadge value={c.status} labels={CHANNEL_STATUS} /> Cobertura objetivo: {c.coverageDays ? `${c.coverageDays} días` : 'sin definir'}</span>}
        actions={<Can perm="canales.editar"><Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setDialog({ open: true, row: null })}>Nueva regla</Button></Can>}
      />
      <Panel bodyClassName="p-0">
        <p className="border-b border-line px-3 py-2 text-xs text-ink-soft">
          Cada regla tiene vigencia y base de cálculo. Para un cambio de tasa, cierra la regla actual con su fecha final y crea la nueva a partir del día siguiente; así se conserva el cálculo correcto de ventas pasadas. Las reglas de un mismo tipo y alcance no pueden traslaparse.
        </p>
        {fees.isLoading ? <Spinner /> : (fees.data ?? []).length === 0 ? <Empty>Sin reglas de comisión.</Empty> : (
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-page text-xs text-ink-soft">
                <tr>{['Regla', 'Tipo', 'Alcance', 'Tasa', 'Monto fijo', 'Base de cálculo', 'Vigencia', '', ''].map((h, i) => <th key={i} className="px-3 py-1.5 text-left whitespace-nowrap">{h}</th>)}</tr>
              </thead>
              <tbody>
                {(fees.data ?? []).map((f) => {
                  const current = f.validFrom <= today && (!f.validTo || f.validTo >= today);
                  return (
                    <tr key={f.id} className="border-t border-line align-top">
                      <td className="px-3 py-1.5">
                        <div className="font-medium">{f.name}</div>
                        {f.notes && <div className="text-xs text-ink-soft">{f.notes}</div>}
                      </td>
                      <td className="px-3 py-1.5">{FEE_TYPE[f.feeType as keyof typeof FEE_TYPE]}</td>
                      <td className="px-3 py-1.5">{f.skuCode ? `SKU ${f.skuCode}` : f.categoryName ? `Categoría ${f.categoryName}` : 'General'}</td>
                      <td className="num px-3 py-1.5">{fmtRate(f.rate)}</td>
                      <td className="num px-3 py-1.5">{fmtMoney(f.fixedAmount)}</td>
                      <td className="px-3 py-1.5">{FEE_BASE[f.base as keyof typeof FEE_BASE]}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap">{fmtDate(f.validFrom)} – {f.validTo ? fmtDate(f.validTo) : 'abierta'}</td>
                      <td className="px-3 py-1.5">{current && <Badge tone="ok">Vigente</Badge>}</td>
                      <td className="px-3 py-1.5 text-right whitespace-nowrap">
                        <Can perm="canales.editar"><Button size="sm" variant="ghost" onClick={() => setDialog({ open: true, row: f })}>Editar</Button></Can>
                        <Can perm="canales.eliminar"><Button size="sm" variant="ghost" onClick={() => remove(f)}>Eliminar</Button></Can>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Dialog
        open={dialog.open}
        onClose={() => setDialog({ open: false, row: null })}
        title={dialog.row ? 'Editar regla' : 'Nueva regla de comisión'}
        footer={
          <>
            <Button onClick={() => setDialog({ open: false, row: null })}>Cancelar</Button>
            <Button variant="primary" loading={formState.isSubmitting} onClick={handleSubmit(onSubmit)}>Guardar</Button>
          </>
        }
      >
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={handleSubmit(onSubmit)}>
          {msg && <div className="sm:col-span-2"><ErrorBox error={msg} /></div>}
          <Field label="Nombre" required error={formState.errors.name?.message}><Input {...register('name')} /></Field>
          <Field label="Tipo"><Select {...register('feeType')}>{Object.entries(FEE_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <Field label="Tasa (%)" hint="Ej. 19 para 19 %" error={formState.errors.ratePct?.message}><Input inputMode="decimal" {...register('ratePct')} className="num" /></Field>
          <Field label="Monto fijo por unidad" error={formState.errors.fixedAmount?.message}><Input inputMode="decimal" {...register('fixedAmount')} className="num" /></Field>
          <Field label="Base de cálculo" className="sm:col-span-2"><Select {...register('base')}>{Object.entries(FEE_BASE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <Field label="Vigente desde" required error={formState.errors.validFrom?.message}><Input type="date" {...register('validFrom')} /></Field>
          <Field label="Vigente hasta" hint="Vacío = sin fecha final" error={formState.errors.validTo?.message}><Input type="date" {...register('validTo')} /></Field>
          <Field label="Sólo para la categoría" className="sm:col-span-2" hint="Vacío = aplica a todo el canal">
            <Select {...register('categoryId')}>
              <option value="">— Todo el canal —</option>
              {cats.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          </Field>
          <Field label="Notas" className="sm:col-span-2"><Textarea rows={2} {...register('notes')} /></Field>
        </form>
      </Dialog>
    </>
  );
}
