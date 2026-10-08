'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { RECORD_STATUS } from '@erp/shared';
import { patch, post } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { Can, useSession } from '@/lib/session';
import { DataTable, optionsFrom, type Column } from '@/components/data-table';
import { useToast } from '@/components/toast';
import { Button, Dialog, ErrorBox, Field, Input, PageHeader, Select, StatusBadge } from '@/components/ui';

interface Supplier {
  id: string;
  code: string | null;
  name: string;
  legalName: string | null;
  taxId: string | null;
  country: string;
  currencyCode: string;
  paymentTerms: string | null;
  leadTimeDays: number | null;
  moq: number | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  skuCount: number;
}
type FormValues = Record<'code' | 'name' | 'legalName' | 'taxId' | 'country' | 'currencyCode' | 'paymentTerms' | 'leadTimeDays' | 'moq' | 'contactName' | 'email' | 'phone' | 'status', string>;

export default function SuppliersPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [dialog, setDialog] = useState<{ open: boolean; row: Supplier | null }>({ open: false, row: null });
  const [msg, setMsg] = useState<string | null>(null);
  const { register, handleSubmit, reset, setError, formState } = useForm<FormValues>();

  useEffect(() => {
    if (!dialog.open) return;
    setMsg(null);
    const r = dialog.row;
    const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
    reset({
      code: s(r?.code), name: s(r?.name), legalName: s(r?.legalName), taxId: s(r?.taxId), country: r?.country ?? 'MX',
      currencyCode: r?.currencyCode ?? 'MXN', paymentTerms: s(r?.paymentTerms), leadTimeDays: s(r?.leadTimeDays), moq: s(r?.moq),
      contactName: s(r?.contactName), email: s(r?.email), phone: s(r?.phone), status: r?.status ?? 'ACTIVO',
    });
  }, [dialog, reset]);

  async function onSubmit(v: FormValues) {
    const body = { ...v, leadTimeDays: v.leadTimeDays || null, moq: v.moq || null };
    try {
      if (dialog.row) await patch(`/suppliers/${dialog.row.id}`, body);
      else await post('/suppliers', body);
      toast.ok('Proveedor guardado.');
      qc.invalidateQueries({ queryKey: ['/suppliers'] });
      qc.invalidateQueries({ queryKey: ['/suppliers/options'] });
      setDialog({ open: false, row: null });
    } catch (e) {
      setMsg(applyServerErrors(e, setError));
    }
  }

  const columns: Column<Supplier>[] = [
    { id: 'name', header: 'Proveedor', sortKey: 'name', cell: (r) => <span className="font-medium">{r.name}</span>, csv: (r) => r.name },
    { id: 'code', header: 'Código', sortKey: 'code', cell: (r) => <span className="font-mono text-xs">{r.code ?? '—'}</span>, csv: (r) => r.code },
    { id: 'country', header: 'País', sortKey: 'country', cell: (r) => r.country, csv: (r) => r.country },
    { id: 'currency', header: 'Moneda', cell: (r) => r.currencyCode, csv: (r) => r.currencyCode },
    { id: 'lead', header: 'Lead time (d)', sortKey: 'leadTimeDays', align: 'right', cell: (r) => r.leadTimeDays ?? '—', csv: (r) => r.leadTimeDays },
    { id: 'moq', header: 'MOQ', align: 'right', cell: (r) => r.moq ?? '—', csv: (r) => r.moq },
    { id: 'terms', header: 'Condiciones de pago', cell: (r) => r.paymentTerms ?? '—', csv: (r) => r.paymentTerms, defaultHidden: true },
    { id: 'contact', header: 'Contacto', cell: (r) => [r.contactName, r.email, r.phone].filter(Boolean).join(' · ') || '—', csv: (r) => [r.contactName, r.email, r.phone].filter(Boolean).join(' · ') },
    { id: 'skus', header: 'SKU preferentes', align: 'right', cell: (r) => r.skuCount, csv: (r) => r.skuCount },
    { id: 'status', header: 'Estado', cell: (r) => <StatusBadge value={r.status} labels={RECORD_STATUS} />, csv: (r) => r.status },
    { id: 'actions', header: '', align: 'right', cell: (r) => can('proveedores.editar') && <Button size="sm" variant="ghost" onClick={() => setDialog({ open: true, row: r })}>Editar</Button> },
  ];

  const err = formState.errors;
  return (
    <>
      <PageHeader
        title="Proveedores"
        subtitle="Ficha básica. Historial de compras, productos del proveedor y calificación llegan con el módulo de compras (entrega 3)."
        actions={<Can perm="proveedores.crear"><Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setDialog({ open: true, row: null })}>Nuevo proveedor</Button></Can>}
      />
      <DataTable<Supplier>
        tableKey="suppliers"
        endpoint="/suppliers"
        columns={columns}
        rowId={(r) => r.id}
        exportPerm="proveedores.exportar"
        exportName="proveedores"
        filters={[{ key: 'status', label: 'Estado', options: optionsFrom(RECORD_STATUS) }]}
      />
      <Dialog
        open={dialog.open}
        onClose={() => setDialog({ open: false, row: null })}
        title={dialog.row ? `Editar ${dialog.row.name}` : 'Nuevo proveedor'}
        footer={<><Button onClick={() => setDialog({ open: false, row: null })}>Cancelar</Button><Button variant="primary" loading={formState.isSubmitting} onClick={handleSubmit(onSubmit)}>Guardar</Button></>}
      >
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={handleSubmit(onSubmit)}>
          {msg && <div className="sm:col-span-2"><ErrorBox error={msg} /></div>}
          <Field label="Nombre" required error={err.name?.message}><Input {...register('name')} /></Field>
          <Field label="Código" error={err.code?.message}><Input {...register('code')} className="font-mono uppercase" /></Field>
          <Field label="Razón social" error={err.legalName?.message}><Input {...register('legalName')} /></Field>
          <Field label="RFC / Tax ID" error={err.taxId?.message}><Input {...register('taxId')} /></Field>
          <Field label="País (ISO)" error={err.country?.message} hint="MX, CN, US…"><Input {...register('country')} className="uppercase" maxLength={2} /></Field>
          <Field label="Moneda">
            <Select {...register('currencyCode')}><option value="MXN">MXN</option><option value="USD">USD</option><option value="CNY">CNY</option></Select>
          </Field>
          <Field label="Lead time (días)" error={err.leadTimeDays?.message}><Input inputMode="numeric" {...register('leadTimeDays')} className="num" /></Field>
          <Field label="MOQ" error={err.moq?.message}><Input inputMode="numeric" {...register('moq')} className="num" /></Field>
          <Field label="Condiciones de pago" className="sm:col-span-2" error={err.paymentTerms?.message}><Input {...register('paymentTerms')} placeholder="Ej. 30% anticipo, 70% contra BL" /></Field>
          <Field label="Contacto"><Input {...register('contactName')} /></Field>
          <Field label="Correo" error={err.email?.message}><Input type="email" {...register('email')} /></Field>
          <Field label="Teléfono"><Input {...register('phone')} /></Field>
          <Field label="Estado"><Select {...register('status')}>{Object.entries(RECORD_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        </form>
      </Dialog>
    </>
  );
}
