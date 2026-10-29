'use client';

import Link from 'next/link';
import { Plus } from 'lucide-react';
import { ADJUSTMENT_REASON, ADJUSTMENT_STATUS } from '@erp/shared';
import { fmtDateTime, fmtInt, fmtMoney } from '@/lib/format';
import { useWarehouses } from '@/lib/inventory';
import { Can, useSession } from '@/lib/session';
import { DataTable, optionsFrom, type Column } from '@/components/data-table';
import { Button, PageHeader, StatusBadge } from '@/components/ui';

interface Row {
  id: string;
  folio: string;
  warehouseCode: string;
  reason: keyof typeof ADJUSTMENT_REASON;
  status: string;
  notes: string | null;
  totalValue: string | null;
  createdAt: string;
  appliedAt: string | null;
  createdByName: string | null;
  lines: number;
  unitsIn: number;
  unitsOut: number;
}

export default function AdjustmentsPage() {
  const { can } = useSession();
  const whs = useWarehouses();
  const columns: Column<Row>[] = [
    { id: 'folio', header: 'Folio', cell: (r) => <span className="font-mono">{r.folio}</span>, csv: (r) => r.folio },
    { id: 'date', header: 'Creado', cell: (r) => fmtDateTime(r.createdAt), csv: (r) => r.createdAt },
    { id: 'wh', header: 'Almacén', cell: (r) => r.warehouseCode, csv: (r) => r.warehouseCode },
    { id: 'reason', header: 'Motivo', cell: (r) => ADJUSTMENT_REASON[r.reason] ?? r.reason, csv: (r) => ADJUSTMENT_REASON[r.reason] },
    { id: 'lines', header: 'Renglones', align: 'right', cell: (r) => fmtInt(r.lines), csv: (r) => r.lines },
    { id: 'in', header: 'Entradas', align: 'right', cell: (r) => (r.unitsIn ? <span className="text-ok">+{fmtInt(r.unitsIn)}</span> : '—'), csv: (r) => r.unitsIn },
    { id: 'out', header: 'Salidas', align: 'right', cell: (r) => (r.unitsOut ? <span className="text-bad">−{fmtInt(r.unitsOut)}</span> : '—'), csv: (r) => r.unitsOut },
    ...(can('costos.ver') ? ([{ id: 'value', header: 'Valor', align: 'right', cell: (r) => fmtMoney(r.totalValue), csv: (r) => r.totalValue }] as Column<Row>[]) : []),
    { id: 'status', header: 'Estado', cell: (r) => <StatusBadge value={r.status} labels={ADJUSTMENT_STATUS} />, csv: (r) => ADJUSTMENT_STATUS[r.status as keyof typeof ADJUSTMENT_STATUS] },
    { id: 'user', header: 'Capturó', cell: (r) => r.createdByName ?? '—', csv: (r) => r.createdByName },
    { id: 'notes', header: 'Notas', cell: (r) => <span className="line-clamp-1 text-xs text-ink-soft">{r.notes ?? ''}</span>, csv: (r) => r.notes, defaultHidden: true },
  ];
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Inventario', href: '/inventario' }, { label: 'Ajustes' }]}
        title="Ajustes de inventario"
        subtitle="Mermas, daños, conciliaciones con el canal y correcciones. Si el valor supera el umbral configurado, el ajuste espera autorización."
        actions={
          <Can perm="ajustes.crear">
            <Link href="/inventario/ajustes/nuevo"><Button variant="primary" icon={<Plus className="h-4 w-4" />}>Nuevo ajuste</Button></Link>
          </Can>
        }
      />
      <DataTable<Row>
        tableKey="adjustments"
        endpoint="/adjustments"
        columns={columns}
        rowId={(r) => r.id}
        rowHref={(r) => `/inventario/ajustes/${r.id}`}
        exportPerm="ajustes.exportar"
        exportName="ajustes"
        searchPlaceholder="Folio, SKU o nota…"
        filters={[
          { key: 'status', label: 'Estado', options: optionsFrom(ADJUSTMENT_STATUS) },
          { key: 'reason', label: 'Motivo', options: optionsFrom(ADJUSTMENT_REASON) },
          { key: 'warehouseId', label: 'Almacén', options: (whs.data ?? []).map((w) => ({ value: w.id, label: w.code })) },
        ]}
      />
    </>
  );
}
