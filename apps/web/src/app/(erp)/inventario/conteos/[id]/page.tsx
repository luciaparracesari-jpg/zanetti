'use client';

import { use, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Save, ScanLine } from 'lucide-react';
import { COUNT_STATUS } from '@erp/shared';
import { ApiError, get, patch, post, qs } from '@/lib/api';
import { fmtDateTime, fmtInt, fmtMoney } from '@/lib/format';
import { useLocations } from '@/lib/inventory';
import { useSession } from '@/lib/session';
import { SignedQty } from '@/components/inventory';
import { useToast } from '@/components/toast';
import { Badge, Button, Checkbox, Dialog, ErrorBox, Field, Input, PageHeader, Panel, Select, Spinner, Stat, StatusBadge, cx } from '@/components/ui';

interface Line {
  id: string;
  masterSkuId: string;
  skuCode: string;
  skuName: string;
  avgCost: string | null;
  locationId: string;
  locationCode: string;
  systemQty: number | null;
  countedQty: number | null;
  difference: number | null;
  countedAt: string | null;
  countedByName: string | null;
}
interface Count {
  id: string;
  folio: string;
  status: keyof typeof COUNT_STATUS;
  blind: boolean;
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  locationId: string | null;
  locationCode: string | null;
  notes: string | null;
  frozenAt: string;
  closedAt: string | null;
  createdByName: string | null;
  closedByName: string | null;
  showsSystem: boolean;
  lines: Line[];
}
interface ResolveResult {
  sku: { id: string; skuCode: string; name: string } | null;
  units: number;
  lineIds: string[];
}

type View = 'todos' | 'pendientes' | 'diferencias';

export default function CountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can, me } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const isAdmin = me.roles.includes('ADMIN');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [view, setView] = useState<View>('todos');
  const [filter, setFilter] = useState('');
  const [scan, setScan] = useState('');
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [addSku, setAddSku] = useState<{ id: string; skuCode: string; units: number } | null>(null);
  const [addLoc, setAddLoc] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [asZero, setAsZero] = useState(false);
  const [negative, setNegative] = useState(false);

  const q = useQuery({ queryKey: ['count', id], queryFn: () => get<Count>(`/counts/${id}`) });
  const c = q.data;
  const locs = useLocations(c?.warehouseId);
  useEffect(() => setEdits({}), [c?.status]);

  const value = (l: Line) => (l.id in edits ? edits[l.id] : l.countedQty === null ? '' : String(l.countedQty));
  const dirty = Object.keys(edits).length;
  const rows = useMemo(() => {
    if (!c) return [];
    const f = filter.trim().toUpperCase();
    return c.lines.filter((l) => {
      if (f && !l.skuCode.toUpperCase().includes(f) && !l.skuName.toUpperCase().includes(f)) return false;
      const v = value(l);
      if (view === 'pendientes') return v === '';
      if (view === 'diferencias') return v !== '' && l.systemQty !== null && Number(v) !== l.systemQty;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c, filter, view, edits]);

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  if (!c) return null;
  const open = c.status === 'ABIERTO';
  const canCapture = open && can('transferencias.editar');

  const counted = c.lines.filter((l) => value(l) !== '').length;
  const diffs = c.lines.filter((l) => value(l) !== '' && l.systemQty !== null && Number(value(l)) !== l.systemQty);
  const plus = diffs.reduce((s, l) => s + Math.max(Number(value(l)) - (l.systemQty ?? 0), 0), 0);
  const minus = diffs.reduce((s, l) => s + Math.max((l.systemQty ?? 0) - Number(value(l)), 0), 0);
  const diffValue = diffs.reduce((s, l) => s + (Number(value(l)) - (l.systemQty ?? 0)) * Number(l.avgCost ?? 0), 0);

  async function save(quiet = false) {
    if (!dirty) return true;
    setBusy('save');
    setError(null);
    try {
      await patch(`/counts/${id}/lines`, { lines: Object.entries(edits).map(([lineId, v]) => ({ lineId, countedQty: v === '' ? null : Number(v) })) });
      if (!quiet) toast.ok(`Se guardaron ${dirty} renglones.`);
      setEdits({});
      await qc.invalidateQueries({ queryKey: ['count', id] });
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'No se pudo guardar.');
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function onScan(e: React.FormEvent) {
    e.preventDefault();
    const code = scan.trim();
    if (!code) return;
    setScan('');
    try {
      const r = await get<ResolveResult>(`/counts/${id}/resolve${qs({ code })}`);
      if (!r.sku) return setScanMsg(`No se encontró “${code}”.`);
      const lines = c!.lines.filter((l) => r.lineIds.includes(l.id));
      if (lines.length === 0) {
        setAddSku({ id: r.sku.id, skuCode: r.sku.skuCode, units: r.units });
        setAddLoc(c!.locationId ?? locs.data?.find((l) => l.code === 'GEN')?.id ?? '');
        return setScanMsg(`${r.sku.skuCode} no estaba en la foto del conteo.`);
      }
      const target = lines.find((l) => (c!.locationId ? l.locationId === c!.locationId : true)) ?? lines[0];
      const next = Number(value(target) || 0) + r.units;
      setEdits((x) => ({ ...x, [target.id]: String(next) }));
      setScanMsg(`${r.sku.skuCode} en ${target.locationCode}: ${next}${r.units > 1 ? ` (+${r.units} por caja)` : ''}`);
    } catch (err) {
      setScanMsg((err as Error).message);
    }
  }

  async function addLine() {
    if (!addSku || !addLoc) return;
    setBusy('add');
    try {
      await post(`/counts/${id}/lines`, { masterSkuId: addSku.id, locationId: addLoc, countedQty: addSku.units });
      toast.ok(`${addSku.skuCode} agregado al conteo con ${addSku.units} pzas.`);
      setAddSku(null);
      qc.invalidateQueries({ queryKey: ['count', id] });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'No se pudo agregar.');
    } finally {
      setBusy(null);
    }
  }

  async function closeCount() {
    if (!(await save(true))) return;
    setBusy('close');
    setError(null);
    try {
      const r = await post<{ adjusted: number; unitsPlus: number; unitsMinus: number; value: string | null }>(`/counts/${id}/close`, { uncountedAsZero: asZero, authorizeNegative: negative });
      toast.ok(`Conteo cerrado: ${r.adjusted} ajustes (+${r.unitsPlus} / −${r.unitsMinus} pzas).`);
      setClosing(false);
      qc.invalidateQueries({ queryKey: ['count', id] });
      qc.invalidateQueries({ queryKey: ['/counts'] });
      qc.invalidateQueries({ queryKey: ['/inventory/stock'] });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'No se pudo cerrar.');
    } finally {
      setBusy(null);
    }
  }

  async function cancelCount() {
    if (!window.confirm(`¿Cancelar el conteo ${c!.folio}? No se ajusta nada.`)) return;
    setBusy('cancel');
    try {
      await post(`/counts/${id}/cancel`);
      toast.ok('Conteo cancelado.');
      qc.invalidateQueries({ queryKey: ['count', id] });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'No se pudo cancelar.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Inventario', href: '/inventario' }, { label: 'Conteos físicos', href: '/inventario/conteos' }, { label: c.folio }]}
        title={
          <span className="flex items-center gap-2">
            Conteo <span className="font-mono">{c.folio}</span> <StatusBadge value={c.status} labels={COUNT_STATUS} />
            {c.blind && <Badge>ciego</Badge>}
          </span>
        }
        subtitle={`${c.warehouseCode} · ${c.warehouseName}${c.locationCode ? ` / ${c.locationCode}` : ' (todo el almacén)'} · foto de existencia ${fmtDateTime(c.frozenAt)}`}
        actions={
          <>
            {open && can('transferencias.editar') && <Button variant="danger" loading={busy === 'cancel'} onClick={cancelCount}>Cancelar conteo</Button>}
            {canCapture && <Button icon={<Save className="h-4 w-4" />} loading={busy === 'save'} disabled={!dirty} onClick={() => save()}>Guardar captura{dirty ? ` (${dirty})` : ''}</Button>}
            {open && can('ajustes.autorizar') && <Button variant="primary" onClick={() => setClosing(true)}>Cerrar y ajustar</Button>}
            {c.status === 'CERRADO' && <Link href={`/inventario/movimientos?documentId=${c.id}`}><Button>Ver ajustes</Button></Link>}
          </>
        }
      />
      {error && <div className="mb-3"><ErrorBox error={error} /></div>}

      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-6">
        <Stat label="Renglones" value={fmtInt(c.lines.length)} />
        <Stat label="Capturados" value={`${fmtInt(counted)} / ${fmtInt(c.lines.length)}`} tone="brand" />
        {c.showsSystem && <Stat label="Con diferencia" value={fmtInt(diffs.length)} />}
        {c.showsSystem && <Stat label="Sobrante / faltante" value={`+${fmtInt(plus)} / −${fmtInt(minus)}`} />}
        {c.showsSystem && can('costos.ver') && <Stat label="Valor de la diferencia" value={fmtMoney(diffValue)} hint="Al costo promedio" />}
      </div>

      {canCapture && (
        <Panel className="mb-3">
          <form onSubmit={onScan} className="flex flex-wrap items-start gap-3">
            <div className="relative w-full max-w-md">
              <ScanLine className="pointer-events-none absolute top-2 left-2 h-4 w-4 text-ink-faint" />
              <Input value={scan} onChange={(e) => setScan(e.target.value)} placeholder="Escanea pieza o caja master: suma 1 pieza o las piezas de la caja" className="pl-7 font-mono" autoFocus aria-label="Escanear" />
            </div>
            <div className="pt-1.5 text-sm text-ink-soft">{scanMsg ?? 'También puedes teclear la cantidad en la tabla.'}</div>
          </form>
          {addSku && (
            <div className="mt-2 flex flex-wrap items-end gap-2 rounded border border-warn/30 bg-warn-soft px-3 py-2 text-sm">
              <span className="pb-1.5">Agregar <b className="font-mono">{addSku.skuCode}</b> con {addSku.units} pzas en</span>
              <Field label="Ubicación">
                <Select value={addLoc} onChange={(e) => setAddLoc(e.target.value)} disabled={Boolean(c.locationId)}>
                  <option value="">Selecciona…</option>
                  {(locs.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}
                </Select>
              </Field>
              <Button size="md" variant="primary" loading={busy === 'add'} disabled={!addLoc} onClick={addLine}>Agregar al conteo</Button>
              <Button size="md" variant="ghost" onClick={() => setAddSku(null)}>Descartar</Button>
            </div>
          )}
        </Panel>
      )}

      <Panel
        title="Renglones"
        bodyClassName="p-0"
        actions={
          <div className="flex items-center gap-2">
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrar SKU…" className="h-7 w-40 text-xs" />
            <Select value={view} onChange={(e) => setView(e.target.value as View)} className="h-7 w-36 text-xs">
              <option value="todos">Todos</option>
              <option value="pendientes">Sin capturar</option>
              {c.showsSystem && <option value="diferencias">Con diferencia</option>}
            </Select>
          </div>
        }
      >
        <div className="scroll-thin max-h-[60vh] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-page text-xs text-ink-soft">
              <tr>
                <th className="px-2 py-1.5 text-left">SKU</th>
                <th className="px-2 py-1.5 text-left">Nombre</th>
                <th className="px-2 py-1.5 text-left">Ubicación</th>
                {c.showsSystem && <th className="px-2 py-1.5 text-right">Sistema</th>}
                <th className="w-28 px-2 py-1.5 text-right">Contado</th>
                {c.showsSystem && <th className="px-2 py-1.5 text-right">Diferencia</th>}
                <th className="px-2 py-1.5 text-left">Capturó</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => {
                const v = value(l);
                const d = v !== '' && l.systemQty !== null ? Number(v) - l.systemQty : null;
                return (
                  <tr key={l.id} className={cx('border-t border-line', l.id in edits && 'bg-brand-soft/40')}>
                    <td className="px-2 py-1 font-mono">{l.skuCode}</td>
                    <td className="px-2 py-1"><span className="line-clamp-1 text-xs text-ink-soft">{l.skuName}</span></td>
                    <td className="px-2 py-1">{l.locationCode}</td>
                    {c.showsSystem && <td className="num px-2 py-1">{fmtInt(l.systemQty)}</td>}
                    <td className="px-2 py-0.5">
                      {canCapture ? (
                        <Input
                          inputMode="numeric"
                          value={v}
                          onChange={(e) => setEdits({ ...edits, [l.id]: e.target.value.replace(/[^\d]/g, '') })}
                          className="h-7 num"
                          aria-label={`Contado ${l.skuCode}`}
                        />
                      ) : (
                        <span className="block text-right tabular-nums">{l.countedQty === null ? '—' : fmtInt(l.countedQty)}</span>
                      )}
                    </td>
                    {c.showsSystem && <td className="num px-2 py-1">{d === null ? '—' : d === 0 ? <span className="text-ink-faint">0</span> : <SignedQty value={d} />}</td>}
                    <td className="px-2 py-1 text-xs text-ink-soft">{l.countedByName ? `${l.countedByName} · ${fmtDateTime(l.countedAt)}` : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && <div className="px-3 py-6 text-center text-sm text-ink-soft">Sin renglones con este filtro.</div>}
        </div>
      </Panel>

      <Dialog
        open={closing}
        onClose={() => setClosing(false)}
        width="sm"
        title={`Cerrar el conteo ${c.folio}`}
        footer={
          <>
            <Button onClick={() => setClosing(false)}>Seguir contando</Button>
            <Button variant="primary" loading={busy === 'close' || busy === 'save'} onClick={closeCount}>Cerrar y ajustar</Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <p>
            Se registrará un ajuste por conteo en cada renglón con diferencia ({fmtInt(diffs.length)}: +{fmtInt(plus)} / −{fmtInt(minus)} pzas). Las diferencias se calculan contra la foto de existencia del {fmtDateTime(c.frozenAt)}.
          </p>
          {c.lines.length - counted > 0 && (
            <Checkbox
              label={`Contar como 0 los ${c.lines.length - counted} renglones sin capturar (si no, se dejan igual)`}
              checked={asZero}
              onChange={(e) => setAsZero(e.target.checked)}
            />
          )}
          {isAdmin && <Checkbox label="Autorizar negativos si hubo salidas después de la foto (sólo Administrador)" checked={negative} onChange={(e) => setNegative(e.target.checked)} />}
          {error && <ErrorBox error={error} />}
        </div>
      </Dialog>
    </>
  );
}
