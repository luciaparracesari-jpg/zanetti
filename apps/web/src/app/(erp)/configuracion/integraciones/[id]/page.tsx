'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { ApiError, get, patch, post, qs } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtInt, fmtMoney } from '@/lib/format';
import { Can } from '@/lib/session';
import { ORDER_KIND, PROVIDER, type Connection, type OrderKind, type OrderRow, type StockResult, type StockRow, type Summary, type SyncRun } from '@/lib/integrations';
import { LocalTable, type LocalColumn } from '@/components/local-table';
import { Badge, Button, ErrorBox, PageHeader, Panel, Select, Spinner, Stat, Tabs, cx } from '@/components/ui';
import { useToast } from '@/components/toast';

const STATE: Record<StockRow['state'], { label: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'neutral' }> = {
  CUADRA: { label: 'Cuadra', tone: 'ok' },
  DIFERENCIA: { label: 'Diferencia', tone: 'warn' },
  SIN_LIGAR: { label: 'Sin ligar a SKU', tone: 'bad' },
  NO_ESTA_EN_APLIN: { label: 'No está en APLIN', tone: 'info' },
};

export default function IntegrationPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const conn = useQuery({ queryKey: ['/integrations', id], queryFn: () => get<Connection>(`/integrations/${id}`) });
  const summary = useQuery({ queryKey: ['/integrations', id, 'summary'], queryFn: () => get<Summary>(`/integrations/${id}/summary`) });
  const [tab, setTab] = useState<'existencias' | 'ordenes' | 'vendor' | 'bitacora'>('existencias');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['/integrations'] });
  async function sync() {
    setBusy(true);
    setError(null);
    try {
      await post(`/integrations/${id}/sync`);
      toast.ok('Sincronización terminada.');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e);
    } finally {
      setBusy(false);
      refresh();
    }
  }
  async function toggle(c: Connection) {
    await patch(`/integrations/${id}`, { status: c.status === 'ACTIVA' ? 'PAUSADA' : 'ACTIVA' });
    refresh();
  }
  if (conn.isLoading) return <Spinner />;
  if (conn.error) return <ErrorBox error={conn.error} />;
  const c = conn.data!;
  const blocked = summary.data?.byKind.reduce((a, k) => a + k.blocked, 0) ?? 0;
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Configuración' }, { label: 'Integraciones', href: '/configuracion/integraciones' }, { label: c.code }]}
        title={<span className="flex items-center gap-2">{c.name} <Badge tone={c.status === 'ACTIVA' ? 'ok' : 'neutral'}>{c.status === 'ACTIVA' ? 'Activa' : 'Pausada'}</Badge></span>}
        subtitle={`${PROVIDER[c.provider]} · sólo consulta · credenciales del servidor ${c.credentialsRef}_*${c.credentialsOk ? '' : ' (faltan)'}`}
        actions={
          <Can perm="integraciones.editar">
            <Button onClick={() => toggle(c)}>{c.status === 'ACTIVA' ? 'Pausar' : 'Activar'}</Button>
            <Button variant="primary" icon={<RefreshCw className="h-4 w-4" />} loading={busy} disabled={!c.credentialsOk} onClick={sync}>
              Sincronizar ahora
            </Button>
          </Can>
        }
      />
      <ErrorBox error={error} />
      {c.lastError && !c.lastSyncOk && <ErrorBox error={`Última sincronización con error: ${c.lastError}`} />}
      <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="Última sincronización" value={c.lastSyncAt ? fmtDateTime(c.lastSyncAt) : 'Nunca'} />
        <Stat label="Órdenes" value={fmtInt(summary.data?.byKind.reduce((a, k) => a + k.orders, 0) ?? 0)} />
        <Stat label="Abiertas sin existencia para surtir" value={fmtInt(blocked)} tone={blocked ? 'brand' : undefined} hint="Stock disponible NOT OK en APLIN" />
        <Stat label="Pedidos Vendor (30 días)" value={fmtInt(summary.data?.vendorLast30.reduce((a, v) => a + v.orders, 0) ?? 0)} hint="Señal de faltante en Liverpool FBL" />
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'existencias', label: 'Existencias APLIN vs ERP' },
          { value: 'ordenes', label: 'Órdenes' },
          { value: 'vendor', label: 'Vendor = falta en FBL' },
          { value: 'bitacora', label: 'Bitácora' },
        ]}
      />
      {tab === 'existencias' && <StockView id={id} />}
      {tab === 'ordenes' && <OrdersView id={id} summary={summary.data} />}
      {tab === 'vendor' && <VendorView summary={summary.data} />}
      {tab === 'bitacora' && <RunsView id={id} />}
    </>
  );
}

function StockView({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['/integrations', id, 'stock'], queryFn: () => get<StockResult>(`/integrations/${id}/stock`) });
  const [only, setOnly] = useState<'todo' | 'diferencias'>('diferencias');
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;
  const rows = only === 'todo' ? d.items : d.items.filter((r) => r.state !== 'CUADRA');
  const n = (v: number | null) => (v === null ? <span className="text-ink-faint">—</span> : fmtInt(v));
  const cols: LocalColumn<StockRow>[] = [
    {
      id: 'sku',
      header: 'SKU',
      sticky: true,
      cell: (r) => (
        <div>
          {r.skuId ? <Link href={`/productos/skus/${r.skuId}`} className="font-mono text-xs text-brand hover:underline">{r.skuCode}</Link> : <span className="font-mono text-xs">{r.externalSku}</span>}
          <div className="max-w-72 truncate text-xs text-ink-soft">{r.skuName}</div>
        </div>
      ),
      value: (r) => r.skuCode ?? r.externalSku,
    },
    { id: 'state', header: 'Estado', cell: (r) => <Badge tone={STATE[r.state].tone}>{STATE[r.state].label}</Badge>, value: (r) => STATE[r.state].label },
    { id: 'aOn', header: 'Física', group: 'APLIN', align: 'right', cell: (r) => n(r.aplinOnHand), value: (r) => r.aplinOnHand },
    { id: 'aAv', header: 'Disponible', group: 'APLIN', align: 'right', cell: (r) => n(r.aplinAvailable), value: (r) => r.aplinAvailable },
    { id: 'aCo', header: 'Comprometida', group: 'APLIN', align: 'right', cell: (r) => n(r.aplinCommitted), value: (r) => r.aplinCommitted },
    { id: 'aBo', header: 'Apartada', group: 'APLIN', align: 'right', cell: (r) => n(r.aplinBooked), value: (r) => r.aplinBooked },
    { id: 'aUn', header: 'No disponible', group: 'APLIN', align: 'right', cell: (r) => n(r.aplinUnavailable), value: (r) => r.aplinUnavailable },
    { id: 'eOn', header: 'Física', group: 'ERP', align: 'right', cell: (r) => n(r.erpOnHand), value: (r) => r.erpOnHand },
    { id: 'eAv', header: 'Disponible', group: 'ERP', align: 'right', cell: (r) => n(r.erpAvailable), value: (r) => r.erpAvailable },
    {
      id: 'diff',
      header: 'APLIN − ERP',
      align: 'right',
      cell: (r) => (r.difference === null ? '' : <span className={cx('font-semibold', r.difference < 0 ? 'text-bad' : r.difference > 0 ? 'text-warn' : '')}>{r.difference > 0 ? `+${fmtInt(r.difference)}` : fmtInt(r.difference)}</span>),
      value: (r) => r.difference,
    },
  ];
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        <Stat label="SKU que cuadran" value={fmtInt(d.totals.cuadran)} />
        <Stat label="Con diferencia" value={fmtInt(d.totals.conDiferencia)} tone={d.totals.conDiferencia ? 'brand' : undefined} />
        <Stat label="En APLIN sin ligar" value={fmtInt(d.totals.sinLigar)} />
        <Stat label="Piezas en APLIN" value={fmtInt(d.totals.aplinOnHand)} />
        <Stat label="Piezas APLIN en el ERP" value={fmtInt(d.totals.erpOnHand)} />
      </div>
      <p className="text-xs text-ink-soft">
        APLIN es la fuente de verdad del inventario físico. La diferencia es lo que habría que ajustar en el ERP; en esta fase no se ajusta sola. Datos de APLIN al {d.syncedAt ? fmtDateTime(d.syncedAt) : '—'}.
      </p>
      <LocalTable
        rows={rows}
        columns={cols}
        rowKey={(r) => `${r.skuId ?? ''}|${r.externalSku ?? ''}`}
        search={(r) => `${r.skuCode ?? ''} ${r.externalSku ?? ''} ${r.skuName ?? ''}`}
        csvName="existencias-aplin-vs-erp"
        toolbar={
          <div className="w-44">
            <Select value={only} onChange={(e) => setOnly(e.target.value as 'todo' | 'diferencias')}>
              <option value="diferencias">Sólo lo que no cuadra</option>
              <option value="todo">Todos los SKU</option>
            </Select>
          </div>
        }
        empty={d.items.length ? 'Todo cuadra.' : 'Sin datos: sincroniza primero.'}
      />
    </div>
  );
}

function OrdersView({ id, summary }: { id: string; summary?: Summary }) {
  const [kind, setKind] = useState<OrderKind | ''>('');
  const [alert, setAlert] = useState(false);
  const q = useQuery({
    queryKey: ['/integrations', id, 'orders', kind, alert],
    queryFn: () => get<OrderRow[]>(`/integrations/${id}/orders${qs({ kind: kind || undefined, alert: alert ? '1' : undefined, limit: 2000 })}`),
  });
  const cols: LocalColumn<OrderRow>[] = [
    { id: 'num', header: 'Número', cell: (o) => <span className="font-mono text-xs">{o.orderNumber}</span>, value: (o) => o.orderNumber },
    { id: 'kind', header: 'Qué es', cell: (o) => ORDER_KIND[o.kind], value: (o) => ORDER_KIND[o.kind] },
    { id: 'created', header: 'Creada', cell: (o) => fmtDate(o.externalCreatedAt), value: (o) => o.externalCreatedAt },
    { id: 'status', header: 'Estado', cell: (o) => <span className="text-xs">{[o.status, o.substatus].filter(Boolean).join(' · ')}</span>, value: (o) => o.status },
    {
      id: 'stock',
      header: 'Existencia',
      cell: (o) => (o.stockOk === null ? '' : o.stockOk ? <Badge tone="ok">OK</Badge> : <Badge tone={o.open ? 'bad' : 'neutral'}>NOT OK</Badge>),
      value: (o) => (o.stockOk === null ? '' : o.stockOk ? 'OK' : 'NOT OK'),
    },
    { id: 'pieces', header: 'Piezas', align: 'right', cell: (o) => fmtInt(o.pieces), value: (o) => o.pieces },
    { id: 'total', header: 'Total', align: 'right', cell: (o) => (o.total && Number(o.total) ? fmtMoney(o.total) : ''), value: (o) => (o.total ? Number(o.total) : null) },
    {
      id: 'lines',
      header: 'Productos',
      cell: (o) => <span className="text-xs">{o.lines.map((l) => `${l.skuCode ?? `${l.sku} (sin ligar)`} × ${l.quantity}`).join(', ')}</span>,
      value: (o) => o.lines.map((l) => `${l.skuCode ?? l.sku} x ${l.quantity}`).join(', '),
    },
  ];
  return (
    <div className="grid gap-3">
      {summary && (
        <Panel title="Órdenes por tipo">
          <div className="flex flex-wrap gap-2 text-sm">
            {summary.byKind.map((k) => (
              <button key={k.kind} onClick={() => setKind(kind === k.kind ? '' : k.kind)} className={cx('rounded border px-2 py-1', kind === k.kind ? 'border-brand bg-brand-soft' : 'border-line')}>
                {ORDER_KIND[k.kind]}: <b>{fmtInt(k.orders)}</b> · {fmtInt(k.pieces)} pzas{k.blocked ? <span className="text-bad"> · {k.blocked} sin existencia</span> : ''}
              </button>
            ))}
          </div>
        </Panel>
      )}
      {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : (
        <LocalTable
          rows={q.data!}
          columns={cols}
          rowKey={(o) => o.id}
          search={(o) => `${o.orderNumber} ${o.lines.map((l) => l.skuCode ?? l.sku).join(' ')}`}
          csvName="ordenes-aplin"
          rowClassName={(o) => (o.open && o.stockOk === false ? 'bg-bad-soft/40' : undefined)}
          toolbar={
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={alert} onChange={(e) => setAlert(e.target.checked)} /> Sólo abiertas sin existencia
            </label>
          }
          empty="Sin órdenes."
        />
      )}
    </div>
  );
}

function VendorView({ summary }: { summary?: Summary }) {
  if (!summary) return <Spinner />;
  const cols: LocalColumn<Summary['vendorLast30'][number]>[] = [
    { id: 'sku', header: 'SKU', cell: (v) => <span className="font-mono text-xs">{v.skuCode ?? `${v.externalSku} (sin ligar)`}</span>, value: (v) => v.skuCode ?? v.externalSku },
    { id: 'orders', header: 'Pedidos', align: 'right', cell: (v) => fmtInt(v.orders), value: (v) => v.orders },
    { id: 'pieces', header: 'Piezas', align: 'right', cell: (v) => fmtInt(v.pieces), value: (v) => v.pieces },
    { id: 'last', header: 'Último', cell: (v) => fmtDate(v.last), value: (v) => v.last },
  ];
  return (
    <div className="grid gap-2">
      <p className="text-sm text-ink-soft">
        Pedidos de Liverpool surtidos por Vendor desde APLIN en los últimos 30 días. Lo ideal es que todo salga de Liverpool FBL: si un SKU aparece aquí, faltó en FBL y conviene mandarle con prioridad (pestaña Envíos del Reabasto).
      </p>
      <LocalTable rows={summary.vendorLast30} columns={cols} rowKey={(v) => `${v.skuCode}|${v.externalSku}`} csvName="vendor-30-dias" empty="Sin pedidos Vendor en 30 días." />
    </div>
  );
}

function RunsView({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['/integrations', id, 'runs'], queryFn: () => get<SyncRun[]>(`/integrations/${id}/runs`) });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const cols: LocalColumn<SyncRun>[] = [
    { id: 'at', header: 'Inicio', cell: (r) => fmtDateTime(r.startedAt), value: (r) => r.startedAt },
    { id: 'res', header: 'Qué', cell: (r) => (r.resource === 'productos' ? 'Productos y existencias' : r.resource === 'ordenes' ? 'Órdenes' : r.resource), value: (r) => r.resource },
    { id: 'st', header: 'Resultado', cell: (r) => <Badge tone={r.status === 'OK' ? 'ok' : r.status === 'ERROR' ? 'bad' : 'info'}>{r.status === 'OK' ? 'OK' : r.status === 'ERROR' ? 'Error' : 'En curso'}</Badge>, value: (r) => r.status },
    { id: 'det', header: 'Detalle', cell: (r) => <span className="text-xs">{r.error ?? (r.stats ? JSON.stringify(r.stats).replace(/[{}"]/g, '').replace(/,/g, ', ') : '')}</span>, value: (r) => r.error ?? JSON.stringify(r.stats) },
  ];
  return <LocalTable rows={q.data!} columns={cols} rowKey={(r) => r.id} empty="Todavía no se ha sincronizado." />;
}
