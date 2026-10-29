'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { COUNT_STATUS } from '@erp/shared';
import { ApiError, post } from '@/lib/api';
import { fmtDateTime, fmtInt } from '@/lib/format';
import { useLocations, useWarehouses } from '@/lib/inventory';
import { Can } from '@/lib/session';
import { AsyncCombobox } from '@/components/combobox';
import { DataTable, optionsFrom, type Column } from '@/components/data-table';
import { useToast } from '@/components/toast';
import { Badge, Button, Checkbox, Dialog, ErrorBox, Field, PageHeader, Select, StatusBadge, Textarea } from '@/components/ui';

interface Row {
  id: string;
  folio: string;
  status: string;
  blind: boolean;
  warehouseCode: string;
  locationCode: string | null;
  notes: string | null;
  frozenAt: string;
  closedAt: string | null;
  createdByName: string | null;
  lines: number;
  counted: number;
  differences: number;
}

export default function CountsPage() {
  const sp = useSearchParams();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (sp.get('nuevo') === '1') setOpen(true);
  }, [sp]);
  const columns: Column<Row>[] = [
    { id: 'folio', header: 'Folio', cell: (r) => <span className="font-mono">{r.folio}</span>, csv: (r) => r.folio },
    { id: 'where', header: 'Almacén / ubicación', cell: (r) => `${r.warehouseCode}${r.locationCode ? ` / ${r.locationCode}` : ' (todo)'}`, csv: (r) => `${r.warehouseCode}/${r.locationCode ?? ''}` },
    { id: 'status', header: 'Estado', cell: (r) => <><StatusBadge value={r.status} labels={COUNT_STATUS} />{r.blind && <Badge className="ml-1">ciego</Badge>}</>, csv: (r) => r.status },
    { id: 'lines', header: 'Renglones', align: 'right', cell: (r) => fmtInt(r.lines), csv: (r) => r.lines },
    { id: 'counted', header: 'Capturados', align: 'right', cell: (r) => `${fmtInt(r.counted)} / ${fmtInt(r.lines)}`, csv: (r) => r.counted },
    { id: 'diff', header: 'Con diferencia', align: 'right', cell: (r) => (r.differences ? <span className="font-semibold text-warn">{fmtInt(r.differences)}</span> : '0'), csv: (r) => r.differences },
    { id: 'frozen', header: 'Foto de existencia', cell: (r) => fmtDateTime(r.frozenAt), csv: (r) => r.frozenAt },
    { id: 'closed', header: 'Cerrado', cell: (r) => fmtDateTime(r.closedAt), csv: (r) => r.closedAt },
    { id: 'user', header: 'Abrió', cell: (r) => r.createdByName ?? '—', csv: (r) => r.createdByName, defaultHidden: true },
  ];
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Inventario', href: '/inventario' }, { label: 'Conteos físicos' }]}
        title="Conteos físicos"
        subtitle="Al abrir un conteo se toma la foto de la existencia; al cerrarlo se ajusta sólo la diferencia contra esa foto, así no se pierden los movimientos que ocurran mientras se cuenta."
        actions={
          <Can perm="transferencias.crear">
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>Nuevo conteo</Button>
          </Can>
        }
      />
      <DataTable<Row>
        tableKey="counts"
        endpoint="/counts"
        columns={columns}
        rowId={(r) => r.id}
        rowHref={(r) => `/inventario/conteos/${r.id}`}
        exportPerm="transferencias.exportar"
        exportName="conteos"
        searchPlaceholder="Folio o nota…"
        filters={[{ key: 'status', label: 'Estado', options: optionsFrom(COUNT_STATUS) }]}
      />
      <NewCountDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function NewCountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const whs = useWarehouses();
  const [warehouseId, setWarehouseId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [blind, setBlind] = useState(true);
  const [notes, setNotes] = useState('');
  const [skus, setSkus] = useState<{ id: string; label: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locs = useLocations(warehouseId);
  useEffect(() => {
    if (open && !warehouseId && whs.data?.length) setWarehouseId(whs.data.find((w) => w.code === 'APLIN')?.id ?? whs.data[0].id);
  }, [open, whs.data, warehouseId]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ id: string; folio: string; lines: number }>('/counts', { warehouseId, locationId: locationId || null, blind, notes: notes || null, skuIds: skus.map((s) => s.id) });
      toast.ok(`Conteo ${r.folio} abierto con ${r.lines} renglones.`);
      qc.invalidateQueries({ queryKey: ['/counts'] });
      onClose();
      router.push(`/inventario/conteos/${r.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'No se pudo abrir el conteo.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Nuevo conteo físico"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={busy} disabled={!warehouseId} onClick={create}>Abrir conteo</Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {error && <div className="sm:col-span-2"><ErrorBox error={error} /></div>}
        <Field label="Almacén" required>
          <Select value={warehouseId} onChange={(e) => { setWarehouseId(e.target.value); setLocationId(''); }}>
            {(whs.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}
          </Select>
        </Field>
        <Field label="Ubicación" hint="Vacío = todo el almacén.">
          <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">Todo el almacén</option>
            {(locs.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.code}{l.name ? ` · ${l.name}` : ''}</option>)}
          </Select>
        </Field>
        <Field label="Conteo cíclico (opcional)" hint="Agrega SKU para contar sólo esos; vacío = todo lo que tiene existencia." className="sm:col-span-2">
          <AsyncCombobox<{ id: string; skuCode: string; name: string }>
            value={null}
            onChange={(v, o) => v && o && !skus.some((s) => s.id === v) && setSkus([...skus, { id: v, label: o.label }])}
            fetchPath="/skus/options?excludeKits=true"
            map={(s) => ({ value: s.id, label: s.skuCode, hint: s.name })}
            placeholder="Agregar SKU…"
          />
          {skus.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {skus.map((s) => (
                <span key={s.id} className="inline-flex items-center gap-1 rounded border border-line bg-page px-1.5 py-0.5 font-mono text-xs">
                  {s.label}
                  <button onClick={() => setSkus(skus.filter((x) => x.id !== s.id))} aria-label="Quitar"><X className="h-3 w-3" /></button>
                </span>
              ))}
            </div>
          )}
        </Field>
        <div className="sm:col-span-2">
          <Checkbox label="Conteo ciego: quien captura no ve la existencia del sistema" checked={blind} onChange={(e) => setBlind(e.target.checked)} />
        </div>
        <Field label="Notas" className="sm:col-span-2">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </Field>
      </div>
    </Dialog>
  );
}
