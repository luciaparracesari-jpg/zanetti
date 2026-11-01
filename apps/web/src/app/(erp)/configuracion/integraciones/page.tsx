'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { ApiError, get, post } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { Can } from '@/lib/session';
import { PROVIDER, type Connection } from '@/lib/integrations';
import { LocalTable, type LocalColumn } from '@/components/local-table';
import { Badge, Button, Dialog, ErrorBox, Field, Input, PageHeader, Panel, Select, Spinner } from '@/components/ui';
import { useToast } from '@/components/toast';

export default function IntegrationsPage() {
  const q = useQuery({ queryKey: ['/integrations'], queryFn: () => get<Connection[]>('/integrations') });
  const [creating, setCreating] = useState(false);
  const cols: LocalColumn<Connection>[] = [
    { id: 'code', header: 'Conexión', cell: (c) => <Link href={`/configuracion/integraciones/${c.id}`} className="font-mono text-brand hover:underline">{c.code}</Link>, value: (c) => c.code },
    { id: 'name', header: 'Nombre', cell: (c) => c.name, value: (c) => c.name },
    { id: 'provider', header: 'Sistema', cell: (c) => PROVIDER[c.provider], value: (c) => c.provider },
    {
      id: 'creds',
      header: 'Credenciales en el servidor',
      cell: (c) => (c.credentialsOk ? <Badge tone="ok">{c.credentialsRef}_*</Badge> : <Badge tone="bad">Faltan {c.credentialsRef}_*</Badge>),
      value: (c) => (c.credentialsOk ? 'OK' : 'Faltan'),
    },
    { id: 'status', header: 'Estado', cell: (c) => <Badge tone={c.status === 'ACTIVA' ? 'ok' : 'neutral'}>{c.status === 'ACTIVA' ? 'Activa' : 'Pausada'}</Badge>, value: (c) => c.status },
    {
      id: 'last',
      header: 'Última sincronización',
      cell: (c) =>
        c.lastSyncAt ? (
          <span className={c.lastSyncOk ? '' : 'text-bad'} title={c.lastError ?? undefined}>
            {fmtDateTime(c.lastSyncAt)} {c.lastSyncOk ? '' : '· con error'}
          </span>
        ) : (
          <span className="text-ink-faint">Nunca</span>
        ),
      value: (c) => c.lastSyncAt,
    },
  ];
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Configuración' }, { label: 'Integraciones' }]}
        title="Integraciones"
        subtitle="Conexiones con APLIN y, después, con Shopify, Amazon y Liverpool. Por ahora sólo consultan: comparan existencias y clasifican órdenes; no mueven el inventario del ERP ni escriben en el otro sistema."
        actions={
          <Can perm="integraciones.crear">
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>Nueva conexión</Button>
          </Can>
        }
      />
      <Panel className="mb-3">
        <p className="text-sm text-ink-soft">
          Las credenciales nunca se capturan aquí: van en el archivo <code>.env</code> del servidor con un prefijo (para APLIN, <code>APLIN_BASE_URL</code> y{' '}
          <code>APLIN_ORG_CODE</code>). La conexión sólo guarda el prefijo.
        </p>
      </Panel>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : (
        <LocalTable rows={q.data!} columns={cols} rowKey={(c) => c.id} empty="Sin conexiones. Cuando el servidor tenga las credenciales de APLIN, crea la conexión aquí." />
      )}
      {creating && <CreateDialog onClose={() => setCreating(false)} />}
    </>
  );
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const refs = useQuery({ queryKey: ['/integrations/credential-refs'], queryFn: () => get<{ aplin: string[] }>('/integrations/credential-refs') });
  const [code, setCode] = useState('APLIN');
  const [name, setName] = useState('APLIN Grupo Samaredi');
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const options = refs.data?.aplin ?? [];
  const chosen = ref || options[0] || '';
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await post('/integrations', { code, name, provider: 'APLIN', credentialsRef: chosen });
      toast.ok('Conexión creada.');
      qc.invalidateQueries({ queryKey: ['/integrations'] });
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
      title="Nueva conexión con APLIN"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={busy} disabled={!chosen} onClick={save}>Crear</Button>
        </>
      }
    >
      <div className="grid gap-3">
        <ErrorBox error={error} />
        {refs.isLoading ? <Spinner /> : options.length === 0 ? (
          <p className="text-sm text-bad">
            El servidor no tiene credenciales de APLIN. Agrega <code>APLIN_BASE_URL</code> y <code>APLIN_ORG_CODE</code> al archivo <code>.env</code> del servidor y reinicia la API.
          </p>
        ) : (
          <>
            <Field label="Clave"><Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} /></Field>
            <Field label="Nombre"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Credenciales del servidor" hint="Sólo se muestran los nombres de los prefijos configurados, nunca los valores.">
              <Select value={chosen} onChange={(e) => setRef(e.target.value)}>
                {options.map((r) => <option key={r} value={r}>{r}_BASE_URL / {r}_ORG_CODE</option>)}
              </Select>
            </Field>
          </>
        )}
      </div>
    </Dialog>
  );
}
