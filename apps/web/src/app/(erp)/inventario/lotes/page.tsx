'use client';

import Link from 'next/link';
import { LOT_COST_STATUS, MOVEMENT_DOCUMENT } from '@erp/shared';
import { fmtCost, fmtDate, fmtInt, fmtMoney } from '@/lib/format';
import { useWarehouses } from '@/lib/inventory';
import { useSession } from '@/lib/session';
import { DataTable, type Column } from '@/components/data-table';
import { StockQty } from '@/components/inventory';
import { PageHeader, StatusBadge } from '@/components/ui';

interface Row {
  id: string;
  lotCode: string;
  receivedAt: string;
  initialQty: number;
  onHand: number;
  sourceType: string;
  skuId: string;
  skuCode: string;
  skuName: string;
  supplierName: string | null;
  byLocation: { code: string; location: string; qty: number }[];
  unitCost?: string;
  costStatus?: string;
  value?: string;
}

export default function LotsPage() {
  const { can } = useSession();
  const costs = can('costos.ver');
  const whs = useWarehouses();
  const columns: Column<Row>[] = [
    { id: 'lot', header: 'Lote', cell: (r) => <span className="font-mono">{r.lotCode}</span>, csv: (r) => r.lotCode },
    { id: 'sku', header: 'SKU', cell: (r) => <Link href={`/inventario/kardex?skuId=${r.skuId}`} className="font-mono text-brand hover:underline">{r.skuCode}</Link>, csv: (r) => r.skuCode },
    { id: 'name', header: 'Nombre', cell: (r) => <span className="line-clamp-1">{r.skuName}</span>, csv: (r) => r.skuName, defaultHidden: true },
    { id: 'received', header: 'Entrada', cell: (r) => fmtDate(r.receivedAt), csv: (r) => r.receivedAt },
    { id: 'source', header: 'Origen', cell: (r) => MOVEMENT_DOCUMENT[r.sourceType as keyof typeof MOVEMENT_DOCUMENT] ?? r.sourceType, csv: (r) => r.sourceType },
    { id: 'supplier', header: 'Proveedor', cell: (r) => r.supplierName ?? '—', csv: (r) => r.supplierName, defaultHidden: true },
    { id: 'initial', header: 'Inicial', align: 'right', cell: (r) => fmtInt(r.initialQty), csv: (r) => r.initialQty },
    { id: 'onHand', header: 'Existencia', align: 'right', cell: (r) => <StockQty value={r.onHand} strong />, csv: (r) => r.onHand },
    {
      id: 'where',
      header: 'Dónde está',
      cell: (r) => <span className="text-xs text-ink-soft">{r.byLocation.map((b) => `${b.code}/${b.location}: ${fmtInt(b.qty)}`).join(' · ') || '—'}</span>,
      csv: (r) => r.byLocation.map((b) => `${b.code}/${b.location}:${b.qty}`).join(' '),
    },
    ...(costs
      ? ([
          { id: 'cost', header: 'Costo unit.', align: 'right', cell: (r) => fmtCost(r.unitCost), csv: (r) => r.unitCost },
          { id: 'costStatus', header: 'Costo', cell: (r) => (r.costStatus ? <StatusBadge value={r.costStatus} labels={LOT_COST_STATUS} /> : '—'), csv: (r) => r.costStatus },
          { id: 'value', header: 'Valor', align: 'right', cell: (r) => fmtMoney(r.value), csv: (r) => r.value },
        ] as Column<Row>[])
      : []),
  ];
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Inventario', href: '/inventario' }, { label: 'Lotes FIFO' }]}
        title="Lotes FIFO"
        subtitle="Cada entrada crea un lote con su costo. Las salidas consumen primero los lotes más antiguos; en una transferencia el lote viaja con su costo."
      />
      <DataTable<Row>
        tableKey="inventory-lots"
        endpoint="/inventory/lots"
        columns={columns}
        rowId={(r) => r.id}
        exportPerm="inventario.exportar"
        exportName="lotes"
        searchPlaceholder="Lote, SKU o nombre…"
        urlParams={['skuId']}
        filters={[
          { key: 'warehouseId', label: 'Almacén', options: (whs.data ?? []).map((w) => ({ value: w.id, label: w.code })) },
          { key: 'withStock', label: 'Lotes', allLabel: 'Lotes: con existencia', options: [{ value: '0', label: 'todos (incluye agotados)' }] },
        ]}
      />
    </>
  );
}
