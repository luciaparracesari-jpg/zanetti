'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import { RECORD_STATUS } from '@erp/shared';
import { patch, post } from '@/lib/api';
import { applyServerErrors, emptyToNull } from '@/lib/forms';
import { useOptions } from './data-table';
import { useToast } from './toast';
import { Button, Dialog, ErrorBox, Field, Input, Select, Textarea } from './ui';

export interface ProductInput {
  id?: string;
  name: string;
  description: string | null;
  brandId: string | null;
  categoryId: string | null;
  status: string;
}

/** Alta y edición de producto (agrupador de SKU); se usa en Catálogo y desde el alta de SKU. */
export function ProductDialog({
  open,
  onClose,
  product,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  product?: ProductInput | null;
  onSaved?: (p: { id: string; name: string }) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const brands = useOptions<{ id: string; name: string }>('/brands/options', (b) => b.name);
  const cats = useOptions<{ id: string; path: string; status: string }>('/categories', (c) => c.path);
  const [msg, setMsg] = useState<string | null>(null);
  const { register, handleSubmit, reset, setError, formState } = useForm<ProductInput>();

  useEffect(() => {
    if (open) {
      reset(product ?? { name: '', description: '', brandId: '', categoryId: '', status: 'ACTIVO' });
      setMsg(null);
    }
  }, [open, product, reset]);

  async function onSubmit(v: ProductInput) {
    try {
      const body = emptyToNull({ name: v.name, description: v.description, brandId: v.brandId, categoryId: v.categoryId, status: v.status });
      const saved = product?.id
        ? await patch<{ id: string; name: string }>(`/products/${product.id}`, body)
        : await post<{ id: string; name: string }>('/products', body);
      toast.ok(product?.id ? 'Producto actualizado.' : 'Producto creado.');
      qc.invalidateQueries({ queryKey: ['/products'] });
      qc.invalidateQueries({ queryKey: ['/products/options'] });
      onSaved?.(saved);
      onClose();
    } catch (e) {
      setMsg(applyServerErrors(e, setError));
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={product?.id ? 'Editar producto' : 'Nuevo producto'}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={formState.isSubmitting} onClick={handleSubmit(onSubmit)}>
            Guardar
          </Button>
        </>
      }
    >
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={handleSubmit(onSubmit)}>
        {msg && <div className="sm:col-span-2"><ErrorBox error={msg} /></div>}
        <Field label="Nombre del producto" required error={formState.errors.name?.message} className="sm:col-span-2">
          <Input {...register('name')} placeholder="Ej. Caja organizadora con tapa" autoFocus />
        </Field>
        <Field label="Marca" error={formState.errors.brandId?.message}>
          <Select {...register('brandId')}>
            <option value="">Sin marca</option>
            {brands.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
          </Select>
        </Field>
        <Field label="Categoría" error={formState.errors.categoryId?.message}>
          <Select {...register('categoryId')}>
            <option value="">Sin categoría</option>
            {cats.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </Select>
        </Field>
        <Field label="Descripción" className="sm:col-span-2" error={formState.errors.description?.message}>
          <Textarea rows={3} {...register('description')} />
        </Field>
        <Field label="Estado">
          <Select {...register('status')}>
            {Object.entries(RECORD_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
      </form>
    </Dialog>
  );
}
