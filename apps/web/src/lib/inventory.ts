import { useQuery } from '@tanstack/react-query';
import { get, qs } from './api';

export interface WarehouseOpt {
  id: string;
  code: string;
  name: string;
  type: string;
  channelId: string | null;
}

export interface LocationOpt {
  id: string;
  code: string;
  name: string | null;
  type: string;
}

export interface SkuInfo {
  id: string;
  skuCode: string;
  name: string;
  isKit: boolean;
  onHand: number;
  available: number;
  avgCost?: string | null;
  packages: { id: string; code: string; type: string; units: number }[];
  balances: { locationId: string; locationCode: string; lotId: string | null; lotCode: string | null; qty: number }[];
}

export interface Resolved {
  sku: { id: string; skuCode: string; name: string; isKit: boolean } | null;
  units?: number;
  packageId?: string | null;
  packageCode?: string | null;
  via?: string;
}

/** Almacenes activos a los que el usuario tiene acceso. */
export function useWarehouses() {
  return useQuery({ queryKey: ['/inventory/warehouses'], queryFn: () => get<WarehouseOpt[]>('/inventory/warehouses'), staleTime: 60_000 });
}

export function useLocations(warehouseId: string | null | undefined) {
  return useQuery({
    queryKey: ['/inventory/locations', warehouseId],
    queryFn: () => get<LocationOpt[]>(`/inventory/locations${qs({ warehouseId })}`),
    enabled: Boolean(warehouseId),
    staleTime: 60_000,
  });
}

/** Existencia, cajas y lotes de varios SKU en un almacén (para capturar renglones). */
export function useSkuInfo(warehouseId: string | null | undefined, ids: string[]) {
  const key = [...new Set(ids)].sort().join(',');
  return useQuery({
    queryKey: ['/inventory/sku-info', warehouseId, key],
    queryFn: () => get<SkuInfo[]>(`/inventory/sku-info${qs({ warehouseId, ids: key })}`),
    enabled: key.length > 0,
    placeholderData: (prev) => prev,
  });
}

export const resolveCode = (code: string) => get<Resolved>(`/inventory/resolve${qs({ code })}`);

/** Liga al documento que originó un movimiento. */
export function documentHref(type: string, id: string): string | null {
  switch (type) {
    case 'AJUSTE':
      return `/inventario/ajustes/${id}`;
    case 'TRANSFERENCIA':
      return `/inventario/transferencias/${id}`;
    case 'CONTEO':
      return `/inventario/conteos/${id}`;
    case 'IMPORTACION':
      return `/importar/${id}`;
    default:
      return null;
  }
}
