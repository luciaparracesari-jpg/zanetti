'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import { RECORD_STATUS, WAREHOUSE_TYPE } from '@erp/shared';
import { patch, post } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { useSession } from '@/lib/session';
import { useOptions } from './data-table';
import { useToast } from './toast';
import { Button, Checkbox, Dialog, ErrorBox, Field, Input, Select } from './ui';

export interface WarehouseRow {
  id: string;
  code: string;
  name: string;
  type: string;
  channelId: string | null;
  channelName?: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  allowNegative: boolean;
  status: string;
  locationCount?: number;
}

type FormValues = Omit<WarehouseRow, 'id' | 'channelName' | 'locationCount' | 'channelId' | 'address' | 'city' | 'state' | 'zip'> & {
  channelId: string;
  address: string;
  city: string;
  state: string;
  zip: string;
};

export function WarehouseDialog({ open, onClose, row }: { open: boolean; onClose: () => void; row: WarehouseRow | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useSession();
  const channels = useOptions<{ id: string; name: string }>('/channels/options', (c) => c.name);
  const [msg, setMsg] = useState<string | null>(null);
  const { register, handleSubmit, reset, watch, setError, formState } = useForm<FormValues>();

  useEffect(() => {
    if (!open) return;
    setMsg(null);
    reset({
      code: row?.code ?? '',
      name: row?.name ?? '',
      type: row?.type ?? 'PROPIO',
      channelId: row?.channelId ?? '',
      address: row?.address ?? '',
      city: row?.city ?? '',
      state: row?.state ?? '',
      zip: row?.zip ?? '',
      allowNegative: row?.allowNegative ?? false,
      status: row?.status ?? 'ACTIVO',
    });
  }, [open, row, reset]);

  const type = watch('type');
  async function onSubmit(v: FormValues) {
    try {
      const body = { ...v, channelId: v.channelId || null };
      if (row) await patch(`/warehouses/${row.id}`, body);
      else await post('/warehouses', body);
      toast.ok('Almacén guardado.');
      qc.invalidateQueries({ queryKey: ['/warehouses'] });
      qc.invalidateQueries({ queryKey: ['/warehouses/options'] });
      qc.invalidateQueries({ queryKey: ['warehouse'] });
      onClose();
    } catch (e) {
      setMsg(applyServerErrors(e, setError));
    }
  }

  const err = formState.errors;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={row ? `Editar almacén ${row.code}` : 'Nuevo almacén'}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={formState.isSubmitting} onClick={handleSubmit(onSubmit)}>Guardar</Button>
        </>
      }
    >
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={handleSubmit(onSubmit)}>
        {msg && <div className="sm:col-span-2"><ErrorBox error={msg} /></div>}
        <Field label="Código" required error={err.code?.message} hint={row ? 'El código no se cambia.' : 'Ej. APLIN, AMZ-FBA'}>
          <Input {...register('code')} disabled={Boolean(row)} className="font-mono uppercase" />
        </Field>
        <Field label="Nombre" required error={err.name?.message}>
          <Input {...register('name')} />
        </Field>
        <Field label="Tipo" error={err.type?.message} hint="Fulfillment del canal: el stock vive en Amazon o Liverpool.">
          <Select {...register('type')}>
            {Object.entries(WAREHOUSE_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
        </Field>
        <Field label="Canal" required={['FULFILLMENT_CANAL', 'CONSIGNACION'].includes(type)} error={err.channelId?.message}>
          <Select {...register('channelId')}>
            <option value="">— Ninguno —</option>
            {channels.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </Select>
        </Field>
        <Field label="Dirección" className="sm:col-span-2" error={err.address?.message}>
          <Input {...register('address')} />
        </Field>
        <Field label="Ciudad"><Input {...register('city')} /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Estado"><Input {...register('state')} /></Field>
          <Field label="C.P." error={err.zip?.message}><Input {...register('zip')} /></Field>
        </div>
        <Field label="Estatus">
          <Select {...register('status')}>
            {Object.entries(RECORD_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
        </Field>
        <Field label="Inventario negativo" hint="Sólo el Administrador puede permitirlo." error={err.allowNegative?.message}>
          <div className="flex h-8 items-center">
            <Checkbox label="Permitir saldo negativo" disabled={!me.roles.includes('ADMIN')} {...register('allowNegative')} />
          </div>
        </Field>
      </form>
    </Dialog>
  );
}
