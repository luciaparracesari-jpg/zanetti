'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { RECORD_STATUS, WAREHOUSE_TYPE } from '@erp/shared';
import { get } from '@/lib/api';
import { Can } from '@/lib/session';
import { WarehouseDialog, type WarehouseRow } from '@/components/warehouse-dialog';
import { Badge, Button, ErrorBox, PageHeader, Panel, Spinner, StatusBadge } from '@/components/ui';

export default function WarehousesPage() {
  const q = useQuery({ queryKey: ['/warehouses'], queryFn: () => get<WarehouseRow[]>('/warehouses') });
  const [dialog, setDialog] = useState<{ open: boolean; row: WarehouseRow | null }>({ open: false, row: null });

  return (
    <>
      <PageHeader
        title="Almacenes y ubicaciones"
        subtitle="La bodega propia y los almacenes de los canales (Amazon FBA, Liverpool FBL, 99 Minutos) son almacenes separados: su stock nunca se suma dos veces."
        actions={
          <Can perm="almacenes.crear">
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setDialog({ open: true, row: null })}>Nuevo almacén</Button>
          </Can>
        }
      />
      <Panel bodyClassName="p-0">
        {q.isLoading ? <Spinner /> : q.error ? <div className="p-3"><ErrorBox error={q.error} /></div> : (
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-page text-xs text-ink-soft">
                <tr>
                  {['Código', 'Nombre', 'Tipo', 'Canal', 'Ubicación', 'Ubicaciones', 'Negativos', 'Estado', ''].map((h) => (
                    <th key={h} className="px-3 py-1.5 text-left whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(q.data ?? []).map((w) => (
                  <tr key={w.id} className="border-t border-line hover:bg-page">
                    <td className="px-3 py-1.5"><Link href={`/almacenes/${w.id}`} className="font-mono font-medium text-brand hover:underline">{w.code}</Link></td>
                    <td className="px-3 py-1.5">{w.name}</td>
                    <td className="px-3 py-1.5">{WAREHOUSE_TYPE[w.type as keyof typeof WAREHOUSE_TYPE]}</td>
                    <td className="px-3 py-1.5">{w.channelName ?? '—'}</td>
                    <td className="px-3 py-1.5">{[w.city, w.state].filter(Boolean).join(', ') || '—'}</td>
                    <td className="num px-3 py-1.5">{w.locationCount}</td>
                    <td className="px-3 py-1.5">{w.allowNegative ? <Badge tone="bad">Permitidos</Badge> : <span className="text-ink-faint">No</span>}</td>
                    <td className="px-3 py-1.5"><StatusBadge value={w.status} labels={RECORD_STATUS} /></td>
                    <td className="px-3 py-1.5 text-right">
                      <Can perm="almacenes.editar">
                        <Button size="sm" variant="ghost" onClick={() => setDialog({ open: true, row: w })}>Editar</Button>
                      </Can>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <WarehouseDialog open={dialog.open} row={dialog.row} onClose={() => setDialog({ open: false, row: null })} />
    </>
  );
}
