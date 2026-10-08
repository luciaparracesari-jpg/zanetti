'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { RECORD_STATUS } from '@erp/shared';
import { del, get, patch, post } from '@/lib/api';
import { applyServerErrors, emptyToNull } from '@/lib/forms';
import { Can, useSession } from '@/lib/session';
import { useToast } from '@/components/toast';
import { Button, Dialog, Empty, ErrorBox, Field, Input, PageHeader, Panel, Select, Spinner, StatusBadge } from '@/components/ui';

interface Cat {
  id: string;
  name: string;
  parentId: string | null;
  status: string;
  path: string;
  depth: number;
  productCount: number;
}

export default function CategoriesPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ['/categories'], queryFn: () => get<Cat[]>('/categories') });
  const [dialog, setDialog] = useState<{ open: boolean; row: Cat | null; parentId?: string | null }>({ open: false, row: null });
  const [msg, setMsg] = useState<string | null>(null);
  const { register, handleSubmit, reset, setError, formState } = useForm<{ name: string; parentId: string; status: string }>();

  useEffect(() => {
    if (dialog.open) {
      reset({ name: dialog.row?.name ?? '', parentId: dialog.row?.parentId ?? dialog.parentId ?? '', status: dialog.row?.status ?? 'ACTIVO' });
      setMsg(null);
    }
  }, [dialog, reset]);

  async function onSubmit(v: { name: string; parentId: string; status: string }) {
    try {
      const body = emptyToNull(v);
      if (dialog.row) await patch(`/categories/${dialog.row.id}`, body);
      else await post('/categories', body);
      toast.ok('Categoría guardada.');
      qc.invalidateQueries({ queryKey: ['/categories'] });
      setDialog({ open: false, row: null });
    } catch (e) {
      setMsg(applyServerErrors(e, setError));
    }
  }

  async function remove(c: Cat) {
    if (!confirm(`¿Eliminar la categoría ${c.path}?`)) return;
    try {
      await del(`/categories/${c.id}`);
      toast.ok('Categoría eliminada.');
      qc.invalidateQueries({ queryKey: ['/categories'] });
    } catch (e) {
      toast.error(`${(e as Error).message} Revisa que no tenga subcategorías ni productos.`);
    }
  }

  const cats = list.data ?? [];
  return (
    <>
      <PageHeader
        title="Categorías"
        subtitle="Árbol de categorías y subcategorías. Las comisiones pueden definirse por categoría."
        actions={
          <Can perm="productos.crear">
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setDialog({ open: true, row: null })}>Nueva categoría</Button>
          </Can>
        }
      />
      <Panel bodyClassName="p-0">
        {list.isLoading ? <Spinner /> : cats.length === 0 ? <Empty>Aún no hay categorías.</Empty> : (
          <table className="w-full text-sm">
            <thead className="bg-page text-xs text-ink-soft">
              <tr><th className="px-3 py-1.5 text-left">Categoría</th><th className="px-3 py-1.5 text-right">Productos</th><th className="px-3 py-1.5 text-left">Estado</th><th /></tr>
            </thead>
            <tbody>
              {cats.map((c) => (
                <tr key={c.id} className="border-t border-line hover:bg-page">
                  <td className="px-3 py-1.5" style={{ paddingLeft: 12 + c.depth * 20 }}>
                    {c.depth > 0 && <span className="mr-1 text-ink-faint">└</span>}
                    <span className={c.depth === 0 ? 'font-medium' : ''}>{c.name}</span>
                  </td>
                  <td className="num px-3 py-1.5">{c.productCount}</td>
                  <td className="px-3 py-1.5"><StatusBadge value={c.status} labels={RECORD_STATUS} /></td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">
                    {can('productos.crear') && <Button size="sm" variant="ghost" onClick={() => setDialog({ open: true, row: null, parentId: c.id })}>+ Subcategoría</Button>}
                    {can('productos.editar') && <Button size="sm" variant="ghost" onClick={() => setDialog({ open: true, row: c })}>Editar</Button>}
                    {can('productos.eliminar') && c.productCount === 0 && <Button size="sm" variant="ghost" onClick={() => remove(c)}>Eliminar</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <Dialog
        open={dialog.open}
        onClose={() => setDialog({ open: false, row: null })}
        title={dialog.row ? 'Editar categoría' : 'Nueva categoría'}
        width="sm"
        footer={
          <>
            <Button onClick={() => setDialog({ open: false, row: null })}>Cancelar</Button>
            <Button variant="primary" loading={formState.isSubmitting} onClick={handleSubmit(onSubmit)}>Guardar</Button>
          </>
        }
      >
        <form className="flex flex-col gap-3" onSubmit={handleSubmit(onSubmit)}>
          {msg && <ErrorBox error={msg} />}
          <Field label="Nombre" required error={formState.errors.name?.message}>
            <Input {...register('name')} autoFocus />
          </Field>
          <Field label="Categoría padre" error={formState.errors.parentId?.message}>
            <Select {...register('parentId')}>
              <option value="">— Ninguna (categoría principal) —</option>
              {cats.filter((c) => c.id !== dialog.row?.id).map((c) => <option key={c.id} value={c.id}>{c.path}</option>)}
            </Select>
          </Field>
          <Field label="Estado">
            <Select {...register('status')}>
              {Object.entries(RECORD_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </Field>
        </form>
      </Dialog>
    </>
  );
}
