import { z } from 'zod';
import {
  ADJUSTMENT_REASON,
  BARCODE_TYPE,
  CHANNEL_STATUS,
  CHANNEL_TYPE,
  COST_METHOD,
  FEE_BASE,
  FEE_TYPE,
  FULFILLMENT_MODEL,
  LISTING_STATUS,
  LOCATION_TYPE,
  PACKAGE_TYPE,
  RECORD_STATUS,
  SKU_STATUS,
  USER_STATUS,
  WAREHOUSE_TYPE,
  keysOf,
} from './labels';

// ───────────────────────────── Utilidades ─────────────────────────────

const trimmed = (max = 200) => z.string().trim().min(1, 'Requerido').max(max);
const optText = (max = 2000) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));
const id = () => z.uuid('Identificador inválido');
const optId = () =>
  z
    .union([z.uuid(), z.literal(''), z.null()])
    .optional()
    .transform((v) => (v ? v : null));
const optInt = (min = 0, max = 1_000_000_000) =>
  z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((v, ctx) => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: `Debe ser un entero entre ${min} y ${max}` });
        return z.NEVER;
      }
      return n;
    });

/** Decimal como texto con `scale` decimales (evita errores de punto flotante con dinero). */
export const decimal = (scale: number, opts: { min?: number; max?: number } = {}) =>
  z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((v, ctx) => {
      if (v === null || v === undefined || v === '') return null;
      const s = String(v).replace(/[$,\s]/g, '');
      if (!/^-?\d+(\.\d+)?$/.test(s)) {
        ctx.addIssue({ code: 'custom', message: 'Número inválido' });
        return z.NEVER;
      }
      const n = Number(s);
      if (opts.min !== undefined && n < opts.min) {
        ctx.addIssue({ code: 'custom', message: `Debe ser mayor o igual a ${opts.min}` });
        return z.NEVER;
      }
      if (opts.max !== undefined && n > opts.max) {
        ctx.addIssue({ code: 'custom', message: `Debe ser menor o igual a ${opts.max}` });
        return z.NEVER;
      }
      return n.toFixed(scale);
    });

const isoDate = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD');

export function eanChecksumOk(code: string): boolean {
  if (!/^\d+$/.test(code)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop()!;
  const sum = digits
    .reverse()
    .reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

// ───────────────────────────── Listados ─────────────────────────────

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
  sort: z
    .string()
    .regex(/^[a-zA-Z_]+:(asc|desc)$/)
    .optional(),
  q: z.string().trim().max(100).optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ───────────────────────────── Autenticación ─────────────────────────────

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('Correo inválido')),
  password: z.string().min(1, 'Requerido').max(200),
});

export const passwordPolicy = z
  .string()
  .min(10, 'Mínimo 10 caracteres')
  .max(200)
  .regex(/[A-Za-z]/, 'Debe incluir letras')
  .regex(/\d/, 'Debe incluir números');

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Requerido'),
  newPassword: passwordPolicy,
});

// ───────────────────────────── Catálogo ─────────────────────────────

export const brandSchema = z.object({
  name: trimmed(120),
  status: z.enum(keysOf(RECORD_STATUS)).default('ACTIVO'),
});

export const categorySchema = z.object({
  name: trimmed(120),
  parentId: optId(),
  status: z.enum(keysOf(RECORD_STATUS)).default('ACTIVO'),
});

export const attributeSchema = z.object({
  name: trimmed(80),
  values: z.array(trimmed(80)).max(200).default([]),
});

export const productSchema = z.object({
  name: trimmed(200),
  description: optText(),
  brandId: optId(),
  categoryId: optId(),
  status: z.enum(keysOf(RECORD_STATUS)).default('ACTIVO'),
});

export const SKU_CODE_REGEX = /^[A-Z0-9][A-Z0-9._-]{1,39}$/;

const skuFields = {
  productId: id(),
  name: trimmed(200),
  description: optText(),
  isKit: z.boolean().default(false),
  weightG: optInt(0, 1_000_000),
  lengthMm: optInt(0, 100_000),
  widthMm: optInt(0, 100_000),
  heightMm: optInt(0, 100_000),
  basePrice: decimal(2, { min: 0 }),
  costMethod: z.enum(keysOf(COST_METHOD)).default('FIFO'),
  currentCost: decimal(4, { min: 0 }),
  preferredSupplierId: optId(),
  leadTimeDays: optInt(0, 730),
  safetyDays: optInt(0, 365),
  minQty: optInt(0),
  maxQty: optInt(0),
  status: z.enum(keysOf(SKU_STATUS)).default('ACTIVO'),
};

const minMaxOk = (v: { minQty?: number | null; maxQty?: number | null }) =>
  v.minQty == null || v.maxQty == null || v.minQty <= v.maxQty;

export const skuCreateSchema = z
  .object({
    skuCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(SKU_CODE_REGEX, 'Use letras, números, punto, guion o guion bajo (2 a 40)'),
    ...skuFields,
  })
  .refine(minMaxOk, { message: 'El mínimo no puede ser mayor que el máximo', path: ['maxQty'] });

export const skuUpdateSchema = z
  .object(skuFields)
  .partial()
  .refine(minMaxOk, { message: 'El mínimo no puede ser mayor que el máximo', path: ['maxQty'] });

export const barcodeSchema = z
  .object({
    barcode: z.string().trim().min(4).max(40),
    type: z.enum(keysOf(BARCODE_TYPE)).default('EAN13'),
    isPrimary: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.type === 'EAN13' && !(v.barcode.length === 13 && eanChecksumOk(v.barcode))) {
      ctx.addIssue({ code: 'custom', path: ['barcode'], message: 'EAN-13 inválido (13 dígitos con dígito verificador)' });
    }
    if (v.type === 'UPC' && !(v.barcode.length === 12 && eanChecksumOk(v.barcode))) {
      ctx.addIssue({ code: 'custom', path: ['barcode'], message: 'UPC inválido (12 dígitos con dígito verificador)' });
    }
  });

export const packageSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,59}$/, 'Letras, números, punto, guion o guion bajo'),
  type: z.enum(keysOf(PACKAGE_TYPE)).default('CAJA_MASTER'),
  unitsPerPackage: z.coerce.number().int('Debe ser entero').min(1, 'Mínimo 1').max(100_000),
});

export const importRowPatchSchema = z
  .object({
    values: z.record(z.string(), z.union([z.string().max(500), z.null()])).optional(),
    skipped: z.boolean().optional(),
  })
  .refine((v) => v.values !== undefined || v.skipped !== undefined, { message: 'Nada que actualizar' });

export const kitComponentsSchema = z.object({
  components: z
    .array(z.object({ componentSkuId: id(), quantity: z.coerce.number().int().min(1).max(10_000) }))
    .max(50)
    .refine((arr) => new Set(arr.map((c) => c.componentSkuId)).size === arr.length, {
      message: 'Un componente aparece dos veces',
    }),
});

// ───────────────────────────── Canales y publicaciones ─────────────────────────────

export const channelSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_]{2,30}$/, 'Mayúsculas, números y guion bajo'),
  name: trimmed(80),
  type: z.enum(keysOf(CHANNEL_TYPE)),
  status: z.enum(keysOf(CHANNEL_STATUS)).default('ACTIVO'),
  coverageDays: optInt(1, 365),
  sortOrder: optInt(0, 1000).transform((v) => v ?? 0),
});

export const listingSchema = z
  .object({
    channelId: id(),
    masterSkuId: id(),
    externalId: trimmed(80),
    externalSku: z.string().trim().max(120).default(''),
    fnsku: optText(40),
    unitsPerListing: z.coerce.number().int().min(1).max(1000).default(1),
    title: optText(300),
    price: decimal(2, { min: 0 }),
    fulfillmentModel: z.enum(keysOf(FULFILLMENT_MODEL)).default('BODEGA_PROPIA'),
    fulfillmentWarehouseId: optId(),
    status: z.enum(keysOf(LISTING_STATUS)).default('ACTIVA'),
  })
  .refine((v) => v.fulfillmentModel !== 'FULFILLMENT_CANAL' || v.fulfillmentWarehouseId, {
    message: 'Indica el almacén del canal que surte esta publicación',
    path: ['fulfillmentWarehouseId'],
  });

export const listingUpdateSchema = z.object({
  /** Se puede corregir (p. ej. capturar el artículo de Liverpool de una oferta Vendor “OF22”). */
  externalId: trimmed(80).optional(),
  externalSku: z.string().trim().max(120).optional(),
  fnsku: optText(40),
  unitsPerListing: z.coerce.number().int().min(1).max(1000).optional(),
  title: optText(300),
  price: decimal(2, { min: 0 }),
  fulfillmentModel: z.enum(keysOf(FULFILLMENT_MODEL)).optional(),
  fulfillmentWarehouseId: optId(),
  status: z.enum(keysOf(LISTING_STATUS)).optional(),
});

export const feeRuleSchema = z
  .object({
    categoryId: optId(),
    masterSkuId: optId(),
    name: trimmed(120),
    feeType: z.enum(keysOf(FEE_TYPE)).default('COMISION'),
    /** Porcentaje como fracción: 0.19 = 19 %. */
    rate: decimal(4, { min: 0, max: 1 }),
    fixedAmount: decimal(2, { min: 0 }),
    base: z.enum(keysOf(FEE_BASE)).default('VENTA_CON_IVA'),
    validFrom: isoDate(),
    validTo: isoDate().nullish().transform((v) => v ?? null),
    notes: optText(500),
  })
  .refine((v) => v.rate !== null || v.fixedAmount !== null, {
    message: 'Captura una tasa o un monto fijo',
    path: ['rate'],
  })
  .refine((v) => !v.validTo || v.validTo >= v.validFrom, {
    message: 'La vigencia final no puede ser anterior a la inicial',
    path: ['validTo'],
  });

export const mapUnmappedSchema = z.object({
  masterSkuId: id(),
  unitsPerListing: z.coerce.number().int().min(1).max(1000).default(1),
  fulfillmentModel: z.enum(keysOf(FULFILLMENT_MODEL)).default('BODEGA_PROPIA'),
  fulfillmentWarehouseId: optId(),
});

// ───────────────────────────── Almacenes ─────────────────────────────

export const warehouseSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9_-]{2,20}$/, 'Mayúsculas, números, guion y guion bajo'),
    name: trimmed(120),
    type: z.enum(keysOf(WAREHOUSE_TYPE)),
    channelId: optId(),
    address: optText(300),
    city: optText(80),
    state: optText(80),
    zip: optText(10),
    allowNegative: z.boolean().default(false),
    status: z.enum(keysOf(RECORD_STATUS)).default('ACTIVO'),
  })
  .refine((v) => !['FULFILLMENT_CANAL', 'CONSIGNACION'].includes(v.type) || v.channelId, {
    message: 'Un almacén de fulfillment o consignación debe pertenecer a un canal',
    path: ['channelId'],
  });

export const locationSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_.-]{1,30}$/, 'Mayúsculas, números, punto y guion'),
  name: optText(120),
  type: z.enum(keysOf(LOCATION_TYPE)).default('ALMACENAJE'),
  status: z.enum(keysOf(RECORD_STATUS)).default('ACTIVO'),
});

// ───────────────────────────── Usuarios y roles ─────────────────────────────

export const userCreateSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('Correo inválido')),
  name: trimmed(120),
  password: passwordPolicy,
  roleIds: z.array(id()).min(1, 'Asigna al menos un rol'),
  warehouseIds: z.array(id()).default([]),
});

export const userUpdateSchema = z.object({
  name: trimmed(120).optional(),
  status: z.enum(keysOf(USER_STATUS)).optional(),
  roleIds: z.array(id()).min(1, 'Asigna al menos un rol').optional(),
  warehouseIds: z.array(id()).optional(),
});

export const resetPasswordSchema = z.object({ newPassword: passwordPolicy });

export const roleSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_]{2,30}$/, 'Mayúsculas, números y guion bajo'),
  name: trimmed(80),
  description: optText(300),
});

export const rolePermissionsSchema = z.object({
  permissionKeys: z.array(z.string().regex(/^[a-z]+\.[a-z]+$/)).max(500),
});

export const savedFilterSchema = z.object({
  tableKey: z.string().regex(/^[a-z0-9_.-]{2,60}$/),
  name: trimmed(60),
  filter: z.record(z.string(), z.unknown()),
  isDefault: z.boolean().default(false),
});

// ───────────────────────────── Inventario (entrega 2) ─────────────────────────────

const qtyInt = (opts: { allowNegative?: boolean; allowZero?: boolean } = {}) =>
  z.union([z.number(), z.string()]).transform((v, ctx) => {
    const n = Number(typeof v === 'string' ? v.replace(/,/g, '').trim() : v);
    if (!Number.isInteger(n) || Math.abs(n) > 1_000_000) {
      ctx.addIssue({ code: 'custom', message: 'Debe ser un número entero de piezas' });
      return z.NEVER;
    }
    if (n === 0 && !opts.allowZero) {
      ctx.addIssue({ code: 'custom', message: 'No puede ser 0' });
      return z.NEVER;
    }
    if (n < 0 && !opts.allowNegative) {
      ctx.addIssue({ code: 'custom', message: 'No puede ser negativo' });
      return z.NEVER;
    }
    return n;
  });

export const adjustmentItemSchema = z.object({
  masterSkuId: id(),
  /** Con signo: positivo entra, negativo sale. */
  qty: qtyInt({ allowNegative: true }),
  locationId: optId(),
  lotId: optId(),
  unitCost: decimal(4, { min: 0, max: 10_000_000 }),
  notes: optText(500),
});

export const adjustmentSchema = z
  .object({
    warehouseId: id(),
    reason: z.enum(keysOf(ADJUSTMENT_REASON)),
    notes: optText(1000),
    items: z.array(adjustmentItemSchema).min(1, 'Agrega al menos un renglón').max(500),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.items.forEach((it, i) => {
      const k = `${it.masterSkuId}|${it.locationId ?? ''}|${it.lotId ?? ''}`;
      if (seen.has(k)) ctx.addIssue({ code: 'custom', path: ['items', i, 'masterSkuId'], message: 'SKU repetido en la misma ubicación y lote' });
      seen.add(k);
      if (it.qty < 0 && it.unitCost !== null)
        ctx.addIssue({ code: 'custom', path: ['items', i, 'unitCost'], message: 'Las salidas se valúan con el costo de sus lotes (FIFO); no captures costo' });
    });
    if (v.notes === null && (v.reason === 'OTRO' || v.reason === 'ERROR_CAPTURA'))
      ctx.addIssue({ code: 'custom', path: ['notes'], message: 'Explica el motivo del ajuste' });
  });
export type AdjustmentInput = z.infer<typeof adjustmentSchema>;

export const applySchema = z.object({
  /** Sólo Administrador: permite que la salida deje la existencia en negativo. */
  authorizeNegative: z.boolean().optional().default(false),
});

export const transferItemSchema = z
  .object({
    masterSkuId: id(),
    qtyRequested: optInt(1, 1_000_000),
    packageId: optId(),
    packageQty: optInt(1, 100_000),
    notes: optText(500),
  })
  .superRefine((v, ctx) => {
    if (v.packageId && v.packageQty === null) ctx.addIssue({ code: 'custom', path: ['packageQty'], message: 'Indica cuántas cajas' });
    if (!v.packageId && v.qtyRequested === null) ctx.addIssue({ code: 'custom', path: ['qtyRequested'], message: 'Indica las piezas' });
  });

export const transferSchema = z
  .object({
    originWarehouseId: id(),
    destinationWarehouseId: id(),
    reference: optText(120),
    notes: optText(1000),
    items: z.array(transferItemSchema).min(1, 'Agrega al menos un SKU').max(500),
  })
  .superRefine((v, ctx) => {
    if (v.originWarehouseId === v.destinationWarehouseId)
      ctx.addIssue({ code: 'custom', path: ['destinationWarehouseId'], message: 'El destino debe ser distinto del origen' });
    const seen = new Set<string>();
    v.items.forEach((it, i) => {
      if (seen.has(it.masterSkuId)) ctx.addIssue({ code: 'custom', path: ['items', i, 'masterSkuId'], message: 'SKU repetido en la transferencia' });
      seen.add(it.masterSkuId);
    });
  });
export type TransferInput = z.infer<typeof transferSchema>;

export const transferShipSchema = z.object({
  reference: optText(120),
  /** Piezas enviadas por renglón; si se omite un renglón se envía lo solicitado. */
  items: z.array(z.object({ itemId: id(), qtyShipped: qtyInt({ allowZero: true }) })).optional().default([]),
  authorizeNegative: z.boolean().optional().default(false),
});

export const transferReceiveSchema = z.object({
  /** Piezas recibidas en esta recepción (se suman a recepciones anteriores). */
  items: z.array(z.object({ itemId: id(), qty: qtyInt({ allowZero: true }) })).max(500),
  locationId: optId(),
  /** Cerrar aunque falten piezas: la diferencia queda registrada como faltante de la transferencia. */
  close: z.boolean().optional().default(false),
  notes: optText(1000),
});

export const countCreateSchema = z.object({
  warehouseId: id(),
  locationId: optId(),
  blind: z.boolean().optional().default(true),
  notes: optText(1000),
  /** Conteo cíclico: sólo estos SKU. Vacío = todo lo que tiene existencia. */
  skuIds: z.array(id()).max(2000).optional().default([]),
});

export const countCaptureSchema = z.object({
  lines: z
    .array(z.object({ lineId: id(), countedQty: z.union([qtyInt({ allowZero: true }), z.null()]) }))
    .min(1)
    .max(2000),
});

export const countAddLineSchema = z.object({ masterSkuId: id(), locationId: id(), countedQty: optInt(0, 1_000_000) });

export const countCloseSchema = z.object({
  /** Los renglones sin capturar cuentan como 0 (si no, se ignoran). */
  uncountedAsZero: z.boolean().optional().default(false),
  authorizeNegative: z.boolean().optional().default(false),
});

export const relocationSchema = z
  .object({
    masterSkuId: id(),
    warehouseId: id(),
    fromLocationId: id(),
    toLocationId: id(),
    qty: qtyInt(),
    lotId: optId(),
    notes: optText(500),
  })
  .refine((v) => v.fromLocationId !== v.toLocationId, { path: ['toLocationId'], message: 'Elige una ubicación distinta' });
