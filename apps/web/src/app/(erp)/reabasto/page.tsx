'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { PackagePlus, Settings2, Ship, SlidersHorizontal, Truck } from 'lucide-react';
import { ApiError, patch, post } from '@/lib/api';
import { fmtDate, fmtInt } from '@/lib/format';
import { ALERT_LABEL, fmtDays, fmtDec, useReplenishment, type ChannelRow, type ChinaRow, type ReplParams, type ReplResult } from '@/lib/replenishment';
import { Can, useSession } from '@/lib/session';
import { LocalTable, type LocalColumn } from '@/components/local-table';
import { useToast } from '@/components/toast';
import { Badge, Button, Checkbox, Dialog, ErrorBox, Field, Input, PageHeader, Panel, Select, Spinner, Stat, Tabs, cx } from '@/components/ui';

type Tab = 'envios' | 'china' | 'urgentes' | 'parametros';

const skuCell = (r: { skuId: string; skuCode: string; skuName: string }) => (
  <div className="min-w-0">
    <Link href={`/productos/skus/${r.skuId}`} className="font-mono text-xs text-brand hover:underline">
      {r.skuCode}
    </Link>
    <div className="max-w-[260px] truncate text-xs text-ink-soft" title={r.skuName}>
      {r.skuName}
    </div>
  </div>
);
const searchOf = (r: { skuCode: string; skuName: string; category: string | null }) => `${r.skuCode} ${r.skuName} ${r.category ?? ''}`;
const days = (v: number | null, warn: number, bad: number) =>
  v === null ? <span className="text-ink-faint">—</span> : <span className={cx(v < bad ? 'font-semibold text-bad' : v < warn ? 'text-warn' : '')}>{fmtDays(v)}</span>;
const qty = (v: number) => (v ? fmtInt(v) : <span className="text-ink-faint">—</span>);

export default function ReplenishmentPage() {
  const router = useRouter();
  const sp = useSearchParams();
  const tab = (sp.get('tab') as Tab) || 'envios';
  const fecha = sp.get('fecha') ?? '';
  const q = useReplenishment(fecha);
  const setParam = (k: string, v: string) => {
    const p = new URLSearchParams(sp.toString());
    if (v) p.set(k, v);
    else p.delete(k);
    router.replace(`/reabasto?${p.toString()}`);
  };

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Compras' }, { label: 'Reabasto' }]}
        title="Reabasto"
        subtitle="Qué mandar de APLIN a Amazon FBA y Liverpool, y qué pedir a China para el siguiente contenedor. Se calcula con las ventas importadas, las existencias y los contenedores en camino."
        actions={
          <div className="flex items-end gap-2">
            <Field label="Calcular al" className="w-36">
              <Input type="date" value={fecha} onChange={(e) => setParam('fecha', e.target.value)} />
            </Field>
            <Link href="/compras/contenedores">
              <Button icon={<Ship className="h-4 w-4" />}>Contenedores</Button>
            </Link>
          </div>
        }
      />
      {q.isLoading ? <Spinner label="Calculando…" /> : q.error ? <ErrorBox error={q.error} /> : <Body data={q.data!} tab={tab} setTab={(t) => setParam('tab', t)} />}
    </>
  );
}

function Body({ data, tab, setTab }: { data: ReplResult; tab: Tab; setTab: (t: Tab) => void }) {
  const s = data.summary;
  const noSales = data.months.length === 0 || s.demandTotal === 0;
  return (
    <>
      {noSales && (
        <div className="mb-3 rounded border border-warn/30 bg-warn-soft px-3 py-2 text-sm text-warn">
          No hay ventas importadas en los últimos meses. Carga los reportes de Amazon, Liverpool y Shopify en{' '}
          <Link href="/importar?plantilla=ventas-amazon" className="underline">
            Importar desde Excel
          </Link>
          .
        </div>
      )}
      <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-7">
        <Stat label="Venta diaria Amazon FBA" value={fmtDec(s.demandFba)} hint={`Promedio de ${data.historyMonths.join(', ')} sin meses de quiebre`} />
        <Stat label="Venta diaria Liverpool" value={fmtDec(s.demandFbl)} />
        <Stat label="Venta diaria total (piezas)" value={fmtDec(s.demandTotal)} hint="Bundles separados en sus componentes" />
        <Stat label="Se agotan antes de que llegue más" value={fmtInt(s.urgentCount)} tone={s.urgentCount ? 'brand' : undefined} />
        <Stat label="FBA con menos días que DHL" value={fmtInt(s.fbaUrgent)} />
        <Stat label="Envío a FBA posible / sugerido" value={`${fmtInt(s.sendFba)} / ${fmtInt(s.suggestFba)}`} />
        <Stat label="Contenedor lleno" value={`${fmtInt(data.fill.days)} días · ${fmtDec(data.fill.cbm)} CBM`} hint={`Capacidad ${data.fill.capacity} CBM`} />
      </div>
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'envios', label: 'Envíos desde APLIN' },
          { value: 'china', label: 'Pedido a China' },
          { value: 'urgentes', label: `Se agotan (${s.urgentCount})` },
          { value: 'parametros', label: 'Parámetros' },
        ]}
      />
      {tab === 'envios' && <Shipments data={data} />}
      {tab === 'china' && <China data={data} />}
      {tab === 'urgentes' && <Urgent data={data} />}
      {tab === 'parametros' && <ParamsForm data={data} />}
    </>
  );
}

// ───────────────────────────── Envíos ─────────────────────────────

function Shipments({ data }: { data: ReplResult }) {
  const [onlySuggested, setOnlySuggested] = useState(true);
  const [dialog, setDialog] = useState<'AMZ-FBA' | 'LIV-FBL' | null>(null);
  const p = data.params;
  const rows = onlySuggested ? data.channels.filter((r) => r.suggestFba > 0 || r.suggestFbl > 0) : data.channels;
  const cols: LocalColumn<ChannelRow>[] = [
    { id: 'sku', header: 'SKU', cell: (r) => <div className="flex items-start gap-1">{skuCell(r)}{r.isKit && <Badge tone="info">Kit</Badge>}</div>, value: (r) => r.skuCode, sticky: true },
    { id: 'cat', header: 'Categoría', cell: (r) => r.category ?? '—', value: (r) => r.category },
    { id: 'dFba', header: 'FBA', group: 'Venta diaria', align: 'right', cell: (r) => fmtDec(r.demandFba), value: (r) => r.demandFba },
    { id: 'dFbl', header: 'Liverpool', group: 'Venta diaria', align: 'right', cell: (r) => fmtDec(r.demandFbl), value: (r) => r.demandFbl },
    { id: 'aplin', header: 'APLIN', group: 'Existencia hoy', align: 'right', cell: (r) => <span title={r.isKit ? 'Kits que se pueden armar con lo que sobra de componentes' : undefined}>{fmtInt(r.aplin)}</span>, value: (r) => r.aplin },
    { id: 'fba', header: 'FBA', group: 'Existencia hoy', align: 'right', cell: (r) => fmtInt(r.fba), value: (r) => r.fba },
    { id: 'tr', header: 'En tránsito', group: 'Existencia hoy', align: 'right', cell: (r) => qty(r.fbaTransit), value: (r) => r.fbaTransit },
    { id: 'fbl', header: 'Liverpool', group: 'Existencia hoy', align: 'right', cell: (r) => fmtInt(r.fbl), value: (r) => r.fbl },
    { id: 'cFba', header: 'Días', group: 'Amazon FBA', align: 'right', cell: (r) => days(r.coverFba, p.almexDias + p.colchonFba, p.dhlDias), value: (r) => r.coverFba },
    { id: 'oFba', header: 'Se agota', group: 'Amazon FBA', cell: (r) => fmtDate(r.stockoutFba), value: (r) => r.stockoutFba },
    { id: 'sFba', header: 'Sugerido', group: 'Amazon FBA', align: 'right', cell: (r) => qty(r.suggestFba), value: (r) => r.suggestFba },
    { id: 'wFba', header: 'Se puede', group: 'Amazon FBA', align: 'right', cell: (r) => <span className={cx(r.sendFba > 0 && 'font-semibold text-ok')}>{qty(r.sendFba)}</span>, value: (r) => r.sendFba },
    { id: 'via', header: 'Vía', group: 'Amazon FBA', cell: (r) => (r.via ? <Badge tone={r.via === 'DHL' ? 'bad' : 'info'}>{r.via}</Badge> : ''), value: (r) => r.via },
    { id: 'cFbl', header: 'Días', group: 'Liverpool FBL', align: 'right', cell: (r) => days(r.coverFbl, p.envioFblDias + p.colchonFbl, p.envioFblDias), value: (r) => r.coverFbl },
    { id: 'sFbl', header: 'Sugerido', group: 'Liverpool FBL', align: 'right', cell: (r) => qty(r.suggestFbl), value: (r) => r.suggestFbl },
    { id: 'wFbl', header: 'Se puede', group: 'Liverpool FBL', align: 'right', cell: (r) => <span className={cx(r.sendFbl > 0 && 'font-semibold text-ok')}>{qty(r.sendFbl)}</span>, value: (r) => r.sendFbl },
    { id: 'short', header: 'No alcanza', align: 'right', cell: (r) => (r.shortfall ? <span className="text-warn">{fmtInt(r.shortfall)}</span> : ''), value: (r) => r.shortfall },
    { id: 'min', header: 'Mínimo', group: 'Tener en APLIN', align: 'right', cell: (r) => (r.minAplin === null ? '' : fmtInt(r.minAplin)), value: (r) => r.minAplin },
    { id: 'max', header: 'Al llegar contenedor', group: 'Tener en APLIN', align: 'right', cell: (r) => (r.aplinAfterContainer === null ? '' : fmtInt(r.aplinAfterContainer)), value: (r) => r.aplinAfterContainer },
  ];
  return (
    <>
      <p className="mb-2 text-xs text-ink-soft">
        Todo Amazon se surte desde FBA y todo Liverpool desde FBL; APLIN sólo surte esas bodegas (y Shopify). Se sugiere enviar cuando la cobertura baja de {p.almexDias}+{p.colchonFba} días en FBA ({p.envioFblDias}+{p.colchonFbl} en Liverpool), hasta {p.coberturaFba} y {p.coberturaFbl} días. DHL si ya no llega por Almex. “Se puede” es lo que hay en APLIN (primero FBA).
      </p>
      <LocalTable
        rows={rows}
        columns={cols}
        rowKey={(r) => r.skuId}
        search={searchOf}
        csvName={`envios-${data.today}`}
        rowClassName={(r) => (r.isKit ? 'bg-page/60' : undefined)}
        initialSort={{ id: 'cFba', dir: 'asc' }}
        toolbar={
          <>
            <Checkbox label="Sólo con envío sugerido" checked={onlySuggested} onChange={(e) => setOnlySuggested(e.target.checked)} />
            <Can perm="transferencias.crear">
              <Button size="sm" variant="primary" icon={<Truck className="h-3.5 w-3.5" />} disabled={!data.channels.some((r) => r.sendFba > 0 && !r.isKit)} onClick={() => setDialog('AMZ-FBA')}>
                Crear envío a FBA
              </Button>
              <Button size="sm" variant="primary" icon={<Truck className="h-3.5 w-3.5" />} disabled={!data.channels.some((r) => r.sendFbl > 0 && !r.isKit)} onClick={() => setDialog('LIV-FBL')}>
                Crear envío a Liverpool
              </Button>
            </Can>
          </>
        }
      />
      {dialog && <ShipmentDialog data={data} destination={dialog} onClose={() => setDialog(null)} />}
    </>
  );
}

function ShipmentDialog({ data, destination, onClose }: { data: ReplResult; destination: 'AMZ-FBA' | 'LIV-FBL'; onClose: () => void }) {
  const toast = useToast();
  const router = useRouter();
  const base = data.channels.filter((r) => !r.isKit && (destination === 'AMZ-FBA' ? r.sendFba : r.sendFbl) > 0);
  const kits = data.channels.filter((r) => r.isKit && (destination === 'AMZ-FBA' ? r.sendFba : r.sendFbl) > 0);
  const [qtys, setQtys] = useState<Record<string, string>>(() => Object.fromEntries(base.map((r) => [r.skuId, String(destination === 'AMZ-FBA' ? r.sendFba : r.sendFbl)])));
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const items = base.map((r) => ({ masterSkuId: r.skuId, qty: Number(qtys[r.skuId] || 0) })).filter((i) => i.qty > 0);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const t = await post<{ id: string; folio: string }>('/replenishment/shipments', { destination, reference: reference || null, items });
      toast.ok(`Transferencia ${t.folio} creada en borrador.`);
      router.push(`/inventario/transferencias/${t.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e);
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      width="lg"
      title={`Envío de APLIN a ${destination === 'AMZ-FBA' ? 'Amazon FBA' : 'Liverpool FBL'}`}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={busy} disabled={!items.length} onClick={submit}>
            Crear transferencia ({fmtInt(items.reduce((a, i) => a + i.qty, 0))} pzas)
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <ErrorBox error={error} />
        <p className="text-sm text-ink-soft">Se crea en borrador: después la autorizas y registras el envío en Transferencias. Ajusta las piezas si hace falta (0 = no se manda).</p>
        <Field label="Referencia (envío FBA, guía…)">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="FBA15… / guía DHL" />
        </Field>
        <div className="scroll-thin max-h-[50vh] overflow-auto rounded border border-line">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-page text-xs text-ink-soft">
              <tr>
                <th className="px-2 py-1 text-left">SKU</th>
                <th className="px-2 py-1 text-right">Caja</th>
                <th className="px-2 py-1 text-right">Días hoy</th>
                <th className="px-2 py-1 text-right">Piezas</th>
              </tr>
            </thead>
            <tbody>
              {base.map((r) => (
                <tr key={r.skuId} className="border-t border-line">
                  <td className="px-2 py-1">{skuCell(r)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{r.caseUnits ?? '—'}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtDays(destination === 'AMZ-FBA' ? r.coverFba : r.coverFbl)}</td>
                  <td className="px-2 py-1 text-right">
                    <Input className="w-24 text-right" inputMode="numeric" value={qtys[r.skuId]} onChange={(e) => setQtys((q) => ({ ...q, [r.skuId]: e.target.value.replace(/[^\d]/g, '') }))} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {kits.length > 0 && (
          <p className="rounded border border-line bg-page px-3 py-2 text-xs text-ink-soft">
            También se sugieren bundles: {kits.map((k) => `${k.skuCode} × ${destination === 'AMZ-FBA' ? k.sendFba : k.sendFbl}`).join(', ')}. Ármalos primero en{' '}
            <Link href="/inventario" className="text-brand underline">Existencias → Armar kits</Link> y agrégalos a la transferencia.
          </p>
        )}
      </div>
    </Dialog>
  );
}

// ───────────────────────────── China ─────────────────────────────

function China({ data }: { data: ReplResult }) {
  const [adjust, setAdjust] = useState<ChinaRow | null>(null);
  const [order, setOrder] = useState(false);
  const [only, setOnly] = useState(false);
  const conts = data.containers.filter((c) => ['EN_PRODUCCION', 'EN_NAVIERA', 'EN_ADUANA'].includes(c.status)).sort((a, b) => (a.eta ?? '').localeCompare(b.eta ?? ''));
  const rows = only ? data.china.filter((r) => r.fullOrder > 0 || r.minOrder > 0) : data.china;
  const f = data.fill;
  const cols: LocalColumn<ChinaRow>[] = [
    { id: 'sku', header: 'SKU', cell: skuCell, value: (r) => r.skuCode, sticky: true },
    { id: 'cat', header: 'Categoría', cell: (r) => r.category ?? '—', value: (r) => r.category },
    { id: 'case', header: 'Caja', align: 'right', cell: (r) => r.caseUnits ?? '—', value: (r) => r.caseUnits },
    {
      id: 'd',
      header: 'Usada',
      group: 'Venta diaria',
      align: 'right',
      cell: (r) => (
        <span title={`Calculada ${fmtDec(r.demandCalc, 2)} · promedio de todo el periodo ${fmtDec(r.demandHistory, 2)}`} className={cx(r.demand !== r.demandCalc && 'font-semibold text-brand')}>
          {fmtDec(r.demand, 1)}
        </span>
      ),
      value: (r) => r.demand,
    },
    { id: 'dh', header: 'Periodo', group: 'Venta diaria', align: 'right', cell: (r) => fmtDec(r.demandHistory, 1), value: (r) => r.demandHistory },
    { id: 'phys', header: 'Física', group: 'Existencia', align: 'right', cell: (r) => fmtInt(r.physical), value: (r) => r.physical },
    ...conts.map<LocalColumn<ChinaRow>>((c) => ({
      id: `c-${c.code}`,
      header: <span title={`Llega ${fmtDate(c.eta)}`}>{c.code}</span>,
      csvHeader: c.code,
      group: 'En camino',
      align: 'right',
      cell: (r) => qty(r.byContainer[c.code] ?? 0),
      value: (r) => r.byContainer[c.code] ?? 0,
    })),
    { id: 'cover', header: 'Cobertura', align: 'right', cell: (r) => fmtDays(r.coverTotal), value: (r) => r.coverTotal },
    { id: 'out', header: 'Se agota', group: 'Agotados', cell: (r) => fmtDate(r.stockoutDate), value: (r) => r.stockoutDate },
    { id: 'next', header: 'Siguiente llegada', group: 'Agotados', cell: (r) => fmtDate(r.nextArrival ?? r.newOrderArrival), value: (r) => r.nextArrival ?? r.newOrderArrival },
    { id: 'without', header: 'Días sin', group: 'Agotados', align: 'right', cell: (r) => (r.daysWithout ? <span className="font-semibold text-bad">{fmtDays(r.daysWithout)}</span> : ''), value: (r) => r.daysWithout },
    { id: 'proj', header: 'Al llegar el pedido', align: 'right', cell: (r) => fmtInt(Math.round(r.projectedAtArrival)), value: (r) => r.projectedAtArrival },
    { id: 'min', header: 'Piezas', group: 'Pedido mínimo', align: 'right', cell: (r) => qty(r.minOrder), value: (r) => r.minOrder },
    { id: 'minCbm', header: 'CBM', group: 'Pedido mínimo', align: 'right', cell: (r) => (r.minCbm ? fmtDec(r.minCbm, 2) : ''), value: (r) => r.minCbm },
    { id: 'full', header: 'Piezas', group: 'Contenedor lleno', align: 'right', cell: (r) => <span className={cx(r.fullOrder > 0 && 'font-semibold')}>{qty(r.fullOrder)}</span>, value: (r) => r.fullOrder },
    { id: 'fullCases', header: 'Cajas', group: 'Contenedor lleno', align: 'right', cell: (r) => (r.fullCases ? fmtInt(r.fullCases) : ''), value: (r) => r.fullCases },
    { id: 'fullCbm', header: 'CBM', group: 'Contenedor lleno', align: 'right', cell: (r) => (r.fullCbm ? fmtDec(r.fullCbm, 2) : ''), value: (r) => r.fullCbm },
    { id: 'dar', header: 'Días al llegar', group: 'Contenedor lleno', align: 'right', cell: (r) => fmtDays(r.daysAtArrival), value: (r) => r.daysAtArrival },
    {
      id: 'alert',
      header: 'Aviso',
      cell: (r) => (
        <div className="flex items-center gap-1">
          {!r.include && <Badge>Excluido</Badge>}
          {r.alert && <Badge tone={r.alert.startsWith('SE_AGOTA') ? 'bad' : 'warn'}>{ALERT_LABEL[r.alert]}</Badge>}
        </div>
      ),
      value: (r) => (r.alert ? ALERT_LABEL[r.alert] : r.include ? '' : 'Excluido'),
    },
    {
      id: 'adj',
      header: '',
      cell: (r) => (
        <Can perm="reabasto.editar">
          <Button size="sm" variant="ghost" icon={<SlidersHorizontal className="h-3.5 w-3.5" />} onClick={() => setAdjust(r)} title="Ajustar venta o excluir" />
        </Can>
      ),
    },
  ];
  return (
    <>
      <div className="mb-3 grid gap-3 lg:grid-cols-[1fr_1.4fr]">
        <Panel title="Próximo contenedor">
          <div className="grid gap-1 text-sm">
            <div>
              Pedido el <b>{fmtDate(data.params.fechaProximoPedido)}</b> · llega a APLIN aprox. el <b>{fmtDate(f.arrival)}</b> ({data.params.diasContenedor} días: producción + {data.params.navieraDias} de naviera + {data.params.aduanaDias} de puerto y aduana).
            </div>
            <div>
              Pedido mínimo (cubre {f.minDays} días al llegar): <b>{fmtDec(f.minCbm, 1)} CBM</b> de {fmtInt(f.capacity)}.{' '}
              {f.minCbm > f.capacity ? <span className="font-semibold text-bad">No cabe en un contenedor.</span> : <span className="text-ok">Cabe.</span>}
            </div>
            <div>
              Con el contenedor lleno cada SKU llega con <b>{fmtInt(f.days)} días</b> de venta ({fmtDec(f.cbm, 1)} CBM).
            </div>
          </div>
        </Panel>
        <Panel
          title="Por categoría"
          actions={
            <Can perm="compras.crear">
              <Button size="sm" variant="primary" icon={<PackagePlus className="h-3.5 w-3.5" />} onClick={() => setOrder(true)}>
                Guardar como contenedor planeado
              </Button>
            </Can>
          }
          bodyClassName="p-0"
        >
          <table className="w-full text-sm">
            <thead className="bg-page text-xs text-ink-soft">
              <tr>
                <th className="px-2 py-1 text-left">Categoría</th>
                <th className="px-2 py-1 text-left">Pedir a más tardar</th>
                <th className="px-2 py-1 text-right">Mínimo (pzas)</th>
                <th className="px-2 py-1 text-right">Mínimo (CBM)</th>
                <th className="px-2 py-1 text-right">Lleno (pzas)</th>
                <th className="px-2 py-1 text-right">Lleno (cajas)</th>
                <th className="px-2 py-1 text-right">Lleno (CBM)</th>
              </tr>
            </thead>
            <tbody>
              {data.byCategory.map((c) => (
                <tr key={c.category} className="border-t border-line">
                  <td className="px-2 py-1">{c.category}</td>
                  <td className="px-2 py-1">{fmtDate(c.orderBy)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtInt(c.minQty)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtDec(c.minCbm)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtInt(c.fullQty)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtInt(c.fullCases)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtDec(c.fullCbm)}</td>
                </tr>
              ))}
              <tr className="border-t border-line font-semibold">
                <td className="px-2 py-1" colSpan={2}>
                  Total
                </td>
                <td className="px-2 py-1 text-right tabular-nums">{fmtInt(data.byCategory.reduce((a, c) => a + c.minQty, 0))}</td>
                <td className="px-2 py-1 text-right tabular-nums">{fmtDec(f.minCbm)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{fmtInt(data.byCategory.reduce((a, c) => a + c.fullQty, 0))}</td>
                <td className="px-2 py-1 text-right tabular-nums">{fmtInt(data.byCategory.reduce((a, c) => a + c.fullCases, 0))}</td>
                <td className="px-2 py-1 text-right tabular-nums">{fmtDec(f.cbm)}</td>
              </tr>
            </tbody>
          </table>
        </Panel>
      </div>
      <LocalTable
        rows={rows}
        columns={cols}
        rowKey={(r) => r.skuId}
        search={searchOf}
        csvName={`pedido-china-${data.today}`}
        rowClassName={(r) => (!r.include ? 'opacity-60' : undefined)}
        toolbar={<Checkbox label="Sólo lo que se pide" checked={only} onChange={(e) => setOnly(e.target.checked)} />}
      />
      {adjust && <AdjustDialog row={adjust} onClose={() => setAdjust(null)} />}
      {order && <OrderDialog data={data} onClose={() => setOrder(false)} />}
    </>
  );
}

function AdjustDialog({ row, onClose }: { row: ChinaRow; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [include, setInclude] = useState(row.include);
  const manual = row.demand !== row.demandCalc;
  const [value, setValue] = useState(manual ? String(row.demand) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function save() {
    setBusy(true);
    try {
      await patch(`/replenishment/skus/${row.skuId}`, { includeInOrders: include, manualDailyDemand: value.trim() === '' ? null : Number(value) });
      toast.ok(`Reabasto de ${row.skuCode} actualizado.`);
      qc.invalidateQueries({ queryKey: ['replenishment'] });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e);
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Ajustar ${row.skuCode}`}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={busy} onClick={save}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <ErrorBox error={error} />
        <p className="text-sm text-ink-soft">{row.skuName}</p>
        <p className="text-sm">
          Venta diaria calculada: <b>{fmtDec(row.demandCalc, 2)}</b> · promedio de todo el periodo: <b>{fmtDec(row.demandHistory, 2)}</b>
        </p>
        <Field label="Venta diaria a usar (piezas)" hint="Vacío = la calculada. Útil para productos nuevos o promociones.">
          <Input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ''))} placeholder={fmtDec(row.demandCalc, 2)} />
        </Field>
        <Checkbox label="Incluir en el pedido a China" checked={include} onChange={(e) => setInclude(e.target.checked)} />
      </div>
    </Dialog>
  );
}

function OrderDialog({ data, onClose }: { data: ReplResult; onClose: () => void }) {
  const toast = useToast();
  const router = useRouter();
  const nextCode = useMemo(() => {
    const nums = data.containers.map((c) => /(\d+)\s*$/.exec(c.code)?.[1]).filter(Boolean).map(Number);
    return nums.length ? `CONT-${Math.max(...nums) + 1}` : 'CONT-1';
  }, [data.containers]);
  const [code, setCode] = useState(nextCode);
  const [mode, setMode] = useState<'LLENO' | 'MINIMO'>('LLENO');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit() {
    setBusy(true);
    try {
      const r = await post<{ id: string; code: string; skus: number; qty: number }>('/replenishment/orders', { code, mode, fecha: data.today });
      toast.ok(`${r.code} planeado: ${r.skus} SKU, ${fmtInt(r.qty)} piezas.`);
      router.push(`/compras/contenedores/${r.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e);
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title="Guardar pedido como contenedor planeado"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <ErrorBox error={error} />
        <p className="text-sm text-ink-soft">
          Queda como PLANEADO: no cuenta como “en camino” hasta que lo pases a En producción. Ahí puedes cambiar piezas o enviarlo al proveedor.
        </p>
        <Field label="Clave del contenedor">
          <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
        </Field>
        <Field label="Cantidades">
          <Select value={mode} onChange={(e) => setMode(e.target.value as 'LLENO' | 'MINIMO')}>
            <option value="LLENO">Contenedor lleno ({fmtInt(data.byCategory.reduce((a, c) => a + c.fullQty, 0))} pzas · {fmtDec(data.fill.cbm)} CBM)</option>
            <option value="MINIMO">Pedido mínimo ({fmtInt(data.byCategory.reduce((a, c) => a + c.minQty, 0))} pzas · {fmtDec(data.fill.minCbm)} CBM)</option>
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}

// ───────────────────────────── Urgentes ─────────────────────────────

function Urgent({ data }: { data: ReplResult }) {
  type U = ReplResult['urgent'][number] & { category: string | null };
  const rows: U[] = data.urgent.map((u) => ({ ...u, category: null }));
  const cols: LocalColumn<U>[] = [
    { id: 'sku', header: 'SKU', cell: skuCell, value: (r) => r.skuCode },
    { id: 'out', header: 'Se agota el', cell: (r) => fmtDate(r.stockoutDate), value: (r) => r.stockoutDate },
    { id: 'next', header: 'Siguiente llegada', cell: (r) => fmtDate(r.nextArrival), value: (r) => r.nextArrival },
    { id: 'days', header: 'Días sin inventario', align: 'right', cell: (r) => <span className="font-semibold text-bad">{fmtDays(r.daysWithout)}</span>, value: (r) => r.daysWithout },
    { id: 'd', header: 'Venta/día', align: 'right', cell: (r) => fmtDec(r.demand), value: (r) => r.demand },
    { id: 'way', header: 'En camino', align: 'right', cell: (r) => qty(r.onTheWay), value: (r) => r.onTheWay },
    { id: 'min', header: 'Pedido mínimo', align: 'right', cell: (r) => qty(r.minOrder), value: (r) => r.minOrder },
  ];
  return (
    <>
      <p className="mb-2 text-xs text-ink-soft">SKU que venden al menos 3 piezas al mes y se quedan sin inventario (sumando APLIN, FBA, Liverpool y lo que va a FBA) antes de que llegue el siguiente contenedor que los trae o, si no vienen, el pedido nuevo.</p>
      <LocalTable rows={rows} columns={cols} rowKey={(r) => r.skuId} search={(r) => `${r.skuCode} ${r.skuName}`} csvName={`agotados-${data.today}`} empty="Ningún SKU se agota antes de su siguiente llegada." />
    </>
  );
}

// ───────────────────────────── Parámetros ─────────────────────────────

const PARAM_FIELDS: { key: keyof ReplParams; label: string; hint?: string; step?: string; group: string }[] = [
  { group: 'Venta base', key: 'mesesHistoria', label: 'Meses de historia', hint: 'Últimos meses completos que se promedian.' },
  { group: 'Venta base', key: 'pctQuiebre', label: 'Ignorar meses con venta menor a (fracción de la mediana)', hint: '0.3 = 30 %. Quita meses sin inventario.', step: '0.05' },
  { group: 'Venta base', key: 'factorFba', label: 'Factor de demanda Amazon', hint: '1.25 para preparar Buen Fin.', step: '0.05' },
  { group: 'Venta base', key: 'factorFbl', label: 'Factor de demanda Liverpool', step: '0.05' },
  { group: 'Venta base', key: 'factorAplin', label: 'Factor de demanda Shopify (APLIN)', step: '0.05' },
  { group: 'Envíos', key: 'almexDias', label: 'Almex: días hasta disponible en FBA' },
  { group: 'Envíos', key: 'dhlDias', label: 'DHL: días hasta disponible en FBA' },
  { group: 'Envíos', key: 'colchonFba', label: 'Colchón FBA (días)' },
  { group: 'Envíos', key: 'envioFblDias', label: 'Días hasta recibido en Liverpool' },
  { group: 'Envíos', key: 'colchonFbl', label: 'Colchón Liverpool (días)' },
  { group: 'Envíos', key: 'reservaAplinDias', label: 'Reserva en APLIN para Shopify (días)' },
  { group: 'China', key: 'navieraDias', label: 'Naviera (días)' },
  { group: 'China', key: 'aduanaDias', label: 'Puerto, aduana y traslado (días)' },
  { group: 'China', key: 'cicloDias', label: 'Ciclo entre contenedores (días)' },
  { group: 'China', key: 'seguridadDias', label: 'Días de seguridad' },
  { group: 'China', key: 'capacidadCbm', label: 'Capacidad del contenedor (CBM)', step: '0.5' },
];

function ParamsForm({ data }: { data: ReplResult }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const saved = data.params.guardados;
  const [v, setV] = useState<Record<string, string>>({});
  const [round, setRound] = useState(saved.redondearCajas);
  const [fechaPedido, setFechaPedido] = useState(saved.fechaProximoPedido ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    setV(Object.fromEntries(PARAM_FIELDS.map((f) => [f.key, String(saved[f.key])])));
  }, [saved]);
  const editable = can('reabasto.editar');
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = Object.fromEntries(PARAM_FIELDS.map((f) => [f.key, Number(v[f.key])]));
      body.redondearCajas = round;
      body.fechaProximoPedido = fechaPedido || null;
      await patch('/replenishment/params', body);
      toast.ok('Parámetros guardados.');
      qc.invalidateQueries({ queryKey: ['replenishment'] });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e);
    } finally {
      setBusy(false);
    }
  }
  const groups = [...new Set(PARAM_FIELDS.map((f) => f.group))];
  return (
    <div className="grid gap-3">
      <ErrorBox error={error} />
      <div className="grid gap-3 lg:grid-cols-3">
        {groups.map((g) => (
          <Panel key={g} title={g}>
            <div className="grid gap-2">
              {PARAM_FIELDS.filter((f) => f.group === g).map((f) => (
                <Field key={f.key} label={f.label} hint={f.hint}>
                  <Input type="number" step={f.step ?? '1'} value={v[f.key] ?? ''} disabled={!editable} onChange={(e) => setV((x) => ({ ...x, [f.key]: e.target.value }))} />
                </Field>
              ))}
              {g === 'China' && (
                <>
                  <Field label="Fecha del próximo pedido" hint={`Vacío = último pedido + ciclo (${fmtDate(data.params.fechaProximoPedido)}).`}>
                    <Input type="date" value={fechaPedido} disabled={!editable} onChange={(e) => setFechaPedido(e.target.value)} />
                  </Field>
                  <Checkbox label="Redondear a cajas master" checked={round} disabled={!editable} onChange={(e) => setRound(e.target.checked)} />
                </>
              )}
            </div>
          </Panel>
        ))}
      </div>
      <Panel title="Cobertura objetivo y de dónde sale cada venta">
        <p className="text-sm text-ink-soft">
          Cobertura: Amazon {data.params.coberturaFba} días y Liverpool {data.params.coberturaFbl} días (se editan en{' '}
          <Link href="/configuracion/canales" className="text-brand underline">Canales y comisiones</Link>). Se planea surtir:{' '}
          {Object.entries(saved.origenAlmacen)
            .map(([o, w]) => `${o} → ${w}`)
            .join(' · ')}
          . El lead time de cada SKU está en su ficha (producción + naviera + aduana).
        </p>
      </Panel>
      {editable && (
        <div>
          <Button variant="primary" icon={<Settings2 className="h-4 w-4" />} loading={busy} onClick={save}>
            Guardar parámetros
          </Button>
        </div>
      )}
    </div>
  );
}

