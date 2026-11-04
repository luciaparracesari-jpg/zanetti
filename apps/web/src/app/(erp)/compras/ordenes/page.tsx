'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { ApiError, get, post } from '@/lib/api';
import { fmtDate, fmtInt } from '@/lib/format';
import { CURRENCIES, PO_STATUS, fmtCur, type PoRow } from '@/lib/purchasing';
import { Can, useSession } from '@/lib/session';
import { DataTable, optionsFrom, type Column } from '@/components/data-table';
import { Badge, Button, Dialog, ErrorBox, Field, Input, PageHeader, Select, StatusBadge, Textarea } from '@/components/ui';

interface SupplierOpt {
  id: string;
  name: string;
}

export default function PurchaseOrdersPage() {
  const { can } = useSession();
  const costs = can('costos.ver');
  const [open, setOpen] = useState(false);
  const columns: Column<PoRow>[] = [
    { id: 'folio', header: 'Folio', cell: (r) => <Link href={`/compras/ordenes/${r.id}`} className="font-mono text-xs font-semibold text-brand hover:underline">{r.folio}</Link>, csv: (r) => r.folio },
    { id: 'supplier', header: 'Proveedor', cell: (r) => <span className="font-medium">{r.supplier}</span>, csv: (r) => r.supplier },
    { id: 'ref', header: 'Ref. proveedor', cell: (r) => r.supplierRef ?? '—', csv: (r) => r.supplierRef },
    { id: 'date', header: 'Fecha', cell: (r) => fmtDate(r.orderDate), csv: (r) => r.orderDate },
    { id: 'status', header: 'Estado', cell: (r) => <StatusBadge value={r.status} labels={PO_STATUS} />, csv: (r) => PO_STATUS[r.status] },
    { id: 'skus', header: 'SKU', align: 'right', cell: (r) => fmtInt(r.skus), csv: (r) => r.skus },
    { id: 'pieces', header: 'Piezas', align: 'right', cell: (r) => fmtInt(r.pieces), csv: (r) => r.pieces },
    ...(costs
      ? ([
          {
            id: 'total',
            header: 'Total',
            align: 'right',
            cell: (r) => (
              <span className="tabular-nums">
                {fmtCur(r.total, r.currency)}
                {r.unpriced ? <Badge tone="warn" className="ml-1">{r.unpriced} sin precio</Badge> : null}
              </span>
            ),
            csv: (r) => r.total,
          },
          { id: 'paid', header: 'Pagado', align: 'right', cell: (r) => <span className="tabular-nums">{fmtCur(r.paid, r.currency)}</span>, csv: (r) => r.paid },
        ] as Column<PoRow>[])
      : []),
    { id: 'containers', header: 'Contenedor', cell: (r) => r.containers ?? <span className="text-ink-soft">Sin contenedor</span>, csv: (r) => r.containers },
  ];
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Compras' }, { label: 'Órdenes de compra' }]}
        title="Órdenes de compra"
        subtitle="Pedidos a Zanetti, Lean Travel y demás proveedores: renglones con precio, archivos, pagos y el contenedor en que viajan."
        actions={<Can perm="compras.crear"><Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>Nueva orden</Button></Can>}
      />
      <DataTable<PoRow>
        tableKey="purchase-orders"
        endpoint="/purchase-orders"
        columns={columns}
        rowId={(r) => r.id}
        exportPerm="compras.exportar"
        exportName="ordenes-de-compra"
        searchPlaceholder="Folio, proveedor, referencia o SKU…"
        filters={[{ key: 'status', label: 'Estado', options: optionsFrom(PO_STATUS) }]}
      />
      {open && <NewOrderDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function NewOrderDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { can } = useSession();
  const suppliers = useQuery({ queryKey: ['/suppliers/options'], queryFn: () => get<SupplierOpt[]>('/suppliers/options') });
  const [supplierId, setSupplierId] = useState('');
  const [orderDate, setOrderDate] = useState(new Date().toISOString().slice(0, 10));
  const [currency, setCurrency] = useState('USD');
  const [fxRate, setFxRate] = useState('');
  const [supplierRef, setSupplierRef] = useState('');
  const [incoterm, setIncoterm] = useState('FOB');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const po = await post<{ id: string }>('/purchase-orders', {
        supplierId,
        orderDate,
        currency,
        ...(can('costos.ver') ? { fxRate: fxRate || null } : {}),
        supplierRef: supplierRef || null,
        incoterm: incoterm || null,
        paymentTerms: paymentTerms || null,
        notes: notes || null,
      });
      router.push(`/compras/ordenes/${po.id}`);
    } catch (e) {
      setError(e instanceof ApiError && e.errors.length ? e.errors.map((x) => x.message).join(' ') : e);
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title="Nueva orden de compra"
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} disabled={!supplierId} onClick={submit}>Crear orden</Button></>}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><ErrorBox error={error} /></div>
        <Field label="Proveedor" required className="sm:col-span-2">
          <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">Elige…</option>
            {(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="Fecha de la orden" required><Input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} /></Field>
        <Field label="Referencia del proveedor" hint="Número de proforma o de orden del proveedor."><Input value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)} /></Field>
        <Field label="Moneda"><Select value={currency} onChange={(e) => setCurrency(e.target.value)}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select></Field>
        {can('costos.ver') && (
          <Field label="Tipo de cambio para costear" hint="Opcional. Si lo dejas vacío se usa el del contenedor.">
            <Input inputMode="decimal" className="num" value={fxRate} onChange={(e) => setFxRate(e.target.value)} disabled={currency === 'MXN'} placeholder="18.0000" />
          </Field>
        )}
        <Field label="Incoterm"><Input value={incoterm} onChange={(e) => setIncoterm(e.target.value.toUpperCase())} /></Field>
        <Field label="Condiciones de pago"><Input value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} placeholder="30% anticipo, 70% contra BL" /></Field>
        <Field label="Notas" className="sm:col-span-2"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <p className="text-xs text-ink-soft sm:col-span-2">Después de crearla puedes cargar los renglones desde Excel (por ejemplo, la hoja &quot;Pedido Zanetti&quot; del pedido propuesto) o agregarlos uno por uno.</p>
      </div>
    </Dialog>
  );
}
