'use client';

import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Plus } from 'lucide-react';
import { COST_METHOD, SKU_STATUS } from '@erp/shared';
import { patch, post } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { useSession } from '@/lib/session';
import { AsyncCombobox } from './combobox';
import { useOptions } from './data-table';
import { ProductDialog } from './product-dialog';
import { Button, Checkbox, ErrorBox, Field, Input, Panel, Select, Textarea } from './ui';

export interface SkuDetail {
  id: string;
  skuCode: string;
  productId: string;
  product: { id: string; name: string };
  name: string;
  description: string | null;
  isKit: boolean;
  status: string;
  basePrice: string | null;
  currentCost?: string | null;
  costMethod: string;
  preferredSupplierId: string | null;
  leadTimeDays: number | null;
  safetyDays: number | null;
  minQty: number | null;
  maxQty: number | null;
  weightG: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
}

interface FormValues {
  skuCode: string;
  productId: string | null;
  name: string;
  description: string;
  isKit: boolean;
  status: string;
  basePrice: string;
  currentCost: string;
  costMethod: string;
  preferredSupplierId: string;
  leadTimeDays: string;
  safetyDays: string;
  minQty: string;
  maxQty: string;
  weightKg: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
}

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const toInt = (v: string, factor = 1) => (v.trim() === '' ? null : Math.round(Number(v.replace(',', '.')) * factor));

function toForm(d?: SkuDetail | null): FormValues {
  return {
    skuCode: d?.skuCode ?? '',
    productId: d?.productId ?? null,
    name: d?.name ?? '',
    description: d?.description ?? '',
    isKit: d?.isKit ?? false,
    status: d?.status ?? 'ACTIVO',
    basePrice: s(d?.basePrice),
    currentCost: s(d?.currentCost),
    costMethod: d?.costMethod ?? 'FIFO',
    preferredSupplierId: d?.preferredSupplierId ?? '',
    leadTimeDays: s(d?.leadTimeDays),
    safetyDays: s(d?.safetyDays),
    minQty: s(d?.minQty),
    maxQty: s(d?.maxQty),
    weightKg: d?.weightG ? String(d.weightG / 1000) : '',
    lengthCm: d?.lengthMm ? String(d.lengthMm / 10) : '',
    widthCm: d?.widthMm ? String(d.widthMm / 10) : '',
    heightCm: d?.heightMm ? String(d.heightMm / 10) : '',
  };
}

export function SkuForm({ sku, onSaved, onCancel }: { sku?: SkuDetail | null; onSaved: (saved: { id: string }) => void; onCancel?: () => void }) {
  const { can } = useSession();
  const editing = Boolean(sku);
  const canEdit = editing ? can('productos.editar') : can('productos.crear');
  const suppliers = useOptions<{ id: string; name: string }>('/suppliers/options', (x) => x.name);
  const [msg, setMsg] = useState<string | null>(null);
  const [productDialog, setProductDialog] = useState(false);
  const [productLabel, setProductLabel] = useState<string | null>(sku?.product.name ?? null);
  const { register, handleSubmit, reset, setError, control, setValue, formState } = useForm<FormValues>({ defaultValues: toForm(sku) });

  useEffect(() => {
    reset(toForm(sku));
    setProductLabel(sku?.product.name ?? null);
  }, [sku, reset]);

  async function onSubmit(v: FormValues) {
    setMsg(null);
    const body: Record<string, unknown> = {
      productId: v.productId,
      name: v.name,
      description: v.description || null,
      isKit: v.isKit,
      status: v.status,
      basePrice: v.basePrice || null,
      costMethod: v.costMethod,
      preferredSupplierId: v.preferredSupplierId || null,
      leadTimeDays: toInt(v.leadTimeDays),
      safetyDays: toInt(v.safetyDays),
      minQty: toInt(v.minQty),
      maxQty: toInt(v.maxQty),
      weightG: toInt(v.weightKg, 1000),
      lengthMm: toInt(v.lengthCm, 10),
      widthMm: toInt(v.widthCm, 10),
      heightMm: toInt(v.heightCm, 10),
    };
    if (can('costos.ver')) body.currentCost = v.currentCost || null;
    if (!editing) body.skuCode = v.skuCode;
    try {
      const saved = editing ? await patch<{ id: string }>(`/skus/${sku!.id}`, body) : await post<{ id: string }>('/skus', body);
      onSaved(saved);
    } catch (e) {
      setMsg(applyServerErrors(e, setError, { weightG: 'weightKg', lengthMm: 'lengthCm', widthMm: 'widthCm', heightMm: 'heightCm' }));
    }
  }

  const err = formState.errors;
  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
      {msg && <ErrorBox error={msg} />}
      <fieldset disabled={!canEdit} className="contents">
        <Panel title="Identificación">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="SKU maestro" required hint={editing ? 'El código no se cambia una vez creado.' : 'Ej. ZNT-00123'} error={err.skuCode?.message}>
              <Input {...register('skuCode')} disabled={editing} className="font-mono uppercase" autoFocus={!editing} />
            </Field>
            <Field label="Nombre" required className="sm:col-span-2" error={err.name?.message}>
              <Input {...register('name')} placeholder="Nombre corto para tablas y etiquetas" />
            </Field>
            <Field label="Estado" error={err.status?.message}>
              <Select {...register('status')}>
                {Object.entries(SKU_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </Select>
            </Field>
            <Field label="Producto" required className="sm:col-span-2" error={err.productId?.message} hint="Agrupa las variantes (talla, color, capacidad) de un mismo artículo.">
              <div className="flex gap-2">
                <div className="flex-1">
                  <Controller
                    control={control}
                    name="productId"
                    render={({ field }) => (
                      <AsyncCombobox<{ id: string; name: string }>
                        value={field.value}
                        onChange={(v, o) => {
                          field.onChange(v);
                          setProductLabel(o?.label ?? null);
                        }}
                        fetchPath="/products/options"
                        map={(p) => ({ value: p.id, label: p.name })}
                        initialLabel={productLabel}
                        placeholder="Buscar producto…"
                        invalid={Boolean(err.productId)}
                      />
                    )}
                  />
                </div>
                {can('productos.crear') && (
                  <Button icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setProductDialog(true)} title="Nuevo producto">
                    Nuevo
                  </Button>
                )}
              </div>
            </Field>
            <Field label="Tipo" className="sm:col-span-2" hint="Un kit (bundle) descuenta cada uno de sus componentes al venderse.">
              <div className="flex h-8 items-center">
                <Controller control={control} name="isKit" render={({ field }) => <Checkbox label="Es kit (bundle)" checked={field.value} onChange={(e) => field.onChange(e.target.checked)} />} />
              </div>
            </Field>
            <Field label="Descripción" className="sm:col-span-2 lg:col-span-4" error={err.description?.message}>
              <Textarea rows={2} {...register('description')} />
            </Field>
          </div>
        </Panel>

        <Panel title="Precio y costo">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Precio de lista (con IVA)" error={err.basePrice?.message}>
              <Input inputMode="decimal" {...register('basePrice')} placeholder="0.00" className="num" />
            </Field>
            {can('costos.ver') && (
              <Field label="Costo actual (sin IVA)" hint="Captura manual hasta que lleguen compras e importaciones." error={err.currentCost?.message}>
                <Input inputMode="decimal" {...register('currentCost')} placeholder="0.0000" className="num" />
              </Field>
            )}
            <Field label="Método de costeo" error={err.costMethod?.message}>
              <Select {...register('costMethod')}>
                {Object.entries(COST_METHOD).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </Select>
            </Field>
          </div>
        </Panel>

        <Panel title="Logística y reabasto">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Proveedor preferente" error={err.preferredSupplierId?.message}>
              <Select {...register('preferredSupplierId')}>
                <option value="">Sin proveedor</option>
                {suppliers.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            </Field>
            <Field label="Lead time (días)" error={err.leadTimeDays?.message} hint="Vacío = el del proveedor.">
              <Input inputMode="numeric" {...register('leadTimeDays')} className="num" />
            </Field>
            <Field label="Días de seguridad" error={err.safetyDays?.message}>
              <Input inputMode="numeric" {...register('safetyDays')} className="num" />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Stock mínimo" error={err.minQty?.message}>
                <Input inputMode="numeric" {...register('minQty')} className="num" />
              </Field>
              <Field label="Stock máximo" error={err.maxQty?.message}>
                <Input inputMode="numeric" {...register('maxQty')} className="num" />
              </Field>
            </div>
            <Field label="Peso (kg)" error={err.weightKg?.message}>
              <Input inputMode="decimal" {...register('weightKg')} className="num" />
            </Field>
            <Field label="Largo (cm)" error={err.lengthCm?.message}>
              <Input inputMode="decimal" {...register('lengthCm')} className="num" />
            </Field>
            <Field label="Ancho (cm)" error={err.widthCm?.message}>
              <Input inputMode="decimal" {...register('widthCm')} className="num" />
            </Field>
            <Field label="Alto (cm)" error={err.heightCm?.message}>
              <Input inputMode="decimal" {...register('heightCm')} className="num" />
            </Field>
          </div>
        </Panel>
      </fieldset>

      {canEdit && (
        <div className="flex justify-end gap-2">
          {onCancel && <Button onClick={onCancel}>Cancelar</Button>}
          <Button type="submit" variant="primary" loading={formState.isSubmitting}>
            {editing ? 'Guardar cambios' : 'Crear SKU'}
          </Button>
        </div>
      )}

      <ProductDialog
        open={productDialog}
        onClose={() => setProductDialog(false)}
        onSaved={(p) => {
          setValue('productId', p.id, { shouldDirty: true });
          setProductLabel(p.name);
        }}
      />
    </form>
  );
}
