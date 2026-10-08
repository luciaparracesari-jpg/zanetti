/**
 * Catálogo de permisos del ERP: un permiso = módulo + acción.
 * La matriz de roles iniciales replica la sección 7 del documento de diseño.
 */

export const ACTIONS = ['ver', 'crear', 'editar', 'eliminar', 'exportar', 'autorizar'] as const;
export type Action = (typeof ACTIONS)[number];

export const ACTION_LABELS: Record<Action, string> = {
  ver: 'Ver',
  crear: 'Crear',
  editar: 'Editar',
  eliminar: 'Eliminar',
  exportar: 'Exportar',
  autorizar: 'Autorizar',
};

export const MODULES = [
  'dashboard',
  'productos',
  'canales',
  'inventario',
  'ajustes',
  'transferencias',
  'almacenes',
  'pedidos',
  'devoluciones',
  'proveedores',
  'compras',
  'recepciones',
  'importaciones',
  'reabasto',
  'costos',
  'finanzas',
  'reportes',
  'integraciones',
  'configuracion',
  'auditoria',
] as const;
export type Module = (typeof MODULES)[number];

export const MODULE_LABELS: Record<Module, string> = {
  dashboard: 'Dashboard',
  productos: 'Productos y SKU',
  canales: 'Canales y publicaciones',
  inventario: 'Inventario y kardex',
  ajustes: 'Ajustes de inventario',
  transferencias: 'Transferencias y conteos',
  almacenes: 'Almacenes y ubicaciones',
  pedidos: 'Pedidos',
  devoluciones: 'Devoluciones',
  proveedores: 'Proveedores',
  compras: 'Solicitudes y órdenes de compra',
  recepciones: 'Recepciones',
  importaciones: 'Importaciones',
  reabasto: 'Reabasto y reglas',
  costos: 'Costos y márgenes (campos)',
  finanzas: 'Finanzas',
  reportes: 'Reportes',
  integraciones: 'Integraciones y sincronización',
  configuracion: 'Usuarios, roles y configuración',
  auditoria: 'Auditoría',
};

/** Acciones que tienen sentido en cada módulo (p. ej. "costos" sólo se ve). */
export const MODULE_ACTIONS: Record<Module, readonly Action[]> = {
  dashboard: ['ver', 'exportar'],
  productos: ACTIONS,
  canales: ACTIONS,
  inventario: ['ver', 'exportar'],
  ajustes: ACTIONS,
  transferencias: ACTIONS,
  almacenes: ACTIONS,
  pedidos: ACTIONS,
  devoluciones: ACTIONS,
  proveedores: ACTIONS,
  compras: ACTIONS,
  recepciones: ACTIONS,
  importaciones: ACTIONS,
  reabasto: ACTIONS,
  costos: ['ver'],
  finanzas: ACTIONS,
  reportes: ['ver', 'exportar'],
  integraciones: ACTIONS,
  configuracion: ACTIONS,
  auditoria: ['ver', 'exportar'],
};

export type PermissionKey = `${Module}.${Action}`;
export const permissionKey = (m: Module, a: Action): PermissionKey => `${m}.${a}`;

export const ROLE_CODES = [
  'ADMIN',
  'GERENCIA',
  'COMPRAS',
  'INVENTARIOS',
  'VENTAS',
  'ALMACEN',
  'FINANZAS',
  'CONSULTA',
] as const;
export type RoleCode = (typeof ROLE_CODES)[number];

export const ROLE_NAMES: Record<RoleCode, string> = {
  ADMIN: 'Administrador',
  GERENCIA: 'Gerencia',
  COMPRAS: 'Compras',
  INVENTARIOS: 'Inventarios',
  VENTAS: 'Ventas',
  ALMACEN: 'Almacén',
  FINANZAS: 'Finanzas',
  CONSULTA: 'Consulta',
};

/** Letras de la matriz: V ver, C crear, E editar, D eliminar, X exportar, A autorizar. */
const LETTER: Record<string, Action> = {
  V: 'ver',
  C: 'crear',
  E: 'editar',
  D: 'eliminar',
  X: 'exportar',
  A: 'autorizar',
};

type Matrix = Partial<Record<Module, string>>;

const MATRIX: Record<Exclude<RoleCode, 'ADMIN'>, Matrix> = {
  GERENCIA: {
    dashboard: 'VX', productos: 'VEX', canales: 'VX', inventario: 'VX', ajustes: 'VA',
    transferencias: 'VA', almacenes: 'V', pedidos: 'VX', devoluciones: 'VA', proveedores: 'VX',
    compras: 'VAX', recepciones: 'V', importaciones: 'VAX', reabasto: 'VE', costos: 'V',
    finanzas: 'VAX', reportes: 'VX', integraciones: 'V', configuracion: 'V', auditoria: 'VX',
  },
  COMPRAS: {
    dashboard: 'V', productos: 'VCEX', canales: 'V', inventario: 'VX', transferencias: 'V',
    almacenes: 'V', pedidos: 'V', proveedores: 'VCEX', compras: 'VCEX', recepciones: 'V',
    importaciones: 'VCEX', reabasto: 'VEX', costos: 'V', reportes: 'VX',
  },
  INVENTARIOS: {
    dashboard: 'V', productos: 'VE', canales: 'V', inventario: 'VX', ajustes: 'VCE',
    transferencias: 'VCEA', almacenes: 'VCE', pedidos: 'V', devoluciones: 'VE', proveedores: 'V',
    compras: 'VC', recepciones: 'VC', importaciones: 'V', reabasto: 'VE', reportes: 'VX',
  },
  VENTAS: {
    dashboard: 'V', productos: 'V', canales: 'VCEX', inventario: 'V', pedidos: 'VCEX',
    devoluciones: 'VCE', reabasto: 'V', reportes: 'VX', integraciones: 'V',
  },
  ALMACEN: {
    dashboard: 'V', productos: 'V', inventario: 'V', ajustes: 'VC', transferencias: 'VCE',
    almacenes: 'V', pedidos: 'VE', devoluciones: 'VE', compras: 'V', recepciones: 'VC',
    importaciones: 'V', reportes: 'V',
  },
  FINANZAS: {
    dashboard: 'VX', productos: 'VX', canales: 'V', inventario: 'VX', ajustes: 'V',
    pedidos: 'VX', devoluciones: 'V', proveedores: 'VX', compras: 'VX', recepciones: 'V',
    importaciones: 'VEX', reabasto: 'V', costos: 'V', finanzas: 'VCEXA', reportes: 'VX',
    auditoria: 'V',
  },
  CONSULTA: {
    dashboard: 'V', productos: 'V', canales: 'V', inventario: 'V', transferencias: 'V',
    almacenes: 'V', pedidos: 'V', devoluciones: 'V', proveedores: 'V', compras: 'V',
    recepciones: 'V', importaciones: 'V', reabasto: 'V', reportes: 'V',
  },
};

export function allPermissionKeys(): PermissionKey[] {
  return MODULES.flatMap((m) => MODULE_ACTIONS[m].map((a) => permissionKey(m, a)));
}

/** Permisos por defecto de cada rol inicial. */
export function defaultRolePermissions(role: RoleCode): PermissionKey[] {
  if (role === 'ADMIN') return allPermissionKeys();
  const matrix = MATRIX[role];
  const keys: PermissionKey[] = [];
  for (const m of MODULES) {
    const letters = matrix[m];
    if (!letters) continue;
    for (const ch of letters) {
      const action = LETTER[ch];
      if (action && MODULE_ACTIONS[m].includes(action)) keys.push(permissionKey(m, action));
    }
  }
  return keys;
}
