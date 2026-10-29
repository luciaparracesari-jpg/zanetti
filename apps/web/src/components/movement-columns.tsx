'use client';

import Link from 'next/link';
import { MOVEMENT_TYPE } from '@erp/shared';
import { fmtCost, fmtDateTime, fmtMoney } from '@/lib/format';
import type { Column } from './data-table';
import { DocLink, SignedQty } from './inventory';
import { Badge } from './ui';

export interface MovementRow {
  id: number;
  occurredAt: string;
  type: string;
  masterSkuId: string;
  skuCode: string;
  skuName: string;
  warehouseCode: string;
  locationCode: string;
  lotCode: string | null;
  qty: number;
  unitCost?: string;
  totalCost?: string;
  documentType: string;
  documentId: string;
  documentFolio: string | null;
  documentLine: number | null;
  notes: string | null;
  userName: string | null;
  negativeAuthorized: boolean;
  balance?: number;
  balanceValue?: string;
}

/** Columnas comunes de movimientos (también las usa el kardex). */
export function movementColumns(costs: boolean, opts: { showSku: boolean; sortable?: boolean }): Column<MovementRow>[] {
  return [
    { id: 'date', header: 'Fecha', sortKey: opts.sortable === false ? undefined : 'occurredAt', cell: (r) => <span className="whitespace-nowrap">{fmtDateTime(r.occurredAt)}</span>, csv: (r) => r.occurredAt },
    {
      id: 'type',
      header: 'Movimiento',
      cell: (r) => (
        <span className="whitespace-nowrap">
          {MOVEMENT_TYPE[r.type as keyof typeof MOVEMENT_TYPE] ?? r.type}
          {r.negativeAuthorized && <Badge tone="bad" className="ml-1">negativo autorizado</Badge>}
        </span>
      ),
      csv: (r) => MOVEMENT_TYPE[r.type as keyof typeof MOVEMENT_TYPE] ?? r.type,
    },
    ...(opts.showSku
      ? ([
          {
            id: 'sku',
            header: 'SKU',
            cell: (r) => (
              <Link href={`/inventario/kardex?skuId=${r.masterSkuId}`} className="font-mono text-brand hover:underline" title={r.skuName}>
                {r.skuCode}
              </Link>
            ),
            csv: (r) => r.skuCode,
          },
          { id: 'skuName', header: 'Nombre', cell: (r) => <span className="line-clamp-1">{r.skuName}</span>, csv: (r) => r.skuName, defaultHidden: true },
        ] as Column<MovementRow>[])
      : []),
    { id: 'wh', header: 'Almacén', cell: (r) => r.warehouseCode, csv: (r) => r.warehouseCode },
    { id: 'loc', header: 'Ubicación', cell: (r) => r.locationCode, csv: (r) => r.locationCode },
    { id: 'lot', header: 'Lote', cell: (r) => <span className="font-mono text-xs">{r.lotCode ?? 'sin lote'}</span>, csv: (r) => r.lotCode },
    { id: 'qty', header: 'Cantidad', align: 'right', cell: (r) => <SignedQty value={r.qty} />, csv: (r) => r.qty },
    ...(costs
      ? ([
          { id: 'unitCost', header: 'Costo unit.', align: 'right', cell: (r) => fmtCost(r.unitCost), csv: (r) => r.unitCost },
          { id: 'totalCost', header: 'Importe', align: 'right', cell: (r) => fmtMoney(r.totalCost), csv: (r) => r.totalCost },
        ] as Column<MovementRow>[])
      : []),
    { id: 'doc', header: 'Documento', cell: (r) => <DocLink type={r.documentType} id={r.documentId} folio={r.documentFolio} line={r.documentLine} />, csv: (r) => r.documentFolio ?? r.documentType },
    { id: 'user', header: 'Usuario', cell: (r) => r.userName ?? 'sistema', csv: (r) => r.userName },
    { id: 'notes', header: 'Notas', cell: (r) => <span className="line-clamp-1 text-xs text-ink-soft">{r.notes ?? ''}</span>, csv: (r) => r.notes, defaultHidden: true },
  ];
}
