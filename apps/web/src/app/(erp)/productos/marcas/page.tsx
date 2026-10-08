'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { RECORD_STATUS } from '@erp/shared';
import { del, patch, post } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { Can, useSession } from '@/lib/session';
import { DataTable, optionsFrom, type Column } from '@/components/data-table';
import { useToast } from '@/components/toast';
import { Button, Dialog, ErrorBox, Field, Input, PageHeader, Select, StatusBadge } from '@/components/ui';

interface BrandRow {
  id: string;
  name: string;
  status: string;
  productCount: number;
}

export default function BrandsPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [dialog, setDialog] = useState<{ open: boolean; row: BrandRow | null }>({ open: false, row: null });
  const [msg, setMsg] = useState<string | null>(null);
  const { register, handleSubmit, reset, setError, formState } = useForm<{ name: string; status: string }>();

  useEffect(() => {
    if (dialog.open) {
      reset({ name: dialog.row?.name ?? '', status: dialog.row?.status ?? 'ACTIVO' });
      setMsg(null);
    }
  }, [dialog, reset]);

  async function onSubmit(v: { name: string; status: string }) {
    try {
      if (dialog.row) await patch(`/brands/${dialog.row.id}`, v);
      else await post('/brands', v);
      toast.ok('Marca guardada.');
      qc.invalidateQueries({ queryKey: ['/brands'] });
      qc.invalidateQueries({ queryKey: ['/brands/options'] });
      setDialog({ open: false, row: null });
    } catch (e) {
      setMsg(applyServerErrors(e, setError));
    }
  }

  async function remove(row: BrandRow) {
    if (!confirm(`¿Eliminar la marca ${row.name}?`)) return;
    try {
      await del(`/brands/${row.id}`);
      toast.ok('Marca eliminada.');
      qc.invalidateQueries({ queryKey: ['/brands'] });
    } catch (e) {
      toast.error(`${(e as Error).message} Puedes inactivarla en su lugar.`);
    }
  }

  const columns: Column<BrandRow>[] = [
    { id: 'name', header: 'Marca', sortKey: 'name', cell: (r) => <span className="font-medium">{r.name}</span>, csv: (r) => r.name },
    { id: 'products', header: 'Productos', align: 'right', cell: (r) => r.productCount, csv: (r) => r.productCount },
    { id: 'status', header: 'Estado', sortKey: 'status', cell: (r) => <StatusBadge value={r.status} labels={RECORD_STATUS} />, csv: (r) => r.status },
    {
      id: 'actions',
      header: '',
      align: 'right',
      cell: (r) => (
        <span className="flex justify-end gap-1">
          {can('productos.editar') && <Button size="sm" variant="ghost" onClick={() => setDialog({ open: true, row: r })}>Editar</Button>}
          {can('productos.eliminar') && r.productCount === 0 && <Button size="sm" variant="ghost" onClick={() => remove(r)}>Eliminar</Button>}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Marcas"
        actions={
          <Can perm="productos.crear">
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setDialog({ open: true, row: null })}>Nueva marca</Button>
          </Can>
        }
      />
      <DataTable<BrandRow>
        tableKey="brands"
        endpoint="/brands"
        columns={columns}
        rowId={(r) => r.id}
        exportPerm="productos.exportar"
        exportName="marcas"
        filters={[{ key: 'status', label: 'Estado', options: optionsFrom(RECORD_STATUS) }]}
      />
      <Dialog
        open={dialog.open}
        onClose={() => setDialog({ open: false, row: null })}
        title={dialog.row ? 'Editar marca' : 'Nueva marca'}
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
