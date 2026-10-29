'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { get } from '@/lib/api';
import { fmtDate, fmtInt } from '@/lib/format';
import { CONTAINER_STATUS, fmtDec } from '@/lib/replenishment';
import { Can } from '@/lib/session';
import { LocalTable, type LocalColumn } from '@/components/local-table';
import { Badge, Button, ErrorBox, PageHeader, Spinner } from '@/components/ui';

interface Row {
  id: string;
  code: string;
  status: string;
  eta: string | null;
  etaSource: 'MANUAL' | 'PUERTO' | 'ETD' | 'PEDIDO';
  etd: string | null;
  portEta: string | null;
  lastOrderDate: string | null;
  qty: number;
  skus: number;
  cbm: number;
  capacityCbm: string | null;
  receivedAt: string | null;
}

const TONE: Record<string, 'ok' | 'warn' | 'bad' | 'info' | 'neutral'> = {
  PLANEADO: 'info', EN_PRODUCCION: 'warn', EN_NAVIERA: 'warn', EN_ADUANA: 'warn', RECIBIDO: 'ok', PERDIDO: 'bad', CANCELADO: 'neutral',
};
const containerBadge = (s: string) => <Badge tone={TONE[s] ?? 'neutral'}>{CONTAINER_STATUS[s] ?? s}</Badge>;
const SOURCE: Record<string, string> = { MANUAL: 'capturada', PUERTO: 'llegada a puerto + puerto, aduana y traslado', ETD: 'ETD + naviera + aduana', PEDIDO: 'pedido + lead time' };

export default function ContainersPage() {
  const q = useQuery({ queryKey: ['/containers'], queryFn: () => get<Row[]>('/containers') });
  const cols: LocalColumn<Row>[] = [
    { id: 'code', header: 'Contenedor', cell: (r) => <Link href={`/compras/contenedores/${r.id}`} className="font-mono text-brand hover:underline">{r.code}</Link>, value: (r) => r.code },
    { id: 'status', header: 'Estado', cell: (r) => containerBadge(r.status), value: (r) => CONTAINER_STATUS[r.status] },
    { id: 'order', header: 'Último pedido', cell: (r) => fmtDate(r.lastOrderDate), value: (r) => r.lastOrderDate },
    { id: 'etd', header: 'ETD', cell: (r) => fmtDate(r.etd), value: (r) => r.etd },
    { id: 'port', header: 'Llega a puerto', cell: (r) => fmtDate(r.portEta), value: (r) => r.portEta },
    { id: 'eta', header: 'Llega a APLIN', cell: (r) => (r.status === 'RECIBIDO' ? <span className="text-ink-soft">recibido {fmtDate(r.receivedAt?.slice(0, 10))}</span> : <span title={SOURCE[r.etaSource]}>{fmtDate(r.eta)}</span>), value: (r) => r.eta },
    { id: 'skus', header: 'SKU', align: 'right', cell: (r) => fmtInt(r.skus), value: (r) => r.skus },
    { id: 'qty', header: 'Piezas', align: 'right', cell: (r) => fmtInt(r.qty), value: (r) => r.qty },
    { id: 'cbm', header: 'CBM', align: 'right', cell: (r) => fmtDec(r.cbm), value: (r) => r.cbm },
  ];
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Compras' }, { label: 'Contenedores' }]}
        title="Contenedores"
        subtitle="Mercancía pedida a China (Zanetti, Lean Travel…) que viaja junta. Lo que está en producción, en el mar o en aduana cuenta en el reabasto; al llegar se recibe en APLIN."
        actions={
          <Can perm="compras.crear">
            <Link href="/importar?plantilla=contenedores"><Button icon={<Upload className="h-4 w-4" />}>Cargar desde Excel</Button></Link>
          </Can>
        }
      />
      {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : (
        <LocalTable rows={q.data!} columns={cols} rowKey={(r) => r.id} search={(r) => `${r.code} ${CONTAINER_STATUS[r.status]}`} searchPlaceholder="Buscar contenedor…" csvName="contenedores" empty="Sin contenedores. Cárgalos desde Excel." />
      )}
    </>
  );
}
