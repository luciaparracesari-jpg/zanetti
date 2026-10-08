'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { get, post } from '@/lib/api';
import { Can } from '@/lib/session';
import { useToast } from '@/components/toast';
import { Badge, Button, Dialog, ErrorBox, Field, Input, PageHeader, Panel, Spinner } from '@/components/ui';

interface Role { id: string; code: string; name: string; description: string | null; isSystem: boolean; userCount: number; permissionCount: number }

export default function RolesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['/roles'], queryFn: () => get<Role[]>('/roles') });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ code: '', name: '', description: '' });
  const [err, setErr] = useState<unknown>(null);

  async function create() {
    try {
      const r = await post<Role>('/roles', form);
      toast.ok('Rol creado. Ahora asigna sus permisos.');
      qc.invalidateQueries({ queryKey: ['/roles'] });
      setOpen(false);
      window.location.href = `/configuracion/roles/${r.id}`;
    } catch (e) {
      setErr(e);
    }
  }

  return (
    <>
      <PageHeader
        title="Roles y permisos"
        subtitle="Un permiso es módulo + acción (ver, crear, editar, eliminar, exportar, autorizar)."
        actions={<Can perm="configuracion.crear"><Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => { setForm({ code: '', name: '', description: '' }); setErr(null); setOpen(true); }}>Nuevo rol</Button></Can>}
      />
      <Panel bodyClassName="p-0">
        {q.isLoading ? <Spinner /> : (
          <table className="w-full text-sm">
            <thead className="bg-page text-xs text-ink-soft">
              <tr><th className="px-3 py-1.5 text-left">Rol</th><th className="px-3 py-1.5 text-left">Descripción</th><th className="px-3 py-1.5 text-right">Usuarios</th><th className="px-3 py-1.5 text-right">Permisos</th><th /></tr>
            </thead>
            <tbody>
              {(q.data ?? []).map((r) => (
                <tr key={r.id} className="border-t border-line hover:bg-page">
                  <td className="px-3 py-1.5">
                    <Link href={`/configuracion/roles/${r.id}`} className="font-medium text-brand hover:underline">{r.name}</Link>
                    {r.isSystem && <Badge className="ml-2">Inicial</Badge>}
                  </td>
                  <td className="px-3 py-1.5 text-ink-soft">{r.description ?? '—'}</td>
                  <td className="num px-3 py-1.5">{r.userCount}</td>
                  <td className="num px-3 py-1.5">{r.permissionCount}</td>
                  <td className="px-3 py-1.5 text-right"><Link href={`/configuracion/roles/${r.id}`}><Button size="sm" variant="ghost">Ver permisos</Button></Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Nuevo rol"
        width="sm"
        footer={<><Button onClick={() => setOpen(false)}>Cancelar</Button><Button variant="primary" onClick={create}>Crear</Button></>}
      >
        <div className="flex flex-col gap-3">
          <ErrorBox error={err} />
          <Field label="Código" required hint="Ej. ATENCION_CLIENTES"><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className="font-mono uppercase" /></Field>
          <Field label="Nombre" required><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Descripción"><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        </div>
      </Dialog>
    </>
  );
}
