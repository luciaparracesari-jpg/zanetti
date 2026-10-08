'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ACTIONS, ACTION_LABELS, MODULES, MODULE_ACTIONS, MODULE_LABELS, permissionKey } from '@erp/shared';
import { del, get, put } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useToast } from '@/components/toast';
import { Badge, Button, ErrorBox, PageHeader, Panel, Spinner } from '@/components/ui';

interface RoleDetail { id: string; code: string; name: string; description: string | null; isSystem: boolean; permissionKeys: string[] }

export default function RolePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['role', id], queryFn: () => get<RoleDetail>(`/roles/${id}`) });
  const [keys, setKeys] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (q.data) setKeys(new Set(q.data.permissionKeys));
  }, [q.data]);

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const role = q.data!;
  const isAdmin = role.code === 'ADMIN';
  const editable = can('configuracion.editar') && !isAdmin;
  const dirty = [...keys].sort().join() !== [...role.permissionKeys].sort().join();

  const toggle = (k: string) => {
    const next = new Set(keys);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setKeys(next);
  };
  const toggleRow = (m: (typeof MODULES)[number]) => {
    const rowKeys = MODULE_ACTIONS[m].map((a) => permissionKey(m, a));
    const all = rowKeys.every((k) => keys.has(k));
    const next = new Set(keys);
    rowKeys.forEach((k) => (all ? next.delete(k) : next.add(k)));
    setKeys(next);
  };

  async function save() {
    setSaving(true);
    try {
      await put(`/roles/${id}/permissions`, { permissionKeys: [...keys] });
      toast.ok('Permisos guardados. Aplican desde la siguiente acción de cada usuario.');
      qc.invalidateQueries({ queryKey: ['role', id] });
      qc.invalidateQueries({ queryKey: ['/roles'] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!confirm(`¿Eliminar el rol ${role.name}?`)) return;
    try {
      await del(`/roles/${id}`);
      router.push('/configuracion/roles');
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Configuración' }, { label: 'Roles', href: '/configuracion/roles' }, { label: role.name }]}
        title={<span>{role.name} {role.isSystem && <Badge className="ml-1 align-middle">Inicial</Badge>}</span>}
        subtitle={isAdmin ? 'El Administrador siempre tiene todos los permisos.' : role.description ?? undefined}
        actions={
          editable && (
            <>
              {!role.isSystem && can('configuracion.eliminar') && <Button variant="danger" onClick={remove}>Eliminar rol</Button>}
              <Button onClick={() => setKeys(new Set(role.permissionKeys))} disabled={!dirty}>Descartar</Button>
              <Button variant="primary" onClick={save} loading={saving} disabled={!dirty}>Guardar permisos</Button>
            </>
          )
        }
      />
      <Panel bodyClassName="p-0">
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-page text-xs text-ink-soft">
              <tr>
                <th className="px-3 py-1.5 text-left">Módulo</th>
                {ACTIONS.map((a) => <th key={a} className="px-3 py-1.5 text-center">{ACTION_LABELS[a]}</th>)}
                <th />
              </tr>
            </thead>
            <tbody>
              {MODULES.map((m) => (
                <tr key={m} className="border-t border-line hover:bg-page">
                  <td className="px-3 py-1.5">{MODULE_LABELS[m]}</td>
                  {ACTIONS.map((a) => {
                    const available = MODULE_ACTIONS[m].includes(a);
                    const k = permissionKey(m, a);
                    return (
                      <td key={a} className="px-3 py-1.5 text-center">
                        {available ? (
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-brand"
                            checked={isAdmin || keys.has(k)}
                            disabled={!editable}
                            onChange={() => toggle(k)}
                            aria-label={`${MODULE_LABELS[m]} · ${ACTION_LABELS[a]}`}
                          />
                        ) : (
                          <span className="text-ink-faint">·</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-3 py-1.5 text-right">
                    {editable && <button className="text-xs text-brand hover:underline" onClick={() => toggleRow(m)}>todo / nada</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-line px-3 py-2 text-xs text-ink-soft">
          “Costos y márgenes” es un permiso de campo: sin él, la API no envía costo ni margen en ninguna pantalla ni exportación. “Eliminar” sólo aplica a borradores; los movimientos de inventario nunca se borran.
        </p>
      </Panel>
    </>
  );
}
