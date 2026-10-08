'use client';

import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FULFILLMENT_MODEL, UNMAPPED_STATUS } from '@erp/shared';
import { get, post } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { applyServerErrors } from '@/lib/forms';
import { useSession } from '@/lib/session';
import { AsyncCombobox } from '@/components/combobox';
import { DataTable, optionsFrom, useOptions, type Column } from '@/components/data-table';
import { useToast } from '@/components/toast';
import { Button, Dialog, ErrorBox, Field, Input, PageHeader, Select, StatusBadge } from '@/components/ui';

interface Row {
  id: string;
  channelId: string;
  channelName: string;
  externalId: string;
  externalSku: string;
  title: string | null;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  status: string;
}
interface Wh {
  id: string;
  code: string;
  name: string;
  type: string;
  channelId: string | null;
}

export default function UnmappedPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const channels = useOptions<{ id: string; name: string }>('/channels/options', (c) => c.name);
  const warehouses = useQuery({ queryKey: ['/warehouses/options'], queryFn: () => get<Wh[]>('/warehouses/options') });
  const [row, setRow] = useState<Row | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const { register, handleSubmit, reset, watch, control, setError, formState } = useForm<{
    masterSkuId: string | null;
    unitsPerListing: string;
    fulfillmentModel: string;
    fulfillmentWarehouseId: string;
  }>();

  useEffect(() => {
    if (row) {
      reset({ masterSkuId: null, unitsPerListing: '1', fulfillmentModel: 'BODEGA_PROPIA', fulfillmentWarehouseId: '' });
      setMsg(null);
    }
  }, [row, reset]);
  const model = watch('fulfillmentModel');
  const whs = useMemo(
    () =>
      (warehouses.data ?? []).filter((w) =>
        model === 'FULFILLMENT_CANAL' ? w.type === 'FULFILLMENT_CANAL' && w.channelId === row?.channelId : ['PROPIO', 'OPERADOR_LOGISTICO'].includes(w.type),
      ),
    [warehouses.data, model, row],
  );

  async function onSubmit(v: { masterSkuId: string | null; unitsPerListing: string; fulfillmentModel: string; fulfillmentWarehouseId: string }) {
    try {
      await post(`/listings/unmapped/${row!.id}/map`, { ...v, unitsPerListing: Number(v.unitsPerListing), fulfillmentWarehouseId: v.fulfillmentWarehouseId || null });
      toast.ok(`${row!.externalId} quedó ligado al SKU.`);
      qc.invalidateQueries({ queryKey: ['/listings/unmapped'] });
      qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
      setRow(null);
    } catch (e) {
      setMsg(applyServerErrors(e, setError));
    }
  }

  async function ignore(r: Row) {
    if (!confirm(`¿Ignorar ${r.externalId}? Sus ventas no descontarán inventario.`)) return;
    await post(`/listings/unmapped/${r.id}/ignore`);
    qc.invalidateQueries({ queryKey: ['/listings/unmapped'] });
  }

  const columns: Column<Row>[] = [
    { id: 'externalId', header: 'Código externo', sortKey: 'externalId', cell: (r) => <span className="font-mono">{r.externalId}</span>, csv: (r) => r.externalId },
    { id: 'externalSku', header: 'SKU externo', cell: (r) => <span className="font-mono text-xs">{r.externalSku || '—'}</span>, csv: (r) => r.externalSku },
    { id: 'channel', header: 'Canal', cell: (r) => r.channelName, csv: (r) => r.channelName },
    { id: 'title', header: 'Descripción', cell: (r) => <span className="line-clamp-1">{r.title ?? '—'}</span>, csv: (r) => r.title },
    { id: 'occ', header: 'Apariciones', sortKey: 'occurrences', align: 'right', cell: (r) => r.occurrences, csv: (r) => r.occurrences },
    { id: 'last', header: 'Última vez', sortKey: 'lastSeenAt', cell: (r) => fmtDateTime(r.lastSeenAt), csv: (r) => r.lastSeenAt },
    { id: 'status', header: 'Estado', cell: (r) => <StatusBadge value={r.status} labels={UNMAPPED_STATUS} />, csv: (r) => r.status },
    {
      id: 'actions',
      header: '',
      align: 'right',
      cell: (r) =>
        r.status === 'PENDIENTE' && (
          <span className="flex justify-end gap-1">
            {can('canales.crear') && <Button size="sm" variant="primary" onClick={() => setRow(r)}>Mapear</Button>}
            {can('canales.editar') && <Button size="sm" variant="ghost" onClick={() => ignore(r)}>Ignorar</Button>}
          </span>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Códigos sin mapear"
        subtitle="Códigos que llegan en ventas o sincronizaciones y no están ligados a un SKU maestro. No tocan inventario hasta mapearse."
      />
      <DataTable<Row>
        tableKey="unmapped"
        endpoint="/listings/unmapped"
        columns={columns}
        rowId={(r) => r.id}
        exportPerm="canales.exportar"
        exportName="codigos-sin-mapear"
        filters={[
          { key: 'channelId', label: 'Canal', options: channels },
          { key: 'status', label: 'Estado', allLabel: 'Estado: pendientes', options: optionsFrom(UNMAPPED_STATUS).filter((o) => o.value !== 'PENDIENTE') },
        ]}
        emptyText="No hay códigos pendientes. Aparecerán aquí al importar ventas (entrega 4) o sincronizar canales (fase 2)."
      />
      <Dialog
        open={Boolean(row)}
        onClose={() => setRow(null)}
        title={`Mapear ${row?.externalId ?? ''}`}
        footer={
          <>
            <Button onClick={() => setRow(null)}>Cancelar</Button>
            <Button variant="primary" loading={formState.isSubmitting} onClick={handleSubmit(onSubmit)}>Ligar al SKU</Button>
          </>
        }
      >
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={handleSubmit(onSubmit)}>
          {msg && <div className="sm:col-span-2"><ErrorBox error={msg} /></div>}
          <div className="text-sm text-ink-soft sm:col-span-2">
            {row?.channelName} · {row?.externalId} {row?.externalSku && `· ${row.externalSku}`} {row?.title && `· ${row.title}`}
          </div>
          <Field label="SKU maestro" required className="sm:col-span-2" error={formState.errors.masterSkuId?.message}>
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
                />
              )}
            />
          </Field>
          <Field label="Unidades por publicación">
            <Input inputMode="numeric" {...register('unitsPerListing')} className="num" />
          </Field>
          <Field label="Modelo de surtido">
            <Select {...register('fulfillmentModel')}>
              {Object.entries(FULFILLMENT_MODEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </Field>
          <Field label="Almacén que surte" required={model === 'FULFILLMENT_CANAL'} error={formState.errors.fulfillmentWarehouseId?.message} className="sm:col-span-2">
            <Select {...register('fulfillmentWarehouseId')}>
              <option value="">Selecciona…</option>
              {whs.map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}
            </Select>
          </Field>
        </form>
      </Dialog>
    </>
  );
}
