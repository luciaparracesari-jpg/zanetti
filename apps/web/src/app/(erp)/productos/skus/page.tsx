'use client';

import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { FileSpreadsheet, Plus } from 'lucide-react';
import { SKU_STATUS } from '@erp/shared';
import { patch } from '@/lib/api';
import { fmtCost, fmtMoney, fmtPct } from '@/lib/format';
import { Can, useSession } from '@/lib/session';
import { DataTable, optionsFrom, useOptions, type Column } from '@/components/data-table';
import { useToast } from '@/components/toast';
import { Badge, Button, PageHeader, StatusBadge } from '@/components/ui';

export interface SkuRow {
  id: string;
  skuCode: string;
  name: string;
  status: string;
  isKit: boolean;
  productName: string;
  brandName: string | null;
  categoryName: string | null;
  basePrice: string | null;
  currentCost?: string | null;
  marginPct?: number | null;
  weightG: number | null;
  leadTimeDays: number | null;
  minQty: number | null;
  maxQty: number | null;
  supplierName: string | null;
  primaryBarcode: string | null;
  listingCount: number;
  channelCodes: string[];
}

export default function SkusPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const brands = useOptions<{ id: string; name: string }>('/brands/options', (b) => b.name);
  const channels = useOptions<{ id: string; name: string }>('/channels/options', (c) => c.name);

  const columns: Column<SkuRow>[] = [
    { id: 'skuCode', header: 'SKU maestro', sortKey: 'skuCode', cell: (r) => r.skuCode, csv: (r) => r.skuCode },
    { id: 'name', header: 'Nombre', sortKey: 'name', cell: (r) => <span className="line-clamp-1">{r.name}</span>, csv: (r) => r.name },
    { id: 'product', header: 'Producto', sortKey: 'productName', cell: (r) => r.productName, csv: (r) => r.productName, defaultHidden: true },
    { id: 'brand', header: 'Marca', sortKey: 'brandName', cell: (r) => r.brandName ?? '—', csv: (r) => r.brandName },
    { id: 'category', header: 'Categoría', sortKey: 'categoryName', cell: (r) => r.categoryName ?? '—', csv: (r) => r.categoryName },
    { id: 'barcode', header: 'Código de barras', cell: (r) => <span className="font-mono text-xs">{r.primaryBarcode ?? '—'}</span>, csv: (r) => r.primaryBarcode },
    {
      id: 'channels',
      header: 'Canales',
      sortKey: 'listingCount',
      cell: (r) =>
        r.channelCodes.length ? (
          <span className="flex flex-wrap gap-1">
            {r.channelCodes.map((c) => (
              <Badge key={c} tone="info">{c.replace('_', ' ')}</Badge>
            ))}
          </span>
        ) : (
          <span className="text-ink-faint">Sin publicar</span>
        ),
      csv: (r) => r.channelCodes.join(' '),
    },
    { id: 'price', header: 'Precio lista (c/IVA)', sortKey: 'basePrice', align: 'right', cell: (r) => fmtMoney(r.basePrice), csv: (r) => r.basePrice },
    ...(can('costos.ver')
      ? ([
          { id: 'cost', header: 'Costo actual', sortKey: 'currentCost', align: 'right', cell: (r) => fmtCost(r.currentCost), csv: (r) => r.currentCost },
          {
            id: 'margin',
            header: 'Margen',
            align: 'right',
            cell: (r) => <span className={r.marginPct != null && r.marginPct < 20 ? 'text-bad' : ''}>{fmtPct(r.marginPct)}</span>,
            csv: (r) => r.marginPct,
          },
        ] as Column<SkuRow>[])
      : []),
    { id: 'supplier', header: 'Proveedor', cell: (r) => r.supplierName ?? '—', csv: (r) => r.supplierName, defaultHidden: true },
    { id: 'lead', header: 'Lead time (d)', align: 'right', cell: (r) => r.leadTimeDays ?? '—', csv: (r) => r.leadTimeDays, defaultHidden: true },
    { id: 'minmax', header: 'Mín / Máx', align: 'right', cell: (r) => (r.minQty ?? r.maxQty ? `${r.minQty ?? '—'} / ${r.maxQty ?? '—'}` : '—'), csv: (r) => `${r.minQty ?? ''}/${r.maxQty ?? ''}`, defaultHidden: true },
    { id: 'kit', header: 'Tipo', cell: (r) => (r.isKit ? <Badge tone="info">Kit</Badge> : 'Simple'), csv: (r) => (r.isKit ? 'Kit' : 'Simple') },
    { id: 'status', header: 'Estado', sortKey: 'status', cell: (r) => <StatusBadge value={r.status} labels={SKU_STATUS} />, csv: (r) => SKU_STATUS[r.status as keyof typeof SKU_STATUS] },
  ];

  async function bulkStatus(rows: SkuRow[], status: string, clear: () => void) {
    let ok = 0;
    for (const r of rows) {
      try {
        await patch(`/skus/${r.id}`, { status });
        ok++;
      } catch (e) {
        toast.error(`${r.skuCode}: ${(e as Error).message}`);
      }
    }
    toast.ok(`${ok} SKU actualizados a ${SKU_STATUS[status as keyof typeof SKU_STATUS]}.`);
    clear();
    qc.invalidateQueries({ queryKey: ['/skus'] });
  }

  return (
    <>
      <PageHeader
        title="SKU maestros"
        subtitle="Entidad central: cada publicación de cualquier canal apunta a un SKU maestro o a un kit."
        actions={
          <Can perm="productos.crear">
            <Link href="/importar?plantilla=skus">
              <Button icon={<FileSpreadsheet className="h-4 w-4" />}>Importar desde Excel</Button>
            </Link>
            <Link href="/productos/skus/nuevo">
              <Button variant="primary" icon={<Plus className="h-4 w-4" />}>
                Nuevo SKU
              </Button>
            </Link>
          </Can>
        }
      />
      <DataTable<SkuRow>
        tableKey="skus"
        endpoint="/skus"
        columns={columns}
        rowId={(r) => r.id}
        rowHref={(r) => `/productos/skus/${r.id}`}
        exportPerm="productos.exportar"
        exportName="sku-maestros"
        searchPlaceholder="SKU, nombre, código de barras, ASIN…  ( / )"
        filters={[
          { key: 'status', label: 'Estado', options: optionsFrom(SKU_STATUS) },
          { key: 'brandId', label: 'Marca', options: brands },
          { key: 'channelId', label: 'Canal', options: channels },
          { key: 'isKit', label: 'Tipo', options: [{ value: 'false', label: 'Simple' }, { value: 'true', label: 'Kit' }] },
          { key: 'withoutListings', label: 'Publicación', options: [{ value: 'true', label: 'Sin publicación vigente' }] },
          { key: 'withoutName', label: 'Nombre', options: [{ value: 'true', label: 'Sin nombre' }] },
        ]}
        bulkActions={
          can('productos.editar')
            ? (rows, clear) => (
                <>
                  <Button size="sm" onClick={() => bulkStatus(rows, 'ACTIVO', clear)}>Activar</Button>
                  <Button size="sm" onClick={() => bulkStatus(rows, 'DESCONTINUADO', clear)}>Descontinuar</Button>
                  <Button size="sm" onClick={() => bulkStatus(rows, 'INACTIVO', clear)}>Inactivar</Button>
                </>
              )
            : undefined
        }
      />
    </>
  );
}
