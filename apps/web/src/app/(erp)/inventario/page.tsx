'use client';

import Link from 'next/link';
import { ArrowLeftRight, ClipboardCheck, FileUp, SlidersHorizontal } from 'lucide-react';
import { SKU_STATUS, STOCK_FILTER } from '@erp/shared';
import { fmtCost, fmtInt, fmtMoney } from '@/lib/format';
import { useWarehouses } from '@/lib/inventory';
import { Can, useSession } from '@/lib/session';
import { DataTable, optionsFrom, type Column } from '@/components/data-table';
import { StockQty, TotalsBar } from '@/components/inventory';
import { Button, PageHeader } from '@/components/ui';

interface Row {
  id: string;
  skuCode: string;
  name: string;
  status: string;
  productName: string;
  brandName: string | null;
  onHand: number;
  blocked: number;
  reserved: number;
  inTransit: number;
  available: number;
  value?: string;
  avgCost?: string | null;
  byWarehouse: { warehouseId: string; code: string; onHand: number; available: number; inTransit: number; reserved: number }[];
}

interface Totals {
  onHand: number;
  available: number;
  inTransit: number;
  reserved: number;
  value?: string;
  inTransitValue?: string;
}

export default function StockPage() {
  const { can } = useSession();
  const whs = useWarehouses();
  const costs = can('costos.ver');

  const whCols: Column<Row>[] = (whs.data ?? []).map((w) => ({
    id: `wh-${w.code}`,
    header: w.code,
    align: 'right',
    cell: (r) => {
      const x = r.byWarehouse.find((b) => b.warehouseId === w.id);
      if (!x) return <span className="text-ink-faint">—</span>;
      return (
        <span title={`Físico ${x.onHand} · disponible ${x.available}${x.reserved ? ` · apartado ${x.reserved}` : ''}${x.inTransit ? ` · en tránsito ${x.inTransit}` : ''}`}>
          <StockQty value={x.onHand} />
          {x.inTransit > 0 && <span className="ml-1 text-xs text-warn">+{fmtInt(x.inTransit)}</span>}
        </span>
      );
    },
    csv: (r) => r.byWarehouse.find((b) => b.warehouseId === w.id)?.onHand ?? 0,
  }));

  const columns: Column<Row>[] = [
    { id: 'sku', header: 'SKU maestro', sortKey: 'skuCode', cell: (r) => <span className="font-mono">{r.skuCode}</span>, csv: (r) => r.skuCode },
    { id: 'name', header: 'Nombre', sortKey: 'name', cell: (r) => <span className="line-clamp-1">{r.name}</span>, csv: (r) => r.name },
    { id: 'brand', header: 'Marca', cell: (r) => r.brandName ?? '—', csv: (r) => r.brandName, defaultHidden: true },
    ...whCols,
    { id: 'onHand', header: 'Físico', sortKey: 'onHand', align: 'right', cell: (r) => <StockQty value={r.onHand} strong />, csv: (r) => r.onHand },
    { id: 'reserved', header: 'Apartado', sortKey: 'reserved', align: 'right', cell: (r) => <StockQty value={r.reserved} />, csv: (r) => r.reserved },
    { id: 'blocked', header: 'Bloqueado', align: 'right', cell: (r) => <StockQty value={r.blocked} />, csv: (r) => r.blocked, defaultHidden: true },
    { id: 'available', header: 'Disponible', sortKey: 'available', align: 'right', cell: (r) => <StockQty value={r.available} strong />, csv: (r) => r.available },
    { id: 'transit', header: 'En tránsito', sortKey: 'inTransit', align: 'right', cell: (r) => <StockQty value={r.inTransit} />, csv: (r) => r.inTransit },
    ...(costs
      ? ([
          { id: 'avgCost', header: 'Costo prom.', align: 'right', cell: (r) => fmtCost(r.avgCost), csv: (r) => r.avgCost, defaultHidden: true },
          { id: 'value', header: 'Valor', sortKey: 'value', align: 'right', cell: (r) => fmtMoney(r.value), csv: (r) => r.value },
        ] as Column<Row>[])
      : []),
    {
      id: 'actions',
      header: '',
      align: 'right',
      cell: (r) => (
        <Link href={`/inventario/kardex?skuId=${r.id}`} className="text-xs text-brand hover:underline">
          Kardex
        </Link>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Inventario' }]}
        title="Existencias"
        subtitle="Físico por almacén, apartado (pedidos y transferencias autorizadas), disponible y en tránsito. Los kits no tienen existencia propia."
        actions={
          <>
            <Can perm="ajustes.crear">
              <Link href="/inventario/ajustes/nuevo"><Button icon={<SlidersHorizontal className="h-4 w-4" />}>Ajuste</Button></Link>
            </Can>
            <Can perm="transferencias.crear">
              <Link href="/inventario/transferencias/nueva"><Button icon={<ArrowLeftRight className="h-4 w-4" />}>Transferencia</Button></Link>
              <Link href="/inventario/conteos?nuevo=1"><Button icon={<ClipboardCheck className="h-4 w-4" />}>Conteo</Button></Link>
            </Can>
            {can('ajustes.autorizar') && can('costos.ver') && (
              <Link href="/importar?plantilla=inventario-inicial"><Button icon={<FileUp className="h-4 w-4" />}>Inventario inicial</Button></Link>
            )}
          </>
        }
      />
      <DataTable<Row>
        tableKey="inventory-stock"
        endpoint="/inventory/stock"
        columns={columns}
        rowId={(r) => r.id}
        rowHref={(r) => `/productos/skus/${r.id}?tab=inventario`}
        rowClassName={(r) => (r.onHand < 0 || r.available < 0 ? 'bg-bad-soft/40' : undefined)}
        exportPerm="inventario.exportar"
        exportName="existencias"
        searchPlaceholder="SKU, nombre, código de barras, ASIN o artículo…"
        filters={[
          { key: 'warehouseId', label: 'Almacén', options: (whs.data ?? []).map((w) => ({ value: w.id, label: `${w.code} · ${w.name}` })) },
          { key: 'stock', label: 'Existencia', allLabel: `Existencia: ${STOCK_FILTER.CON.toLowerCase()}`, options: optionsFrom(STOCK_FILTER).filter((o) => o.value !== 'CON') },
          { key: 'status', label: 'Estado', options: optionsFrom(SKU_STATUS) },
        ]}
        summary={(d) => {
          const t = d.totals as Totals | undefined;
          if (!t) return null;
          return (
            <TotalsBar
              items={[
                { label: 'SKU', value: fmtInt(d.total) },
                { label: 'Físico', value: fmtInt(t.onHand) },
                { label: 'Apartado', value: fmtInt(t.reserved) },
                { label: 'Disponible', value: fmtInt(t.available), tone: t.available < 0 ? 'bad' : undefined },
                { label: 'En tránsito', value: fmtInt(t.inTransit), tone: t.inTransit ? 'warn' : undefined },
                ...(t.value !== undefined ? [{ label: 'Valor al costo', value: fmtMoney(t.value) }] : []),
                ...(t.inTransitValue !== undefined && Number(t.inTransitValue) > 0 ? [{ label: 'Valor en tránsito', value: fmtMoney(t.inTransitValue) }] : []),
              ]}
            />
          );
        }}
      />
    </>
  );
}
