'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { TRANSFER_STATUS } from '@erp/shared';
import { ApiError, get, post } from '@/lib/api';
import { fmtCost, fmtDateTime, fmtInt, fmtMoney } from '@/lib/format';
import { useLocations } from '@/lib/inventory';
import { useSession } from '@/lib/session';
import { StockQty } from '@/components/inventory';
import { TransferForm, newTransferLine } from '@/components/transfer-form';
import { useToast } from '@/components/toast';
import { Badge, Button, Checkbox, Dialog, ErrorBox, Field, Input, PageHeader, Panel, Select, Spinner, Stat, StatusBadge, cx } from '@/components/ui';

interface Lot { itemId: string; lotId: string | null; lotCode: string | null; qty: number; qtyReceived: number; unitCost: string | null }
interface Item {
  id: string;
  lineNo: number;
  masterSkuId: string;
  skuCode: string;
  skuName: string;
  qtyRequested: number;
  packageId: string | null;
  packageCode: string | null;
  packageUnits: number | null;
  packageQty: number | null;
  qtyShipped: number | null;
  qtyReceived: number | null;
  originAvailable: number;
  lots: Lot[];
}
interface Transfer {
  id: string;
  folio: string;
  status: keyof typeof TRANSFER_STATUS;
  reference: string | null;
  notes: string | null;
  originWarehouseId: string;
  destinationWarehouseId: string;
  originCode: string;
  originName: string;
  destinationCode: string;
  destinationName: string;
  createdAt: string;
  createdByName?: string;
  authorizedAt: string | null;
  authorizedByName?: string;
  shippedAt: string | null;
  shippedByName?: string;
  receivedAt: string | null;
  receivedByName?: string;
  cancelledAt: string | null;
  shippedValue?: string;
  items: Item[];
}

const STEPS: { key: string; label: string }[] = [
  { key: 'BORRADOR', label: 'Borrador' },
  { key: 'AUTORIZADA', label: 'Autorizada' },
  { key: 'ENVIADA', label: 'En tránsito' },
  { key: 'RECIBIDA', label: 'Recibida' },
];

export default function TransferPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const { can, me } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const costs = can('costos.ver');
  const isAdmin = me.roles.includes('ADMIN');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | 'ship' | 'receive'>(null);
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [reference, setReference] = useState('');
  const [negative, setNegative] = useState(false);
  const [close, setClose] = useState(false);
  const [locationId, setLocationId] = useState('');
  const [dialogError, setDialogError] = useState<{ msg: string; fields: Record<string, string> } | null>(null);

  const q = useQuery({ queryKey: ['transfer', id], queryFn: () => get<Transfer>(`/transfers/${id}`) });
  const t = q.data;
  const destLocs = useLocations(t?.status === 'ENVIADA' ? t.destinationWarehouseId : null);
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  if (!t) return null;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['transfer', id] });
    qc.invalidateQueries({ queryKey: ['/transfers'] });
    qc.invalidateQueries({ queryKey: ['/inventory/stock'] });
  };

  async function simple(action: 'authorize' | 'cancel') {
    setBusy(action);
    setError(null);
    try {
      await post(`/transfers/${id}/${action}`);
      toast.ok(action === 'authorize' ? 'Transferencia autorizada: la mercancía quedó apartada en el origen.' : 'Transferencia cancelada.');
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'No se pudo completar.');
    } finally {
      setBusy(null);
    }
  }

  function openShip() {
    setQtys(Object.fromEntries(t!.items.map((i) => [i.id, String(i.qtyRequested)])));
    setReference(t!.reference ?? '');
    setNegative(false);
    setDialogError(null);
    setDialog('ship');
  }
  function openReceive() {
    setQtys(Object.fromEntries(t!.items.map((i) => [i.id, String(Math.max((i.qtyShipped ?? 0) - (i.qtyReceived ?? 0), 0))])));
    setClose(false);
    setLocationId('');
    setDialogError(null);
    setDialog('receive');
  }

  const fieldErrors = (e: ApiError, key: 'qtyShipped' | 'qty') =>
    Object.fromEntries(
      e.errors
        .map((x) => {
          const m = new RegExp(`^items\\.(\\d+)\\.${key}$`).exec(x.path);
          const item = m ? t!.items[Number(m[1])] : undefined;
          return item ? [item.id, x.message] : null;
        })
        .filter((x): x is [string, string] => x !== null),
    );

  async function ship() {
    setBusy('ship');
    setDialogError(null);
    try {
      const r = await post<{ units: number }>(`/transfers/${id}/ship`, {
        reference: reference || null,
        items: t!.items.map((i) => ({ itemId: i.id, qtyShipped: Number(qtys[i.id] || 0) })),
        authorizeNegative: negative,
      });
      toast.ok(`Enviadas ${fmtInt(r.units)} pzas. Quedan en tránsito hacia ${t!.destinationCode}.`);
      setDialog(null);
      refresh();
    } catch (e) {
      if (e instanceof ApiError) setDialogError({ msg: e.message, fields: fieldErrors(e, 'qtyShipped') });
      else setDialogError({ msg: 'No se pudo enviar.', fields: {} });
    } finally {
      setBusy(null);
    }
  }

  async function receive() {
    setBusy('receive');
    setDialogError(null);
    try {
      const r = await post<{ status: string; units: number; missing: number }>(`/transfers/${id}/receive`, {
        items: t!.items.filter((i) => (i.qtyShipped ?? 0) > 0).map((i) => ({ itemId: i.id, qty: Number(qtys[i.id] || 0) })),
        locationId: locationId || null,
        close,
      });
      toast.ok(
        r.status === 'RECIBIDA'
          ? `Recibidas ${fmtInt(r.units)} pzas. Transferencia completa.`
          : r.status === 'RECIBIDA_CON_DIFERENCIAS'
            ? `Recibidas ${fmtInt(r.units)} pzas. Se cerró con ${fmtInt(r.missing)} pzas faltantes.`
            : `Recibidas ${fmtInt(r.units)} pzas. Faltan ${fmtInt(r.missing)} por recibir.`,
      );
      setDialog(null);
      refresh();
    } catch (e) {
      if (e instanceof ApiError) setDialogError({ msg: e.message, fields: fieldErrors(e, 'qty') });
      else setDialogError({ msg: 'No se pudo recibir.', fields: {} });
    } finally {
      setBusy(null);
    }
  }

  if (sp.get('editar') === '1' && t.status === 'BORRADOR') {
    return (
      <>
        <PageHeader
          breadcrumbs={[{ label: 'Inventario', href: '/inventario' }, { label: 'Transferencias', href: '/inventario/transferencias' }, { label: t.folio, href: pathname }, { label: 'Editar' }]}
          title={`Editar transferencia ${t.folio}`}
        />
        <TransferForm
          initial={{
            id: t.id,
            originWarehouseId: t.originWarehouseId,
            destinationWarehouseId: t.destinationWarehouseId,
            reference: t.reference ?? '',
            notes: t.notes ?? '',
            lines: t.items.map((i) =>
              newTransferLine({
                masterSkuId: i.masterSkuId,
                skuLabel: i.skuCode,
                packageId: i.packageId ?? '',
                packageQty: i.packageQty ? String(i.packageQty) : '',
                qty: i.packageId ? '' : String(i.qtyRequested),
              }),
            ),
          }}
        />
      </>
    );
  }

  const requested = t.items.reduce((s, i) => s + i.qtyRequested, 0);
  const shipped = t.items.reduce((s, i) => s + (i.qtyShipped ?? 0), 0);
  const received = t.items.reduce((s, i) => s + (i.qtyReceived ?? 0), 0);
  const boxes = t.items.reduce((s, i) => s + (i.packageQty ?? 0), 0);
  const stepIdx = t.status === 'RECIBIDA_CON_DIFERENCIAS' ? 3 : STEPS.findIndex((s) => s.key === t.status);
  const shortItems = t.items.filter((i) => i.qtyRequested > i.originAvailable);

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Inventario', href: '/inventario' }, { label: 'Transferencias', href: '/inventario/transferencias' }, { label: t.folio }]}
        title={
          <span className="flex items-center gap-2">
            Transferencia <span className="font-mono">{t.folio}</span> <StatusBadge value={t.status} labels={TRANSFER_STATUS} />
          </span>
        }
        subtitle={`${t.originCode} · ${t.originName} → ${t.destinationCode} · ${t.destinationName}${t.reference ? ` · ref. ${t.reference}` : ''}`}
        actions={
          <>
            {t.status === 'BORRADOR' && can('transferencias.editar') && <Button onClick={() => router.push(`${pathname}?editar=1`)}>Editar</Button>}
            {(t.status === 'BORRADOR' || t.status === 'AUTORIZADA') && can('transferencias.editar') && (
              <Button variant="danger" loading={busy === 'cancel'} onClick={() => window.confirm(`¿Cancelar la transferencia ${t.folio}?${t.status === 'AUTORIZADA' ? ' Se libera lo apartado.' : ''}`) && simple('cancel')}>
                Cancelar
              </Button>
            )}
            {t.status === 'BORRADOR' && can('transferencias.autorizar') && (
              <Button variant="primary" loading={busy === 'authorize'} onClick={() => simple('authorize')}>Autorizar y apartar</Button>
            )}
            {t.status === 'AUTORIZADA' && can('transferencias.editar') && <Button variant="primary" onClick={openShip}>Registrar envío</Button>}
            {t.status === 'ENVIADA' && can('transferencias.editar') && <Button variant="primary" onClick={openReceive}>Registrar recepción</Button>}
            {t.shippedAt && <Link href={`/inventario/movimientos?documentId=${t.id}`}><Button>Movimientos</Button></Link>}
          </>
        }
      />
      {error && <div className="mb-3"><ErrorBox error={error} /></div>}

      {t.status !== 'CANCELADA' && (
        <ol className="mb-3 flex flex-wrap items-center gap-1 text-xs">
          {STEPS.map((s, i) => (
            <li key={s.key} className="flex items-center gap-1">
              <span
                className={cx(
                  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5',
                  i < stepIdx ? 'border-ok/40 bg-ok-soft text-ok' : i === stepIdx ? 'border-brand bg-brand-soft font-semibold text-brand' : 'border-line text-ink-faint',
                )}
              >
                {i < stepIdx && <Check className="h-3 w-3" />}
                {i === 3 && t.status === 'RECIBIDA_CON_DIFERENCIAS' ? 'Recibida con diferencias' : s.label}
              </span>
              {i < STEPS.length - 1 && <span className="text-ink-faint">—</span>}
            </li>
          ))}
        </ol>
      )}

      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <Stat label="SKU" value={fmtInt(t.items.length)} />
        <Stat label="Solicitado" value={`${fmtInt(requested)} pzas`} />
        {boxes > 0 && <Stat label="Cajas master" value={fmtInt(boxes)} />}
        <Stat label="Enviado" value={t.shippedAt ? `${fmtInt(shipped)} pzas` : '—'} tone={t.status === 'ENVIADA' ? 'brand' : undefined} />
        <Stat label="Recibido" value={t.shippedAt ? `${fmtInt(received)} pzas` : '—'} />
        {costs && t.shippedValue !== undefined && t.shippedAt && <Stat label="Valor enviado" value={fmtMoney(t.shippedValue)} />}
      </div>

      {t.status === 'BORRADOR' && shortItems.length > 0 && (
        <div className="mb-3 rounded border border-warn/30 bg-warn-soft px-3 py-2 text-sm text-warn">
          {shortItems.length} SKU piden más de lo disponible en {t.originCode}. No se podrá autorizar hasta ajustar las cantidades o recibir mercancía.
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-[1fr_18rem]">
        <Panel title="Partidas" bodyClassName="p-0">
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-page text-xs text-ink-soft">
                <tr>
                  <th className="px-2 py-1.5 text-left">#</th>
                  <th className="px-2 py-1.5 text-left">SKU</th>
                  <th className="px-2 py-1.5 text-left">Caja master</th>
                  <th className="px-2 py-1.5 text-right">Solicitado</th>
                  {(t.status === 'BORRADOR' || t.status === 'AUTORIZADA') && <th className="px-2 py-1.5 text-right">Disponible en {t.originCode}</th>}
                  <th className="px-2 py-1.5 text-right">Enviado</th>
                  <th className="px-2 py-1.5 text-right">Recibido</th>
                  <th className="px-2 py-1.5 text-right">Diferencia</th>
                  {costs && t.shippedAt && <th className="px-2 py-1.5 text-left">Lotes (costo)</th>}
                </tr>
              </thead>
              <tbody>
                {t.items.map((i) => {
                  const diff = (i.qtyReceived ?? 0) - (i.qtyShipped ?? 0);
                  return (
                    <tr key={i.id} className="border-t border-line align-top">
                      <td className="px-2 py-1.5 text-xs text-ink-faint">{i.lineNo}</td>
                      <td className="px-2 py-1.5">
                        <Link href={`/inventario/kardex?skuId=${i.masterSkuId}`} className="font-mono text-brand hover:underline">{i.skuCode}</Link>
                        <div className="line-clamp-1 text-xs text-ink-soft">{i.skuName}</div>
                      </td>
                      <td className="px-2 py-1.5 text-xs">{i.packageCode ? `${fmtInt(i.packageQty)} × ${i.packageCode} (${i.packageUnits} pzas)` : '—'}</td>
                      <td className="num px-2 py-1.5">{fmtInt(i.qtyRequested)}</td>
                      {(t.status === 'BORRADOR' || t.status === 'AUTORIZADA') && (
                        <td className="num px-2 py-1.5">
                          <StockQty value={i.originAvailable} />
                          {t.status === 'BORRADOR' && i.qtyRequested > i.originAvailable && <Badge tone="bad" className="ml-1">no alcanza</Badge>}
                        </td>
                      )}
                      <td className="num px-2 py-1.5">{i.qtyShipped === null ? '—' : fmtInt(i.qtyShipped)}</td>
                      <td className="num px-2 py-1.5">{i.qtyReceived === null ? '—' : fmtInt(i.qtyReceived)}</td>
                      <td className={cx('num px-2 py-1.5', t.shippedAt && diff < 0 && 'font-semibold text-bad')}>
                        {t.shippedAt ? (diff === 0 ? '0' : fmtInt(diff)) : '—'}
                      </td>
                      {costs && t.shippedAt && (
                        <td className="px-2 py-1.5 text-xs text-ink-soft">
                          {i.lots.map((l, k) => (
                            <div key={k} className="whitespace-nowrap">
                              <span className="font-mono">{l.lotCode ?? 'sin lote'}</span> · {fmtInt(l.qty)} × {fmtCost(l.unitCost)}
                              {t.status === 'ENVIADA' && <span className="text-ink-faint"> · recibido {fmtInt(l.qtyReceived)}</span>}
                            </div>
                          ))}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel title="Seguimiento">
          <dl className="space-y-2 text-sm">
            <div><dt className="text-xs text-ink-soft">Creó</dt><dd>{t.createdByName ?? '—'} · {fmtDateTime(t.createdAt)}</dd></div>
            {t.authorizedAt && <div><dt className="text-xs text-ink-soft">Autorizó (apartó en origen)</dt><dd>{t.authorizedByName} · {fmtDateTime(t.authorizedAt)}</dd></div>}
            {t.shippedAt && <div><dt className="text-xs text-ink-soft">Envió</dt><dd>{t.shippedByName} · {fmtDateTime(t.shippedAt)}</dd></div>}
            {t.receivedAt && <div><dt className="text-xs text-ink-soft">Cerró la recepción</dt><dd>{t.receivedByName} · {fmtDateTime(t.receivedAt)}</dd></div>}
            {t.cancelledAt && <div><dt className="text-xs text-ink-soft">Cancelada</dt><dd>{fmtDateTime(t.cancelledAt)}</dd></div>}
            {t.notes && <div><dt className="text-xs text-ink-soft">Notas</dt><dd className="whitespace-pre-wrap">{t.notes}</dd></div>}
          </dl>
        </Panel>
      </div>

      <Dialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        width="lg"
        title={dialog === 'ship' ? `Registrar envío de ${t.folio}` : `Registrar recepción en ${t.destinationCode}`}
        footer={
          <>
            <Button onClick={() => setDialog(null)}>Cancelar</Button>
            <Button variant="primary" loading={busy === dialog} onClick={dialog === 'ship' ? ship : receive}>
              {dialog === 'ship' ? 'Confirmar envío' : close ? 'Recibir y cerrar' : 'Registrar recepción'}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          {dialog === 'ship' ? (
            <p className="text-ink-soft">
              Sale la mercancía de {t.originCode} (lotes más antiguos primero) y queda en tránsito. Si envías menos de lo autorizado, la diferencia se libera.
            </p>
          ) : (
            <p className="text-ink-soft">
              Captura lo que llegó en esta recepción; puedes registrar varias (Amazon suele recibir en partes). Las piezas entran con el costo de sus lotes de origen.
            </p>
          )}
          {dialogError && <ErrorBox error={dialogError.msg} />}
          <div className="grid gap-3 sm:grid-cols-2">
            {dialog === 'ship' ? (
              <Field label="Referencia del envío" hint="ID de envío de Amazon, cita o guía.">
                <Input value={reference} onChange={(e) => setReference(e.target.value)} className="font-mono" />
              </Field>
            ) : (
              <Field label="Ubicación en destino" hint="Por omisión GEN.">
                <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  <option value="">GEN</option>
                  {(destLocs.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.code}{l.name ? ` · ${l.name}` : ''}</option>)}
                </Select>
              </Field>
            )}
          </div>
          <table className="w-full text-sm">
            <thead className="text-xs text-ink-soft">
              <tr>
                <th className="py-1 text-left">SKU</th>
                <th className="py-1 text-right">{dialog === 'ship' ? 'Autorizado' : 'Enviado'}</th>
                {dialog === 'receive' && <th className="py-1 text-right">Ya recibido</th>}
                <th className="w-32 py-1 text-right">{dialog === 'ship' ? 'Piezas enviadas' : 'Recibido ahora'}</th>
              </tr>
            </thead>
            <tbody>
              {t.items
                .filter((i) => dialog === 'ship' || (i.qtyShipped ?? 0) > 0)
                .map((i) => (
                  <tr key={i.id} className="border-t border-line">
                    <td className="py-1"><span className="font-mono">{i.skuCode}</span> <span className="text-xs text-ink-soft">{i.packageCode ? `· ${i.packageQty} cajas` : ''}</span></td>
                    <td className="num py-1">{fmtInt(dialog === 'ship' ? i.qtyRequested : i.qtyShipped)}</td>
                    {dialog === 'receive' && <td className="num py-1">{fmtInt(i.qtyReceived ?? 0)}</td>}
                    <td className="py-1">
                      <Input
                        inputMode="numeric"
                        value={qtys[i.id] ?? ''}
                        onChange={(e) => setQtys({ ...qtys, [i.id]: e.target.value.replace(/[^\d]/g, '') })}
                        className="num"
                        aria-invalid={Boolean(dialogError?.fields[i.id])}
                      />
                      {dialogError?.fields[i.id] && <div className="text-right text-xs text-bad">{dialogError.fields[i.id]}</div>}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          {dialog === 'receive' && (
            <Checkbox label="Cerrar la transferencia aunque falten piezas (quedará “recibida con diferencias”)" checked={close} onChange={(e) => setClose(e.target.checked)} />
          )}
          {dialog === 'ship' && isAdmin && (
            <Checkbox label="Autorizar que el origen quede en negativo si no alcanza (sólo Administrador)" checked={negative} onChange={(e) => setNegative(e.target.checked)} />
          )}
        </div>
      </Dialog>
    </>
  );
}
