'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { FULFILLMENT_MODEL, LISTING_STATUS } from '@erp/shared';
import { post } from '@/lib/api';
import { fmtDate, fmtMoney } from '@/lib/format';
import { Can, useSession } from '@/lib/session';
import { DataTable, optionsFrom, useOptions, type Column } from '@/components/data-table';
import { ListingDialog, type ListingRow } from '@/components/listing-dialog';
import { useToast } from '@/components/toast';
import { Button, PageHeader, StatusBadge } from '@/components/ui';

interface Row extends ListingRow {
  channelCode: string;
  channelName: string;
  masterSkuId: string;
  skuCode: string;
  skuName: string;
  warehouseCode: string | null;
  validFrom: string;
  validTo: string | null;
}

export default function ListingsPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const channels = useOptions<{ id: string; name: string }>('/channels/options', (c) => c.name);
  const [dialog, setDialog] = useState<{ open: boolean; listing: Row | null }>({ open: false, listing: null });

  async function close(rows: Row[], clear: () => void) {
    if (!confirm(`¿Dar de baja ${rows.length} publicaciones? Se conservan en el historial.`)) return;
    for (const r of rows) {
      try {
        await post(`/listings/${r.id}/close`);
      } catch (e) {
        toast.error(`${r.externalId}: ${(e as Error).message}`);
      }
    }
    toast.ok('Publicaciones dadas de baja.');
    clear();
    qc.invalidateQueries({ queryKey: ['/listings'] });
  }

  const columns: Column<Row>[] = [
    { id: 'externalId', header: 'Código externo', sortKey: 'externalId', cell: (r) => <span className="font-mono">{r.externalId}</span>, csv: (r) => r.externalId },
    { id: 'channel', header: 'Canal', sortKey: 'channelName', cell: (r) => r.channelName, csv: (r) => r.channelName },
    { id: 'externalSku', header: 'SKU externo', sortKey: 'externalSku', cell: (r) => <span className="font-mono text-xs">{r.externalSku || '—'}</span>, csv: (r) => r.externalSku },
    { id: 'fnsku', header: 'FNSKU', cell: (r) => <span className="font-mono text-xs">{r.fnsku ?? '—'}</span>, csv: (r) => r.fnsku, defaultHidden: true },
    {
      id: 'sku',
      header: 'SKU maestro',
      sortKey: 'skuCode',
      cell: (r) => (
        <Link href={`/productos/skus/${r.masterSkuId}?tab=publicaciones`} className="font-mono text-brand hover:underline">
          {r.skuCode}
        </Link>
      ),
      csv: (r) => r.skuCode,
    },
    { id: 'skuName', header: 'Nombre SKU', cell: (r) => <span className="line-clamp-1">{r.skuName}</span>, csv: (r) => r.skuName },
    { id: 'units', header: 'Uds.', align: 'right', cell: (r) => r.unitsPerListing, csv: (r) => r.unitsPerListing },
    { id: 'model', header: 'Surtido', cell: (r) => FULFILLMENT_MODEL[r.fulfillmentModel as keyof typeof FULFILLMENT_MODEL], csv: (r) => r.fulfillmentModel },
    { id: 'wh', header: 'Almacén', cell: (r) => r.warehouseCode ?? '—', csv: (r) => r.warehouseCode },
    { id: 'price', header: 'Precio', sortKey: 'price', align: 'right', cell: (r) => fmtMoney(r.price), csv: (r) => r.price },
    { id: 'status', header: 'Estado', sortKey: 'status', cell: (r) => <StatusBadge value={r.status} labels={LISTING_STATUS} />, csv: (r) => r.status },
    { id: 'valid', header: 'Vigencia', cell: (r) => `${fmtDate(r.validFrom)} – ${r.validTo ? fmtDate(r.validTo) : 'vigente'}`, csv: (r) => r.validTo ?? 'vigente', defaultHidden: true },
    {
      id: 'actions',
      header: '',
      align: 'right',
      cell: (r) => (!r.validTo && can('canales.editar') ? <Button size="sm" variant="ghost" onClick={() => setDialog({ open: true, listing: r })}>Editar</Button> : null),
    },
  ];

  return (
    <>
      <PageHeader
        title="Publicaciones de marketplaces"
        subtitle="ASIN, artículos de Liverpool, variantes de Shopify y publicaciones de Mercado Libre ligadas a su SKU maestro."
        actions={
          <Can perm="canales.crear">
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setDialog({ open: true, listing: null })}>Nueva publicación</Button>
          </Can>
        }
      />
      <DataTable<Row>
        tableKey="listings"
        endpoint="/listings"
        columns={columns}
        rowId={(r) => r.id}
        exportPerm="canales.exportar"
        exportName="publicaciones"
        searchPlaceholder="ASIN, artículo, SKU externo, FNSKU o SKU maestro…"
        filters={[
          { key: 'channelId', label: 'Canal', options: channels },
          { key: 'fulfillmentModel', label: 'Surtido', options: optionsFrom(FULFILLMENT_MODEL) },
          { key: 'status', label: 'Estado', options: optionsFrom(LISTING_STATUS) },
          { key: 'vigencia', label: 'Vigencia', allLabel: 'Vigencia: vigentes', options: [{ value: 'historicas', label: 'dadas de baja' }, { value: 'todas', label: 'todas' }] },
        ]}
        bulkActions={can('canales.editar') ? (rows, clear) => <Button size="sm" onClick={() => close(rows.filter((r) => !r.validTo), clear)}>Dar de baja</Button> : undefined}
      />
      <ListingDialog open={dialog.open} listing={dialog.listing} onClose={() => setDialog({ open: false, listing: null })} />
    </>
  );
}
