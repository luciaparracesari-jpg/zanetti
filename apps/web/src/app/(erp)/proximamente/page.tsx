'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Construction } from 'lucide-react';
import { ENTREGA_LABEL } from '@/lib/nav';
import { Button, PageHeader, Panel } from '@/components/ui';

const ROADMAP: Record<number, string> = {
  2: 'Movimientos, lotes FIFO, kardex, ajustes, transferencias y conteos.',
  3: 'Proveedores completos, solicitudes, órdenes de compra y recepciones.',
  4: 'Pedidos, devoluciones e importación de reportes de Amazon y Liverpool.',
  5: 'Reabasto, alertas, dashboard de ventas y reportes.',
  6: 'Carga inicial de inventario y costos; pruebas con datos reales.',
  7: 'Centro de sincronización y conectores: Amazon SP-API, Liverpool, Shopify, Mercado Libre.',
  8: 'Importaciones con costo puesto en almacén, costos por lote y rentabilidad.',
  9: 'Finanzas: gastos, cuentas por pagar y cobrar, flujo de efectivo y CFDI.',
};

export default function ComingSoonPage() {
  const sp = useSearchParams();
  const modulo = sp.get('modulo') ?? 'Este módulo';
  const entrega = Number(sp.get('entrega') ?? 0);
  return (
    <>
      <PageHeader title={modulo} breadcrumbs={[{ label: 'Roadmap' }]} />
      <Panel>
        <div className="flex items-start gap-3">
          <Construction className="mt-0.5 h-5 w-5 text-warn" />
          <div className="text-sm">
            <p className="font-medium">Llega en {entrega ? ENTREGA_LABEL(entrega) : 'una entrega posterior'}.</p>
            {ROADMAP[entrega] && <p className="mt-1 text-ink-soft">Esa entrega incluye: {ROADMAP[entrega]}</p>}
            <p className="mt-2 text-ink-soft">Las tablas y reglas de esta sección ya están previstas en el modelo de datos; la entrega 1 cubre catálogo, SKU maestros, canales, almacenes, usuarios y auditoría.</p>
            <Link href="/dashboard" className="mt-3 inline-block"><Button>Volver al dashboard</Button></Link>
          </div>
        </div>
      </Panel>
    </>
  );
}
