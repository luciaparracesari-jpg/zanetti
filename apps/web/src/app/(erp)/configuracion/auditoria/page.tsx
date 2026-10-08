'use client';

import { useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { MODULES, MODULE_LABELS } from '@erp/shared';
import { fmtDateTime } from '@/lib/format';
import { DataTable, type Column } from '@/components/data-table';
import { Button, Dialog, Field, Input, PageHeader } from '@/components/ui';

interface AuditRow {
  id: number;
  occurredAt: string;
  userEmail: string | null;
  action: string;
  module: string;
  entity: string;
  entityId: string | null;
  summary: string | null;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  ip: string | null;
}

const ACTIONS = ['CREAR', 'EDITAR', 'ELIMINAR', 'BAJA', 'EDITAR_PERMISOS', 'EDITAR_COMPONENTES', 'AGREGAR_CODIGO', 'QUITAR_CODIGO', 'LOGIN', 'LOGIN_FALLIDO', 'LOGOUT', 'CAMBIO_CONTRASENA', 'RESTABLECER_CONTRASENA'];
const fmtVal = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export default function AuditPage() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [row, setRow] = useState<AuditRow | null>(null);
  const setDate = (k: 'from' | 'to', v: string) => {
    const n = new URLSearchParams(sp.toString());
    if (v) n.set(k, v);
    else n.delete(k);
    n.delete('page');
    router.replace(`${pathname}?${n}`, { scroll: false });
  };

  const columns: Column<AuditRow>[] = [
    { id: 'when', header: 'Fecha y hora', cell: (r) => <span className="whitespace-nowrap">{fmtDateTime(r.occurredAt)}</span>, csv: (r) => r.occurredAt },
    { id: 'user', header: 'Usuario', cell: (r) => r.userEmail ?? 'sistema', csv: (r) => r.userEmail },
    { id: 'module', header: 'Módulo', cell: (r) => MODULE_LABELS[r.module as keyof typeof MODULE_LABELS] ?? r.module, csv: (r) => r.module },
    { id: 'action', header: 'Acción', cell: (r) => <span className="font-mono text-xs">{r.action}</span>, csv: (r) => r.action },
    { id: 'summary', header: 'Descripción', cell: (r) => r.summary ?? '—', csv: (r) => r.summary },
    { id: 'entity', header: 'Registro', cell: (r) => <span className="font-mono text-xs">{r.entity}</span>, csv: (r) => `${r.entity}:${r.entityId ?? ''}`, defaultHidden: true },
    { id: 'old', header: 'Valor anterior', cell: () => null, csv: (r) => (r.oldValues ? JSON.stringify(r.oldValues) : ''), defaultHidden: true },
    { id: 'new', header: 'Valor nuevo', cell: () => null, csv: (r) => (r.newValues ? JSON.stringify(r.newValues) : ''), defaultHidden: true },
    { id: 'ip', header: 'IP', cell: (r) => r.ip ?? '—', csv: (r) => r.ip, defaultHidden: true },
  ];

  return (
    <>
      <PageHeader title="Auditoría" subtitle="Bitácora de sólo inserción: la base de datos rechaza cualquier edición o borrado." />
      <DataTable<AuditRow>
        tableKey="audit"
        endpoint="/audit-logs"
        columns={columns}
        rowId={(r) => String(r.id)}
        onRowClick={(r) => setRow(r)}
        exportPerm="auditoria.exportar"
        exportName="auditoria"
        urlParams={['from', 'to']}
        searchPlaceholder="Descripción, usuario o registro…"
        filters={[
          { key: 'module', label: 'Módulo', options: MODULES.map((m) => ({ value: m, label: MODULE_LABELS[m] })) },
          { key: 'action', label: 'Acción', options: ACTIONS.map((a) => ({ value: a, label: a })) },
        ]}
        toolbar={
          <span className="flex items-center gap-1 text-xs text-ink-soft">
            Del <Input type="date" value={sp.get('from') ?? ''} onChange={(e) => setDate('from', e.target.value)} className="h-7 w-36 text-xs" />
            al <Input type="date" value={sp.get('to') ?? ''} onChange={(e) => setDate('to', e.target.value)} className="h-7 w-36 text-xs" />
          </span>
        }
      />
      <Dialog open={Boolean(row)} onClose={() => setRow(null)} title="Detalle del cambio" footer={<Button onClick={() => setRow(null)}>Cerrar</Button>}>
        {row && (
          <div className="flex flex-col gap-3 text-sm">
            <div className="grid grid-cols-2 gap-2">
              <Field label="Fecha y hora"><span>{fmtDateTime(row.occurredAt)}</span></Field>
              <Field label="Usuario"><span>{row.userEmail ?? 'sistema'}</span></Field>
              <Field label="Acción"><span className="font-mono">{row.action}</span></Field>
              <Field label="Registro"><span className="font-mono text-xs break-all">{row.entity} · {row.entityId ?? '—'}</span></Field>
            </div>
            <p>{row.summary}</p>
            {(row.oldValues || row.newValues) && (
              <table className="w-full text-xs">
                <thead className="bg-page text-ink-soft"><tr><th className="px-2 py-1 text-left">Campo</th><th className="px-2 py-1 text-left">Anterior</th><th className="px-2 py-1 text-left">Nuevo</th></tr></thead>
                <tbody>
                  {[...new Set([...Object.keys(row.oldValues ?? {}), ...Object.keys(row.newValues ?? {})])].map((k) => (
                    <tr key={k} className="border-t border-line align-top">
                      <td className="px-2 py-1 font-mono">{k}</td>
                      <td className="px-2 py-1 break-all">{fmtVal(row.oldValues?.[k])}</td>
                      <td className="px-2 py-1 font-medium break-all">{fmtVal(row.newValues?.[k])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}
