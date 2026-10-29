import type { LucideIcon } from 'lucide-react';
import {
  BarChart3,
  Boxes,
  LayoutDashboard,
  Package,
  Settings,
  Ship,
  ShoppingCart,
  Truck,
  Wallet,
  Warehouse,
} from 'lucide-react';
import type { PermissionKey } from '@erp/shared';

export interface NavItem {
  label: string;
  href: string;
  perm?: PermissionKey;
  /** Entrega del roadmap en la que llega; sin valor = disponible. */
  entrega?: number;
}

export interface NavSection {
  label: string;
  icon: LucideIcon;
  href?: string;
  perm?: PermissionKey;
  items?: NavItem[];
}

const soon = (label: string, entrega: number, modulo: string, perm?: PermissionKey): NavItem => ({
  label,
  entrega,
  perm,
  href: `/proximamente?modulo=${encodeURIComponent(modulo)}&entrega=${entrega}`,
});

/** Menú lateral (sección 2 del planteamiento). Lo que llega en entregas futuras se marca. */
export const NAV: NavSection[] = [
  { label: 'Dashboard', icon: LayoutDashboard, href: '/dashboard', perm: 'dashboard.ver' },
  {
    label: 'Ventas',
    icon: ShoppingCart,
    items: [
      soon('Pedidos', 4, 'Pedidos', 'pedidos.ver'),
      soon('Ventas por canal', 4, 'Ventas por canal', 'pedidos.ver'),
      soon('Clientes', 4, 'Clientes', 'pedidos.ver'),
      soon('Devoluciones', 4, 'Devoluciones', 'devoluciones.ver'),
      soon('Cancelaciones', 4, 'Cancelaciones', 'pedidos.ver'),
    ],
  },
  {
    label: 'Productos',
    icon: Package,
    items: [
      { label: 'SKU maestros', href: '/productos/skus', perm: 'productos.ver' },
      { label: 'Catálogo', href: '/productos/catalogo', perm: 'productos.ver' },
      { label: 'Publicaciones', href: '/productos/publicaciones', perm: 'canales.ver' },
      { label: 'Códigos sin mapear', href: '/productos/sin-mapear', perm: 'canales.ver' },
      { label: 'Importar desde Excel', href: '/importar?plantilla=skus', perm: 'productos.crear' },
      { label: 'Categorías', href: '/productos/categorias', perm: 'productos.ver' },
      { label: 'Marcas', href: '/productos/marcas', perm: 'productos.ver' },
    ],
  },
  {
    label: 'Inventario',
    icon: Boxes,
    items: [
      { label: 'Existencias', href: '/inventario', perm: 'inventario.ver' },
      { label: 'Movimientos', href: '/inventario/movimientos', perm: 'inventario.ver' },
      { label: 'Kardex', href: '/inventario/kardex', perm: 'inventario.ver' },
      { label: 'Lotes FIFO', href: '/inventario/lotes', perm: 'inventario.ver' },
      { label: 'Ajustes', href: '/inventario/ajustes', perm: 'ajustes.ver' },
      { label: 'Transferencias', href: '/inventario/transferencias', perm: 'transferencias.ver' },
      { label: 'Conteos físicos', href: '/inventario/conteos', perm: 'transferencias.ver' },
      { label: 'Inventario inicial', href: '/importar?plantilla=inventario-inicial', perm: 'ajustes.autorizar' },
    ],
  },
  {
    label: 'Compras',
    icon: Truck,
    items: [
      { label: 'Proveedores', href: '/compras/proveedores', perm: 'proveedores.ver' },
      soon('Solicitudes de compra', 3, 'Solicitudes de compra', 'compras.ver'),
      soon('Órdenes de compra', 3, 'Órdenes de compra', 'compras.ver'),
      soon('Recepciones', 3, 'Recepciones', 'recepciones.ver'),
      soon('Reabasto', 5, 'Reabasto', 'reabasto.ver'),
    ],
  },
  {
    label: 'Importaciones',
    icon: Ship,
    items: [
      soon('Órdenes de importación', 8, 'Importaciones (fase 3)', 'importaciones.ver'),
      soon('Contenedores', 8, 'Contenedores (fase 3)', 'importaciones.ver'),
      soon('Costo puesto en almacén', 8, 'Costo puesto en almacén (fase 3)', 'importaciones.ver'),
    ],
  },
  {
    label: 'Almacenes',
    icon: Warehouse,
    items: [
      { label: 'Almacenes y ubicaciones', href: '/almacenes', perm: 'almacenes.ver' },
      soon('Recepción', 3, 'Recepción', 'recepciones.ver'),
      soon('Picking y packing', 4, 'Picking y packing', 'pedidos.ver'),
    ],
  },
  {
    label: 'Finanzas',
    icon: Wallet,
    items: [soon('Ingresos y gastos', 9, 'Finanzas (fase 4)', 'finanzas.ver'), soon('Rentabilidad', 8, 'Rentabilidad (fase 3)', 'finanzas.ver')],
  },
  {
    label: 'Reportes',
    icon: BarChart3,
    items: [soon('Reportes', 5, 'Reportes', 'reportes.ver')],
  },
  {
    label: 'Configuración',
    icon: Settings,
    items: [
      { label: 'Empresa y parámetros', href: '/configuracion/empresa', perm: 'configuracion.ver' },
      { label: 'Usuarios', href: '/configuracion/usuarios', perm: 'configuracion.ver' },
      { label: 'Roles y permisos', href: '/configuracion/roles', perm: 'configuracion.ver' },
      { label: 'Canales y comisiones', href: '/configuracion/canales', perm: 'canales.ver' },
      { label: 'Auditoría', href: '/configuracion/auditoria', perm: 'auditoria.ver' },
      soon('Integraciones', 7, 'Integraciones (fase 2)', 'integraciones.ver'),
    ],
  },
];

export const ENTREGA_LABEL = (n: number) => (n <= 6 ? `Entrega ${n}` : n === 7 ? 'Fase 2' : n === 8 ? 'Fase 3' : 'Fase 4');
