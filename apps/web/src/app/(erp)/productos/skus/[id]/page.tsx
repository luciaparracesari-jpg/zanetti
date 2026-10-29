'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Star, Trash2 } from 'lucide-react';
import { BARCODE_TYPE, FULFILLMENT_MODEL, LISTING_STATUS, PACKAGE_TYPE, SKU_STATUS } from '@erp/shared';
import { del, get, patch, post, put, qs, type Paged } from '@/lib/api';
import { fmtCost, fmtDate, fmtDateTime, fmtDims, fmtMoney, fmtPct, fmtWeight } from '@/lib/format';
import { Can, useSession } from '@/lib/session';
import { AsyncCombobox } from '@/components/combobox';
import { ListingDialog, type ListingRow } from '@/components/listing-dialog';
import { SkuForm, type SkuDetail } from '@/components/sku-form';
import { SkuInventoryTab } from '@/components/sku-inventory';
import { useToast } from '@/components/toast';
import { Badge, Button, Empty, ErrorBox, Field, Input, PageHeader, Panel, Select, Spinner, Stat, StatusBadge, Tabs } from '@/components/ui';

interface Barcode { id: string; barcode: string; type: string; isPrimary: boolean; createdAt: string }
interface Pack { id: string; code: string; type: string; unitsPerPackage: number; createdAt: string }
interface KitRow { quantity: number; component?: { id: string; skuCode: string; name: string; status: string }; kit?: { id: string; skuCode: string; name: string; status: string } }
interface SkuListing extends ListingRow { channelCode: string; channelName: string; warehouseCode: string | null; validFrom: string; validTo: string | null }
interface Full extends SkuDetail {
  product: { id: string; name: string; brand: { name: string } | null; category: { name: string } | null };
  preferredSupplier: { id: string; name: string; leadTimeDays: number | null } | null;
  barcodes: Barcode[];
  packages: Pack[];
  components: (KitRow & { componentSkuId: string })[];
  usedInKits: KitRow[];
  listings: SkuListing[];
  priceHistory: { id: number; price: string; validFrom: string; source: string; channelId: string | null }[];
  costHistory?: { id: number; cost: string; validFrom: string; sourceType: string }[];
  avgCost?: string | null;
  marginPct?: number | null;
}
interface AuditRow { id: number; occurredAt: string; userEmail: string | null; action: string; summary: string | null; oldValues: Record<string, unknown> | null; newValues: Record<string, unknown> | null }

type Tab = 'general' | 'codigos' | 'componentes' | 'publicaciones' | 'precios' | 'inventario' | 'historial';

export default function SkuPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const tab = (sp.get('tab') as Tab) ?? 'general';
  const setTab = (t: Tab) => router.replace(`${pathname}?tab=${t}`, { scroll: false });
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();

  const q = useQuery({ queryKey: ['sku', id], queryFn: () => get<Full>(`/skus/${id}`) });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const s = q.data!;
  const vigentes = s.listings.filter((l) => !l.validTo);

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Productos' }, { label: 'SKU maestros', href: '/productos/skus' }, { label: s.skuCode }]}
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{s.skuCode}</span>
            <span className="font-normal text-ink-soft">·</span>
            <span>{s.name}</span>
          </span>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge value={s.status} labels={SKU_STATUS} />
            {s.isKit && <Badge tone="info">Kit</Badge>}
            <span>{s.product.name}</span>
            {s.product.brand && <span>· {s.product.brand.name}</span>}
            {s.product.category && <span>· {s.product.category.name}</span>}
          </span>
        }
      />

      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
        <Stat label="Precio lista (c/IVA)" value={fmtMoney(s.basePrice)} />
        {can('costos.ver') && <Stat label="Costo actual" value={fmtCost(s.currentCost)} />}
        {can('costos.ver') && <Stat label="Margen bruto" value={fmtPct(s.marginPct)} hint="Sobre precio de lista sin IVA" />}
        <Stat label="Publicaciones vigentes" value={vigentes.length} tone="brand" />
        <Stat label="Peso" value={fmtWeight(s.weightG)} />
        <Stat label="Dimensiones" value={fmtDims(s.lengthMm, s.widthMm, s.heightMm)} />
        <Stat label="Lead time" value={s.leadTimeDays ?? s.preferredSupplier?.leadTimeDays ?? '—'} hint="Días" />
        <Stat label="Mín / Máx" value={`${s.minQty ?? '—'} / ${s.maxQty ?? '—'}`} />
      </div>

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'general', label: 'General' },
          { value: 'codigos', label: `Códigos y cajas (${s.barcodes.length + s.packages.length})` },
          { value: 'componentes', label: s.isKit ? `Componentes (${s.components.length})` : `Usado en kits (${s.usedInKits.length})` },
          { value: 'publicaciones', label: `Publicaciones (${vigentes.length})` },
          { value: 'precios', label: 'Precios y costos' },
          { value: 'inventario', label: 'Inventario' },
          { value: 'historial', label: 'Historial' },
        ]}
      />

      {tab === 'general' && (
        <div className="max-w-5xl">
          <SkuForm
            sku={s}
            onSaved={() => {
              toast.ok('Cambios guardados.');
              qc.invalidateQueries({ queryKey: ['sku', id] });
              qc.invalidateQueries({ queryKey: ['/skus'] });
            }}
          />
        </div>
      )}
      {tab === 'codigos' && (
        <div className="flex flex-col gap-3">
          <BarcodesTab sku={s} />
          <PackagesPanel sku={s} />
        </div>
      )}
      {tab === 'componentes' && <ComponentsTab sku={s} />}
      {tab === 'publicaciones' && <ListingsTab sku={s} />}
      {tab === 'precios' && <PricesTab sku={s} />}
      {tab === 'inventario' && <SkuInventoryTab skuId={s.id} />}
      {tab === 'historial' && <HistoryTab id={id} />}
    </>
  );
}

function BarcodesTab({ sku }: { sku: Full }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [barcode, setBarcode] = useState('');
  const [type, setType] = useState('EAN13');
  const [primary, setPrimary] = useState(sku.barcodes.length === 0);
  const refresh = () => qc.invalidateQueries({ queryKey: ['sku', sku.id] });
  const add = useMutation({
    mutationFn: () => post(`/skus/${sku.id}/barcodes`, { barcode, type, isPrimary: primary }),
    onSuccess: () => { toast.ok('Código agregado.'); setBarcode(''); setPrimary(false); refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (bid: string) => del(`/skus/${sku.id}/barcodes/${bid}`),
    onSuccess: () => { toast.ok('Código eliminado.'); refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const makePrimary = useMutation({
    mutationFn: (bid: string) => post(`/skus/${sku.id}/barcodes/${bid}/primary`),
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Panel title="Códigos de barras" bodyClassName="p-0">
      <Can perm="productos.editar">
        <form
          className="flex flex-wrap items-end gap-2 border-b border-line p-3"
          onSubmit={(e) => { e.preventDefault(); add.mutate(); }}
        >
          <Field label="Código" className="w-56">
            <Input value={barcode} onChange={(e) => setBarcode(e.target.value.trim())} className="font-mono" placeholder="7501234567895" />
          </Field>
          <Field label="Tipo" className="w-36">
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              {Object.entries(BARCODE_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </Field>
          <label className="mb-1.5 flex items-center gap-1.5 text-sm">
            <input type="checkbox" className="accent-brand" checked={primary} onChange={(e) => setPrimary(e.target.checked)} /> Principal
          </label>
          <Button type="submit" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} loading={add.isPending} disabled={!barcode}>
            Agregar
          </Button>
          <span className="mb-1.5 text-xs text-ink-faint">EAN-13 y UPC se validan con su dígito verificador.</span>
        </form>
      </Can>
      {sku.barcodes.length === 0 ? (
        <Empty>Este SKU aún no tiene códigos de barras.</Empty>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-page text-xs text-ink-soft">
            <tr><th className="px-3 py-1.5 text-left">Código</th><th className="px-3 py-1.5 text-left">Tipo</th><th className="px-3 py-1.5 text-left">Alta</th><th /></tr>
          </thead>
          <tbody>
            {sku.barcodes.map((b) => (
              <tr key={b.id} className="border-t border-line">
                <td className="px-3 py-1.5 font-mono">{b.barcode} {b.isPrimary && <Badge tone="ok" className="ml-1">Principal</Badge>}</td>
                <td className="px-3 py-1.5">{BARCODE_TYPE[b.type as keyof typeof BARCODE_TYPE]}</td>
                <td className="px-3 py-1.5">{fmtDate(b.createdAt)}</td>
                <td className="px-3 py-1.5 text-right">
                  <Can perm="productos.editar">
                    {!b.isPrimary && (
                      <Button size="sm" variant="ghost" icon={<Star className="h-3.5 w-3.5" />} onClick={() => makePrimary.mutate(b.id)}>Hacer principal</Button>
                    )}
                    <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => confirm(`¿Quitar el código ${b.barcode}?`) && remove.mutate(b.id)}>Quitar</Button>
                  </Can>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function PackagesPanel({ sku }: { sku: Full }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useSession();
  const [code, setCode] = useState(`${sku.skuCode}-C`);
  const [type, setType] = useState('CAJA_MASTER');
  const [units, setUnits] = useState('');
  const [editing, setEditing] = useState<Record<string, string>>({});
  const refresh = () => qc.invalidateQueries({ queryKey: ['sku', sku.id] });
  const add = useMutation({
    mutationFn: () => post(`/skus/${sku.id}/packages`, { code, type, unitsPerPackage: units }),
    onSuccess: () => { toast.ok('Caja agregada.'); setUnits(''); refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const save = useMutation({
    mutationFn: ({ pid, u }: { pid: string; u: string }) => patch(`/skus/${sku.id}/packages/${pid}`, { unitsPerPackage: u }),
    onSuccess: (_d, v) => { toast.ok('Piezas actualizadas.'); setEditing((e) => { const n = { ...e }; delete n[v.pid]; return n; }); refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (pid: string) => del(`/skus/${sku.id}/packages/${pid}`),
    onSuccess: () => { toast.ok('Caja eliminada.'); refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const editable = can('productos.editar');
  return (
    <Panel title="Cajas y empaques" bodyClassName="p-0">
      <p className="border-b border-line px-3 py-2 text-xs text-ink-soft">El código de la caja identifica la caja en recepciones y envíos a Amazon FBA o Liverpool; se encuentra con la búsqueda global.</p>
      {editable && (
        <form className="flex flex-wrap items-end gap-2 border-b border-line p-3" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <Field label="Código de la caja" className="w-56">
            <Input value={code} onChange={(e) => setCode(e.target.value.trim())} className="font-mono uppercase" />
          </Field>
          <Field label="Tipo" className="w-40">
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              {Object.entries(PACKAGE_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </Field>
          <Field label="Piezas" className="w-24">
            <Input inputMode="numeric" value={units} onChange={(e) => setUnits(e.target.value)} className="num" />
          </Field>
          <Button type="submit" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} loading={add.isPending} disabled={!code || !units}>Agregar</Button>
        </form>
      )}
      {sku.packages.length === 0 ? (
        <Empty>Sin cajas registradas.</Empty>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-page text-xs text-ink-soft">
            <tr><th className="px-3 py-1.5 text-left">Código</th><th className="px-3 py-1.5 text-left">Tipo</th><th className="px-3 py-1.5 text-right">Piezas</th><th /></tr>
          </thead>
          <tbody>
            {sku.packages.map((p) => (
              <tr key={p.id} className="border-t border-line">
                <td className="px-3 py-1.5 font-mono">{p.code}</td>
                <td className="px-3 py-1.5">{PACKAGE_TYPE[p.type as keyof typeof PACKAGE_TYPE]}</td>
                <td className="num px-3 py-1.5">
                  {p.id in editing ? (
                    <Input value={editing[p.id]} onChange={(e) => setEditing({ ...editing, [p.id]: e.target.value })} className="ml-auto w-20 num" autoFocus />
                  ) : (
                    p.unitsPerPackage
                  )}
                </td>
                <td className="px-3 py-1.5 text-right whitespace-nowrap">
                  {editable &&
                    (p.id in editing ? (
                      <>
                        <Button size="sm" variant="primary" onClick={() => save.mutate({ pid: p.id, u: editing[p.id] })}>Guardar</Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing((e) => { const n = { ...e }; delete n[p.id]; return n; })}>Cancelar</Button>
                      </>
                    ) : (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => setEditing({ ...editing, [p.id]: String(p.unitsPerPackage) })}>Cambiar piezas</Button>
                        <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => confirm(`¿Quitar la caja ${p.code}?`) && remove.mutate(p.id)}>Quitar</Button>
                      </>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function ComponentsTab({ sku }: { sku: Full }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useSession();
  const [rows, setRows] = useState(sku.components.map((c) => ({ id: c.component!.id, skuCode: c.component!.skuCode, name: c.component!.name, quantity: c.quantity })));
  useEffect(() => setRows(sku.components.map((c) => ({ id: c.component!.id, skuCode: c.component!.skuCode, name: c.component!.name, quantity: c.quantity }))), [sku.components]);
  const save = useMutation({
    mutationFn: () => put(`/skus/${sku.id}/components`, { components: rows.map((r) => ({ componentSkuId: r.id, quantity: r.quantity })) }),
    onSuccess: () => { toast.ok('Componentes guardados.'); qc.invalidateQueries({ queryKey: ['sku', sku.id] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!sku.isKit) {
    return (
      <Panel title="Kits que incluyen este SKU" bodyClassName="p-0">
        {sku.usedInKits.length === 0 ? (
          <Empty>Este SKU no forma parte de ningún kit. Para convertirlo en kit, márcalo en la pestaña General.</Empty>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {sku.usedInKits.map((k) => (
                <tr key={k.kit!.id} className="border-t border-line first:border-0">
                  <td className="px-3 py-1.5"><Link className="font-mono text-brand hover:underline" href={`/productos/skus/${k.kit!.id}`}>{k.kit!.skuCode}</Link></td>
                  <td className="px-3 py-1.5">{k.kit!.name}</td>
                  <td className="num px-3 py-1.5">× {k.quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    );
  }

  const editable = can('productos.editar');
  return (
    <Panel
      title="Componentes del kit"
      actions={editable && <Button variant="primary" size="sm" loading={save.isPending} onClick={() => save.mutate()}>Guardar componentes</Button>}
      bodyClassName="p-0"
    >
      <p className="border-b border-line px-3 py-2 text-xs text-ink-soft">Al venderse el kit, se descuenta cada componente por la cantidad indicada. Un kit no puede contener otro kit.</p>
      <table className="w-full text-sm">
        <thead className="bg-page text-xs text-ink-soft">
          <tr><th className="px-3 py-1.5 text-left">SKU</th><th className="px-3 py-1.5 text-left">Nombre</th><th className="px-3 py-1.5 text-right">Cantidad</th><th /></tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id} className="border-t border-line">
              <td className="px-3 py-1.5 font-mono">{r.skuCode}</td>
              <td className="px-3 py-1.5">{r.name}</td>
              <td className="px-3 py-1.5 text-right">
                <Input type="number" min={1} value={r.quantity} disabled={!editable} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, quantity: Math.max(1, Number(e.target.value)) } : x)))} className="ml-auto w-20 num" />
              </td>
              <td className="px-3 py-1.5 text-right">
                {editable && <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setRows(rows.filter((_, j) => j !== i))}>Quitar</Button>}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={4}><Empty>Agrega los SKU que forman este kit.</Empty></td></tr>
          )}
        </tbody>
      </table>
      {editable && (
        <div className="flex items-end gap-2 border-t border-line p-3">
          <div className="w-80">
            <AsyncCombobox<{ id: string; skuCode: string; name: string }>
              value={null}
              onChange={(v, o) => {
                if (!v || !o || v === sku.id || rows.some((r) => r.id === v)) return;
                setRows([...rows, { id: v, skuCode: o.label, name: o.hint ?? '', quantity: 1 }]);
              }}
              fetchPath="/skus/options?excludeKits=true"
              map={(x) => ({ value: x.id, label: x.skuCode, hint: x.name })}
              placeholder="Agregar componente…"
            />
          </div>
        </div>
      )}
    </Panel>
  );
}

function ListingsTab({ sku }: { sku: Full }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [dialog, setDialog] = useState<{ open: boolean; listing: SkuListing | null }>({ open: false, listing: null });
  const close = useMutation({
    mutationFn: (lid: string) => post(`/listings/${lid}/close`),
    onSuccess: () => { toast.ok('Publicación dada de baja; el código queda libre para otro SKU.'); qc.invalidateQueries({ queryKey: ['sku', sku.id] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Panel
      title="Publicaciones y códigos externos"
      actions={
        <Can perm="canales.crear">
          <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setDialog({ open: true, listing: null })}>Nueva publicación</Button>
        </Can>
      }
      bodyClassName="p-0"
    >
      {sku.listings.length === 0 ? (
        <Empty>Sin publicaciones. Liga aquí el ASIN, el artículo de Liverpool o la variante de Shopify.</Empty>
      ) : (
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-page text-xs text-ink-soft">
              <tr>
                {['Canal', 'Código externo', 'SKU externo', 'FNSKU', 'Uds.', 'Surtido', 'Almacén', 'Precio', 'Estado', 'Vigencia', ''].map((h) => (
                  <th key={h} className="px-3 py-1.5 text-left whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sku.listings.map((l) => (
                <tr key={l.id} className={`border-t border-line ${l.validTo ? 'text-ink-faint' : ''}`}>
                  <td className="px-3 py-1.5">{l.channelName}</td>
                  <td className="px-3 py-1.5 font-mono">{l.externalId}</td>
                  <td className="px-3 py-1.5 font-mono">{l.externalSku || '—'}</td>
                  <td className="px-3 py-1.5 font-mono">{l.fnsku ?? '—'}</td>
                  <td className="num px-3 py-1.5">{l.unitsPerListing}</td>
                  <td className="px-3 py-1.5">{FULFILLMENT_MODEL[l.fulfillmentModel as keyof typeof FULFILLMENT_MODEL]}</td>
                  <td className="px-3 py-1.5">{l.warehouseCode ?? '—'}</td>
                  <td className="num px-3 py-1.5">{fmtMoney(l.price)}</td>
                  <td className="px-3 py-1.5"><StatusBadge value={l.status} labels={LISTING_STATUS} /></td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{fmtDate(l.validFrom)} – {l.validTo ? fmtDate(l.validTo) : 'vigente'}</td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">
                    {!l.validTo && (
                      <Can perm="canales.editar">
                        <Button size="sm" variant="ghost" onClick={() => setDialog({ open: true, listing: { ...l, masterSkuId: sku.id, skuCode: sku.skuCode } })}>Editar</Button>
                        <Button size="sm" variant="ghost" onClick={() => confirm(`¿Dar de baja ${l.externalId}? Se conserva en el historial.`) && close.mutate(l.id)}>Dar de baja</Button>
                      </Can>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ListingDialog
        open={dialog.open}
        onClose={() => setDialog({ open: false, listing: null })}
        listing={dialog.listing}
        fixedSku={{ id: sku.id, skuCode: sku.skuCode, name: sku.name }}
      />
    </Panel>
  );
}

function PricesTab({ sku }: { sku: Full }) {
  const { can } = useSession();
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Panel title="Historial de precio de lista" bodyClassName="p-0">
        {sku.priceHistory.length === 0 ? <Empty>Sin cambios de precio.</Empty> : (
          <table className="w-full text-sm">
            <tbody>
              {sku.priceHistory.map((p) => (
                <tr key={p.id} className="border-t border-line first:border-0">
                  <td className="px-3 py-1.5">{fmtDateTime(p.validFrom)}</td>
                  <td className="num px-3 py-1.5">{fmtMoney(p.price)}</td>
                  <td className="px-3 py-1.5 text-xs text-ink-soft">{p.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      {can('costos.ver') && (
        <Panel title="Historial de costo" bodyClassName="p-0">
          {!sku.costHistory?.length ? <Empty>Sin costos registrados.</Empty> : (
            <table className="w-full text-sm">
              <tbody>
                {sku.costHistory.map((c) => (
                  <tr key={c.id} className="border-t border-line first:border-0">
                    <td className="px-3 py-1.5">{fmtDateTime(c.validFrom)}</td>
                    <td className="num px-3 py-1.5">{fmtCost(c.cost)}</td>
                    <td className="px-3 py-1.5 text-xs text-ink-soft">{c.sourceType}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      )}
    </div>
  );
}

const fmtVal = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function HistoryTab({ id }: { id: string }) {
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['sku-history', id, page], queryFn: () => get<Paged<AuditRow>>(`/skus/${id}/history${qs({ page, pageSize: 25 })}`) });
  if (q.isLoading) return <Spinner />;
  const d = q.data!;
  return (
    <Panel title="Historial de cambios" bodyClassName="p-0">
      {d.items.length === 0 ? <Empty>Sin cambios registrados.</Empty> : (
        <table className="w-full text-sm">
          <thead className="bg-page text-xs text-ink-soft">
            <tr><th className="px-3 py-1.5 text-left">Fecha</th><th className="px-3 py-1.5 text-left">Usuario</th><th className="px-3 py-1.5 text-left">Acción</th><th className="px-3 py-1.5 text-left">Cambio</th></tr>
          </thead>
          <tbody>
            {d.items.map((a) => (
              <tr key={a.id} className="border-t border-line align-top">
                <td className="px-3 py-1.5 whitespace-nowrap">{fmtDateTime(a.occurredAt)}</td>
                <td className="px-3 py-1.5">{a.userEmail ?? 'sistema'}</td>
                <td className="px-3 py-1.5">{a.summary ?? a.action}</td>
                <td className="px-3 py-1.5 text-xs">
                  {a.newValues && Object.keys(a.newValues).map((k) => (
                    <div key={k}><span className="text-ink-soft">{k}:</span> {fmtVal(a.oldValues?.[k])} → <b>{fmtVal(a.newValues?.[k])}</b></div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {d.total > d.pageSize && (
        <div className="flex justify-end gap-2 border-t border-line p-2">
          <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</Button>
          <Button size="sm" disabled={page * d.pageSize >= d.total} onClick={() => setPage(page + 1)}>Siguiente</Button>
        </div>
      )}
    </Panel>
  );
}
