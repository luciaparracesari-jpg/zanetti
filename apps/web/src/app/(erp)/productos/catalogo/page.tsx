'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { RECORD_STATUS, SKU_STATUS } from '@erp/shared';
import { get } from '@/lib/api';
import { fmtDateTime, fmtMoney } from '@/lib/format';
import { Can, useSession } from '@/lib/session';
import { DataTable, optionsFrom, useOptions, type Column } from '@/components/data-table';
import { ProductDialog, type ProductInput } from '@/components/product-dialog';
import { Badge, Button, Dialog, PageHeader, Spinner, StatusBadge } from '@/components/ui';

interface ProductRow {
  id: string;
  name: string;
  status: string;
  brandId: string | null;
  brandName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  skuCount: number;
  updatedAt: string;
}
interface ProductDetail {
  id: string;
  name: string;
  description: string | null;
  brandId: string | null;
  categoryId: string | null;
  status: string;
  skus: { id: string; skuCode: string; name: string; status: string; isKit: boolean; basePrice: string | null }[];
}

export default function CatalogPage() {
  const sp = useSearchParams();
  const { can } = useSession();
  const brands = useOptions<{ id: string; name: string }>('/brands/options', (b) => b.name);
  const cats = useOptions<{ id: string; path: string }>('/categories', (c) => c.path);
  const [edit, setEdit] = useState<{ open: boolean; product: ProductInput | null }>({ open: false, product: null });
  const [viewId, setViewId] = useState<string | null>(null);
  useEffect(() => {
    const p = sp.get('producto');
    if (p) setViewId(p);
  }, [sp]);

  const detail = useQuery({ queryKey: ['product', viewId], queryFn: () => get<ProductDetail>(`/products/${viewId}`), enabled: Boolean(viewId) });

  const columns: Column<ProductRow>[] = [
    { id: 'name', header: 'Producto', sortKey: 'name', cell: (r) => <span className="font-medium">{r.name}</span>, csv: (r) => r.name },
    { id: 'brand', header: 'Marca', sortKey: 'brandName', cell: (r) => r.brandName ?? '—', csv: (r) => r.brandName },
    { id: 'category', header: 'Categoría', sortKey: 'categoryName', cell: (r) => r.categoryName ?? '—', csv: (r) => r.categoryName },
    { id: 'skus', header: 'SKU / variantes', sortKey: 'skuCount', align: 'right', cell: (r) => r.skuCount, csv: (r) => r.skuCount },
    { id: 'status', header: 'Estado', sortKey: 'status', cell: (r) => <StatusBadge value={r.status} labels={RECORD_STATUS} />, csv: (r) => r.status },
    { id: 'updated', header: 'Actualizado', sortKey: 'updatedAt', cell: (r) => fmtDateTime(r.updatedAt), csv: (r) => r.updatedAt, defaultHidden: true },
  ];

  return (
    <>
      <PageHeader
        title="Catálogo de productos"
        subtitle="Un producto agrupa sus variantes; cada variante es un SKU maestro."
        actions={
          <Can perm="productos.crear">
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEdit({ open: true, product: null })}>
              Nuevo producto
            </Button>
          </Can>
        }
      />
      <DataTable<ProductRow>
        tableKey="products"
        endpoint="/products"
        columns={columns}
        rowId={(r) => r.id}
        onRowClick={(r) => setViewId(r.id)}
        exportPerm="productos.exportar"
        exportName="productos"
        searchPlaceholder="Producto o SKU…"
        filters={[
          { key: 'status', label: 'Estado', options: optionsFrom(RECORD_STATUS) },
          { key: 'brandId', label: 'Marca', options: brands },
          { key: 'categoryId', label: 'Categoría', options: cats },
        ]}
      />

      <Dialog
        open={Boolean(viewId)}
        onClose={() => setViewId(null)}
        title={detail.data?.name ?? 'Producto'}
        width="lg"
        footer={
          <>
            {can('productos.editar') && detail.data && (
              <Button onClick={() => { setEdit({ open: true, product: detail.data! }); setViewId(null); }}>Editar producto</Button>
            )}
            {can('productos.crear') && <Link href="/productos/skus/nuevo"><Button variant="primary">Agregar SKU</Button></Link>}
          </>
        }
      >
        {detail.isLoading ? <Spinner /> : detail.data && (
          <>
            {detail.data.description && <p className="mb-3 text-sm text-ink-soft">{detail.data.description}</p>}
            <table className="w-full text-sm">
              <thead className="bg-page text-xs text-ink-soft">
                <tr><th className="px-3 py-1.5 text-left">SKU</th><th className="px-3 py-1.5 text-left">Nombre</th><th className="px-3 py-1.5 text-right">Precio</th><th className="px-3 py-1.5 text-left">Estado</th></tr>
              </thead>
              <tbody>
                {detail.data.skus.map((s) => (
                  <tr key={s.id} className="border-t border-line">
                    <td className="px-3 py-1.5"><Link href={`/productos/skus/${s.id}`} className="font-mono text-brand hover:underline">{s.skuCode}</Link> {s.isKit && <Badge tone="info">Kit</Badge>}</td>
                    <td className="px-3 py-1.5">{s.name}</td>
                    <td className="num px-3 py-1.5">{fmtMoney(s.basePrice)}</td>
                    <td className="px-3 py-1.5"><StatusBadge value={s.status} labels={SKU_STATUS} /></td>
                  </tr>
                ))}
                {detail.data.skus.length === 0 && <tr><td colSpan={4} className="px-3 py-4 text-center text-ink-soft">Sin SKU todavía.</td></tr>}
              </tbody>
            </table>
          </>
        )}
      </Dialog>

      <ProductDialog open={edit.open} product={edit.product} onClose={() => setEdit({ open: false, product: null })} />
    </>
  );
}
