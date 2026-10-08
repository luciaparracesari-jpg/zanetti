'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { USER_STATUS } from '@erp/shared';
import { get, patch, post } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { applyServerErrors } from '@/lib/forms';
import { Can, useSession } from '@/lib/session';
import { DataTable, optionsFrom, useOptions, type Column } from '@/components/data-table';
import { useToast } from '@/components/toast';
import { Badge, Button, Dialog, ErrorBox, Field, Input, PageHeader, Select, StatusBadge } from '@/components/ui';

interface UserRow {
  id: string;
  email: string;
  name: string;
  status: string;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  mustChangePassword: boolean;
  roleNames: string[];
  warehouseCodes: string[];
}
interface UserDetail extends UserRow { roleIds: string[]; warehouseIds: string[] }
interface Role { id: string; code: string; name: string }
interface Wh { id: string; code: string; name: string }
interface FormValues { email: string; name: string; password: string; status: string; roleIds: string[]; warehouseIds: string[] }

export default function UsersPage() {
  const { can, me } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const roleOpts = useOptions<Role>('/roles', (r) => r.name);
  const roles = useQuery({ queryKey: ['/roles'], queryFn: () => get<Role[]>('/roles') });
  const whs = useQuery({ queryKey: ['/warehouses/options'], queryFn: () => get<Wh[]>('/warehouses/options') });
  const [dialog, setDialog] = useState<{ open: boolean; id: string | null }>({ open: false, id: null });
  const [reset1, setReset1] = useState<UserRow | null>(null);
  const [newPass, setNewPass] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const detail = useQuery({ queryKey: ['user', dialog.id], queryFn: () => get<UserDetail>(`/users/${dialog.id}`), enabled: Boolean(dialog.id) });
  const { register, handleSubmit, reset, setError, formState } = useForm<FormValues>();

  useEffect(() => {
    if (!dialog.open) return;
    setMsg(null);
    if (dialog.id && detail.data) {
      reset({ email: detail.data.email, name: detail.data.name, password: '', status: detail.data.status, roleIds: detail.data.roleIds, warehouseIds: detail.data.warehouseIds });
    } else if (!dialog.id) {
      reset({ email: '', name: '', password: '', status: 'ACTIVO', roleIds: [], warehouseIds: [] });
    }
  }, [dialog, detail.data, reset]);

  async function onSubmit(v: FormValues) {
    const roleIds = ([] as string[]).concat(v.roleIds || []);
    const warehouseIds = ([] as string[]).concat(v.warehouseIds || []);
    try {
      if (dialog.id) await patch(`/users/${dialog.id}`, { name: v.name, status: v.status, roleIds, warehouseIds });
      else await post('/users', { email: v.email, name: v.name, password: v.password, roleIds, warehouseIds });
      toast.ok(dialog.id ? 'Usuario actualizado.' : 'Usuario creado; deberá cambiar su contraseña al entrar.');
      qc.invalidateQueries({ queryKey: ['/users'] });
      qc.invalidateQueries({ queryKey: ['user'] });
      setDialog({ open: false, id: null });
    } catch (e) {
      setMsg(applyServerErrors(e, setError));
    }
  }

  async function doReset() {
    try {
      await post(`/users/${reset1!.id}/reset-password`, { newPassword: newPass });
      toast.ok('Contraseña restablecida; se cerraron sus sesiones.');
      setReset1(null);
      setNewPass('');
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const columns: Column<UserRow>[] = [
    { id: 'name', header: 'Nombre', sortKey: 'name', cell: (r) => <span className="font-medium">{r.name}</span>, csv: (r) => r.name },
    { id: 'email', header: 'Correo', sortKey: 'email', cell: (r) => r.email, csv: (r) => r.email },
    { id: 'roles', header: 'Roles', cell: (r) => <span className="flex flex-wrap gap-1">{r.roleNames.map((n) => <Badge key={n}>{n}</Badge>)}</span>, csv: (r) => r.roleNames.join(' / ') },
    { id: 'wh', header: 'Almacenes', cell: (r) => (r.warehouseCodes.length ? r.warehouseCodes.join(', ') : <span className="text-ink-faint">Todos</span>), csv: (r) => r.warehouseCodes.join(' ') || 'Todos' },
    { id: 'last', header: 'Último acceso', sortKey: 'lastLoginAt', cell: (r) => fmtDateTime(r.lastLoginAt), csv: (r) => r.lastLoginAt },
    {
      id: 'status',
      header: 'Estado',
      sortKey: 'status',
      cell: (r) => (
        <span className="flex gap-1">
          <StatusBadge value={r.status} labels={USER_STATUS} />
          {r.lockedUntil && new Date(r.lockedUntil) > new Date() && <Badge tone="bad">Bloqueo temporal</Badge>}
          {r.mustChangePassword && <Badge tone="warn">Cambio de contraseña</Badge>}
        </span>
      ),
      csv: (r) => r.status,
    },
    {
      id: 'actions',
      header: '',
      align: 'right',
      cell: (r) =>
        can('configuracion.editar') && (
          <span className="flex justify-end gap-1">
            <Button size="sm" variant="ghost" onClick={() => setDialog({ open: true, id: r.id })}>Editar</Button>
            {r.id !== me.id && <Button size="sm" variant="ghost" onClick={() => setReset1(r)}>Restablecer contraseña</Button>}
          </span>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Usuarios"
        actions={<Can perm="configuracion.crear"><Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setDialog({ open: true, id: null })}>Nuevo usuario</Button></Can>}
      />
      <DataTable<UserRow>
        tableKey="users"
        endpoint="/users"
        columns={columns}
        rowId={(r) => r.id}
        exportPerm="configuracion.exportar"
        exportName="usuarios"
        filters={[
          { key: 'status', label: 'Estado', options: optionsFrom(USER_STATUS) },
          { key: 'roleId', label: 'Rol', options: roleOpts },
        ]}
      />
      <Dialog
        open={dialog.open}
        onClose={() => setDialog({ open: false, id: null })}
        title={dialog.id ? 'Editar usuario' : 'Nuevo usuario'}
        footer={
          <>
            <Button onClick={() => setDialog({ open: false, id: null })}>Cancelar</Button>
            <Button variant="primary" loading={formState.isSubmitting} onClick={handleSubmit(onSubmit)}>Guardar</Button>
          </>
        }
      >
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={handleSubmit(onSubmit)}>
          {msg && <div className="sm:col-span-2"><ErrorBox error={msg} /></div>}
          <Field label="Correo" required error={formState.errors.email?.message}><Input type="email" {...register('email')} disabled={Boolean(dialog.id)} /></Field>
          <Field label="Nombre" required error={formState.errors.name?.message}><Input {...register('name')} /></Field>
          {!dialog.id ? (
            <Field label="Contraseña temporal" required hint="Mínimo 10 caracteres con letras y números; se pedirá cambiarla." error={formState.errors.password?.message}>
              <Input type="password" autoComplete="new-password" {...register('password')} />
            </Field>
          ) : (
            <Field label="Estado" error={formState.errors.status?.message}>
              <Select {...register('status')}>{Object.entries(USER_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
            </Field>
          )}
          <div />
          <fieldset className="rounded border border-line p-2">
            <legend className="px-1 text-xs font-medium text-ink-soft">Roles *</legend>
            <div className="grid gap-1">
              {(roles.data ?? []).map((r) => (
                <label key={r.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="accent-brand" value={r.id} {...register('roleIds')} /> {r.name}
                </label>
              ))}
            </div>
            {formState.errors.roleIds && <p className="mt-1 text-xs text-bad">{formState.errors.roleIds.message}</p>}
          </fieldset>
          <fieldset className="rounded border border-line p-2">
            <legend className="px-1 text-xs font-medium text-ink-soft">Almacenes permitidos</legend>
            <p className="mb-1 text-xs text-ink-faint">Sin marcar = acceso a todos.</p>
            <div className="grid gap-1">
              {(whs.data ?? []).map((w) => (
                <label key={w.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="accent-brand" value={w.id} {...register('warehouseIds')} /> {w.code} · {w.name}
                </label>
              ))}
            </div>
          </fieldset>
        </form>
      </Dialog>
      <Dialog
        open={Boolean(reset1)}
        onClose={() => setReset1(null)}
        title={`Restablecer contraseña de ${reset1?.name ?? ''}`}
        width="sm"
        footer={
          <>
            <Button onClick={() => setReset1(null)}>Cancelar</Button>
            <Button variant="primary" disabled={newPass.length < 10} onClick={doReset}>Restablecer</Button>
          </>
        }
      >
        <Field label="Contraseña temporal" hint="Se pedirá cambiarla al entrar y se cerrarán sus sesiones abiertas.">
          <Input type="password" autoComplete="new-password" value={newPass} onChange={(e) => setNewPass(e.target.value)} />
        </Field>
      </Dialog>
    </>
  );
}
