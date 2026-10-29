import { config } from 'dotenv';
import path from 'node:path';
import crypto from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  MODULES,
  MODULE_ACTIONS,
  ROLE_CODES,
  ROLE_NAMES,
  defaultRolePermissions,
  permissionKey,
} from '@erp/shared';
import { closeDb, getDb } from './index';
import { hashPassword } from './password';
import {
  channels,
  companySettings,
  currencies,
  feeRules,
  permissions,
  rolePermissions,
  roles,
  systemParameters,
  taxRates,
  userRoles,
  users,
  warehouseLocations,
  warehouses,
} from './schema';

config({ path: path.resolve(__dirname, '../../../.env') });

/**
 * Datos base del ERP. Es idempotente: se puede correr varias veces sin duplicar.
 * No crea productos ni SKU: el catálogo se carga desde el archivo maestro del negocio.
 */
async function main() {
  const db = getDb();

  // ── Permisos y roles ──────────────────────────────────────────────
  const permRows = MODULES.flatMap((m) =>
    MODULE_ACTIONS[m].map((a) => ({ key: permissionKey(m, a), module: m, action: a })),
  );
  await db.insert(permissions).values(permRows).onConflictDoNothing();
  const allPerms = await db.select().from(permissions);
  const permIdByKey = new Map(allPerms.map((p) => [p.key, p.id]));

  for (const code of ROLE_CODES) {
    await db
      .insert(roles)
      .values({ code, name: ROLE_NAMES[code], isSystem: true })
      .onConflictDoNothing();
    const [role] = await db.select().from(roles).where(eq(roles.code, code));
    const existing = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, role.id));
    // Sólo se asignan permisos por defecto a roles sin permisos (no pisa ajustes del Administrador).
    if (existing[0].c === 0 || code === 'ADMIN') {
      const keys = defaultRolePermissions(code);
      const rows = keys
        .map((k) => permIdByKey.get(k))
        .filter((id): id is string => Boolean(id))
        .map((permissionId) => ({ roleId: role.id, permissionId }));
      if (rows.length) await db.insert(rolePermissions).values(rows).onConflictDoNothing();
    }
  }

  // ── Usuario administrador inicial ─────────────────────────────────
  const adminEmail = (process.env.SEED_ADMIN_EMAIL ?? 'admin@empresa.mx').toLowerCase();
  const found = await db.select().from(users).where(sql`lower(email) = ${adminEmail}`);
  if (found.length === 0) {
    const generated = !process.env.SEED_ADMIN_PASSWORD;
    const password = process.env.SEED_ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
    const [admin] = await db
      .insert(users)
      .values({
        email: adminEmail,
        name: process.env.SEED_ADMIN_NAME ?? 'Administrador',
        passwordHash: await hashPassword(password),
        mustChangePassword: true,
      })
      .returning();
    const [adminRole] = await db.select().from(roles).where(eq(roles.code, 'ADMIN'));
    await db.insert(userRoles).values({ userId: admin.id, roleId: adminRole.id });
    console.log(`Administrador creado: ${adminEmail}`);
    if (generated) console.log(`Contraseña temporal (se pedirá cambiarla): ${password}`);
  }

  // ── Empresa, monedas, impuestos, parámetros ───────────────────────
  await db
    .insert(companySettings)
    .values({ id: 1, legalName: 'Zanetti', tradeName: 'Zanetti' })
    .onConflictDoNothing();
  await db
    .insert(currencies)
    .values([
      { code: 'MXN', name: 'Peso mexicano', symbol: '$' },
      { code: 'USD', name: 'Dólar estadounidense', symbol: 'US$' },
      { code: 'CNY', name: 'Yuan chino', symbol: '¥' },
    ])
    .onConflictDoNothing();
  await db
    .insert(taxRates)
    .values({ code: 'IVA', name: 'IVA general', rate: '0.1600', validFrom: '2014-01-01' })
    .onConflictDoNothing();
  await db
    .insert(systemParameters)
    .values([
      {
        key: 'inventario.permitir_negativos',
        value: false,
        description: 'Si es verdadero, cualquier almacén puede quedar en negativo. Recomendado: falso.',
      },
      {
        key: 'compras.umbral_autorizacion_mxn',
        value: sql`'null'::jsonb`,
        description: 'Monto de OC (MXN) a partir del cual se requiere autorización. Pendiente de definir.',
      },
      {
        key: 'ajustes.umbral_autorizacion_mxn',
        value: sql`'null'::jsonb`,
        description: 'Valor de ajuste (MXN) a partir del cual se requiere autorización. Pendiente de definir.',
      },
      {
        key: 'reabasto.parametros',
        value: {"mesesHistoria": 3, "pctQuiebre": 0.3, "factorFba": 1, "factorFbl": 1, "factorAplin": 1, "almexDias": 33, "dhlDias": 17, "colchonFba": 7, "envioFblDias": 10, "colchonFbl": 5, "reservaAplinDias": 30, "redondearCajas": true, "navieraDias": 40, "aduanaDias": 15, "cicloDias": 45, "seguridadDias": 21, "capacidadCbm": 68, "fechaProximoPedido": null, "origenAlmacen": {"AMZ-FBA": "AMZ-FBA", "AMZ-MFN": "AMZ-FBA", "LIVERPOOL": "LIV-FBL", "SHOPIFY": "APLIN"}},
        description: 'Parámetros del cálculo de reabasto (venta base, envíos a FBA y Liverpool, contenedores). Se editan en Reabasto → Parámetros.',
      },
    ])
    .onConflictDoNothing();

  // ── Canales ───────────────────────────────────────────────────────
  await db
    .insert(channels)
    .values([
      { code: 'AMAZON', name: 'Amazon', type: 'MARKETPLACE', status: 'ACTIVO', coverageDays: 90, sortOrder: 1 },
      { code: 'LIVERPOOL', name: 'Liverpool', type: 'MARKETPLACE', status: 'ACTIVO', coverageDays: 45, sortOrder: 2 },
      { code: 'SHOPIFY', name: 'Shopify', type: 'TIENDA_PROPIA', status: 'ACTIVO', sortOrder: 3 },
      { code: 'MERCADO_LIBRE', name: 'Mercado Libre', type: 'MARKETPLACE', status: 'PAUSADO', sortOrder: 4 },
      { code: 'DIRECTO', name: 'Venta directa', type: 'DIRECTO', status: 'ACTIVO', sortOrder: 5 },
    ])
    .onConflictDoNothing();
  const chRows = await db.select().from(channels);
  const ch = (code: string) => chRows.find((c) => c.code === code)!.id;

  // ── Almacenes y ubicaciones ───────────────────────────────────────
  await db
    .insert(warehouses)
    .values([
      { code: 'APLIN', name: 'Bodega APLIN', type: 'PROPIO' },
      { code: 'AMZ-FBA', name: 'Amazon FBA', type: 'FULFILLMENT_CANAL', channelId: ch('AMAZON') },
      { code: 'LIV-FBL', name: 'Liverpool FBL', type: 'FULFILLMENT_CANAL', channelId: ch('LIVERPOOL') },
      { code: 'LIV-99MIN', name: 'Liverpool 99 Minutos', type: 'FULFILLMENT_CANAL', channelId: ch('LIVERPOOL') },
    ])
    .onConflictDoNothing();
  const whRows = await db.select().from(warehouses);
  const wh = (code: string) => whRows.find((w) => w.code === code)!.id;

  const locs: (typeof warehouseLocations.$inferInsert)[] = [
    { warehouseId: wh('APLIN'), code: 'REC', name: 'Recepción', type: 'RECEPCION' },
    { warehouseId: wh('APLIN'), code: 'GEN', name: 'Almacenaje general', type: 'ALMACENAJE' },
    { warehouseId: wh('APLIN'), code: 'CUA', name: 'Cuarentena (devoluciones)', type: 'CUARENTENA' },
    { warehouseId: wh('APLIN'), code: 'MER', name: 'Merma', type: 'MERMA' },
    { warehouseId: wh('APLIN'), code: 'EMB', name: 'Embarque', type: 'EMBARQUE' },
    { warehouseId: wh('AMZ-FBA'), code: 'GEN', name: 'Existencia en Amazon', type: 'ALMACENAJE' },
    { warehouseId: wh('LIV-FBL'), code: 'GEN', name: 'Existencia en Liverpool FBL', type: 'ALMACENAJE' },
    { warehouseId: wh('LIV-99MIN'), code: 'GEN', name: 'Existencia en 99 Minutos', type: 'ALMACENAJE' },
  ];
  await db.insert(warehouseLocations).values(locs).onConflictDoNothing();

  // ── Comisión general de Liverpool (cambio del 8-abr-2026, sobre venta con IVA antes de descuento)
  const existingFees = await db
    .select()
    .from(feeRules)
    .where(and(eq(feeRules.channelId, ch('LIVERPOOL')), inArray(feeRules.validFrom, ['2025-01-01', '2026-04-08'])));
  if (existingFees.length === 0) {
    await db.insert(feeRules).values([
      {
        channelId: ch('LIVERPOOL'),
        name: 'Comisión general',
        feeType: 'COMISION',
        rate: '0.1643',
        base: 'VENTA_CON_IVA',
        validFrom: '2025-01-01',
        validTo: '2026-04-07',
        notes: 'Tasa observada en ventas de ene–abr 2026. Ajustar la fecha de inicio si se conoce.',
      },
      {
        channelId: ch('LIVERPOOL'),
        name: 'Comisión general',
        feeType: 'COMISION',
        rate: '0.1900',
        base: 'VENTA_CON_IVA',
        validFrom: '2026-04-08',
        notes: 'Se cobra sobre la venta con IVA antes del descuento.',
      },
    ]);
  }

  console.log('Datos base listos.');
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
