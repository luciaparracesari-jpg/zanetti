'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { LOCATION_TYPE, LOT_COST_STATUS, WAREHOUSE_TYPE } from '@erp/shared';
import { get } from '@/lib/api';
import { fmtCost, fmtDate, fmtInt, fmtMoney } from '@/lib/format';
import { useSession } from '@/lib/session';
import { StockQty } from './inventory';
import { KitAssemblyDialog } from './kit-assembly-dialog';
import { Badge, Button, Empty, ErrorBox, Panel, Spinner, Stat, StatusBadge } from './ui';

interface SkuStock {
  sku: { id: string; skuCode: string; name: string; isKit: boolean; avgCost?: string | null; currentCost?: string | null };
  total: { onHand: number; available: number; inTransit: number; reserved: number; assemblable: number; value?: string };
  byWarehouse: { warehouseId: string; code: string; name: string; type: string; onHand: number; blocked: number; reserved: number; committed: number; inTransit: number; assemblable: number; available: number; value: string | null }[];
  balances: { warehouseCode: string; locationCode: string; locationType: string; lotCode: string | null; receivedAt: string | null; qty: number; unitCost?: string | null; costStatus?: string | null }[];
  listings: { id: string; channelName: string; externalId: string; externalSku: string; unitsPerListing: number; warehouseCode: string | null; virtualStock: number | null; status: string }[];
  components: { componentId: string; qty: number; skuCode: string; name: string }[];
}

/** Pestaña Inventario de la ficha del SKU: existencias por almacén, lotes FIFO y stock virtual por publicación. */
export function SkuInventoryTab({ skuId }: { skuId: string }) {
  const { can } = useSession();
  const costs = can('costos.ver');
  const [kitOpen, setKitOpen] = useState(false);
  const q = useQuery({ queryKey: ['/inventory/stock', skuId], queryFn: () => get<SkuStock>(`/inventory/stock/${skuId}`) });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;
  const kit = d.sku.isKit;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <Stat label={kit ? 'Kits armados' : 'Físico total'} value={fmtInt(d.total.onHand)} tone="brand" />
        {kit && <Stat label="Por armar en bodega" value={fmtInt(d.total.assemblable)} hint="Con los componentes disponibles en bodega propia" />}
        <Stat label="Disponible" value={fmtInt(d.total.available)} />
        <Stat label="Apartado" value={fmtInt(d.total.reserved)} hint="Pedidos sin surtir y transferencias autorizadas" />
        <Stat label="En tránsito" value={fmtInt(d.total.inTransit)} />
        {costs && <Stat label="Valor al costo" value={fmtMoney(d.total.value)} />}
        {costs && !kit && <Stat label="Costo promedio" value={fmtCost(d.sku.avgCost ?? d.sku.currentCost)} />}
      </div>

      {kit && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-brand/30 bg-brand-soft px-3 py-2 text-sm text-ink">
          <span>
            Kit de {d.components.map((c) => `${c.qty} × ${c.skuCode}`).join(' + ') || 'sin componentes'}. En bodega propia su disponible incluye los que se pueden armar con los
            componentes; en Amazon FBA y Liverpool sólo cuentan los kits ya armados y enviados.
          </span>
          {can('transferencias.crear') && <Button size="sm" onClick={() => setKitOpen(true)}>Armar o desarmar</Button>}
        </div>
      )}

      <Panel
        title="Por almacén"
        bodyClassName="p-0"
        actions={
          (
            <div className="flex gap-2">
              <Link href={`/inventario/kardex?skuId=${skuId}`}><Button size="sm">Kardex</Button></Link>
              <Link href={`/inventario/lotes?skuId=${skuId}`}><Button size="sm">Lotes</Button></Link>
            </div>
          )
        }
      >
        <table className="w-full text-sm">
          <thead className="bg-page text-xs text-ink-soft">
            <tr>
              <th className="px-3 py-1.5 text-left">Almacén</th>
              <th className="px-3 py-1.5 text-left">Tipo</th>
              <th className="px-3 py-1.5 text-right">{kit ? 'Armados' : 'Físico'}</th>
              {kit && <th className="px-3 py-1.5 text-right">Por armar</th>}
              <th className="px-3 py-1.5 text-right">Bloqueado</th>
              <th className="px-3 py-1.5 text-right">Reservado</th>
              <th className="px-3 py-1.5 text-right">Comprometido</th>
              <th className="px-3 py-1.5 text-right">Disponible</th>
              <th className="px-3 py-1.5 text-right">En tránsito</th>
              {costs && <th className="px-3 py-1.5 text-right">Valor</th>}
            </tr>
          </thead>
          <tbody>
            {d.byWarehouse.map((w) => (
              <tr key={w.warehouseId} className="border-t border-line">
                <td className="px-3 py-1.5"><span className="font-medium">{w.code}</span> <span className="text-xs text-ink-soft">{w.name}</span></td>
                <td className="px-3 py-1.5 text-xs text-ink-soft">{WAREHOUSE_TYPE[w.type as keyof typeof WAREHOUSE_TYPE] ?? w.type}</td>
                <td className="num px-3 py-1.5"><StockQty value={w.onHand} /></td>
                {kit && <td className="num px-3 py-1.5">{['PROPIO', 'OPERADOR_LOGISTICO'].includes(w.type) ? <StockQty value={w.assemblable} /> : <span className="text-xs text-ink-faint">no aplica</span>}</td>}
                <td className="num px-3 py-1.5"><StockQty value={w.blocked} /></td>
                <td className="num px-3 py-1.5"><StockQty value={w.reserved} /></td>
                <td className="num px-3 py-1.5"><StockQty value={w.committed} /></td>
                <td className="num px-3 py-1.5"><StockQty value={w.available} strong /></td>
                <td className="num px-3 py-1.5"><StockQty value={w.inTransit} /></td>
                {costs && <td className="num px-3 py-1.5">{fmtMoney(w.value)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      {(!kit || d.balances.length > 0) && (
        <Panel title={kit ? 'Kits armados por ubicación y lote' : 'Ubicaciones y lotes (FIFO: el más antiguo sale primero)'} bodyClassName="p-0">
          {d.balances.length === 0 ? (
            <Empty>Sin existencia registrada. Carga el inventario inicial o registra una entrada.</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-page text-xs text-ink-soft">
                <tr>
                  <th className="px-3 py-1.5 text-left">Almacén</th>
                  <th className="px-3 py-1.5 text-left">Ubicación</th>
                  <th className="px-3 py-1.5 text-left">Lote</th>
                  <th className="px-3 py-1.5 text-left">Entrada</th>
                  <th className="px-3 py-1.5 text-right">Piezas</th>
                  {costs && <th className="px-3 py-1.5 text-right">Costo unit.</th>}
                  {costs && <th className="px-3 py-1.5 text-left">Costo</th>}
                </tr>
              </thead>
              <tbody>
                {d.balances.map((b, i) => (
                  <tr key={i} className="border-t border-line">
                    <td className="px-3 py-1.5">{b.warehouseCode}</td>
                    <td className="px-3 py-1.5">
                      {b.locationCode}
                      {['CUARENTENA', 'MERMA'].includes(b.locationType) && <Badge tone="warn" className="ml-1">{LOCATION_TYPE[b.locationType as keyof typeof LOCATION_TYPE]}</Badge>}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-xs">{b.lotCode ?? <Badge tone="bad">faltante autorizado</Badge>}</td>
                    <td className="px-3 py-1.5">{fmtDate(b.receivedAt)}</td>
                    <td className="num px-3 py-1.5"><StockQty value={b.qty} /></td>
                    {costs && <td className="num px-3 py-1.5">{fmtCost(b.unitCost)}</td>}
                    {costs && <td className="px-3 py-1.5">{b.costStatus ? <StatusBadge value={b.costStatus} labels={LOT_COST_STATUS} /> : '—'}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      )}

      <Panel title="Stock virtual por publicación" bodyClassName="p-0">
        {d.listings.length === 0 ? (
          <Empty>El SKU no tiene publicaciones vigentes.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-page text-xs text-ink-soft">
              <tr>
                <th className="px-3 py-1.5 text-left">Canal</th>
                <th className="px-3 py-1.5 text-left">Código externo</th>
                <th className="px-3 py-1.5 text-left">Surte desde</th>
                <th className="px-3 py-1.5 text-right">Uds. por publicación</th>
                <th className="px-3 py-1.5 text-right">Stock que se puede publicar</th>
              </tr>
            </thead>
            <tbody>
              {d.listings.map((l) => (
                <tr key={l.id} className="border-t border-line">
                  <td className="px-3 py-1.5">{l.channelName}</td>
                  <td className="px-3 py-1.5 font-mono text-xs">{l.externalId}{l.externalSku && l.externalSku !== l.externalId ? ` · ${l.externalSku}` : ''}</td>
                  <td className="px-3 py-1.5">{l.warehouseCode ?? <span className="text-xs text-warn">sin almacén</span>}</td>
                  <td className="num px-3 py-1.5">{l.unitsPerListing}</td>
                  <td className="num px-3 py-1.5">{l.virtualStock === null ? '—' : <StockQty value={l.virtualStock} strong />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <KitAssemblyDialog open={kitOpen} onClose={() => setKitOpen(false)} kit={kit ? { id: d.sku.id, skuCode: d.sku.skuCode } : null} />
    </div>
  );
}
