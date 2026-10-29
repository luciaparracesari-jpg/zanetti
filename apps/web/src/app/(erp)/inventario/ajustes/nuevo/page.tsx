'use client';

import { AdjustmentForm, newLine } from '@/components/adjustment-form';
import { useWarehouses } from '@/lib/inventory';
import { PageHeader, Spinner } from '@/components/ui';

export default function NewAdjustmentPage() {
  const whs = useWarehouses();
  if (whs.isLoading) return <Spinner />;
  const aplin = whs.data?.find((w) => w.code === 'APLIN') ?? whs.data?.[0];
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Inventario', href: '/inventario' }, { label: 'Ajustes', href: '/inventario/ajustes' }, { label: 'Nuevo' }]}
        title="Nuevo ajuste"
        subtitle="Se guarda como borrador; la existencia cambia hasta que lo apliques. Las salidas usan FIFO salvo que elijas un lote."
      />
      <AdjustmentForm initial={{ warehouseId: aplin?.id ?? '', reason: 'MERMA', notes: '', lines: [newLine()] }} />
    </>
  );
}
