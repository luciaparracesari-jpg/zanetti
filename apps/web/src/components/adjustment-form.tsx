'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { ADJUSTMENT_REASON } from '@erp/shared';
import { ApiError, patch, post } from '@/lib/api';
import { fmtInt, fmtMoney } from '@/lib/format';
import { useLocations, useSkuInfo, useWarehouses } from '@/lib/inventory';
import { useSession } from '@/lib/session';
import { AsyncCombobox } from './combobox';
import { ScanBox, StockQty } from './inventory';
import { useToast } from './toast';
import { Button, ErrorBox, Field, Input, Panel, Select, Textarea, cx } from './ui';

export interface AdjustmentLine {
  key: string;
  masterSkuId: string | null;
  skuLabel: string | null;
  direction: 'IN' | 'OUT';
  qty: string;
  locationId: string;
  lotId: string;
  unitCost: string;
  notes: string;
}

export interface AdjustmentDraft {
  id?: string;
  warehouseId: string;
  reason: string;
  notes: string;
  lines: AdjustmentLine[];
}

let seq = 0;
export const newLine = (p: Partial<AdjustmentLine> = {}): AdjustmentLine => ({
  key: `l${++seq}`,
  masterSkuId: null,
  skuLabel: null,
  direction: 'OUT',
  qty: '',
  locationId: '',
  lotId: '',
  unitCost: '',
  notes: '',
  ...p,
});

/** Captura de un ajuste: entradas (crean lote con su costo) y salidas (FIFO o de un lote específico). */
export function AdjustmentForm({ initial }: { initial: AdjustmentDraft }) {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useSession();
  const costs = can('costos.ver');
  const whs = useWarehouses();
  const [d, setD] = useState<AdjustmentDraft>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const locs = useLocations(d.warehouseId);
  const ids = d.lines.map((l) => l.masterSkuId).filter((x): x is string => Boolean(x));
  const info = useSkuInfo(d.warehouseId, ids);
  const infoOf = (id: string | null) => info.data?.find((i) => i.id === id);

  const setLine = (key: string, p: Partial<AdjustmentLine>) => setD((x) => ({ ...x, lines: x.lines.map((l) => (l.key === key ? { ...l, ...p } : l)) }));
  const err = (path: string) => errors[path];

  const estimate = useMemo(() => {
    let v = 0;
    for (const l of d.lines) {
      const i = infoOf(l.masterSkuId);
      const cost = Number(l.direction === 'IN' && l.unitCost ? l.unitCost : (i?.avgCost ?? 0));
      v += Math.abs(Number(l.qty || 0)) * cost;
    }
    return v;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.lines, info.data]);

  async function save() {
    setSaving(true);
    setErrors({});
    setMsg(null);
    const body = {
      warehouseId: d.warehouseId,
      reason: d.reason,
      notes: d.notes || null,
      items: d.lines
        .filter((l) => l.masterSkuId || l.qty)
        .map((l) => ({
          masterSkuId: l.masterSkuId ?? '',
          qty: l.direction === 'OUT' ? -Math.abs(Number(l.qty || 0)) : Math.abs(Number(l.qty || 0)),
          locationId: l.locationId || null,
          lotId: l.direction === 'OUT' ? l.lotId || null : null,
          unitCost: l.direction === 'IN' && l.unitCost ? l.unitCost : null,
          notes: l.notes || null,
        })),
    };
    try {
      const r = d.id ? await patch<{ id: string }>(`/adjustments/${d.id}`, body) : await post<{ id: string; folio: string }>('/adjustments', body);
      toast.ok(d.id ? 'Ajuste guardado.' : 'Ajuste creado en borrador. Revísalo y aplícalo.');
      qc.invalidateQueries({ queryKey: ['/adjustments'] });
      qc.invalidateQueries({ queryKey: ['adjustment', r.id] });
      router.push(`/inventario/ajustes/${r.id}`);
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
      <Panel title="Datos del ajuste">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Almacén" required error={err('warehouseId')}>
            <Select value={d.warehouseId} disabled={Boolean(d.id)} onChange={(e) => setD({ ...d, warehouseId: e.target.value, lines: d.lines.map((l) => ({ ...l, locationId: '', lotId: '' })) })}>
              <option value="">Selecciona…</option>
              {(whs.data ?? []).map((w) => (
                <option key={w.id} value={w.id}>{w.code} · {w.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Motivo" required error={err('reason')}>
            <Select value={d.reason} onChange={(e) => setD({ ...d, reason: e.target.value })}>
              {Object.entries(ADJUSTMENT_REASON).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </Field>
          <Field label="Notas" error={err('notes')} hint="Obligatorio para “Otro” y “Error de captura”.">
            <Textarea value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} className="min-h-8" rows={1} />
          </Field>
        </div>
      </Panel>

      <Panel
        title={`Renglones (${d.lines.length})`}
        actions={
          <div className="flex items-center gap-2">
            {costs && <span className="text-xs text-ink-soft">Valor estimado: <b className="text-ink">{fmtMoney(estimate)}</b></span>}
            <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setD({ ...d, lines: [...d.lines, newLine()] })} disabled={!d.warehouseId}>
              Renglón
            </Button>
          </div>
        }
        bodyClassName="p-0"
      >
        <div className="border-b border-line p-2">
          <ScanBox
            className="max-w-xl"
            onResolved={(r) => {
              if (!r.sku) return;
              const units = r.units ?? 1;
              const existing = d.lines.find((l) => l.masterSkuId === r.sku!.id && !l.lotId && !l.locationId);
              if (existing) setLine(existing.key, { qty: String(Number(existing.qty || 0) + units) });
              else setD((x) => ({ ...x, lines: [...x.lines.filter((l) => l.masterSkuId || l.qty), newLine({ masterSkuId: r.sku!.id, skuLabel: r.sku!.skuCode, qty: String(units) })] }));
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
                <th className="w-28 px-2 py-1.5 text-left">Tipo</th>
                <th className="w-24 px-2 py-1.5 text-right">Piezas</th>
                <th className="w-32 px-2 py-1.5 text-left">Ubicación</th>
                <th className="w-40 px-2 py-1.5 text-left">Lote</th>
                {costs && <th className="w-28 px-2 py-1.5 text-right">Costo unit.</th>}
                <th className="w-24 px-2 py-1.5 text-right">Disponible</th>
                <th className="w-24 px-2 py-1.5 text-right">Queda</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {d.lines.map((l, i) => {
                const inf = infoOf(l.masterSkuId);
                const lots = (inf?.balances ?? []).filter((b) => b.lotId && b.qty > 0 && (!l.locationId || b.locationId === l.locationId));
                const signed = (l.direction === 'OUT' ? -1 : 1) * Math.abs(Number(l.qty || 0));
                const after = (inf?.onHand ?? 0) + signed;
                return (
                  <tr key={l.key} className="border-t border-line align-top">
                    <td className="px-2 py-1.5 text-xs text-ink-faint">{i + 1}</td>
                    <td className="px-2 py-1">
                      <AsyncCombobox<{ id: string; skuCode: string; name: string; isKit: boolean }>
                        value={l.masterSkuId}
                        initialLabel={l.skuLabel}
                        onChange={(v, o) => setLine(l.key, { masterSkuId: v, skuLabel: o?.label ?? null, lotId: '' })}
                        fetchPath="/skus/options"
                        map={(s) => ({ value: s.id, label: s.skuCode, hint: `${s.isKit ? 'Kit · ' : ''}${s.name}` })}
                        placeholder="Buscar SKU…"
                        invalid={Boolean(err(`items.${i}.masterSkuId`))}
                      />
                      {inf && <div className="mt-0.5 line-clamp-1 text-xs text-ink-soft">{inf.name}</div>}
                      {err(`items.${i}.masterSkuId`) && <div className="text-xs text-bad">{err(`items.${i}.masterSkuId`)}</div>}
                    </td>
                    <td className="px-2 py-1">
                      <Select value={l.direction} onChange={(e) => setLine(l.key, { direction: e.target.value as 'IN' | 'OUT', lotId: '', unitCost: '' })}>
                        <option value="OUT">Salida</option>
                        <option value="IN">Entrada</option>
                      </Select>
                    </td>
                    <td className="px-2 py-1">
                      <Input inputMode="numeric" value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value.replace(/[^\d]/g, '') })} className="num" aria-invalid={Boolean(err(`items.${i}.qty`))} />
                      {err(`items.${i}.qty`) && <div className="text-xs text-bad">{err(`items.${i}.qty`)}</div>}
                    </td>
                    <td className="px-2 py-1">
                      <Select value={l.locationId} onChange={(e) => setLine(l.key, { locationId: e.target.value, lotId: '' })}>
                        <option value="">{l.direction === 'IN' ? 'GEN' : 'FIFO (vendibles)'}</option>
                        {(locs.data ?? []).map((x) => (
                          <option key={x.id} value={x.id}>{x.code}</option>
                        ))}
                      </Select>
                      {err(`items.${i}.locationId`) && <div className="text-xs text-bad">{err(`items.${i}.locationId`)}</div>}
                    </td>
                    <td className="px-2 py-1">
                      {l.direction === 'OUT' ? (
                        <Select value={l.lotId} onChange={(e) => setLine(l.key, { lotId: e.target.value })}>
                          <option value="">FIFO (más antiguo)</option>
                          {lots.map((b) => (
                            <option key={`${b.lotId}-${b.locationId}`} value={b.lotId!}>{b.lotCode} · {b.locationCode} · {fmtInt(b.qty)}</option>
                          ))}
                        </Select>
                      ) : (
                        <span className="text-xs text-ink-faint">Lote nuevo</span>
                      )}
                      {err(`items.${i}.lotId`) && <div className="text-xs text-bad">{err(`items.${i}.lotId`)}</div>}
                    </td>
                    {costs && (
                      <td className="px-2 py-1">
                        {l.direction === 'IN' ? (
                          <Input inputMode="decimal" value={l.unitCost} placeholder={inf?.avgCost ? Number(inf.avgCost).toFixed(2) : '0.00'} onChange={(e) => setLine(l.key, { unitCost: e.target.value })} className="num" />
                        ) : (
                          <span className="block pt-1.5 text-right text-xs text-ink-faint">FIFO</span>
                        )}
                        {err(`items.${i}.unitCost`) && <div className="text-xs text-bad">{err(`items.${i}.unitCost`)}</div>}
                      </td>
                    )}
                    <td className="num px-2 py-1.5">{inf ? <StockQty value={inf.available} /> : '—'}</td>
                    <td className={cx('num px-2 py-1.5', after < 0 && 'text-bad')}>{inf && l.qty ? <StockQty value={after} strong /> : '—'}</td>
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
        <Button variant="primary" loading={saving} disabled={!d.warehouseId || d.lines.length === 0} onClick={save}>
          {d.id ? 'Guardar cambios' : 'Guardar borrador'}
        </Button>
      </div>
    </div>
  );
}
