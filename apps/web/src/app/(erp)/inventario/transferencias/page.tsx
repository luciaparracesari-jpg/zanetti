'use client';

import Link from 'next/link';
import { Plus } from 'lucide-react';
import { TRANSFER_STATUS } from '@erp/shared';
import { fmtDateTime, fmtInt } from '@/lib/format';
import { useWarehouses } from '@/lib/inventory';
import { Can } from '@/lib/session';
import { DataTable, optionsFrom, type Column } from '@/components/data-table';
import { Button, PageHeader, StatusBadge } from '@/components/ui';

interface Row {
  id: string;
  folio: string;
  status: string;
  reference: string | null;
  originCode: string;
  destinationCode: string;
  createdAt: string;
  shippedAt: string | null;
  receivedAt: string | null;
  createdByName: string | null;
  lines: number;
  qtyRequested: number;
  qtyShipped: number;
  qtyReceived: number;
}

export default function TransfersPage() {
  const whs = useWarehouses();
  const whOpts = (whs.data ?? []).map((w) => ({ value: w.id, label: w.code }));
  const columns: Column<Row>[] = [
    { id: 'folio', header: 'Folio', cell: (r) => <span className="font-mono">{r.folio}</span>, csv: (r) => r.folio },
    { id: 'route', header: 'Ruta', cell: (r) => <span className="whitespace-nowrap">{r.originCode} → {r.destinationCode}</span>, csv: (r) => `${r.originCode} > ${r.destinationCode}` },
    { id: 'ref', header: 'Referencia', cell: (r) => <span className="font-mono text-xs">{r.reference ?? '—'}</span>, csv: (r) => r.reference },
    { id: 'status', header: 'Estado', cell: (r) => <StatusBadge value={r.status} labels={TRANSFER_STATUS} />, csv: (r) => TRANSFER_STATUS[r.status as keyof typeof TRANSFER_STATUS] },
    { id: 'lines', header: 'SKU', align: 'right', cell: (r) => fmtInt(r.lines), csv: (r) => r.lines },
    { id: 'req', header: 'Solicitado', align: 'right', cell: (r) => fmtInt(r.qtyRequested), csv: (r) => r.qtyRequested },
    { id: 'ship', header: 'Enviado', align: 'right', cell: (r) => (r.shippedAt ? fmtInt(r.qtyShipped) : '—'), csv: (r) => r.qtyShipped },
    {
      id: 'recv',
      header: 'Recibido',
      align: 'right',
      cell: (r) => (r.shippedAt ? <span className={r.qtyReceived < r.qtyShipped && r.receivedAt ? 'text-bad' : ''}>{fmtInt(r.qtyReceived)}</span> : '—'),
      csv: (r) => r.qtyReceived,
    },
    { id: 'created', header: 'Creada', cell: (r) => fmtDateTime(r.createdAt), csv: (r) => r.createdAt },
    { id: 'shipped', header: 'Enviada', cell: (r) => fmtDateTime(r.shippedAt), csv: (r) => r.shippedAt, defaultHidden: true },
    { id: 'received', header: 'Recibida', cell: (r) => fmtDateTime(r.receivedAt), csv: (r) => r.receivedAt, defaultHidden: true },
    { id: 'user', header: 'Creó', cell: (r) => r.createdByName ?? '—', csv: (r) => r.createdByName, defaultHidden: true },
  ];
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Inventario', href: '/inventario' }, { label: 'Transferencias' }]}
        title="Transferencias entre almacenes"
        subtitle="Envíos de APLIN a Amazon FBA y Liverpool FBL / 99 Minutos (o de regreso). Autorizar aparta la mercancía; enviar la deja en tránsito; recibir la suma al destino con el costo de sus lotes."
        actions={
          <Can perm="transferencias.crear">
            <Link href="/inventario/transferencias/nueva"><Button variant="primary" icon={<Plus className="h-4 w-4" />}>Nueva transferencia</Button></Link>
          </Can>
        }
      />
      <DataTable<Row>
        tableKey="transfers"
        endpoint="/transfers"
        columns={columns}
        rowId={(r) => r.id}
        rowHref={(r) => `/inventario/transferencias/${r.id}`}
        exportPerm="transferencias.exportar"
        exportName="transferencias"
        searchPlaceholder="Folio, referencia (FBA15…) o SKU…"
        filters={[
          { key: 'status', label: 'Estado', options: [{ value: 'ABIERTAS', label: 'abiertas (borrador, autorizadas, en tránsito)' }, ...optionsFrom(TRANSFER_STATUS)] },
          { key: 'originId', label: 'Origen', options: whOpts },
          { key: 'destinationId', label: 'Destino', options: whOpts },
        ]}
      />
    </>
  );
}
