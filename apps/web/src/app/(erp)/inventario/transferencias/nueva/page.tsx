'use client';

import { useSearchParams } from 'next/navigation';
import { useWarehouses } from '@/lib/inventory';
import { TransferForm, newTransferLine } from '@/components/transfer-form';
import { PageHeader, Spinner } from '@/components/ui';

export default function NewTransferPage() {
  const sp = useSearchParams();
  const whs = useWarehouses();
  if (whs.isLoading) return <Spinner />;
  const byCode = (c: string) => whs.data?.find((w) => w.code === c)?.id ?? '';
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Inventario', href: '/inventario' }, { label: 'Transferencias', href: '/inventario/transferencias' }, { label: 'Nueva' }]}
        title="Nueva transferencia"
        subtitle="Captura por piezas o por caja master (escanea la caja para sumarla). Se guarda en borrador; la existencia no cambia hasta enviarla."
      />
      <TransferForm
        initial={{
          originWarehouseId: sp.get('origen') ?? byCode('APLIN'),
          destinationWarehouseId: sp.get('destino') ?? byCode('AMZ-FBA'),
          reference: '',
          notes: '',
          lines: [newTransferLine()],
        }}
      />
    </>
  );
}
