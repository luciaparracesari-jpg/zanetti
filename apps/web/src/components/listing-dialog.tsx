'use client';

import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FULFILLMENT_MODEL, LISTING_STATUS } from '@erp/shared';
import { get, patch, post } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { AsyncCombobox } from './combobox';
import { useToast } from './toast';
import { Button, Dialog, ErrorBox, Field, Input, Select } from './ui';

export interface ListingRow {
  id: string;
  channelId: string;
  channelName?: string;
  masterSkuId?: string;
  skuCode?: string;
  externalId: string;
  externalSku: string;
  fnsku: string | null;
  unitsPerListing: number;
  title: string | null;
  price: string | null;
  fulfillmentModel: string;
  fulfillmentWarehouseId?: string | null;
  status: string;
}

interface WarehouseOpt {
  id: string;
  code: string;
  name: string;
  type: string;
  channelId: string | null;
}
interface ChannelOpt {
  id: string;
  code: string;
  name: string;
  status: string;
}

interface FormValues {
  channelId: string;
  masterSkuId: string | null;
  externalId: string;
  externalSku: string;
  fnsku: string;
  unitsPerListing: string;
  title: string;
  price: string;
  fulfillmentModel: string;
  fulfillmentWarehouseId: string;
  status: string;
}

/** Ayuda contextual del código externo según el canal. */
const EXTERNAL_HINT: Record<string, { id: string; sku: string }> = {
  AMAZON: { id: 'ASIN (B0…)', sku: 'SKU de vendedor en Amazon (seller SKU)' },
  LIVERPOOL: { id: 'Número de artículo Liverpool', sku: 'SKU Liverpool / código del catálogo' },
  SHOPIFY: { id: 'Variant ID', sku: 'SKU de la variante en Shopify' },
  MERCADO_LIBRE: { id: 'ID de publicación (MLM…)', sku: 'SKU de vendedor' },
};

export function ListingDialog({
  open,
  onClose,
  listing,
  fixedSku,
}: {
  open: boolean;
  onClose: () => void;
  listing?: ListingRow | null;
  fixedSku?: { id: string; skuCode: string; name: string } | null;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const editing = Boolean(listing);
  const [msg, setMsg] = useState<string | null>(null);
  const channels = useQuery({ queryKey: ['/channels/options'], queryFn: () => get<ChannelOpt[]>('/channels/options'), staleTime: 60_000 });
  const warehouses = useQuery({ queryKey: ['/warehouses/options'], queryFn: () => get<WarehouseOpt[]>('/warehouses/options'), staleTime: 60_000 });
  const { register, handleSubmit, reset, watch, setError, control, setValue, formState } = useForm<FormValues>();

  useEffect(() => {
    if (!open) return;
    setMsg(null);
    reset({
      channelId: listing?.channelId ?? '',
      masterSkuId: listing?.masterSkuId ?? fixedSku?.id ?? null,
      externalId: listing?.externalId ?? '',
      externalSku: listing?.externalSku ?? '',
      fnsku: listing?.fnsku ?? '',
      unitsPerListing: String(listing?.unitsPerListing ?? 1),
      title: listing?.title ?? '',
      price: listing?.price ?? '',
      fulfillmentModel: listing?.fulfillmentModel ?? 'BODEGA_PROPIA',
      fulfillmentWarehouseId: listing?.fulfillmentWarehouseId ?? '',
      status: listing?.status ?? 'ACTIVA',
    });
  }, [open, listing, fixedSku, reset]);

  const channelId = watch('channelId');
  const model = watch('fulfillmentModel');
  const channel = channels.data?.find((c) => c.id === channelId);
  const hint = channel ? EXTERNAL_HINT[channel.code] : undefined;

  const whOptions = useMemo(
    () =>
      (warehouses.data ?? []).filter((w) =>
        model === 'FULFILLMENT_CANAL' ? w.type === 'FULFILLMENT_CANAL' && w.channelId === channelId : ['PROPIO', 'OPERADOR_LOGISTICO'].includes(w.type),
      ),
    [warehouses.data, model, channelId],
  );
  // Si sólo hay un almacén posible, se preselecciona.
  useEffect(() => {
    if (!open || editing) return;
    if (whOptions.length === 1) setValue('fulfillmentWarehouseId', whOptions[0].id);
    else if (!whOptions.some((w) => w.id === watch('fulfillmentWarehouseId'))) setValue('fulfillmentWarehouseId', '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whOptions, open, editing]);

  async function onSubmit(v: FormValues) {
    setMsg(null);
    const common = {
      externalId: v.externalId,
      externalSku: v.externalSku,
      fnsku: v.fnsku || null,
      unitsPerListing: Number(v.unitsPerListing || 1),
      title: v.title || null,
      price: v.price || null,
      fulfillmentModel: v.fulfillmentModel,
      fulfillmentWarehouseId: v.fulfillmentWarehouseId || null,
      status: v.status,
    };
    try {
      if (editing) await patch(`/listings/${listing!.id}`, common);
      else await post('/listings', { ...common, channelId: v.channelId, masterSkuId: v.masterSkuId });
      toast.ok(editing ? 'Publicación actualizada.' : 'Publicación ligada al SKU.');
      qc.invalidateQueries({ queryKey: ['/listings'] });
      qc.invalidateQueries({ queryKey: ['sku'] });
      qc.invalidateQueries({ queryKey: ['/skus'] });
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
      title={editing ? `Editar publicación ${listing!.externalId}` : 'Nueva publicación'}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={formState.isSubmitting} onClick={handleSubmit(onSubmit)}>
            Guardar
          </Button>
        </>
      }
    >
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={handleSubmit(onSubmit)}>
        {msg && <div className="sm:col-span-2"><ErrorBox error={msg} /></div>}
        <Field label="Canal" required error={err.channelId?.message}>
          <Select {...register('channelId')} disabled={editing}>
            <option value="">Selecciona…</option>
            {(channels.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.status === 'PAUSADO' ? ' (en pausa)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="SKU maestro" required error={err.masterSkuId?.message}>
          {fixedSku || editing ? (
            <Input value={fixedSku ? `${fixedSku.skuCode} · ${fixedSku.name}` : listing?.skuCode ?? ''} disabled />
          ) : (
            <Controller
              control={control}
              name="masterSkuId"
              render={({ field }) => (
                <AsyncCombobox<{ id: string; skuCode: string; name: string; isKit: boolean }>
                  value={field.value}
                  onChange={(v) => field.onChange(v)}
                  fetchPath="/skus/options"
                  map={(s) => ({ value: s.id, label: s.skuCode, hint: `${s.name}${s.isKit ? ' · kit' : ''}` })}
                  placeholder="Buscar SKU…"
                  invalid={Boolean(err.masterSkuId)}
                />
              )}
            />
          )}
        </Field>
        <Field label="Código externo" required hint={hint?.id} error={err.externalId?.message}>
          <Input {...register('externalId')} className="font-mono" />
        </Field>
        <Field label="SKU externo" hint={hint?.sku} error={err.externalSku?.message}>
          <Input {...register('externalSku')} className="font-mono" />
        </Field>
        {channel?.code === 'AMAZON' && (
          <Field label="FNSKU (etiqueta FBA)" hint="X00…" error={err.fnsku?.message}>
            <Input {...register('fnsku')} className="font-mono" />
          </Field>
        )}
        <Field label="Unidades por publicación" hint="Para packs: 2 = se venden 2 piezas del SKU por pedido." error={err.unitsPerListing?.message}>
          <Input inputMode="numeric" {...register('unitsPerListing')} className="num" />
        </Field>
        <Field label="Modelo de surtido" error={err.fulfillmentModel?.message}>
          <Select {...register('fulfillmentModel')}>
            {Object.entries(FULFILLMENT_MODEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
        </Field>
        <Field
          label="Almacén que surte"
          required={model === 'FULFILLMENT_CANAL'}
          hint={model === 'FULFILLMENT_CANAL' ? 'Amazon FBA, Liverpool FBL o 99 Minutos' : 'Bodega desde la que se envía (ej. APLIN para Liverpool Vendor)'}
          error={err.fulfillmentWarehouseId?.message}
        >
          <Select {...register('fulfillmentWarehouseId')} disabled={!channelId && model === 'FULFILLMENT_CANAL'}>
            <option value="">{model === 'FULFILLMENT_CANAL' ? 'Selecciona…' : 'Sin definir'}</option>
            {whOptions.map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}
          </Select>
        </Field>
        <Field label="Precio en el canal (con IVA)" error={err.price?.message}>
          <Input inputMode="decimal" {...register('price')} className="num" />
        </Field>
        <Field label="Estado" error={err.status?.message}>
          <Select {...register('status')}>
            {Object.entries(LISTING_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
        </Field>
        <Field label="Título en el canal" className="sm:col-span-2" error={err.title?.message}>
          <Input {...register('title')} />
        </Field>
      </form>
    </Dialog>
  );
}
