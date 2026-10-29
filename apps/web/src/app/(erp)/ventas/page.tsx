'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { get, qs } from '@/lib/api';
import { fmtDate, fmtInt, fmtMoney } from '@/lib/format';
import { Can } from '@/lib/session';
import { DataTable, type Column } from '@/components/data-table';
import { LocalTable, type LocalColumn } from '@/components/local-table';
import { Button, ErrorBox, PageHeader, Panel, Select, Spinner, Tabs, cx } from '@/components/ui';

interface Monthly {
  months: string[];
  totalsByChannel: Record<string, Record<string, number>>;
  skus: { skuId: string | null; skuCode: string; skuName: string; total: number; byMonth: Record<string, number>; byChannel: Record<string, number> }[];
}
interface Line {
  id: string;
  saleDate: string;
  channelCode: string;
  origin: string;
  kind: 'VENTA' | 'DEVOLUCION';
  qty: number;
  amount: string | null;
  externalCode: string;
  externalSku: string | null;
  orderRef: string | null;
  skuId: string | null;
  skuCode: string | null;
  skuName: string | null;
}
interface Unmapped { channel: string; code: string; sku: string | null; lines: number; qty: number; first: string; last: string }

const MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const monthLabel = (m: string) => `${MES[Number(m.slice(5, 7)) - 1]}-${m.slice(2, 4)}`;
const CHANNELS = ['AMAZON', 'LIVERPOOL', 'SHOPIFY'];
const ORIGIN: Record<string, string> = { 'AMZ-FBA': 'Amazon FBA', 'AMZ-MFN': 'Amazon MFN', LIVERPOOL: 'Liverpool', SHOPIFY: 'Shopify' };

export default function SalesPage() {
  const [tab, setTab] = useState<'mensual' | 'detalle' | 'sinligar'>('mensual');
  const [channel, setChannel] = useState('');
  const monthly = useQuery({ queryKey: ['/sales/monthly', channel], queryFn: () => get<Monthly>(`/sales/monthly${qs({ months: 12, channel: channel || undefined })}`) });
  const unmapped = useQuery({ queryKey: ['/sales/unmapped'], queryFn: () => get<Unmapped[]>('/sales/unmapped') });
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Ventas' }, { label: 'Ventas por canal' }]}
        title="Ventas por canal"
        subtitle="Piezas netas (ventas − devoluciones) de los reportes de Amazon, Liverpool y Shopify. Son la base de la venta diaria del reabasto."
        actions={
          <Can perm="pedidos.crear">
            <Link href="/importar?plantilla=ventas-amazon"><Button icon={<Upload className="h-4 w-4" />}>Importar reportes</Button></Link>
          </Can>
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'mensual', label: 'Por mes' },
          { value: 'detalle', label: 'Detalle' },
          { value: 'sinligar', label: `Códigos sin ligar${unmapped.data?.length ? ` (${unmapped.data.length})` : ''}` },
        ]}
      />
      {tab === 'mensual' && (monthly.isLoading ? <Spinner /> : monthly.error ? <ErrorBox error={monthly.error} /> : <MonthlyView data={monthly.data!} channel={channel} setChannel={setChannel} />)}
      {tab === 'detalle' && <Detail />}
      {tab === 'sinligar' && (unmapped.isLoading ? <Spinner /> : <UnmappedView rows={unmapped.data ?? []} />)}
    </>
  );
}

function MonthlyView({ data, channel, setChannel }: { data: Monthly; channel: string; setChannel: (c: string) => void }) {
  type R = Monthly['skus'][number];
  const cols: LocalColumn<R>[] = useMemo(
    () => [
      {
        id: 'sku',
        header: 'SKU',
        sticky: true,
        cell: (r) => (
          <div>
            {r.skuId ? <Link href={`/productos/skus/${r.skuId}`} className="font-mono text-xs text-brand hover:underline">{r.skuCode}</Link> : <span className="text-xs text-warn">{r.skuCode}</span>}
            <div className="max-w-[240px] truncate text-xs text-ink-soft" title={r.skuName}>{r.skuName}</div>
          </div>
        ),
        value: (r) => r.skuCode,
      },
      ...data.months.map<LocalColumn<R>>((m) => ({ id: m, header: monthLabel(m), csvHeader: m, align: 'right', cell: (r) => (r.byMonth[m] ? fmtInt(r.byMonth[m]) : <span className="text-ink-faint">—</span>), value: (r) => r.byMonth[m] ?? 0 })),
      { id: 'total', header: 'Total', align: 'right', cell: (r) => <b>{fmtInt(r.total)}</b>, value: (r) => r.total },
      ...(channel ? [] : CHANNELS.map<LocalColumn<R>>((c) => ({ id: `ch-${c}`, header: c[0] + c.slice(1).toLowerCase(), group: 'Por canal', align: 'right', cell: (r) => fmtInt(r.byChannel[c] ?? 0), value: (r) => r.byChannel[c] ?? 0 }))),
    ],
    [data.months, channel],
  );
  return (
    <div className="grid gap-3">
      <Panel title="Piezas netas por mes y canal" bodyClassName="p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-page text-xs text-ink-soft">
            <tr>
              <th className="px-2 py-1 text-left">Canal</th>
              {data.months.map((m) => <th key={m} className="px-2 py-1 text-right">{monthLabel(m)}</th>)}
            </tr>
          </thead>
          <tbody>
            {Object.entries(data.totalsByChannel).map(([c, byM]) => (
              <tr key={c} className="border-t border-line">
                <td className="px-2 py-1">{c}</td>
                {data.months.map((m) => <td key={m} className="px-2 py-1 text-right tabular-nums">{fmtInt(byM[m] ?? 0)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <LocalTable
        rows={data.skus}
        columns={cols}
        rowKey={(r) => r.skuId ?? r.skuCode}
        search={(r) => `${r.skuCode} ${r.skuName}`}
        csvName="ventas-por-mes"
        initialSort={{ id: 'total', dir: 'desc' }}
        toolbar={
          <div className="w-44">
            <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="">Todos los canales</option>
              {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </div>
        }
      />
    </div>
  );
}

function Detail() {
  const columns: Column<Line>[] = [
    { id: 'saleDate', header: 'Fecha', sortKey: 'saleDate', cell: (r) => fmtDate(r.saleDate), csv: (r) => r.saleDate },
    { id: 'channel', header: 'Canal', sortKey: 'channel', cell: (r) => ORIGIN[r.origin] ?? r.channelCode, csv: (r) => r.origin },
    { id: 'skuCode', header: 'SKU', sortKey: 'skuCode', cell: (r) => (r.skuId ? <Link href={`/productos/skus/${r.skuId}`} className="font-mono text-xs text-brand hover:underline">{r.skuCode}</Link> : <span className="text-xs text-warn">sin ligar</span>), csv: (r) => r.skuCode },
    { id: 'name', header: 'Nombre', cell: (r) => <span className="text-xs">{r.skuName ?? '—'}</span>, csv: (r) => r.skuName },
    { id: 'code', header: 'Código del canal', cell: (r) => <span className="font-mono text-xs">{r.externalCode}</span>, csv: (r) => r.externalCode },
    { id: 'order', header: 'Pedido / documento', cell: (r) => <span className="font-mono text-xs">{r.orderRef ?? '—'}</span>, csv: (r) => r.orderRef },
    { id: 'qty', header: 'Piezas', align: 'right', sortKey: 'qty', cell: (r) => <span className={cx('tabular-nums', r.qty < 0 && 'text-bad')}>{fmtInt(r.qty)}</span>, csv: (r) => r.qty },
    { id: 'amount', header: 'Venta sin IVA', align: 'right', cell: (r) => (r.amount ? fmtMoney(r.amount) : '—'), csv: (r) => r.amount },
  ];
  return (
    <DataTable<Line>
      tableKey="sales"
      endpoint="/sales"
      columns={columns}
      rowId={(r) => r.id}
      exportPerm="pedidos.exportar"
      exportName="ventas"
      searchPlaceholder="SKU, ASIN, artículo o pedido…"
      filters={[
        { key: 'channel', label: 'Canal', options: CHANNELS.map((c) => ({ value: c, label: c })) },
        { key: 'origin', label: 'Origen', options: Object.entries(ORIGIN).map(([value, label]) => ({ value, label })) },
        { key: 'kind', label: 'Tipo', options: [{ value: 'VENTA', label: 'ventas' }, { value: 'DEVOLUCION', label: 'devoluciones' }] },
        { key: 'unmapped', label: 'SKU', options: [{ value: '1', label: 'sin ligar' }] },
      ]}
    />
  );
}

function UnmappedView({ rows }: { rows: Unmapped[] }) {
  const cols: LocalColumn<Unmapped>[] = [
    { id: 'ch', header: 'Canal', cell: (r) => r.channel, value: (r) => r.channel },
    { id: 'code', header: 'Código', cell: (r) => <span className="font-mono text-xs">{r.code}</span>, value: (r) => r.code },
    { id: 'sku', header: 'SKU en el reporte', cell: (r) => <span className="font-mono text-xs">{r.sku ?? '—'}</span>, value: (r) => r.sku },
    { id: 'lines', header: 'Renglones', align: 'right', cell: (r) => fmtInt(r.lines), value: (r) => r.lines },
    { id: 'qty', header: 'Piezas', align: 'right', cell: (r) => fmtInt(r.qty), value: (r) => r.qty },
    { id: 'range', header: 'Periodo', cell: (r) => `${fmtDate(r.first)} – ${fmtDate(r.last)}`, value: (r) => r.first },
  ];
  return (
    <>
      <p className="mb-2 text-sm text-ink-soft">
        Ventas guardadas con un código que no está ligado a un SKU maestro: no entran al reabasto hasta ligarlas. Regístralo como publicación del SKU o crea una{' '}
        <Link href="/productos/equivalencias" className="text-brand underline">equivalencia de código</Link> (se ligan solas las ventas ya importadas).
      </p>
      <LocalTable rows={rows} columns={cols} rowKey={(r) => `${r.channel}|${r.code}`} search={(r) => `${r.code} ${r.sku ?? ''}`} csvName="ventas-sin-ligar" empty="Todas las ventas están ligadas a un SKU." />
    </>
  );
}
