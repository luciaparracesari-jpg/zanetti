'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Container, Download, FileSpreadsheet, Pencil, Plus, Save, Trash2, Upload } from 'lucide-react';
import { ApiError, api, del, get, patch, post } from '@/lib/api';
import { fmtDate, fmtInt, fmtMoney } from '@/lib/format';
import { CONTAINER_STATUS, fmtDec } from '@/lib/replenishment';
import { COST_STATUS, CURRENCIES, PO_STATUS, fmtCur, type PoItem, type PurchaseOrder } from '@/lib/purchasing';
import { useSession } from '@/lib/session';
import { Attachments } from '@/components/attachments';
import { AsyncCombobox } from '@/components/combobox';
import { LocalTable, type LocalColumn } from '@/components/local-table';
import { useToast } from '@/components/toast';
import { Badge, Button, Checkbox, Dialog, Empty, ErrorBox, Field, Input, PageHeader, Panel, Select, Spinner, Stat, StatusBadge, Tabs, Textarea } from '@/components/ui';

const errText = (e: unknown) => (e instanceof ApiError && e.errors.length ? e.errors.map((x) => x.message).join(' ') : e);

export default function PurchaseOrderPage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({ queryKey: ['/purchase-orders', id], queryFn: () => get<PurchaseOrder>(`/purchase-orders/${id}`) });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  return <Detail po={q.data!} />;
}

function Detail({ po }: { po: PurchaseOrder }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const costs = can('costos.ver');
  const editable = can('compras.editar') && po.status !== 'CANCELADA' && po.status !== 'RECIBIDA';
  const [tab, setTab] = useState<'items' | 'payments' | 'files' | 'containers'>('items');
  const [lineDialog, setLineDialog] = useState<{ open: boolean; item: PoItem | null }>({ open: false, item: null });
  const [importOpen, setImportOpen] = useState(false);
  const [toContainer, setToContainer] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['/purchase-orders'] });
    qc.invalidateQueries({ queryKey: ['/containers'] });
  };
  async function setStatus(status: string) {
    try {
      await patch(`/purchase-orders/${po.id}`, { status });
      toast.ok(`Orden ${PO_STATUS[status].toLowerCase()}.`);
      refresh();
    } catch (e) {
      setError(errText(e));
    }
  }
  async function removeItem(it: PoItem) {
    if (!window.confirm(`¿Quitar ${it.skuCode} de la orden?`)) return;
    try {
      await del(`/purchase-orders/${po.id}/items/${it.id}`);
      refresh();
    } catch (e) {
      setError(errText(e));
    }
  }
  const pending = po.items.reduce((a, i) => a + Math.max(i.qty - i.inContainers, 0), 0);
  const cols: LocalColumn<PoItem>[] = [
    { id: 'n', header: '#', align: 'right', cell: (r) => r.lineNo, value: (r) => r.lineNo },
    { id: 'sku', header: 'SKU', cell: (r) => <Link href={`/productos/skus/${r.skuId}`} className="font-mono text-xs text-brand hover:underline">{r.skuCode}</Link>, value: (r) => r.skuCode },
    { id: 'name', header: 'Nombre', cell: (r) => <span className="text-xs">{r.name}</span>, value: (r) => r.name },
    { id: 'ssku', header: 'Código proveedor', cell: (r) => r.supplierSku ?? '—', value: (r) => r.supplierSku },
    { id: 'qty', header: 'Piezas', align: 'right', cell: (r) => fmtInt(r.qty), value: (r) => r.qty },
    { id: 'cases', header: 'Cajas', align: 'right', cell: (r) => (r.cases !== null ? fmtDec(r.cases) : '—'), value: (r) => r.cases },
    { id: 'cbm', header: 'CBM', align: 'right', cell: (r) => (r.cbm !== null ? fmtDec(r.cbm, 2) : '—'), value: (r) => r.cbm },
    ...(costs
      ? ([
          { id: 'price', header: `Precio (${po.currency})`, align: 'right', cell: (r) => (r.unitPrice === null ? <Badge tone="warn">Sin precio</Badge> : fmtCur(r.unitPrice, po.currency, 4)), value: (r) => (r.unitPrice === null ? null : Number(r.unitPrice)) },
          { id: 'amount', header: `Importe (${po.currency})`, align: 'right', cell: (r) => fmtCur(r.amount, po.currency), value: (r) => (r.amount ? Number(r.amount) : null) },
        ] as LocalColumn<PoItem>[])
      : []),
    { id: 'cont', header: 'En contenedor', cell: (r) => (r.inContainers ? <span className="text-xs">{fmtInt(r.inContainers)} · {r.containers}</span> : <span className="text-xs text-ink-soft">—</span>), value: (r) => r.inContainers },
    ...(editable
      ? ([
          {
            id: 'actions',
            header: '',
            align: 'right',
            cell: (r) => (
              <span className="flex justify-end gap-1">
                <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setLineDialog({ open: true, item: r })} aria-label="Editar" />
                <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => removeItem(r)} aria-label="Quitar" />
              </span>
            ),
          },
        ] as LocalColumn<PoItem>[])
      : []),
  ];
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Compras' }, { label: 'Órdenes de compra', href: '/compras/ordenes' }, { label: po.folio }]}
        title={<span className="flex flex-wrap items-center gap-2">{po.folio} · {po.supplier} <StatusBadge value={po.status} labels={PO_STATUS} /></span>}
        subtitle={`Orden del ${fmtDate(po.orderDate)}${po.supplierRef ? ` · ref. ${po.supplierRef}` : ''}${po.incoterm ? ` · ${po.incoterm}` : ''}${po.paymentTerms ? ` · ${po.paymentTerms}` : ''}`}
        actions={
          <>
            <a href={`/api/v1/purchase-orders/${po.id}/file`} className="inline-flex"><Button icon={<FileSpreadsheet className="h-4 w-4" />}>Orden en Excel</Button></a>
            {can('compras.editar') && po.status !== 'CANCELADA' && pending > 0 && po.items.length > 0 && (
              <Button variant="primary" icon={<Container className="h-4 w-4" />} onClick={() => setToContainer(true)}>Pasar a contenedor</Button>
            )}
          </>
        }
      />
      <ErrorBox error={error} />
      <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-6">
        <Stat label="SKU" value={fmtInt(po.items.length)} />
        <Stat label="Piezas" value={fmtInt(po.pieces)} hint={pending ? `${fmtInt(pending)} aún sin contenedor` : 'Todo en contenedores'} />
        <Stat label="CBM" value={fmtDec(po.cbm, 2)} hint="Con las medidas de la caja master" />
        {costs && <Stat label={`Total (${po.currency})`} value={fmtCur(po.total, po.currency)} hint={po.unpriced ? `${po.unpriced} renglones sin precio` : undefined} />}
        {costs && <Stat label="Pagado" value={fmtCur(po.paid, po.currency)} />}
        {costs && <Stat label="Saldo" value={fmtCur(po.balance, po.currency)} />}
      </div>
      {can('compras.editar') && <HeaderPanel po={po} onSaved={refresh} onStatus={setStatus} />}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'items', label: `Renglones (${po.items.length})` },
          { value: 'payments', label: `Pagos (${po.payments?.length ?? 0})`, hidden: !costs },
          { value: 'files', label: 'Archivos' },
          { value: 'containers', label: `Contenedores (${po.containers.length})` },
        ]}
      />
      {tab === 'items' && (
        <LocalTable
          rows={po.items}
          columns={cols}
          rowKey={(r) => r.id}
          search={(r) => `${r.skuCode} ${r.name} ${r.supplierSku ?? ''}`}
          csvName={`orden-${po.folio}`}
          empty={<Empty>La orden no tiene renglones. Cárgalos desde Excel o agrégalos uno por uno.</Empty>}
          toolbar={
            editable && (
              <>
                <Button icon={<Upload className="h-4 w-4" />} onClick={() => setImportOpen(true)}>Cargar desde Excel</Button>
                <Button icon={<Plus className="h-4 w-4" />} onClick={() => setLineDialog({ open: true, item: null })}>Agregar SKU</Button>
              </>
            )
          }
        />
      )}
      {tab === 'payments' && costs && <Payments po={po} onChange={refresh} />}
      {tab === 'files' && <Attachments entityType="PURCHASE_ORDER" entityId={po.id} kinds={['ORDEN', 'PROFORMA', 'FACTURA', 'PACKING_LIST', 'COMPROBANTE_PAGO', 'OTRO']} />}
      {tab === 'containers' && (
        <Panel title="Contenedores con renglones de esta orden">
          {po.containers.length === 0 ? (
            <Empty>Aún no está en ningún contenedor. Usa “Pasar a contenedor”.</Empty>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {po.containers.map((c) => (
                <li key={c.id} className="flex items-center gap-3 py-2">
                  <Link href={`/compras/contenedores/${c.id}`} className="font-semibold text-brand hover:underline">{c.code}</Link>
                  <Badge>{CONTAINER_STATUS[c.status] ?? c.status}</Badge>
                  <StatusBadge value={c.costStatus} labels={COST_STATUS} />
                  <span className="ml-auto tabular-nums">{fmtInt(c.pieces)} pzas</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
      {lineDialog.open && <LineDialog po={po} item={lineDialog.item} onClose={() => setLineDialog({ open: false, item: null })} onDone={refresh} />}
      {importOpen && <ImportDialog po={po} onClose={() => setImportOpen(false)} onDone={refresh} />}
      {toContainer && <ToContainerDialog po={po} pending={pending} onClose={() => setToContainer(false)} onDone={refresh} />}
    </>
  );
}

function HeaderPanel({ po, onSaved, onStatus }: { po: PurchaseOrder; onSaved: () => void; onStatus: (s: string) => void }) {
  const { can } = useSession();
  const toast = useToast();
  const [v, setV] = useState({
    supplierRef: po.supplierRef ?? '',
    orderDate: po.orderDate,
    expectedDate: po.expectedDate ?? '',
    currency: po.currency,
    fxRate: po.fxRate ?? '',
    incoterm: po.incoterm ?? '',
    paymentTerms: po.paymentTerms ?? '',
    notes: po.notes ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }));
  const cancelled = po.status === 'CANCELADA';
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await patch(`/purchase-orders/${po.id}`, {
        supplierRef: v.supplierRef || null,
        orderDate: v.orderDate,
        expectedDate: v.expectedDate || null,
        currency: v.currency,
        ...(can('costos.ver') ? { fxRate: v.fxRate || null } : {}),
        incoterm: v.incoterm || null,
        paymentTerms: v.paymentTerms || null,
        notes: v.notes || null,
      });
      toast.ok('Orden actualizada.');
      onSaved();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel
      title="Datos de la orden"
      className="mb-3"
      actions={
        <Select value={po.status} onChange={(e) => onStatus(e.target.value)} className="w-auto" aria-label="Estado de la orden">
          {Object.entries(PO_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
      }
    >
      <ErrorBox error={error} />
      <fieldset disabled={cancelled} className="grid gap-3 md:grid-cols-4">
        <Field label="Referencia del proveedor"><Input value={v.supplierRef} onChange={set('supplierRef')} /></Field>
        <Field label="Fecha de la orden"><Input type="date" value={v.orderDate} onChange={set('orderDate')} /></Field>
        <Field label="Termina producción" hint="Fecha que da el proveedor."><Input type="date" value={v.expectedDate} onChange={set('expectedDate')} /></Field>
        <Field label="Moneda"><Select value={v.currency} onChange={set('currency')}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select></Field>
        {can('costos.ver') && (
          <Field label="Tipo de cambio para costear" hint="Vacío = el del contenedor.">
            <Input inputMode="decimal" className="num" value={v.fxRate} onChange={set('fxRate')} disabled={v.currency === 'MXN'} />
          </Field>
        )}
        <Field label="Incoterm"><Input value={v.incoterm} onChange={set('incoterm')} /></Field>
        <Field label="Condiciones de pago" className="md:col-span-2"><Input value={v.paymentTerms} onChange={set('paymentTerms')} /></Field>
        <Field label="Notas" className="md:col-span-4"><Textarea rows={2} value={v.notes} onChange={set('notes')} /></Field>
      </fieldset>
      {!cancelled && (
        <div className="mt-3">
          <Button variant="primary" icon={<Save className="h-4 w-4" />} loading={busy} onClick={save}>Guardar</Button>
        </div>
      )}
    </Panel>
  );
}

function LineDialog({ po, item, onClose, onDone }: { po: PurchaseOrder; item: PoItem | null; onClose: () => void; onDone: () => void }) {
  const { can } = useSession();
  const [skuId, setSkuId] = useState<string | null>(item?.skuId ?? null);
  const [qty, setQty] = useState(item ? String(item.qty) : '');
  const [price, setPrice] = useState(item?.unitPrice ?? '');
  const [supplierSku, setSupplierSku] = useState(item?.supplierSku ?? '');
  const [notes, setNotes] = useState(item?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit() {
    setBusy(true);
    setError(null);
    const body = { qty, supplierSku: supplierSku || null, notes: notes || null, ...(can('costos.ver') ? { unitPrice: price === '' ? null : price } : {}) };
    try {
      if (item) await patch(`/purchase-orders/${po.id}/items/${item.id}`, body);
      else await post(`/purchase-orders/${po.id}/items`, { ...body, skuId });
      onDone();
      onClose();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={item ? `Editar ${item.skuCode}` : 'Agregar SKU a la orden'}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} disabled={!skuId || !qty} onClick={submit}>Guardar</Button></>}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><ErrorBox error={error} /></div>
        {!item && (
          <Field label="SKU" required className="sm:col-span-2">
            <AsyncCombobox<{ id: string; skuCode: string; name: string; isKit: boolean }>
              value={skuId}
              onChange={(v) => setSkuId(v)}
              fetchPath="/skus/options"
              map={(s) => ({ value: s.id, label: s.skuCode, hint: s.name })}
              placeholder="Buscar SKU…"
            />
          </Field>
        )}
        <Field label="Piezas" required hint={item?.inContainers ? `Ya hay ${fmtInt(item.inContainers)} en contenedores.` : undefined}><Input inputMode="numeric" className="num" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
        {can('costos.ver') && <Field label={`Precio unitario (${po.currency})`} hint="Sin IVA."><Input inputMode="decimal" className="num" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>}
        <Field label="Código del proveedor"><Input value={supplierSku} onChange={(e) => setSupplierSku(e.target.value)} /></Field>
        <Field label="Notas"><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}

interface ImportPreview {
  applied: boolean;
  summary: { sheet: string; sheets: string[]; columns: { price: boolean; supplierSku: boolean }; new: number; updated: number; errors: number; removed: string[]; pieces: number; priceIgnored: boolean };
  rows: { row: number; code: string; skuCode: string | null; name: string | null; qty: number | null; unitPrice: number | null; supplierSku: string | null; action: string; message: string | null }[];
}

function ImportDialog({ po, onClose, onDone }: { po: PurchaseOrder; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sheet, setSheet] = useState('');
  const [replace, setReplace] = useState(false);
  const [attach, setAttach] = useState(true);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function send(apply: boolean, f = file, sh = sheet) {
    if (!f) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', f);
      if (sh) fd.append('sheet', sh);
      fd.append('replace', replace ? '1' : '0');
      fd.append('attach', attach ? '1' : '0');
      fd.append('apply', apply ? '1' : '0');
      const r = await api<ImportPreview>(`/purchase-orders/${po.id}/import`, { method: 'POST', body: fd });
      if (apply) {
        toast.ok(`Renglones cargados: ${r.summary.new} nuevos, ${r.summary.updated} actualizados.`);
        onDone();
        onClose();
        return;
      }
      setPreview(r);
      setSheet(r.summary.sheet);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }
  const s = preview?.summary;
  return (
    <Dialog
      open
      width="lg"
      onClose={onClose}
      title={`Cargar renglones en ${po.folio}`}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={busy} disabled={!preview || Boolean(s?.errors)} onClick={() => send(true)}>
            Aplicar {s ? `${s.new + s.updated} renglones` : ''}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <ErrorBox error={error} />
        <p className="text-sm text-ink-soft">
          Excel (.xlsx) o CSV con columnas de <b>SKU</b> y <b>piezas</b> (PIEZAS, PIECES, CANTIDAD o QTY); si trae <b>precio</b> (PRECIO, UNIT PRICE, FOB) y <b>código del proveedor</b>, también se cargan. Sirve la hoja &quot;Pedido Zanetti&quot; o &quot;Pedido Lean Travel&quot; del pedido propuesto.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <input
            ref={input}
            type="file"
            accept=".xlsx,.xlsm,.csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              setPreview(null);
              setSheet('');
              if (f) send(false, f, '');
            }}
          />
          <Button icon={<Upload className="h-4 w-4" />} onClick={() => input.current?.click()}>{file ? file.name : 'Elegir archivo'}</Button>
          {s && s.sheets.length > 1 && (
            <Field label="Hoja">
              <Select value={sheet} onChange={(e) => { setSheet(e.target.value); send(false, file, e.target.value); }}>
                {s.sheets.map((x) => <option key={x}>{x}</option>)}
              </Select>
            </Field>
          )}
          <Checkbox label="Quitar de la orden los SKU que no vengan en el archivo" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
          <Checkbox label="Guardar el archivo en la orden" checked={attach} onChange={(e) => setAttach(e.target.checked)} />
        </div>
        {busy && !preview && <Spinner label="Leyendo archivo…" />}
        {s && (
          <>
            <div className="flex flex-wrap gap-2 text-sm">
              <Badge tone="info">Hoja: {s.sheet}</Badge>
              <Badge tone="ok">{s.new} nuevos</Badge>
              <Badge tone="info">{s.updated} actualizan</Badge>
              {s.errors > 0 && <Badge tone="bad">{s.errors} con error</Badge>}
              <Badge>{fmtInt(s.pieces)} piezas</Badge>
              {!s.columns.price && <Badge tone="warn">Sin columna de precio: se conservan los precios capturados</Badge>}
              {s.priceIgnored && <Badge tone="warn">No tienes permiso de costos: se ignoran los precios</Badge>}
              {replace && s.removed.length > 0 && <Badge tone="warn">Se quitan: {s.removed.join(', ')}</Badge>}
            </div>
            <div className="max-h-80 overflow-auto rounded border border-line">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-page text-xs text-ink-soft">
                  <tr><th className="px-2 py-1 text-left">Renglón</th><th className="px-2 py-1 text-left">SKU</th><th className="px-2 py-1 text-left">Nombre</th><th className="px-2 py-1 text-right">Piezas</th><th className="px-2 py-1 text-right">Precio</th><th className="px-2 py-1 text-left">Resultado</th></tr>
                </thead>
                <tbody>
                  {preview!.rows.map((r) => (
                    <tr key={r.row} className="border-t border-line">
                      <td className="px-2 py-1 tabular-nums">{r.row}</td>
                      <td className="px-2 py-1 font-mono text-xs">{r.skuCode ?? r.code}</td>
                      <td className="px-2 py-1 text-xs">{r.name ?? '—'}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{fmtInt(r.qty)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{r.unitPrice === null ? '—' : fmtCur(r.unitPrice, po.currency, 4)}</td>
                      <td className="px-2 py-1 text-xs">
                        <Badge tone={r.action === 'ERROR' ? 'bad' : r.action === 'NUEVO' ? 'ok' : 'info'}>{r.action === 'ERROR' ? 'Error' : r.action === 'NUEVO' ? 'Nuevo' : 'Actualiza'}</Badge>
                        {r.message && <span className="ml-1">{r.message}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

interface ContainerOpt {
  id: string;
  code: string;
  status: string;
  costStatus?: string;
  qty: number;
  eta: string | null;
}

function ToContainerDialog({ po, pending, onClose, onDone }: { po: PurchaseOrder; pending: number; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const conts = useQuery({ queryKey: ['/containers', 'open'], queryFn: () => get<ContainerOpt[]>('/containers?status=PLANEADO,EN_PRODUCCION,EN_NAVIERA,EN_ADUANA') });
  const [containerId, setContainerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ container: string; added: number; linked: number; pieces: number }>(`/purchase-orders/${po.id}/to-container`, { containerId });
      toast.ok(`${fmtInt(r.pieces)} piezas en ${r.container} (${r.added} renglones nuevos, ${r.linked} ligados).`);
      onDone();
      onClose();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Pasar ${po.folio} a un contenedor`}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} disabled={!containerId} onClick={submit}>Pasar {fmtInt(pending)} piezas</Button></>}
    >
      <div className="grid gap-3">
        <ErrorBox error={error} />
        <p className="text-sm text-ink-soft">
          Se pasa lo que aún no está en un contenedor. Si el contenedor ya trae el SKU sin orden (por ejemplo, el pedido sugerido del reabasto), ese renglón se liga a la orden y toma sus piezas; si no, se agrega.
        </p>
        <Field label="Contenedor">
          <Select value={containerId} onChange={(e) => setContainerId(e.target.value)}>
            <option value="">Elige…</option>
            {(conts.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>{c.code} · {CONTAINER_STATUS[c.status] ?? c.status} · {fmtInt(c.qty)} pzas{c.eta ? ` · llega ${fmtDate(c.eta)}` : ''}</option>
            ))}
          </Select>
        </Field>
        <p className="text-xs text-ink-soft">¿No está el contenedor? Guárdalo desde Reabasto (pedido sugerido) o cárgalo en Contenedores.</p>
      </div>
    </Dialog>
  );
}

function Payments({ po, onChange }: { po: PurchaseOrder; onChange: () => void }) {
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const payments = po.payments ?? [];
  async function remove(id: string) {
    if (!window.confirm('¿Borrar el pago?')) return;
    try {
      await del(`/purchase-orders/${po.id}/payments/${id}`);
      onChange();
    } catch (e) {
      setError(errText(e));
    }
  }
  const totalMxn = payments.reduce((a, p) => a + Number(p.amountMxn ?? 0), 0);
  return (
    <Panel title="Pagos al proveedor" actions={can('compras.editar') && po.status !== 'CANCELADA' && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>Registrar pago</Button>}>
      <ErrorBox error={error} />
      {payments.length === 0 ? (
        <Empty>Sin pagos registrados.</Empty>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-xs text-ink-soft">
            <tr><th className="py-1 text-left">Fecha</th><th className="py-1 text-right">Monto ({po.currency})</th><th className="py-1 text-right">Tipo de cambio</th><th className="py-1 text-right">En pesos</th><th className="py-1 text-left pl-3">Referencia</th><th /></tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id} className="border-t border-line">
                <td className="py-1.5">{fmtDate(p.paidAt)}</td>
                <td className="py-1.5 text-right tabular-nums">{fmtCur(p.amount, po.currency)}</td>
                <td className="py-1.5 text-right tabular-nums">{p.fxRate ?? '—'}</td>
                <td className="py-1.5 text-right tabular-nums">{fmtMoney(p.amountMxn)}</td>
                <td className="py-1.5 pl-3 text-xs">{[p.reference, p.notes].filter(Boolean).join(' · ') || '—'}</td>
                <td className="py-1.5 text-right">{can('compras.editar') && <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => remove(p.id)} aria-label="Borrar pago" />}</td>
              </tr>
            ))}
            <tr className="border-t border-line font-semibold">
              <td className="py-1.5">Total</td>
              <td className="py-1.5 text-right tabular-nums">{fmtCur(po.paid, po.currency)}</td>
              <td />
              <td className="py-1.5 text-right tabular-nums">{fmtMoney(totalMxn)}</td>
              <td className="py-1.5 pl-3 text-xs font-normal text-ink-soft">Saldo {fmtCur(po.balance, po.currency)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      )}
      <p className="mt-2 text-xs text-ink-soft">El tipo de cambio de cada pago es informativo: el costeo usa el que captures en la orden o en el contenedor.</p>
      {open && <PaymentDialog po={po} onClose={() => setOpen(false)} onDone={onChange} />}
    </Panel>
  );
}

function PaymentDialog({ po, onClose, onDone }: { po: PurchaseOrder; onClose: () => void; onDone: () => void }) {
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState('');
  const [fxRate, setFxRate] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit() {
    setBusy(true);
    try {
      await post(`/purchase-orders/${po.id}/payments`, { paidAt, amount, fxRate: fxRate || null, reference: reference || null, notes: notes || null });
      onDone();
      onClose();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  }
  return (
    <Dialog open width="sm" onClose={onClose} title={`Pago de ${po.folio}`} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} disabled={!amount} onClick={submit}>Registrar</Button></>}>
      <div className="grid gap-3">
        <ErrorBox error={error} />
        <Field label="Fecha"><Input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} /></Field>
        <Field label={`Monto (${po.currency})`} hint={po.balance ? `Saldo: ${fmtCur(po.balance, po.currency)}` : undefined}><Input inputMode="decimal" className="num" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        {po.currency !== 'MXN' && <Field label="Tipo de cambio pagado"><Input inputMode="decimal" className="num" value={fxRate} onChange={(e) => setFxRate(e.target.value)} /></Field>}
        <Field label="Referencia"><Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Anticipo 30%, transferencia…" /></Field>
        <Field label="Notas"><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}
