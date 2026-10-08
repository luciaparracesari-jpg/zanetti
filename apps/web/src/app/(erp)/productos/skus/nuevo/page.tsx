'use client';

import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { SkuForm } from '@/components/sku-form';
import { useToast } from '@/components/toast';
import { PageHeader } from '@/components/ui';

export default function NewSkuPage() {
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Nuevo SKU maestro"
        breadcrumbs={[{ label: 'Productos' }, { label: 'SKU maestros', href: '/productos/skus' }, { label: 'Nuevo' }]}
      />
      <SkuForm
        onCancel={() => router.push('/productos/skus')}
        onSaved={(s) => {
          toast.ok('SKU creado. Agrega sus códigos de barras y publicaciones.');
          qc.invalidateQueries({ queryKey: ['/skus'] });
          router.push(`/productos/skus/${s.id}?tab=codigos`);
        }}
      />
    </div>
  );
}
