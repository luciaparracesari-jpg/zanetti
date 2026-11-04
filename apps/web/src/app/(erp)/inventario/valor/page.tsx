'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';
import { fmtInt, fmtMoney } from '@/lib/format';
import { CONTAINER_STATUS } from '@/lib/replenishment';
import { COST_STATUS, PO_STATUS, fmtCur } from '@/lib/purchasing';
import { LocalTable, type LocalColumn } from '@/components/local-table';
import { Badge, ErrorBox, PageHeader, Panel, Spinner, Stat, StatusBadge } from '@/components/ui';

interface LotRow {
  lot: string;
  container: boolean;
  costStatus: string | null;
  skus: number;
  byWarehouse: Record<string, { qty: number; value: string }>;
  transitQty: number;
  transitValue: string;
  qty: number;
  value: string;
  provisional: number;
  noCost: number;
}
interface OnTheWay {
  id: string;
  code: string;
  status: string;
  costStatus: string;
  pieces: number;
  merchMxn: string;
  dutyMxn: string;
  expensesMxn: string;
  total: string;
  unpricedPieces: number;
  issues: number;
}
interface OpenOrder {
  id: string;
  folio: string;
  supplier: string;
  status: string;
  currency: string;
  pending: number;
  pendingValue: string;
  pendingMxn: string | null;
  unpriced: number;
  paid: string;
  paidMxn: string | null;
}
interface Valuation {
  warehouses: string[];
  lots: LotRow[];
  onTheWay: OnTheWay[];
  openOrders: OpenOrder[];
  totals: { onHandQty: number; onHand: string; transitQty: number; transit: string; onTheWayQty: number; onTheWay: string; openOrdersQty: number; openOrders: string; provisionalQty: number; noCostQty: number; inventory: string; all: string };
}

export default function ValuationPage() {
  const q = useQuery({ queryKey: ['/inventory-valuation', 'containers'], queryFn: () => get<Valuation>('/inventory-valuation/containers') });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const v = q.data!;
  const cols: LocalColumn<LotRow>[] = [
    {
      id: 'lot',
      header: 'Contenedor / lote',
      cell: (r) => (r.lot === 'OTROS' ? <span className="text-ink-soft">Otros lotes (ajustes, kits armados)</span> : <span className="font-semibold">{r.lot}</span>),
      value: (r) => (r.lot === 'OTROS' ? -1 : Number(r.lot.replace(/\D/g, '')) || 0),
    },
    {
      id: 'cost',
      header: 'Costo',
      cell: (r) =>
        r.noCost > 0 ? <Badge tone="bad">{fmtInt(r.noCost)} pzas sin costo</Badge> : r.provisional > 0 ? <Badge tone="warn">Provisional</Badge> : r.costStatus ? <StatusBadge value={r.costStatus} labels={COST_STATUS} /> : <Badge tone="ok">Final</Badge>,
      value: (r) => r.noCost * 1e6 + r.provisional,
    },
    { id: 'skus', header: 'SKU', align: 'right', cell: (r) => fmtInt(r.skus), value: (r) => r.skus },
    ...v.warehouses.map(
      (w): LocalColumn<LotRow> => ({
        id: `wh-${w}`,
        header: w,
        group: 'Piezas por almacén',
        align: 'right',
        cell: (r) => (r.byWarehouse[w] ? fmtInt(r.byWarehouse[w].qty) : <span className="text-ink-faint">—</span>),
        value: (r) => r.byWarehouse[w]?.qty ?? 0,
      }),
    ),
    { id: 'transit', header: 'En camino', group: 'Piezas por almacén', align: 'right', cell: (r) => (r.transitQty ? fmtInt(r.transitQty) : <span className="text-ink-faint">—</span>), value: (r) => r.transitQty },
    { id: 'qty', header: 'Total piezas', align: 'right', cell: (r) => <b>{fmtInt(r.qty + r.transitQty)}</b>, value: (r) => r.qty + r.transitQty },
    { id: 'value', header: 'Valor en almacenes', align: 'right', cell: (r) => fmtMoney(r.value), value: (r) => Number(r.value) },
    { id: 'tvalue', header: 'Valor en camino', align: 'right', cell: (r) => (Number(r.transitValue) ? fmtMoney(r.transitValue) : '—'), value: (r) => Number(r.transitValue) },
    { id: 'total', header: 'Valor total', align: 'right', cell: (r) => <b>{fmtMoney(Number(r.value) + Number(r.transitValue))}</b>, value: (r) => Number(r.value) + Number(r.transitValue) },
  ];
  const owCols: LocalColumn<OnTheWay>[] = [
    { id: 'code', header: 'Contenedor', cell: (r) => <Link href={`/compras/contenedores/${r.id}`} className="font-semibold text-brand hover:underline">{r.code}</Link>, value: (r) => r.code },
    { id: 'status', header: 'Estado', cell: (r) => <span className="text-xs">{CONTAINER_STATUS[r.status] ?? r.status} · {COST_STATUS[r.costStatus]}</span>, value: (r) => r.status },
    { id: 'pieces', header: 'Piezas', align: 'right', cell: (r) => fmtInt(r.pieces), value: (r) => r.pieces },
    { id: 'merch', header: 'Mercancía', align: 'right', cell: (r) => fmtMoney(r.merchMxn), value: (r) => Number(r.merchMxn) },
    { id: 'duty', header: 'Arancel', align: 'right', cell: (r) => fmtMoney(r.dutyMxn), value: (r) => Number(r.dutyMxn) },
    { id: 'exp', header: 'Gastos capturados', align: 'right', cell: (r) => fmtMoney(r.expensesMxn), value: (r) => Number(r.expensesMxn) },
    { id: 'total', header: 'Costo estimado', align: 'right', cell: (r) => <b>{fmtMoney(r.total)}</b>, value: (r) => Number(r.total) },
    { id: 'issues', header: 'Pendientes', cell: (r) => (r.unpricedPieces ? <Badge tone="warn">{fmtInt(r.unpricedPieces)} pzas sin precio</Badge> : r.issues ? <Badge tone="warn">{r.issues} pendientes</Badge> : <Badge tone="ok">Completo</Badge>), value: (r) => r.unpricedPieces },
  ];
  const ooCols: LocalColumn<OpenOrder>[] = [
    { id: 'folio', header: 'Orden', cell: (r) => <Link href={`/compras/ordenes/${r.id}`} className="font-mono text-xs font-semibold text-brand hover:underline">{r.folio}</Link>, value: (r) => r.folio },
    { id: 'sup', header: 'Proveedor', cell: (r) => r.supplier, value: (r) => r.supplier },
    { id: 'status', header: 'Estado', cell: (r) => <StatusBadge value={r.status} labels={PO_STATUS} />, value: (r) => r.status },
    { id: 'pending', header: 'Piezas sin contenedor', align: 'right', cell: (r) => fmtInt(r.pending), value: (r) => r.pending },
    { id: 'value', header: 'Valor', align: 'right', cell: (r) => <span>{fmtCur(r.pendingValue, r.currency)}{r.unpriced ? <Badge tone="warn" className="ml-1">{r.unpriced} sin precio</Badge> : null}</span>, value: (r) => Number(r.pendingValue) },
    { id: 'mxn', header: 'En pesos', align: 'right', cell: (r) => (r.pendingMxn === null ? <Badge tone="warn">Sin tipo de cambio</Badge> : fmtMoney(r.pendingMxn)), value: (r) => Number(r.pendingMxn ?? 0) },
    { id: 'paid', header: 'Pagado', align: 'right', cell: (r) => <span>{fmtCur(r.paid, r.currency)}{r.paidMxn ? <span className="block text-xs text-ink-soft">{fmtMoney(r.paidMxn)}</span> : null}</span>, value: (r) => Number(r.paid) },
  ];
  const t = v.totals;
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Inventario' }, { label: 'Valor por contenedor' }]}
        title="Valor del inventario por contenedor"
        subtitle="Cuánto vale lo que hay (al costo de cada lote) y lo que viene de China (al costo estimado de su costeo)."
      />
      <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-5">
        <Stat label="En almacenes" value={fmtMoney(t.onHand)} hint={`${fmtInt(t.onHandQty)} piezas en APLIN, FBA y FBL`} />
        <Stat label="En camino entre almacenes" value={fmtMoney(t.transit)} hint={`${fmtInt(t.transitQty)} piezas en transferencias`} />
        <Stat label="Inventario total" value={fmtMoney(t.inventory)} tone="brand" />
        <Stat label="Contenedores en camino" value={fmtMoney(t.onTheWay)} hint={`${fmtInt(t.onTheWayQty)} piezas; costo estimado`} />
        <Stat label="Órdenes sin contenedor" value={fmtMoney(t.openOrders)} hint={`${fmtInt(t.openOrdersQty)} piezas pedidas`} />
      </div>
      {(t.noCostQty > 0 || t.provisionalQty > 0) && (
        <div className="mb-3 rounded border border-warn/30 bg-warn-soft px-3 py-2 text-sm text-warn">
          {t.noCostQty > 0 && <span>{fmtInt(t.noCostQty)} piezas no tienen costo (valen 0 aquí). </span>}
          {t.provisionalQty > 0 && <span>{fmtInt(t.provisionalQty)} piezas tienen costo provisional: se ajusta al cerrar el costeo de su contenedor.</span>}
        </div>
      )}
      <LocalTable rows={v.lots} columns={cols} rowKey={(r) => r.lot} search={(r) => r.lot} searchPlaceholder="Buscar contenedor…" csvName="valor-inventario-por-contenedor" initialSort={{ id: 'lot', dir: 'desc' }} />
      <Panel title="Contenedores en camino" className="mt-3" bodyClassName="p-0">
        <LocalTable rows={v.onTheWay} columns={owCols} rowKey={(r) => r.id} csvName="contenedores-en-camino" empty="No hay contenedores en producción, naviera o aduana." maxHeight="40vh" />
      </Panel>
      <Panel title="Órdenes de compra sin contenedor" className="mt-3" bodyClassName="p-0">
        <LocalTable rows={v.openOrders} columns={ooCols} rowKey={(r) => r.id} csvName="ordenes-sin-contenedor" empty="Todas las órdenes abiertas ya están en contenedores." maxHeight="40vh" />
      </Panel>
    </>
  );
}
