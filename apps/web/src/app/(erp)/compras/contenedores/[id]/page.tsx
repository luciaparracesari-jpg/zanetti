'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PackageCheck, Save, Trash2 } from 'lucide-react';
import { ApiError, del, get, patch, post } from '@/lib/api';
import { fmtDate, fmtInt } from '@/lib/format';
import { CONTAINER_STATUS, fmtDec } from '@/lib/replenishment';
import { Can, useSession } from '@/lib/session';
import { LocalTable, type LocalColumn } from '@/components/local-table';
import { useToast } from '@/components/toast';
import { Badge, Button, Dialog, ErrorBox, Field, Input, PageHeader, Panel, Select, Spinner, Stat } from '@/components/ui';

interface Line {
  n: number;
  skuId: string;
  skuCode: string;
  name: string | null;
  supplier: string | null;
  qty: number;
  orderDate: string;
  lead: number | null;
  caseUnits: number | null;
  cbm: number;
}
interface Container {
  id: string;
  code: string;
  status: string;
  etd: string | null;
  portEta: string | null;
  etaOverride: string | null;
  eta: string | null;
  etaSource: string;
  capacityCbm: string | null;
  notes: string | null;
  qty: number;
  skus: number;
  cbm: number;
  receivedAt: string | null;
  lines: Line[];
}

const EDITABLE = ['PLANEADO', 'EN_PRODUCCION', 'EN_NAVIERA', 'EN_ADUANA', 'PERDIDO', 'CANCELADO'];
const SOURCE: Record<string, string> = { MANUAL: 'capturada a mano', PUERTO: 'llegada a puerto + días de puerto, aduana y traslado', ETD: 'ETD + naviera + aduana', PEDIDO: 'fecha del pedido + lead time de lo más lento' };

export default function ContainerPage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({ queryKey: ['/containers', id], queryFn: () => get<Container>(`/containers/${id}`) });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  return <Detail c={q.data!} />;
}

function Detail({ c }: { c: Container }) {
  const qc = useQueryClient();
  const toast = useToast();
  const router = useRouter();
  const { can } = useSession();
  const [status, setStatus] = useState(c.status);
  const [etd, setEtd] = useState(c.etd ?? '');
  const [port, setPort] = useState(c.portEta ?? '');
  const [eta, setEta] = useState(c.etaOverride ?? '');
  const [notes, setNotes] = useState(c.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [receive, setReceive] = useState(false);
  const received = c.status === 'RECIBIDO';
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['/containers'] });
    qc.invalidateQueries({ queryKey: ['replenishment'] });
  };
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await patch(`/containers/${c.id}`, { status, etd: etd || null, portEta: port || null, etaOverride: eta || null, notes: notes || null });
      toast.ok('Contenedor actualizado.');
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!window.confirm(`¿Borrar el contenedor planeado ${c.code}?`)) return;
    try {
      await del(`/containers/${c.id}`);
      refresh();
      router.push('/compras/contenedores');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e);
    }
  }
  const cols: LocalColumn<Line>[] = [
    { id: 'n', header: '#', align: 'right', cell: (l) => l.n, value: (l) => l.n },
    { id: 'sku', header: 'SKU', cell: (l) => <Link href={`/productos/skus/${l.skuId}`} className="font-mono text-xs text-brand hover:underline">{l.skuCode}</Link>, value: (l) => l.skuCode },
    { id: 'name', header: 'Nombre', cell: (l) => <span className="text-xs">{l.name}</span>, value: (l) => l.name },
    { id: 'sup', header: 'Proveedor', cell: (l) => l.supplier ?? '—', value: (l) => l.supplier },
    { id: 'order', header: 'Pedido', cell: (l) => fmtDate(l.orderDate), value: (l) => l.orderDate },
    { id: 'lead', header: 'Lead time', align: 'right', cell: (l) => (l.lead ? `${l.lead} d` : '—'), value: (l) => l.lead },
    { id: 'qty', header: 'Piezas', align: 'right', cell: (l) => fmtInt(l.qty), value: (l) => l.qty },
    { id: 'cases', header: 'Cajas', align: 'right', cell: (l) => (l.caseUnits ? fmtDec(l.qty / l.caseUnits) : '—'), value: (l) => (l.caseUnits ? l.qty / l.caseUnits : null) },
    { id: 'cbm', header: 'CBM', align: 'right', cell: (l) => (l.cbm ? fmtDec(l.cbm, 2) : '—'), value: (l) => l.cbm },
  ];
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Compras' }, { label: 'Contenedores', href: '/compras/contenedores' }, { label: c.code }]}
        title={<span className="flex items-center gap-2">Contenedor {c.code} <Badge tone={received ? 'ok' : 'warn'}>{CONTAINER_STATUS[c.status]}</Badge></span>}
        subtitle={received ? `Recibido en APLIN el ${fmtDate(c.receivedAt?.slice(0, 10))}.` : `Llega a APLIN aprox. el ${fmtDate(c.eta)} (${SOURCE[c.etaSource]}).`}
        actions={
          !received && (
            <>
              {c.status === 'PLANEADO' && can('compras.eliminar') && <Button variant="danger" icon={<Trash2 className="h-4 w-4" />} onClick={remove}>Borrar</Button>}
              {['EN_PRODUCCION', 'EN_NAVIERA', 'EN_ADUANA'].includes(c.status) && (
                <Can perm="recepciones.crear">
                  <Button variant="primary" icon={<PackageCheck className="h-4 w-4" />} onClick={() => setReceive(true)}>Recibir en APLIN</Button>
                </Can>
              )}
            </>
          )
        }
      />
      <ErrorBox error={error} />
      <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="SKU" value={fmtInt(c.skus)} />
        <Stat label="Piezas" value={fmtInt(c.qty)} />
        <Stat label="CBM" value={`${fmtDec(c.cbm)}${c.capacityCbm ? ` / ${fmtDec(Number(c.capacityCbm))}` : ''}`} hint="Con las medidas de la caja master de cada SKU" />
        <Stat label="Llega a APLIN" value={fmtDate(c.eta)} />
      </div>
      {!received && can('compras.editar') && (
        <Panel title="Seguimiento" className="mb-3">
          <div className="grid gap-3 md:grid-cols-6">
            <Field label="Estado">
              <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                {EDITABLE.map((s) => <option key={s} value={s}>{CONTAINER_STATUS[s]}</option>)}
              </Select>
            </Field>
            <Field label="ETD (salida del barco)">
              <Input type="date" value={etd} onChange={(e) => setEtd(e.target.value)} />
            </Field>
            <Field label="Llegada a puerto" hint="Manzanillo. Más los días de puerto, aduana y traslado.">
              <Input type="date" value={port} onChange={(e) => setPort(e.target.value)} />
            </Field>
            <Field label="Llegada a APLIN (si la sabes)" hint="Tiene prioridad sobre el cálculo.">
              <Input type="date" value={eta} onChange={(e) => setEta(e.target.value)} />
            </Field>
            <Field label="Notas" className="md:col-span-2">
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>
          <div className="mt-3">
            <Button variant="primary" icon={<Save className="h-4 w-4" />} loading={busy} onClick={save}>Guardar</Button>
          </div>
        </Panel>
      )}
      <LocalTable rows={c.lines} columns={cols} rowKey={(l) => `${l.n}`} search={(l) => `${l.skuCode} ${l.name ?? ''} ${l.supplier ?? ''}`} csvName={`contenedor-${c.code}`} />
      {receive && <ReceiveDialog c={c} onClose={() => setReceive(false)} onDone={refresh} />}
    </>
  );
}

function ReceiveDialog({ c, onClose, onDone }: { c: Container; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit() {
    setBusy(true);
    try {
      const r = await post<{ pieces: number }>(`/containers/${c.id}/receive`, { receivedAt: date });
      toast.ok(`${c.code} recibido: ${fmtInt(r.pieces)} piezas en APLIN.`);
      onDone();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e);
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Recibir ${c.code} en APLIN`}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={busy} onClick={submit}>Recibir {fmtInt(c.qty)} piezas</Button>
        </>
      }
    >
      <div className="grid gap-3">
        <ErrorBox error={error} />
        <p className="text-sm text-ink-soft">Cada línea entra como un lote “{c.code}” en APLIN con su costo. Si la línea no tiene costo, el lote queda con costo provisional para capturarlo después. Para diferencias contra lo pedido, haz después un ajuste o un conteo.</p>
        <Field label="Fecha de recepción">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
