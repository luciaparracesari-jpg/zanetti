'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ADJUSTMENT_REASON, ADJUSTMENT_STATUS } from '@erp/shared';
import { ApiError, get, post } from '@/lib/api';
import { fmtCost, fmtDateTime, fmtInt, fmtMoney } from '@/lib/format';
import { useSession } from '@/lib/session';
import { AdjustmentForm, newLine } from '@/components/adjustment-form';
import { SignedQty, StockQty } from '@/components/inventory';
import { useToast } from '@/components/toast';
import { Badge, Button, Checkbox, Dialog, ErrorBox, PageHeader, Panel, Spinner, Stat, StatusBadge } from '@/components/ui';

interface Item {
  id: string;
  lineNo: number;
  masterSkuId: string;
  skuCode: string;
  skuName: string;
  locationId: string | null;
  locationCode: string | null;
  lotId: string | null;
  lotCode: string | null;
  qty: number;
  unitCost: string | null;
  avgCost: string | null;
  notes: string | null;
  available: number;
}
interface Adjustment {
  id: string;
  folio: string;
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  reason: keyof typeof ADJUSTMENT_REASON;
  status: keyof typeof ADJUSTMENT_STATUS;
  notes: string | null;
  totalValue: string | null;
  threshold: number | null;
  createdAt: string;
  createdById: string | null;
  createdByName: string | null;
  authorizedAt: string | null;
  authorizedByName: string | null;
  appliedAt: string | null;
  appliedByName: string | null;
  cancelledAt: string | null;
  items: Item[];
}

export default function AdjustmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const editing = sp.get('editar') === '1';
  const { can, me } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const costs = can('costos.ver');
  const isAdmin = me.roles.includes('ADMIN');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | 'apply' | 'authorize'>(null);
  const [negative, setNegative] = useState(false);

  const q = useQuery({ queryKey: ['adjustment', id], queryFn: () => get<Adjustment>(`/adjustments/${id}`) });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const a = q.data!;

  async function act(action: 'apply' | 'authorize' | 'cancel') {
    setBusy(action);
    setError(null);
    try {
      const r = await post<{ status: string; shortage?: number }>(`/adjustments/${id}/${action}`, action === 'cancel' ? {} : { authorizeNegative: negative });
      if (r.status === 'POR_AUTORIZAR') toast.ok('El valor supera el umbral: el ajuste quedó en espera de autorización.');
      else if (r.status === 'APLICADO') toast.ok(r.shortage ? `Ajuste aplicado; ${r.shortage} pzas quedaron en negativo con tu autorización.` : 'Ajuste aplicado. La existencia ya cambió.');
      else toast.ok('Ajuste cancelado.');
      setConfirm(null);
      setNegative(false);
      qc.invalidateQueries({ queryKey: ['adjustment', id] });
      qc.invalidateQueries({ queryKey: ['/adjustments'] });
      qc.invalidateQueries({ queryKey: ['/inventory/stock'] });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'No se pudo completar.');
    } finally {
      setBusy(null);
    }
  }

  if (editing && a.status === 'BORRADOR') {
    return (
      <>
        <PageHeader
          breadcrumbs={[{ label: 'Inventario', href: '/inventario' }, { label: 'Ajustes', href: '/inventario/ajustes' }, { label: a.folio, href: pathname }, { label: 'Editar' }]}
          title={`Editar ajuste ${a.folio}`}
        />
        <AdjustmentForm
          initial={{
            id: a.id,
            warehouseId: a.warehouseId,
            reason: a.reason,
            notes: a.notes ?? '',
            lines: a.items.map((i) =>
              newLine({
                masterSkuId: i.masterSkuId,
                skuLabel: i.skuCode,
                direction: i.qty > 0 ? 'IN' : 'OUT',
                qty: String(Math.abs(i.qty)),
                locationId: i.locationId ?? '',
                lotId: i.lotId ?? '',
                unitCost: i.unitCost ?? '',
                notes: i.notes ?? '',
              }),
            ),
          }}
        />
      </>
    );
  }

  const unitsIn = a.items.filter((i) => i.qty > 0).reduce((s, i) => s + i.qty, 0);
  const unitsOut = a.items.filter((i) => i.qty < 0).reduce((s, i) => s - i.qty, 0);
  const needsAuth = a.threshold !== null && a.totalValue !== null && Number(a.totalValue) > a.threshold;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Inventario', href: '/inventario' }, { label: 'Ajustes', href: '/inventario/ajustes' }, { label: a.folio }]}
        title={
          <span className="flex items-center gap-2">
            Ajuste <span className="font-mono">{a.folio}</span> <StatusBadge value={a.status} labels={ADJUSTMENT_STATUS} />
          </span>
        }
        subtitle={`${a.warehouseCode} · ${a.warehouseName} · ${ADJUSTMENT_REASON[a.reason]}`}
        actions={
          <>
            {a.status === 'BORRADOR' && can('ajustes.editar') && <Button onClick={() => router.push(`${pathname}?editar=1`)}>Editar</Button>}
            {(a.status === 'BORRADOR' || a.status === 'POR_AUTORIZAR') && (
              <Button variant="danger" loading={busy === 'cancel'} onClick={() => window.confirm(a.status === 'POR_AUTORIZAR' ? '¿Rechazar el ajuste?' : '¿Cancelar el ajuste?') && act('cancel')}>
                {a.status === 'POR_AUTORIZAR' ? 'Rechazar' : 'Cancelar'}
              </Button>
            )}
            {a.status === 'BORRADOR' && can('ajustes.crear') && (
              <Button variant="primary" onClick={() => setConfirm('apply')}>
                {needsAuth && !can('ajustes.autorizar') ? 'Enviar a autorización' : 'Aplicar'}
              </Button>
            )}
            {a.status === 'POR_AUTORIZAR' && can('ajustes.autorizar') && (
              <Button variant="primary" onClick={() => setConfirm('authorize')}>Autorizar y aplicar</Button>
            )}
            {a.status === 'APLICADO' && (
              <Link href={`/inventario/movimientos?documentId=${a.id}`}><Button>Ver movimientos</Button></Link>
            )}
          </>
        }
      />
      {error && <div className="mb-3"><ErrorBox error={error} /></div>}

      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-6">
        <Stat label="Renglones" value={fmtInt(a.items.length)} />
        <Stat label="Entradas" value={unitsIn ? `+${fmtInt(unitsIn)}` : '0'} />
        <Stat label="Salidas" value={unitsOut ? `−${fmtInt(unitsOut)}` : '0'} />
        {costs && <Stat label={a.status === 'APLICADO' ? 'Valor aplicado' : 'Valor estimado'} value={fmtMoney(a.totalValue)} tone="brand" />}
        {costs && <Stat label="Umbral de autorización" value={a.threshold === null ? 'Sin umbral' : fmtMoney(a.threshold)} />}
      </div>

      <div className="grid gap-3 lg:grid-cols-[1fr_18rem]">
        <Panel title="Renglones" bodyClassName="p-0">
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-page text-xs text-ink-soft">
                <tr>
                  <th className="px-2 py-1.5 text-left">#</th>
                  <th className="px-2 py-1.5 text-left">SKU</th>
                  <th className="px-2 py-1.5 text-left">Ubicación</th>
                  <th className="px-2 py-1.5 text-left">Lote</th>
                  <th className="px-2 py-1.5 text-right">Cantidad</th>
                  {costs && <th className="px-2 py-1.5 text-right">Costo unit.</th>}
                  {a.status !== 'APLICADO' && <th className="px-2 py-1.5 text-right">Disponible hoy</th>}
                  <th className="px-2 py-1.5 text-left">Notas</th>
                </tr>
              </thead>
              <tbody>
                {a.items.map((i) => (
                  <tr key={i.id} className="border-t border-line">
                    <td className="px-2 py-1.5 text-xs text-ink-faint">{i.lineNo}</td>
                    <td className="px-2 py-1.5">
                      <Link href={`/inventario/kardex?skuId=${i.masterSkuId}`} className="font-mono text-brand hover:underline">{i.skuCode}</Link>
                      <div className="line-clamp-1 text-xs text-ink-soft">{i.skuName}</div>
                    </td>
                    <td className="px-2 py-1.5">{i.locationCode ?? (i.qty > 0 ? 'GEN' : 'FIFO')}</td>
                    <td className="px-2 py-1.5 font-mono text-xs">{i.lotCode ?? (i.qty > 0 ? 'nuevo' : 'FIFO')}</td>
                    <td className="num px-2 py-1.5"><SignedQty value={i.qty} /></td>
                    {costs && <td className="num px-2 py-1.5">{i.qty > 0 ? fmtCost(i.unitCost ?? i.avgCost) : <span className="text-xs text-ink-faint">FIFO</span>}</td>}
                    {a.status !== 'APLICADO' && (
                      <td className="num px-2 py-1.5">
                        <StockQty value={i.available} />
                        {i.qty < 0 && i.available < -i.qty && <Badge tone="bad" className="ml-1">insuficiente</Badge>}
                      </td>
                    )}
                    <td className="px-2 py-1.5 text-xs text-ink-soft">{i.notes ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel title="Seguimiento">
          <dl className="space-y-2 text-sm">
            <div><dt className="text-xs text-ink-soft">Capturó</dt><dd>{a.createdByName ?? '—'} · {fmtDateTime(a.createdAt)}</dd></div>
            {a.authorizedAt && <div><dt className="text-xs text-ink-soft">Autorizó</dt><dd>{a.authorizedByName} · {fmtDateTime(a.authorizedAt)}</dd></div>}
            {a.appliedAt && <div><dt className="text-xs text-ink-soft">Aplicó</dt><dd>{a.appliedByName} · {fmtDateTime(a.appliedAt)}</dd></div>}
            {a.cancelledAt && <div><dt className="text-xs text-ink-soft">Cancelado</dt><dd>{fmtDateTime(a.cancelledAt)}</dd></div>}
            {a.notes && <div><dt className="text-xs text-ink-soft">Notas</dt><dd className="whitespace-pre-wrap">{a.notes}</dd></div>}
          </dl>
        </Panel>
      </div>

      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === 'authorize' ? `Autorizar ajuste ${a.folio}` : `Aplicar ajuste ${a.folio}`}
        width="sm"
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>Cancelar</Button>
            <Button variant="primary" loading={busy === confirm} onClick={() => act(confirm!)}>
              {confirm === 'authorize' ? 'Autorizar y aplicar' : needsAuth && !can('ajustes.autorizar') ? 'Enviar a autorización' : 'Aplicar'}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <p>
            Se registrarán {fmtInt(unitsIn)} pzas de entrada y {fmtInt(unitsOut)} de salida en {a.warehouseCode}. Los movimientos no se pueden editar después; para corregir se hace otro ajuste.
          </p>
          {error && <ErrorBox error={error} />}
          {isAdmin && (
            <Checkbox
              label="Autorizar que la existencia quede en negativo si no alcanza (sólo Administrador)"
              checked={negative}
              onChange={(e) => setNegative(e.target.checked)}
            />
          )}
        </div>
      </Dialog>
    </>
  );
}
