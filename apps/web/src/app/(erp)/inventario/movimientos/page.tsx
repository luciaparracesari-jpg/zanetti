'use client';

import { MOVEMENT_DOCUMENT, MOVEMENT_TYPE } from '@erp/shared';
import { useWarehouses } from '@/lib/inventory';
import { useSession } from '@/lib/session';
import { DataTable, optionsFrom } from '@/components/data-table';
import { movementColumns, type MovementRow } from '@/components/movement-columns';
import { DateRange } from '@/components/url-controls';
import { PageHeader } from '@/components/ui';

export default function MovementsPage() {
  const { can } = useSession();
  const whs = useWarehouses();
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Inventario', href: '/inventario' }, { label: 'Movimientos' }]}
        title="Movimientos de inventario"
        subtitle="Cada entrada y salida queda registrada con su lote, costo, documento y usuario. Los movimientos no se editan ni se borran: una corrección es un movimiento nuevo."
      />
      <DataTable<MovementRow>
        tableKey="inventory-movements"
        endpoint="/inventory/movements"
        columns={movementColumns(can('costos.ver'), { showSku: true })}
        rowId={(r) => String(r.id)}
        exportPerm="inventario.exportar"
        exportName="movimientos-inventario"
        searchPlaceholder="SKU, nombre, folio o nota…"
        urlParams={['from', 'to', 'skuId', 'documentId']}
        toolbar={<DateRange />}
        filters={[
          { key: 'warehouseId', label: 'Almacén', options: (whs.data ?? []).map((w) => ({ value: w.id, label: w.code })) },
          { key: 'type', label: 'Tipo', options: optionsFrom(MOVEMENT_TYPE) },
          { key: 'direction', label: 'Sentido', options: [{ value: 'IN', label: 'entradas' }, { value: 'OUT', label: 'salidas' }] },
          { key: 'documentType', label: 'Documento', options: optionsFrom(MOVEMENT_DOCUMENT) },
        ]}
      />
    </>
  );
}
