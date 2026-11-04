'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Settings2 } from 'lucide-react';
import { ApiError, get, put, qs } from '@/lib/api';
import { fmtCost, fmtDate, fmtInt, fmtMoney } from '@/lib/format';
import { COST_STATUS, pctText } from '@/lib/purchasing';
import { useSession } from '@/lib/session';
import { LocalTable, type LocalColumn } from '@/components/local-table';
import { useToast } from '@/components/toast';
import { Badge, Button, Dialog, ErrorBox, Field, Input, PageHeader, Select, Spinner, Stat, cx } from '@/components/ui';

interface ChannelSettings {
  commissionRate: number | null;
  commissionBase: string;
  fulfillmentPerUnit: number;
  adsRate: number;
  storagePerUnit: number;
  inboundPerBox: number;
}
interface Options {
  channels: { id: string; code: string; name: string; settings: ChannelSettings }[];
  containers: { id: string; code: string; status: string; costStatus: string }[];
}
interface UnitPl {
  gross: number;
  net: number;
  product: number;
  duty: number;
  importExpenses: number;
  inbound: number;
  cogs: number;
  commission: number;
  fulfillment: number;
  ads: number;
  operatingMargin: number;
  storage: number;
  ebitda: number;
  ebitdaPct: number | null;
  grossMarginPct: number | null;
}
interface PlRow {
  skuId: string;
  skuCode: string;
  name: string;
  category: string | null;
  isKit: boolean;
  caseUnits: number | null;
  cost: { source: string; container: string | null; product: string; duty: string; importExpenses: string };
  price: { used: number | null; source: string | null; lastSale: number | null; lastSaleDate: string | null; list: number | null };
  commission: { rate: number; fixed: number; base: string; source: string } | null;
  inputs: { listPrice: string | null; fulfillmentPerUnit: string | null; storagePerUnit: string | null; adsRate: string | null; notes: string | null };
  units: number;
  unitsPerMonth: number;
  containerQty: number | null;
  pl: UnitPl | null;
  containerEbitda: number | null;
}
interface PlResponse {
  channel: { id: string; code: string; name: string };
  settings: ChannelSettings;
  container: { id: string; code: string; costStatus: string } | null;
  period: { from: string; to: string; months: number } | null;
  rows: PlRow[];
}

const SOURCE: Record<string, string> = { CONTENEDOR: 'Costeo cerrado', ESTIMADO: 'Estimado (costeo abierto)', ULTIMO_COSTEO: 'Último costeo', PROMEDIO: 'Promedio del inventario', SIN_COSTO: 'Sin costo' };
const SHORT: Record<string, string> = { PROMEDIO: 'Promedio', SIN_COSTO: 'Sin costo', ESTIMADO: 'Estimado' };
const BASE: Record<string, string> = { VENTA_NETA: 'venta neta (sin IVA)', VENTA_CON_IVA: 'venta con IVA', DESPUES_DESCUENTO: 'venta después de descuento' };
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)} %`);
const errText = (e: unknown) => (e instanceof ApiError && e.errors.length ? e.errors.map((x) => x.message).join(' ') : e);

export default function SkuPlPage() {
  const opts = useQuery({ queryKey: ['/profitability/options'], queryFn: () => get<Options>('/profitability/options') });
  const [channelId, setChannelId] = useState('');
  const [containerId, setContainerId] = useState('');
  const [row, setRow] = useState<PlRow | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { can } = useSession();
  useEffect(() => {
    if (!channelId && opts.data?.channels.length) setChannelId((opts.data.channels.find((c) => c.code === 'AMAZON') ?? opts.data.channels[0]).id);
  }, [opts.data, channelId]);
  const pl = useQuery({
    queryKey: ['/profitability/sku', channelId, containerId],
    queryFn: () => get<PlResponse>(`/profitability/sku${qs({ channelId, containerId })}`),
    enabled: Boolean(channelId),
  });
  if (opts.isLoading) return <Spinner />;
  if (opts.error) return <ErrorBox error={opts.error} />;
  const data = pl.data;
  const rows = data?.rows ?? [];
  const withPl = rows.filter((r) => r.pl);
  const avgPct = withPl.length ? withPl.reduce((a, r) => a + (r.pl!.ebitdaPct ?? 0), 0) / withPl.length : null;
  const negatives = withPl.filter((r) => r.pl!.ebitda < 0).length;
  const containerEbitda = rows.reduce((a, r) => a + (r.containerEbitda ?? 0), 0);

  const cols: LocalColumn<PlRow>[] = [
    { id: 'sku', header: 'SKU', sticky: true, cell: (r) => <Link href={`/productos/skus/${r.skuId}`} className="font-mono text-xs text-brand hover:underline">{r.skuCode}</Link>, value: (r) => r.skuCode },
    { id: 'name', header: 'Nombre', cell: (r) => <span className="line-clamp-2 min-w-48 text-xs">{r.isKit && <Badge className="mr-1">Kit</Badge>}{r.name}</span>, value: (r) => r.name },
    {
      id: 'price',
      header: 'Precio con IVA',
      align: 'right',
      cell: (r) =>
        r.price.used === null ? (
          <Badge tone="warn">Sin precio</Badge>
        ) : (
          <span title={r.price.source === 'ULTIMA_VENTA' ? `Última venta: ${fmtDate(r.price.lastSaleDate)}` : 'Precio capturado (sin ventas en el canal)'}>
            {fmtMoney(r.price.used)}
            <span className="block text-[11px] text-ink-soft">{r.price.source === 'ULTIMA_VENTA' ? fmtDate(r.price.lastSaleDate) : 'capturado'}</span>
          </span>
        ),
      value: (r) => r.price.used,
    },
    { id: 'net', header: 'Venta neta', group: 'Por pieza', align: 'right', cell: (r) => fmtMoney(r.pl?.net), value: (r) => r.pl?.net },
    {
      id: 'cogs',
      header: 'COGS',
      group: 'Por pieza',
      align: 'right',
      cell: (r) => (
        <span title={`${SOURCE[r.cost.source]}${r.cost.container ? ` · ${r.cost.container}` : ''}`}>
          {r.cost.source === 'SIN_COSTO' ? <Badge tone="bad">Sin costo</Badge> : fmtMoney(r.pl?.cogs)}
          <span className={cx('block text-[11px] whitespace-nowrap', r.cost.source === 'PROMEDIO' || r.cost.source === 'ESTIMADO' ? 'text-warn' : 'text-ink-soft')}>{r.cost.container ?? SHORT[r.cost.source]}</span>
        </span>
      ),
      value: (r) => r.pl?.cogs,
    },
    { id: 'comm', header: 'Comisión', group: 'Por pieza', align: 'right', cell: (r) => (r.commission ? fmtMoney(r.pl?.commission) : <Badge tone="warn">Sin comisión</Badge>), value: (r) => r.pl?.commission },
    { id: 'ful', header: 'Fulfillment', group: 'Por pieza', align: 'right', cell: (r) => fmtMoney(r.pl?.fulfillment), value: (r) => r.pl?.fulfillment },
    { id: 'ads', header: 'Publicidad', group: 'Por pieza', align: 'right', cell: (r) => fmtMoney(r.pl?.ads), value: (r) => r.pl?.ads },
    { id: 'om', header: 'Margen operativo', group: 'Por pieza', align: 'right', cell: (r) => fmtMoney(r.pl?.operatingMargin), value: (r) => r.pl?.operatingMargin },
    { id: 'sto', header: 'Almacenaje', group: 'Por pieza', align: 'right', cell: (r) => fmtMoney(r.pl?.storage), value: (r) => r.pl?.storage },
    { id: 'ebitda', header: 'EBITDA', group: 'Por pieza', align: 'right', cell: (r) => <b className={r.pl && r.pl.ebitda < 0 ? 'text-bad' : ''}>{fmtMoney(r.pl?.ebitda)}</b>, value: (r) => r.pl?.ebitda },
    {
      id: 'pct',
      header: '% EBITDA',
      group: 'Por pieza',
      align: 'right',
      cell: (r) => <Badge tone={!r.pl ? 'neutral' : (r.pl.ebitdaPct ?? 0) < 0 ? 'bad' : (r.pl.ebitdaPct ?? 0) < 0.1 ? 'warn' : 'ok'}>{pct(r.pl?.ebitdaPct)}</Badge>,
      value: (r) => r.pl?.ebitdaPct,
    },
    { id: 'units', header: 'Piezas / mes', align: 'right', cell: (r) => (r.unitsPerMonth ? fmtInt(r.unitsPerMonth) : '—'), value: (r) => r.unitsPerMonth },
    ...(data?.container
      ? ([
          { id: 'cq', header: `Piezas ${data.container.code}`, align: 'right', cell: (r) => fmtInt(r.containerQty), value: (r) => r.containerQty },
          { id: 'ce', header: `EBITDA ${data.container.code}`, align: 'right', cell: (r) => fmtMoney(r.containerEbitda), value: (r) => r.containerEbitda },
        ] as LocalColumn<PlRow>[])
      : []),
  ];

  const ch = opts.data!.channels.find((c) => c.id === channelId);
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Reportes' }, { label: 'P&L por SKU' }]}
        title="P&L por SKU"
        subtitle="Rentabilidad por pieza en cada canal con el último precio de venta y el costo puesto en bodega del contenedor (producto + arancel + gastos)."
        actions={can('canales.editar') && ch && <Button icon={<Settings2 className="h-4 w-4" />} onClick={() => setSettingsOpen(true)}>Supuestos de {ch.name}</Button>}
      />
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Field label="Canal">
          <Select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
            {opts.data!.channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Costo del contenedor">
          <Select value={containerId} onChange={(e) => setContainerId(e.target.value)}>
            <option value="">Último costeo cerrado de cada SKU</option>
            {opts.data!.containers.map((c) => <option key={c.id} value={c.id}>{c.code} · {COST_STATUS[c.costStatus]}</option>)}
          </Select>
        </Field>
        {data?.period && <span className="pb-2 text-xs text-ink-soft">Piezas por mes con ventas del {fmtDate(data.period.from)} al {fmtDate(data.period.to)}.</span>}
      </div>
      {pl.error && <ErrorBox error={pl.error} />}
      {pl.isLoading && <Spinner />}
      {data && (
        <>
          <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-5">
            <Stat label="SKU" value={fmtInt(rows.length)} hint={`${rows.length - withPl.length} sin precio o sin costo`} />
            <Stat label="% EBITDA promedio" value={pct(avgPct)} tone="brand" />
            <Stat label="SKU con EBITDA negativo" value={fmtInt(negatives)} />
            <Stat label="Comisión" value={rows[0]?.commission ? `${pctText(rows[0].commission.rate)} % s/ ${BASE[rows[0].commission.base] ?? ''}` : 'Sin configurar'} hint={rows[0]?.commission?.source} />
            {data.container ? <Stat label={`EBITDA del ${data.container.code}`} value={fmtMoney(containerEbitda)} hint="EBITDA por pieza × piezas del contenedor" /> : <Stat label="Publicidad / almacenaje" value={`${pctText(data.settings.adsRate)} % · ${fmtMoney(data.settings.storagePerUnit)}`} hint="Supuestos del canal; cada SKU puede tener los suyos" />}
          </div>
          <LocalTable
            rows={rows}
            columns={cols}
            rowKey={(r) => r.skuId}
            search={(r) => `${r.skuCode} ${r.name} ${r.category ?? ''}`}
            csvName={`pl-${data.channel.code.toLowerCase()}${data.container ? `-${data.container.code}` : ''}`}
            rowClassName={(r) => (r.pl && r.pl.ebitda < 0 ? 'bg-bad-soft/40' : undefined)}
            onRowClick={setRow}
            toolbar={<span className="text-xs text-ink-soft">Clic en un renglón para ver su P&L y editar sus supuestos.</span>}
            empty="No hay SKU con ventas o supuestos en este canal."
            initialSort={{ id: 'pct', dir: 'asc' }}
          />
        </>
      )}
      {row && data && <SkuPlDialog row={row} data={data} onClose={() => setRow(null)} />}
      {settingsOpen && ch && <ChannelSettingsDialog channel={ch} onClose={() => setSettingsOpen(false)} />}
    </>
  );
}

function SkuPlDialog({ row, data, onClose }: { row: PlRow; data: PlResponse; onClose: () => void }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [listPrice, setListPrice] = useState(row.inputs.listPrice ?? '');
  const [ful, setFul] = useState(row.inputs.fulfillmentPerUnit ?? '');
  const [sto, setSto] = useState(row.inputs.storagePerUnit ?? '');
  const [ads, setAds] = useState(pctText(row.inputs.adsRate));
  const [notes, setNotes] = useState(row.inputs.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const p = row.pl;
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await put(`/profitability/sku/${row.skuId}/channels/${data.channel.id}`, {
        listPrice: listPrice === '' ? null : listPrice,
        fulfillmentPerUnit: ful === '' ? null : ful,
        storagePerUnit: sto === '' ? null : sto,
        adsRate: ads === '' ? null : Number(ads) / 100,
        notes: notes || null,
      });
      toast.ok(`Supuestos de ${row.skuCode} guardados.`);
      qc.invalidateQueries({ queryKey: ['/profitability/sku'] });
      onClose();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  }
  const line = (label: string, v: number | null | undefined, opts: { bold?: boolean; sub?: string; neg?: boolean } = {}) => (
    <tr className={cx('border-t border-line', opts.bold && 'font-semibold')}>
      <td className="py-1 pr-3">{label}{opts.sub && <span className="block text-xs font-normal text-ink-soft">{opts.sub}</span>}</td>
      <td className={cx('py-1 text-right tabular-nums', opts.neg && v !== null && v !== undefined && v < 0 && 'text-bad')}>{v === null || v === undefined ? '—' : fmtCost(v)}</td>
      <td className="py-1 pl-3 text-right text-xs text-ink-soft tabular-nums">{p && v !== null && v !== undefined && p.net && label !== 'Precio de venta con IVA' ? pct(v / p.net) : ''}</td>
    </tr>
  );
  const editable = can('canales.editar');
  return (
    <Dialog
      open
      width="lg"
      onClose={onClose}
      title={`P&L de ${row.skuCode} en ${data.channel.name}`}
      footer={<><Button onClick={onClose}>Cerrar</Button>{editable && <Button variant="primary" loading={busy} onClick={save}>Guardar supuestos</Button>}</>}
    >
      <div className="grid gap-4 md:grid-cols-[1fr_18rem]">
        <div>
          <p className="mb-2 text-sm text-ink-soft">{row.name}</p>
          {!p ? (
            <ErrorBox error={row.price.used === null ? 'Sin precio: no hay ventas del SKU en este canal. Captura un precio para simular.' : 'Sin costo: el SKU no tiene costeo ni costo promedio.'} />
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {line('Precio de venta con IVA', p.gross, { sub: row.price.source === 'ULTIMA_VENTA' ? `Última venta del ${fmtDate(row.price.lastSaleDate)}` : 'Precio capturado' })}
                {line('Venta neta (÷ 1.16)', p.net, { bold: true })}
                {line('Producto (precio proveedor × TC)', p.product, { sub: `${SOURCE[row.cost.source]}${row.cost.container ? ` · ${row.cost.container}` : ''}` })}
                {line('Arancel (IGI)', p.duty)}
                {line('Gastos de importación por pieza', p.importExpenses, { sub: 'Flete, maniobras, aduana… ÷ piezas del contenedor' })}
                {line('Envío a la bodega del canal', p.inbound, { sub: data.settings.inboundPerBox && row.caseUnits ? `${fmtMoney(data.settings.inboundPerBox)} por caja ÷ ${row.caseUnits} piezas` : undefined })}
                {line('COGS', p.cogs, { bold: true })}
                {line('Comisión del canal', p.commission, { sub: row.commission ? `${pctText(row.commission.rate)} % sobre ${BASE[row.commission.base]} · ${row.commission.source}` : 'Sin comisión configurada' })}
                {line('Fulfillment (FBA / FBL) por pieza', p.fulfillment)}
                {line('Publicidad (PPC)', p.ads)}
                {line('Margen operativo', p.operatingMargin, { bold: true, neg: true })}
                {line('Almacenaje por pieza', p.storage)}
                {line('EBITDA', p.ebitda, { bold: true, neg: true })}
              </tbody>
            </table>
          )}
          {row.price.lastSale !== null && row.price.list !== null && row.price.lastSale !== row.price.list && (
            <p className="mt-2 text-xs text-ink-soft">Precio capturado {fmtMoney(row.price.list)}: el P&L usa el de la última venta.</p>
          )}
        </div>
        <div className="grid content-start gap-3">
          <ErrorBox error={error} />
          <h3 className="text-sm font-semibold">Supuestos del SKU en {data.channel.name}</h3>
          <Field label="Precio capturado con IVA" hint="Sólo se usa si el SKU aún no tiene ventas en el canal."><Input inputMode="decimal" className="num" value={listPrice} onChange={(e) => setListPrice(e.target.value)} disabled={!editable} /></Field>
          <Field label="Fulfillment por pieza" hint={`Tarifa FBA / FBL. Vacío = la del canal (${fmtMoney(data.settings.fulfillmentPerUnit)}).`}><Input inputMode="decimal" className="num" value={ful} onChange={(e) => setFul(e.target.value)} disabled={!editable} /></Field>
          <Field label="Almacenaje por pieza" hint={`Vacío = el del canal (${fmtMoney(data.settings.storagePerUnit)}).`}><Input inputMode="decimal" className="num" value={sto} onChange={(e) => setSto(e.target.value)} disabled={!editable} /></Field>
          <Field label="Publicidad (% de la venta neta)" hint={`Vacío = la del canal (${pctText(data.settings.adsRate)} %).`}><Input inputMode="decimal" className="num" value={ads} onChange={(e) => setAds(e.target.value)} disabled={!editable} /></Field>
          <Field label="Notas"><Input value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!editable} /></Field>
        </div>
      </div>
    </Dialog>
  );
}

function ChannelSettingsDialog({ channel, onClose }: { channel: Options['channels'][number]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const s = channel.settings;
  const [commission, setCommission] = useState(s.commissionRate === null ? '' : pctText(s.commissionRate));
  const [base, setBase] = useState(s.commissionBase);
  const [ads, setAds] = useState(pctText(s.adsRate));
  const [sto, setSto] = useState(String(s.storagePerUnit ?? 0));
  const [ful, setFul] = useState(String(s.fulfillmentPerUnit ?? 0));
  const [inbound, setInbound] = useState(String(s.inboundPerBox ?? 0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await put(`/profitability/channels/${channel.id}`, {
        commissionRate: commission === '' ? null : Number(commission) / 100,
        commissionBase: base,
        adsRate: ads === '' ? 0 : Number(ads) / 100,
        storagePerUnit: sto || 0,
        fulfillmentPerUnit: ful || 0,
        inboundPerBox: inbound || 0,
      });
      toast.ok('Supuestos del canal guardados.');
      qc.invalidateQueries({ queryKey: ['/profitability/options'] });
      qc.invalidateQueries({ queryKey: ['/profitability/sku'] });
      onClose();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title={`Supuestos del P&L de ${channel.name}`} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} onClick={save}>Guardar</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><ErrorBox error={error} /></div>
        <p className="text-sm text-ink-soft sm:col-span-2">
          Valen para todos los SKU del canal; cada SKU puede tener los suyos. Si el canal tiene una regla de comisión vigente (Configuración → Canales y comisiones), el P&L usa esa.
        </p>
        <Field label="Comisión (%)" hint="Amazon: 15 % de la venta neta en tu P&L."><Input inputMode="decimal" className="num" value={commission} onChange={(e) => setCommission(e.target.value)} /></Field>
        <Field label="Se calcula sobre">
          <Select value={base} onChange={(e) => setBase(e.target.value)}>{Object.entries(BASE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
        </Field>
        <Field label="Publicidad PPC (% de la venta neta)"><Input inputMode="decimal" className="num" value={ads} onChange={(e) => setAds(e.target.value)} /></Field>
        <Field label="Almacenaje por pieza"><Input inputMode="decimal" className="num" value={sto} onChange={(e) => setSto(e.target.value)} /></Field>
        <Field label="Fulfillment por pieza" hint="Tarifa por omisión; la de cada SKU va en su P&L."><Input inputMode="decimal" className="num" value={ful} onChange={(e) => setFul(e.target.value)} /></Field>
        <Field label="Envío a la bodega del canal, por caja" hint="Lo que cuesta mandar una caja master de APLIN a la bodega del canal."><Input inputMode="decimal" className="num" value={inbound} onChange={(e) => setInbound(e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}
