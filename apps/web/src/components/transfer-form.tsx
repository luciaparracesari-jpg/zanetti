'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Plus, Trash2 } from 'lucide-react';
import { ApiError, patch, post } from '@/lib/api';
import { fmtInt } from '@/lib/format';
import { useSkuInfo, useWarehouses } from '@/lib/inventory';
import { AsyncCombobox } from './combobox';
import { ScanBox, StockQty } from './inventory';
import { useToast } from './toast';
import { Badge, Button, ErrorBox, Field, Input, Panel, Select, Textarea } from './ui';

export interface TransferLine {
  key: string;
  masterSkuId: string | null;
  skuLabel: string | null;
  packageId: string;
  packageQty: string;
  qty: string;
}

export interface TransferDraft {
  id?: string;
  originWarehouseId: string;
  destinationWarehouseId: string;
  reference: string;
  notes: string;
  lines: TransferLine[];
}

let seq = 0;
export const newTransferLine = (p: Partial<TransferLine> = {}): TransferLine => ({
  key: `t${++seq}`,
  masterSkuId: null,
  skuLabel: null,
  packageId: '',
  packageQty: '',
  qty: '',
  ...p,
});

/** Envío de mercancía entre almacenes (APLIN → Amazon FBA / Liverpool FBL), por piezas o por caja master. */
export function TransferForm({ initial }: { initial: TransferDraft }) {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const whs = useWarehouses();
  const [d, setD] = useState<TransferDraft>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const ids = d.lines.map((l) => l.masterSkuId).filter((x): x is string => Boolean(x));
  const info = useSkuInfo(d.originWarehouseId, ids);
  const infoOf = (id: string | null) => info.data?.find((i) => i.id === id);
  const setLine = (key: string, p: Partial<TransferLine>) => setD((x) => ({ ...x, lines: x.lines.map((l) => (l.key === key ? { ...l, ...p } : l)) }));
  const err = (p: string) => errors[p];

  const pieces = (l: TransferLine) => {
    if (l.packageId) {
      const pk = infoOf(l.masterSkuId)?.packages.find((p) => p.id === l.packageId);
      return (pk?.units ?? 0) * Number(l.packageQty || 0);
    }
    return Number(l.qty || 0);
  };
  const totalPieces = d.lines.reduce((s, l) => s + pieces(l), 0);
  const totalBoxes = d.lines.reduce((s, l) => s + (l.packageId ? Number(l.packageQty || 0) : 0), 0);

  async function save() {
    setSaving(true);
    setErrors({});
    setMsg(null);
    const body = {
      originWarehouseId: d.originWarehouseId,
      destinationWarehouseId: d.destinationWarehouseId,
      reference: d.reference || null,
      notes: d.notes || null,
      items: d.lines
        .filter((l) => l.masterSkuId || l.qty || l.packageQty)
        .map((l) => ({
          masterSkuId: l.masterSkuId ?? '',
          packageId: l.packageId || null,
          packageQty: l.packageId ? l.packageQty || null : null,
          qtyRequested: l.packageId ? null : l.qty || null,
        })),
    };
    try {
      const r = d.id ? await patch<{ id: string }>(`/transfers/${d.id}`, body) : await post<{ id: string; folio: string }>('/transfers', body);
      toast.ok(d.id ? 'Transferencia guardada.' : 'Transferencia creada en borrador. Autorízala para apartar la mercancía.');
      qc.invalidateQueries({ queryKey: ['/transfers'] });
      qc.invalidateQueries({ queryKey: ['transfer', r.id] });
      router.push(`/inventario/transferencias/${r.id}`);
    } catch (e) {
      if (e instanceof ApiError) {
        setErrors(Object.fromEntries(e.errors.map((x) => [x.path, x.message])));
        setMsg(e.message);
      } else setMsg('No se pudo guardar.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {msg && <ErrorBox error={msg} />}
      <Panel title="Ruta">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr_1fr] sm:items-start">
          <Field label="Origen" required error={err('originWarehouseId')}>
            <Select value={d.originWarehouseId} onChange={(e) => setD({ ...d, originWarehouseId: e.target.value })}>
              <option value="">Selecciona…</option>
              {(whs.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}
            </Select>
          </Field>
          <ArrowRight className="mt-7 hidden h-4 w-4 text-ink-faint sm:block" />
          <Field label="Destino" required error={err('destinationWarehouseId')}>
            <Select value={d.destinationWarehouseId} onChange={(e) => setD({ ...d, destinationWarehouseId: e.target.value })}>
              <option value="">Selecciona…</option>
              {(whs.data ?? []).filter((w) => w.id !== d.originWarehouseId).map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}
            </Select>
          </Field>
          <Field label="Referencia" hint="ID de envío de Amazon (FBA15…), cita de Liverpool o guía." error={err('reference')}>
            <Input value={d.reference} onChange={(e) => setD({ ...d, reference: e.target.value })} className="font-mono" />
          </Field>
          <Field label="Notas" className="sm:col-span-4" error={err('notes')}>
            <Textarea value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} rows={1} className="min-h-8" />
          </Field>
        </div>
      </Panel>

      <Panel
        title={`SKU a enviar (${d.lines.length})`}
        actions={
          <div className="flex items-center gap-3">
            <span className="text-xs text-ink-soft">
              <b className="text-ink">{fmtInt(totalPieces)}</b> pzas{totalBoxes ? <> · <b className="text-ink">{fmtInt(totalBoxes)}</b> cajas</> : null}
            </span>
            <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setD({ ...d, lines: [...d.lines, newTransferLine()] })}>Renglón</Button>
          </div>
        }
        bodyClassName="p-0"
      >
        <div className="border-b border-line p-2">
          <ScanBox
            className="max-w-xl"
            placeholder="Escanea la caja master o el código de barras para agregarlo…"
            onResolved={(r) => {
              if (!r.sku) return;
              setD((x) => {
                const lines = x.lines.filter((l) => l.masterSkuId || l.qty || l.packageQty);
                const same = lines.find((l) => l.masterSkuId === r.sku!.id);
                if (same) {
                  if (r.packageId && (same.packageId === r.packageId || !same.qty)) return { ...x, lines: lines.map((l) => (l.key === same.key ? { ...l, packageId: r.packageId!, packageQty: String(Number(l.packageQty || 0) + 1), qty: '' } : l)) };
                  return { ...x, lines: lines.map((l) => (l.key === same.key ? { ...l, packageId: '', packageQty: '', qty: String(pieces(l) + (r.units ?? 1)) } : l)) };
                }
                return {
                  ...x,
                  lines: [...lines, newTransferLine({ masterSkuId: r.sku!.id, skuLabel: r.sku!.skuCode, ...(r.packageId ? { packageId: r.packageId, packageQty: '1' } : { qty: String(r.units ?? 1) }) })],
                };
              });
            }}
          />
        </div>
        {err('items') && <div className="px-3 pt-2 text-xs text-bad">{err('items')}</div>}
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-page text-xs text-ink-soft">
              <tr>
                <th className="w-8 px-2 py-1.5 text-left">#</th>
                <th className="min-w-56 px-2 py-1.5 text-left">SKU</th>
                <th className="w-48 px-2 py-1.5 text-left">Captura</th>
                <th className="w-24 px-2 py-1.5 text-right">Cajas</th>
                <th className="w-24 px-2 py-1.5 text-right">Piezas</th>
                <th className="w-28 px-2 py-1.5 text-right">Disponible en origen</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {d.lines.map((l, i) => {
                const inf = infoOf(l.masterSkuId);
                const pz = pieces(l);
                return (
                  <tr key={l.key} className="border-t border-line align-top">
                    <td className="px-2 py-1.5 text-xs text-ink-faint">{i + 1}</td>
                    <td className="px-2 py-1">
                      <AsyncCombobox<{ id: string; skuCode: string; name: string }>
                        value={l.masterSkuId}
                        initialLabel={l.skuLabel}
                        onChange={(v, o) => setLine(l.key, { masterSkuId: v, skuLabel: o?.label ?? null, packageId: '', packageQty: '' })}
                        fetchPath="/skus/options?excludeKits=true"
                        map={(s) => ({ value: s.id, label: s.skuCode, hint: s.name })}
                        placeholder="Buscar SKU…"
                        invalid={Boolean(err(`items.${i}.masterSkuId`))}
                      />
                      {inf && <div className="mt-0.5 line-clamp-1 text-xs text-ink-soft">{inf.name}</div>}
                      {err(`items.${i}.masterSkuId`) && <div className="text-xs text-bad">{err(`items.${i}.masterSkuId`)}</div>}
                    </td>
                    <td className="px-2 py-1">
                      <Select
                        value={l.packageId}
                        onChange={(e) => setLine(l.key, e.target.value ? { packageId: e.target.value, packageQty: l.packageQty || '1', qty: '' } : { packageId: '', packageQty: '', qty: l.qty || String(pz || '') })}
                        disabled={!inf}
                      >
                        <option value="">Por piezas</option>
                        {(inf?.packages ?? []).map((p) => <option key={p.id} value={p.id}>Caja {p.code} · {p.units} pzas</option>)}
                      </Select>
                      {err(`items.${i}.packageId`) && <div className="text-xs text-bad">{err(`items.${i}.packageId`)}</div>}
                    </td>
                    <td className="px-2 py-1">
                      {l.packageId ? (
                        <Input inputMode="numeric" value={l.packageQty} onChange={(e) => setLine(l.key, { packageQty: e.target.value.replace(/[^\d]/g, '') })} className="num" aria-invalid={Boolean(err(`items.${i}.packageQty`))} />
                      ) : (
                        <span className="block pt-1.5 text-right text-ink-faint">—</span>
                      )}
                    </td>
                    <td className="px-2 py-1">
                      {l.packageId ? (
                        <span className="block pt-1.5 text-right font-semibold tabular-nums">{fmtInt(pz)}</span>
                      ) : (
                        <Input inputMode="numeric" value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value.replace(/[^\d]/g, '') })} className="num" aria-invalid={Boolean(err(`items.${i}.qtyRequested`))} />
                      )}
                      {err(`items.${i}.qtyRequested`) && <div className="text-xs text-bad">{err(`items.${i}.qtyRequested`)}</div>}
                    </td>
                    <td className="num px-2 py-1.5">
                      {inf ? (
                        <>
                          <StockQty value={inf.available} />
                          {pz > inf.available && <Badge tone="bad" className="ml-1">no alcanza</Badge>}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-1 py-1">
                      <button className="rounded p-1 text-ink-faint hover:text-bad" onClick={() => setD({ ...d, lines: d.lines.filter((x) => x.key !== l.key) })} aria-label="Quitar renglón">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="flex justify-end gap-2">
        <Button onClick={() => router.back()}>Cancelar</Button>
        <Button variant="primary" loading={saving} disabled={!d.originWarehouseId || !d.destinationWarehouseId || d.lines.length === 0} onClick={save}>
          {d.id ? 'Guardar cambios' : 'Guardar borrador'}
        </Button>
      </div>
    </div>
  );
}
