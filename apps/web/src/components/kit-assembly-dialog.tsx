'use client';

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, get, post } from '@/lib/api';
import { fmtInt, fmtMoney } from '@/lib/format';
import { useWarehouses } from '@/lib/inventory';
import { useSession } from '@/lib/session';
import { AsyncCombobox } from './combobox';
import { StockQty } from './inventory';
import { useToast } from './toast';
import { Button, Checkbox, Dialog, ErrorBox, Field, Input, Select } from './ui';

interface KitStock {
  sku: { id: string; skuCode: string; name: string; isKit: boolean };
  byWarehouse: { warehouseId: string; code: string; type: string; onHand: number; available: number; assemblable: number }[];
  components: { componentId: string; qty: number; skuCode: string; name: string }[];
}

/**
 * Armar kits en un almacén (salen los componentes, entra el kit con su costo) o desarmarlos.
 * Se usa antes de enviar bundles a FBA o FBL: allá el canal no arma kits con piezas sueltas.
 */
export function KitAssemblyDialog({ open, onClose, kit }: { open: boolean; onClose: () => void; kit?: { id: string; skuCode: string } | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useSession();
  const whs = useWarehouses();
  const [kitId, setKitId] = useState<string | null>(kit?.id ?? null);
  const [kitLabel, setKitLabel] = useState<string | null>(kit?.skuCode ?? null);
  const [warehouseId, setWarehouseId] = useState('');
  const [mode, setMode] = useState<'ARMAR' | 'DESARMAR'>('ARMAR');
  const [qty, setQty] = useState('');
  const [notes, setNotes] = useState('');
  const [negative, setNegative] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setKitId(kit?.id ?? null);
    setKitLabel(kit?.skuCode ?? null);
    setQty('');
    setNotes('');
    setError(null);
    setNegative(false);
    setMode('ARMAR');
  }, [open, kit]);
  useEffect(() => {
    if (open && !warehouseId && whs.data?.length) setWarehouseId(whs.data.find((w) => w.code === 'APLIN')?.id ?? whs.data[0].id);
  }, [open, whs.data, warehouseId]);

  const info = useQuery({ queryKey: ['/inventory/stock', kitId], queryFn: () => get<KitStock>(`/inventory/stock/${kitId}`), enabled: open && Boolean(kitId) });
  const here = info.data?.byWarehouse.find((w) => w.warehouseId === warehouseId);
  const compStock = useQuery({
    queryKey: ['kit-components-stock', kitId, warehouseId],
    queryFn: async () => {
      const ids = (info.data?.components ?? []).map((c) => c.componentId).join(',');
      return get<{ id: string; available: number }[]>(`/inventory/sku-info?warehouseId=${warehouseId}&ids=${ids}`);
    },
    enabled: open && Boolean(info.data?.components.length) && Boolean(warehouseId),
  });
  const n = Number(qty || 0);
  const maxArmar = info.data?.components.length
    ? Math.min(...info.data.components.map((c) => Math.floor(Math.max(compStock.data?.find((x) => x.id === c.componentId)?.available ?? 0, 0) / c.qty)))
    : 0;
  const maxDesarmar = Math.max((here?.available ?? 0) - (here?.assemblable ?? 0), 0);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ folio: string; kitCost: string | null }>('/inventory/kit-assembly', { kitId, warehouseId, qty: n, mode, notes: notes || null, authorizeNegative: negative });
      toast.ok(`${mode === 'ARMAR' ? 'Armados' : 'Desarmados'} ${fmtInt(n)} kits ${kitLabel ?? ''}${r.kitCost ? ` · costo ${fmtMoney(r.kitCost)}` : ''}.`);
      qc.invalidateQueries({ queryKey: ['/inventory/stock'] });
      qc.invalidateQueries({ queryKey: ['/inventory/movements'] });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'No se pudo completar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Armar o desarmar kits"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={busy} disabled={!kitId || !warehouseId || n <= 0} onClick={submit}>
            {mode === 'ARMAR' ? `Armar ${n > 0 ? fmtInt(n) : ''} kits` : `Desarmar ${n > 0 ? fmtInt(n) : ''} kits`}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {error && <div className="sm:col-span-2"><ErrorBox error={error} /></div>}
        <p className="text-sm text-ink-soft sm:col-span-2">
          Arma los bundles antes de mandarlos a Amazon FBA o Liverpool: salen los componentes y entra el kit con la suma de sus costos. Desarmar hace lo contrario. El valor del inventario no cambia.
        </p>
        <Field label="Kit" required>
          <AsyncCombobox<{ id: string; skuCode: string; name: string }>
            value={kitId}
            initialLabel={kitLabel}
            onChange={(v, o) => {
              setKitId(v);
              setKitLabel(o?.label ?? null);
            }}
            fetchPath="/skus/options?onlyKits=true"
            map={(s) => ({ value: s.id, label: s.skuCode, hint: s.name })}
            placeholder="Buscar kit…"
          />
        </Field>
        <Field label="Almacén" required>
          <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            {(whs.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}
          </Select>
        </Field>
        <Field label="Operación">
          <Select value={mode} onChange={(e) => setMode(e.target.value as 'ARMAR' | 'DESARMAR')}>
            <option value="ARMAR">Armar (componentes → kit)</option>
            <option value="DESARMAR">Desarmar (kit → componentes)</option>
          </Select>
        </Field>
        <Field label="Kits" required hint={mode === 'ARMAR' ? `Alcanza para ${fmtInt(maxArmar)}` : `Hay ${fmtInt(maxDesarmar)} armados`}>
          <Input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d]/g, ''))} className="num" />
        </Field>
        {info.data && (
          <div className="rounded border border-line sm:col-span-2">
            <table className="w-full text-sm">
              <thead className="bg-page text-xs text-ink-soft">
                <tr>
                  <th className="px-2 py-1 text-left">Componente</th>
                  <th className="px-2 py-1 text-right">Por kit</th>
                  <th className="px-2 py-1 text-right">Disponible aquí</th>
                  <th className="px-2 py-1 text-right">{mode === 'ARMAR' ? 'Sale' : 'Regresa'}</th>
                </tr>
              </thead>
              <tbody>
                {info.data.components.map((c) => (
                  <tr key={c.componentId} className="border-t border-line">
                    <td className="px-2 py-1"><span className="font-mono">{c.skuCode}</span> <span className="text-xs text-ink-soft">{c.name}</span></td>
                    <td className="num px-2 py-1">{c.qty}</td>
                    <td className="num px-2 py-1"><StockQty value={compStock.data?.find((x) => x.id === c.componentId)?.available ?? 0} /></td>
                    <td className="num px-2 py-1">{n > 0 ? fmtInt(c.qty * n) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Field label="Notas" className="sm:col-span-2">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ej. bundles para el envío FBA15…" />
        </Field>
        {me.roles.includes('ADMIN') && (
          <div className="sm:col-span-2">
            <Checkbox label="Autorizar negativos si no alcanza (sólo Administrador)" checked={negative} onChange={(e) => setNegative(e.target.checked)} />
          </div>
        )}
      </div>
    </Dialog>
  );
}
