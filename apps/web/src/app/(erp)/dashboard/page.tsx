'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { CHANNEL_STATUS } from '@erp/shared';
import { get } from '@/lib/api';
import { fmtDateTime, fmtInt, fmtMoney } from '@/lib/format';
import { useSession } from '@/lib/session';
import { StockQty } from '@/components/inventory';
import { ErrorBox, PageHeader, Panel, Spinner, Stat, StatusBadge } from '@/components/ui';

interface Summary {
  skus: { total: number; activos: number; kits: number; sinNombre: number; sinPrecio: number; sinCodigo: number; sinPublicacion: number };
  productos: number;
  codigosSinMapear: number;
  publicacionesPorCanal: { code: string; name: string; status: string; publicaciones: number }[];
  publicacionesVigentes: number;
  almacenesActivos: number;
  actividadReciente: { id: number; occurredAt: string; userEmail: string | null; action: string; summary: string | null }[];
  pendientesPorEntrega: { entrega: number; indicadores: string[] }[];
  inventario: {
    porAlmacen: { id: string; code: string; name: string; onHand: number; available: number; inTransit: number; reserved: number; skus: number; value?: string }[];
    piezas: number;
    disponibles: number;
    enTransito: number;
    valor?: string;
    valorEnTransito?: string;
    negativos: number;
    sinExistencia: number;
    transferenciasEnTransito: number;
    transferenciasPorEnviar: number;
    ajustesPorAutorizar: number;
    conteosAbiertos: number;
    lotesCostoProvisional: number;
  };
}

export default function DashboardPage() {
  const { can } = useSession();
  const q = useQuery({ queryKey: ['dashboard-summary'], queryFn: () => get<Summary>('/dashboard/summary') });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;

  const pendientes = [
    { label: 'Códigos externos sin mapear', n: d.codigosSinMapear, href: '/productos/sin-mapear' },
    { label: 'SKU activos sin código de barras', n: d.skus.sinCodigo, href: '/productos/skus?status=ACTIVO' },
    { label: 'SKU activos sin nombre', n: d.skus.sinNombre, href: '/productos/skus?status=ACTIVO&withoutName=true' },
    { label: 'SKU activos sin precio de lista', n: d.skus.sinPrecio, href: '/productos/skus?status=ACTIVO&sort=basePrice:desc' },
    { label: 'SKU activos sin publicación vigente', n: d.skus.sinPublicacion, href: '/productos/skus?status=ACTIVO&withoutListings=true' },
  ];

  const inv = d.inventario;
  const alertas = [
    { label: 'Ajustes por autorizar', n: inv.ajustesPorAutorizar, href: '/inventario/ajustes?status=POR_AUTORIZAR', show: can('ajustes.ver') },
    { label: 'Transferencias en tránsito', n: inv.transferenciasEnTransito, href: '/inventario/transferencias?status=ENVIADA', show: can('transferencias.ver') },
    { label: 'Transferencias por enviar', n: inv.transferenciasPorEnviar, href: '/inventario/transferencias?status=ABIERTAS', show: can('transferencias.ver') },
    { label: 'Conteos abiertos', n: inv.conteosAbiertos, href: '/inventario/conteos?status=ABIERTO', show: can('transferencias.ver') },
    { label: 'SKU con existencia negativa', n: inv.negativos, href: '/inventario?stock=NEGATIVO', show: can('inventario.ver'), bad: true },
    { label: 'Lotes con costo provisional', n: inv.lotesCostoProvisional, href: '/inventario/lotes', show: can('costos.ver') },
    { label: 'SKU activos sin existencia', n: inv.sinExistencia, href: '/inventario?stock=SIN', show: can('inventario.ver') },
  ].filter((a) => a.show);

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Catálogo e inventario. Ventas, compras y reabasto se suman con cada entrega." />

      {can('inventario.ver') && (
        <>
          <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Piezas en inventario" value={fmtInt(inv.piezas)} tone="brand" />
            <Stat label="Disponibles para venta" value={fmtInt(inv.disponibles)} />
            <Stat label="En tránsito" value={fmtInt(inv.enTransito)} />
            {inv.valor !== undefined && <Stat label="Valor en almacenes" value={fmtMoney(inv.valor)} hint="Al costo de sus lotes (FIFO), sin IVA" />}
            {inv.valorEnTransito !== undefined && <Stat label="Valor en tránsito" value={fmtMoney(inv.valorEnTransito)} hint="Enviado a FBA / Liverpool y aún no recibido" />}
            <Stat label="Transferencias en tránsito" value={fmtInt(inv.transferenciasEnTransito)} />
          </div>
          <div className="mb-3 grid gap-3 lg:grid-cols-3">
            <Panel title="Inventario por almacén" className="lg:col-span-2" bodyClassName="p-0" actions={<Link href="/inventario" className="text-xs text-brand hover:underline">Ver existencias</Link>}>
              <table className="w-full text-sm">
                <thead className="bg-page text-xs text-ink-soft">
                  <tr>
                    <th className="px-3 py-1.5 text-left">Almacén</th>
                    <th className="px-3 py-1.5 text-right">SKU con stock</th>
                    <th className="px-3 py-1.5 text-right">Físico</th>
                    <th className="px-3 py-1.5 text-right">Apartado</th>
                    <th className="px-3 py-1.5 text-right">Disponible</th>
                    <th className="px-3 py-1.5 text-right">Por llegar</th>
                    {inv.valor !== undefined && <th className="px-3 py-1.5 text-right">Valor</th>}
                  </tr>
                </thead>
                <tbody>
                  {inv.porAlmacen.map((w) => (
                    <tr key={w.id} className="border-t border-line">
                      <td className="px-3 py-1.5">
                        <Link href={`/inventario?warehouseId=${w.id}`} className="font-medium text-brand hover:underline">{w.code}</Link>{' '}
                        <span className="text-xs text-ink-soft">{w.name}</span>
                      </td>
                      <td className="num px-3 py-1.5">{fmtInt(w.skus)}</td>
                      <td className="num px-3 py-1.5"><StockQty value={w.onHand} /></td>
                      <td className="num px-3 py-1.5"><StockQty value={w.reserved} /></td>
                      <td className="num px-3 py-1.5"><StockQty value={w.available} strong /></td>
                      <td className="num px-3 py-1.5"><StockQty value={w.inTransit} /></td>
                      {inv.valor !== undefined && <td className="num px-3 py-1.5">{fmtMoney(w.value)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
            <Panel title="Pendientes de inventario" bodyClassName="p-0">
              <ul>
                {alertas.map((a) => (
                  <li key={a.label} className="border-b border-line last:border-0">
                    <Link href={a.href} className="flex items-center justify-between px-3 py-1.5 text-sm hover:bg-page">
                      <span>{a.label}</span>
                      <span className={a.n > 0 ? (a.bad ? 'font-semibold text-bad' : 'font-semibold text-warn') : 'text-ink-faint'}>{fmtInt(a.n)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        </>
      )}

      <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="SKU maestros activos" value={fmtInt(d.skus.activos)} tone="brand" />
        <Stat label="Kits (bundles)" value={fmtInt(d.skus.kits)} />
        <Stat label="Productos" value={fmtInt(d.productos)} />
        <Stat label="Publicaciones vigentes" value={fmtInt(d.publicacionesVigentes)} />
        <Stat label="Códigos sin mapear" value={fmtInt(d.codigosSinMapear)} />
        <Stat label="Almacenes activos" value={fmtInt(d.almacenesActivos)} />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <Panel title="Publicaciones por canal" bodyClassName="p-0">
          <table className="w-full text-sm">
            <tbody>
              {d.publicacionesPorCanal.map((c) => (
                <tr key={c.code} className="border-b border-line last:border-0">
                  <td className="px-3 py-1.5">{c.name}</td>
                  <td className="px-3 py-1.5">
                    <StatusBadge value={c.status} labels={CHANNEL_STATUS} />
                  </td>
                  <td className="num px-3 py-1.5">{fmtInt(c.publicaciones)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Pendientes de catálogo" bodyClassName="p-0">
          <ul>
            {pendientes.map((p) => (
              <li key={p.label} className="border-b border-line last:border-0">
                <Link href={p.href} className="flex items-center justify-between px-3 py-1.5 text-sm hover:bg-page">
                  <span>{p.label}</span>
                  <span className={p.n > 0 ? 'font-semibold text-warn' : 'text-ink-faint'}>{fmtInt(p.n)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Actividad reciente" bodyClassName="p-0" actions={<Link href="/configuracion/auditoria" className="text-xs text-brand hover:underline">Ver auditoría</Link>}>
          {d.actividadReciente.length === 0 ? (
            <div className="px-3 py-4 text-sm text-ink-soft">Sin movimientos todavía.</div>
          ) : (
            <ul>
              {d.actividadReciente.map((a) => (
                <li key={a.id} className="border-b border-line px-3 py-1.5 last:border-0">
                  <div className="text-sm">{a.summary ?? a.action}</div>
                  <div className="text-xs text-ink-faint">
                    {fmtDateTime(a.occurredAt)} · {a.userEmail ?? 'sistema'}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Indicadores que se agregan en las siguientes entregas" className="mt-3">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {d.pendientesPorEntrega.map((p) => (
            <div key={p.entrega} className="rounded border border-dashed border-line-strong px-3 py-2">
              <div className="text-xs font-semibold text-ink-soft">Entrega {p.entrega}</div>
              <div className="text-sm text-ink">{p.indicadores.join(' · ')}</div>
            </div>
          ))}
        </div>
      </Panel>
    </>
  );
}
