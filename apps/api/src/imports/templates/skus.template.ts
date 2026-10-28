import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  brands,
  categories,
  channelListings,
  channels,
  costHistory,
  masterSkus,
  priceHistory,
  products,
  skuBarcodes,
  skuPackages,
  unmappedCodes,
  warehouses,
  type DbOrTx,
  type Tx,
} from '@erp/db';
import { SKU_CODE_REGEX, eanChecksumOk } from '@erp/shared';
import { can, type Actor } from '../../common/actor';
import type { ImportTemplate, InputRow, RowMessage, ValidatedRow } from '../types';

// ───────────────────────────── Plan de cada renglón ─────────────────────────────

type ChannelCode = 'AMAZON' | 'LIVERPOOL' | 'SHOPIFY';

export interface ListingPlan {
  channel: ChannelCode;
  externalId: string;
  externalSku: string;
  fnsku: string | null;
  warehouse: string;
  model: 'FULFILLMENT_CANAL' | 'BODEGA_PROPIA';
  /** Texto para la vista previa: "Liverpool FBL · artículo 1138782090 · oferta 1138782090-FBL". */
  label: string;
}

export interface SkuPlan {
  skuCode: string;
  existingSkuId: string | null;
  name: string;
  nameChange: { from: string; to: string } | null;
  product: { name: string; brand: string | null; category: string | null } | null;
  basePrice: string | null;
  priceChange: boolean;
  cost: string | null;
  costChange: boolean;
  barcode: { code: string; type: 'EAN13' | 'UPC' | 'INTERNO'; primary: boolean } | null;
  listings: ListingPlan[];
  package: { code: string; units: number; mode: 'crear' | 'actualizar' } | null;
}

// ───────────────────────────── Normalización de valores ─────────────────────────────

const up = (v: string | null) => (v ? v.replace(/\s+/g, '').toUpperCase() : null);

function parseDecimal(v: string | null, scale: number): { value: string | null; ok: boolean } {
  if (!v) return { value: null, ok: true };
  const s = v.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return { value: null, ok: false };
  return { value: Number(s).toFixed(scale), ok: true };
}

function parseUnits(v: string | null): { value: number | null; ok: boolean } {
  if (!v) return { value: null, ok: true };
  const n = Number(v.replace(/,/g, ''));
  if (!Number.isInteger(n) || n < 1 || n > 100_000) return { value: null, ok: false };
  return { value: n, ok: true };
}

/**
 * "SKU de oferta" de Liverpool: 1138782090-FBL, 1112726311, 1120106453-OF, OF22.
 * El número de 7 a 13 dígitos del inicio es el artículo de Liverpool; si no hay número, el artículo es desconocido.
 */
export function parseLiverpoolOffer(v: string): { article: string | null; offerSku: string } {
  const offerSku = v.trim();
  const m = /^(\d{7,13})\b/.exec(offerSku);
  return { article: m ? m[1] : null, offerSku };
}

/** UPC/EAN: devuelve el código limpio, su tipo y avisos. */
function parseBarcode(v: string): { code: string; type: 'EAN13' | 'UPC' | 'INTERNO'; messages: RowMessage[] } {
  const messages: RowMessage[] = [];
  let code = v.replace(/[\s-]/g, '');
  if (!/^\d+$/.test(code)) {
    messages.push({ field: 'barcode', level: 'info', message: 'Código no numérico: se guarda como código interno.' });
    return { code: code.toUpperCase(), type: 'INTERNO', messages };
  }
  // Excel quita el 0 inicial de los UPC al guardarlos como número.
  if (code.length === 11 && eanChecksumOk(`0${code}`)) {
    code = `0${code}`;
    messages.push({ field: 'barcode', level: 'warning', message: `Se agregó el 0 inicial que Excel quitó: ${code}.` });
  }
  if (code.length === 12 || code.length === 13) {
    if (!eanChecksumOk(code)) {
      messages.push({ field: 'barcode', level: 'error', message: `El dígito verificador del ${code.length === 12 ? 'UPC' : 'EAN-13'} ${code} no es válido.` });
    }
    return { code, type: code.length === 12 ? 'UPC' : 'EAN13', messages };
  }
  messages.push({ field: 'barcode', level: 'warning', message: `Longitud no estándar (${code.length} dígitos): se guarda como código interno.` });
  return { code, type: 'INTERNO', messages };
}

const FNSKU_REGEX = /^X00[0-9A-Z]{7}$/;
const ASIN_REGEX = /^[0-9A-Z]{10}$/;

// ───────────────────────────── Plantilla ─────────────────────────────

export const skusTemplate: ImportTemplate<SkuPlan> = {
  key: 'skus',
  label: 'SKU maestro y publicaciones',
  description:
    'Da de alta SKU maestros con su código de barras, caja master y publicaciones de Amazon, Liverpool y Shopify. Si el SKU ya existe, sólo agrega lo que falta; nunca borra.',
  permissions: ['productos.crear', 'productos.editar', 'canales.crear'],
  columns: [
    { field: 'skuCode', header: 'SKU MAESTRO', aliases: ['SKU', 'CODIGO SKU', 'SKU MASTER'], required: true, example: 'X003Q4BXC7', help: 'Código único del producto en el ERP. Letras, números, punto, guion o guion bajo.' },
    { field: 'name', header: 'NOMBRE', aliases: ['DESCRIPCION', 'NOMBRE DEL PRODUCTO', 'TITULO'], example: 'Caja organizadora 30 L', help: 'Nombre corto para tablas y etiquetas. Si falta, se usa el código del SKU.' },
    { field: 'productName', header: 'PRODUCTO', aliases: ['PRODUCTO PADRE', 'MODELO'], example: 'Caja organizadora', help: 'Agrupa variantes (talla, color, capacidad). Si falta, cada SKU es su propio producto.' },
    { field: 'brand', header: 'MARCA', example: 'Zanetti', help: 'Se crea si no existe. Sólo aplica a SKU nuevos.' },
    { field: 'category', header: 'CATEGORIA', aliases: ['CATEGORÍA'], example: 'Hogar / Organización', help: 'Usa " / " para subcategorías. Se crea si no existe. Sólo aplica a SKU nuevos.' },
    { field: 'liverpoolFbl', header: 'ID LIVERPOOL FBL/99 MIN', aliases: ['ID LIVERPOOL FBL', 'LIVERPOOL FBL', 'SKU OFERTA FBL', 'ID LIVERPOOL FBL 99 MIN'], example: '1138782090-FBL', help: 'SKU de oferta de Liverpool con stock en Liverpool. El número inicial es el artículo. Si contiene "99" se registra en 99 Minutos; si no, en FBL.' },
    { field: 'liverpoolVendor', header: 'ID LIVERPOOL VENDOR', aliases: ['LIVERPOOL VENDOR', 'SKU OFERTA VENDOR'], example: 'OF22', help: 'SKU de oferta Vendor; se surte desde la bodega APLIN.' },
    { field: 'asin', header: 'ASIN AMAZON', aliases: ['ASIN'], example: 'B0BWGHJ9SW', help: 'ASIN de Amazon; se registra con stock en Amazon FBA. Si el SKU maestro empieza con X00 se guarda también como FNSKU.' },
    { field: 'amazonSku', header: 'SKU AMAZON', aliases: ['SELLER SKU AMAZON', 'SKU VENDEDOR AMAZON'], help: 'SKU de vendedor en Amazon (opcional).' },
    { field: 'shopifyVariantId', header: 'SHOPIFY VARIANT ID', aliases: ['VARIANT ID SHOPIFY', 'ID VARIANTE SHOPIFY'], help: 'ID de la variante en Shopify (opcional); se surte desde APLIN.' },
    { field: 'shopifySku', header: 'SKU SHOPIFY', help: 'SKU de la variante en Shopify (opcional).' },
    { field: 'barcode', header: 'UPC-EAN', aliases: ['UPC', 'EAN', 'UPC EAN', 'CODIGO DE BARRAS'], example: '7503039141049', help: 'UPC (12 dígitos) o EAN-13; se valida el dígito verificador. Se limpian espacios invisibles.' },
    { field: 'caseCode', header: 'SKU CAJA MASTER', aliases: ['CAJA MASTER', 'CODIGO CAJA MASTER'], example: 'X003Q4BXC7-C', help: 'Código de la caja master.' },
    { field: 'caseUnits', header: 'PIEZAS CAJA MASTER', aliases: ['PIEZAS POR CAJA', 'PZAS CAJA MASTER'], example: '10', help: 'Piezas que trae la caja master. Sin piezas, la caja no se registra.' },
    { field: 'basePrice', header: 'PRECIO LISTA', aliases: ['PRECIO', 'PRECIO CON IVA'], help: 'Precio de lista con IVA (opcional).' },
    { field: 'cost', header: 'COSTO', aliases: ['COSTO UNITARIO'], help: 'Costo unitario sin IVA (opcional; requiere el permiso de costos).' },
  ],

  async validate(db: DbOrTx, rows: InputRow[], actor: Actor): Promise<ValidatedRow<SkuPlan>[]> {
    const active = rows.filter((r) => !r.skipped);
    const v = (r: InputRow, f: string) => r.values[f] ?? null;

    // ── Índices dentro del archivo para detectar duplicados ──
    const index = (fn: (r: InputRow) => string[]) => {
      const m = new Map<string, number[]>();
      for (const r of active) for (const k of fn(r)) m.set(k, [...(m.get(k) ?? []), r.rowNumber]);
      return m;
    };
    const skuIdx = index((r) => (up(v(r, 'skuCode')) ? [up(v(r, 'skuCode'))!] : []));
    const caseIdx = index((r) => (up(v(r, 'caseCode')) ? [up(v(r, 'caseCode'))!] : []));
    const bcIdx = index((r) => (v(r, 'barcode') ? [parseBarcode(v(r, 'barcode')!).code] : []));

    // ── Datos existentes ──
    const fileSkuCodes = [...skuIdx.keys()];
    const allCodes = [...new Set([...fileSkuCodes, ...caseIdx.keys()])];
    const existingSkus = allCodes.length
      ? await db
          .select({ id: masterSkus.id, skuCode: masterSkus.skuCode, name: masterSkus.name, basePrice: masterSkus.basePrice, currentCost: masterSkus.currentCost })
          .from(masterSkus)
          .where(inArray(sql`upper(${masterSkus.skuCode})`, allCodes))
      : [];
    const skuByCode = new Map(existingSkus.map((s) => [s.skuCode.toUpperCase(), s]));

    const bcCodes = [...bcIdx.keys()];
    const existingBc = bcCodes.length
      ? await db
          .select({ barcode: skuBarcodes.barcode, masterSkuId: skuBarcodes.masterSkuId, skuCode: masterSkus.skuCode })
          .from(skuBarcodes)
          .innerJoin(masterSkus, eq(masterSkus.id, skuBarcodes.masterSkuId))
          .where(inArray(skuBarcodes.barcode, bcCodes))
      : [];
    const bcOwner = new Map(existingBc.map((b) => [b.barcode, b]));
    const existingIds = existingSkus.map((s) => s.id);
    const withPrimary = new Set(
      existingIds.length
        ? (await db.select({ id: skuBarcodes.masterSkuId }).from(skuBarcodes).where(and(inArray(skuBarcodes.masterSkuId, existingIds), eq(skuBarcodes.isPrimary, true)))).map((x) => x.id)
        : [],
    );

    const caseCodes = [...caseIdx.keys()];
    const existingPk = caseCodes.length
      ? await db
          .select({ code: skuPackages.code, masterSkuId: skuPackages.masterSkuId, units: skuPackages.unitsPerPackage, skuCode: masterSkus.skuCode })
          .from(skuPackages)
          .innerJoin(masterSkus, eq(masterSkus.id, skuPackages.masterSkuId))
          .where(inArray(sql`upper(${skuPackages.code})`, caseCodes))
      : [];
    const pkOwner = new Map(existingPk.map((p) => [p.code.toUpperCase(), p]));

    const chRows = await db.select({ id: channels.id, code: channels.code }).from(channels).where(inArray(channels.code, ['AMAZON', 'LIVERPOOL', 'SHOPIFY']));
    const chId = new Map(chRows.map((c) => [c.code, c.id]));
    const whRows = await db.select({ code: warehouses.code }).from(warehouses).where(inArray(warehouses.code, ['AMZ-FBA', 'LIV-FBL', 'LIV-99MIN', 'APLIN']));
    const whExists = new Set(whRows.map((w) => w.code));

    // ── Publicaciones de cada renglón (antes de consultar las existentes) ──
    const listingsOf = new Map<number, { plan: ListingPlan; messages: RowMessage[]; field: string }[]>();
    for (const r of rows) {
      const out: { plan: ListingPlan; messages: RowMessage[]; field: string }[] = [];
      const sku = up(v(r, 'skuCode')) ?? '';
      const asin = up(v(r, 'asin'));
      if (asin) {
        const m: RowMessage[] = [];
        if (!ASIN_REGEX.test(asin)) m.push({ field: 'asin', level: 'error', message: `El ASIN “${asin}” debe tener 10 letras o números.` });
        out.push({
          field: 'asin',
          messages: m,
          plan: {
            channel: 'AMAZON', externalId: asin, externalSku: v(r, 'amazonSku') ?? '',
            fnsku: FNSKU_REGEX.test(sku) ? sku : null, warehouse: 'AMZ-FBA', model: 'FULFILLMENT_CANAL',
            label: `Amazon FBA · ASIN ${asin}${FNSKU_REGEX.test(sku) ? ` · FNSKU ${sku}` : ''}`,
          },
        });
      }
      const fbl = v(r, 'liverpoolFbl');
      if (fbl) {
        const { article, offerSku } = parseLiverpoolOffer(fbl);
        const is99 = /99\s*-?\s*MIN/i.test(offerSku);
        const m: RowMessage[] = [];
        if (!article) m.push({ field: 'liverpoolFbl', level: 'warning', message: `No se reconoce el número de artículo en “${offerSku}”; se registra con el SKU de oferta.` });
        else if (!/-FBL$/i.test(offerSku) && !is99) m.push({ field: 'liverpoolFbl', level: 'info', message: `“${offerSku}” no trae el sufijo -FBL; se registra en Liverpool FBL.` });
        out.push({
          field: 'liverpoolFbl',
          messages: m,
          plan: {
            channel: 'LIVERPOOL', externalId: article ?? offerSku, externalSku: offerSku, fnsku: null,
            warehouse: is99 ? 'LIV-99MIN' : 'LIV-FBL', model: 'FULFILLMENT_CANAL',
            label: `Liverpool ${is99 ? '99 Minutos' : 'FBL'} · ${article ? `artículo ${article} · ` : ''}oferta ${offerSku}`,
          },
        });
      }
      const ven = v(r, 'liverpoolVendor');
      if (ven) {
        const { article, offerSku } = parseLiverpoolOffer(ven);
        const m: RowMessage[] = [];
        if (!article) {
          m.push({
            field: 'liverpoolVendor',
            level: 'info',
            message: `La oferta Vendor “${offerSku}” no trae número de artículo: se registra con el SKU de oferta. Agrega el artículo después para que sus ventas se liguen solas.`,
          });
        }
        out.push({
          field: 'liverpoolVendor',
          messages: m,
          plan: {
            channel: 'LIVERPOOL', externalId: article ?? offerSku, externalSku: offerSku, fnsku: null,
            warehouse: 'APLIN', model: 'BODEGA_PROPIA',
            label: `Liverpool Vendor (APLIN) · ${article ? `artículo ${article} · ` : ''}oferta ${offerSku}`,
          },
        });
      }
      const svid = v(r, 'shopifyVariantId');
      const ssku = v(r, 'shopifySku');
      if (svid || ssku) {
        out.push({
          field: svid ? 'shopifyVariantId' : 'shopifySku',
          messages: [],
          plan: {
            channel: 'SHOPIFY', externalId: (svid ?? ssku)!, externalSku: ssku ?? '', fnsku: null,
            warehouse: 'APLIN', model: 'BODEGA_PROPIA',
            label: `Shopify · ${svid ? `variante ${svid}` : `SKU ${ssku}`}`,
          },
        });
      }
      listingsOf.set(r.rowNumber, out);
    }

    const lkey = (c: string, id: string, s: string) => `${c}|${id.toUpperCase()}|${s.toUpperCase()}`;
    const listIdx = new Map<string, number[]>();
    for (const r of active) {
      for (const l of listingsOf.get(r.rowNumber) ?? []) {
        const k = lkey(l.plan.channel, l.plan.externalId, l.plan.externalSku);
        listIdx.set(k, [...(listIdx.get(k) ?? []), r.rowNumber]);
      }
    }
    const extIds = [...new Set([...listingsOf.values()].flat().map((l) => l.plan.externalId))];
    const existingListings = extIds.length && chRows.length
      ? await db
          .select({
            channelId: channelListings.channelId,
            externalId: channelListings.externalId,
            externalSku: channelListings.externalSku,
            masterSkuId: channelListings.masterSkuId,
            skuCode: masterSkus.skuCode,
          })
          .from(channelListings)
          .innerJoin(masterSkus, eq(masterSkus.id, channelListings.masterSkuId))
          .where(and(isNull(channelListings.validTo), inArray(channelListings.channelId, chRows.map((c) => c.id)), inArray(channelListings.externalId, extIds)))
      : [];
    const codeOfChannel = new Map(chRows.map((c) => [c.id, c.code]));
    const listOwner = new Map(existingListings.map((l) => [lkey(codeOfChannel.get(l.channelId)!, l.externalId, l.externalSku), l]));

    // Productos, marcas y categorías existentes (sólo para avisos).
    const prodNames = [...new Set(active.map((r) => v(r, 'productName')).filter((x): x is string => Boolean(x)).map((x) => x.toLowerCase()))];
    const existingProducts = prodNames.length
      ? await db.select({ name: products.name }).from(products).where(inArray(sql`lower(${products.name})`, prodNames))
      : [];
    const productExists = new Set(existingProducts.map((p) => p.name.toLowerCase()));
    const brandNames = [...new Set(active.map((r) => v(r, 'brand')).filter((x): x is string => Boolean(x)).map((x) => x.toLowerCase()))];
    const brandExists = new Set(
      brandNames.length ? (await db.select({ name: brands.name }).from(brands).where(inArray(sql`lower(${brands.name})`, brandNames))).map((b) => b.name.toLowerCase()) : [],
    );
    const allCats = await db.select({ id: categories.id, name: categories.name, parentId: categories.parentId }).from(categories);
    const catPathExists = (path: string) => {
      let parent: string | null = null;
      for (const part of path.split('/').map((p) => p.trim()).filter(Boolean)) {
        const found = allCats.find((c) => c.parentId === parent && c.name.toLowerCase() === part.toLowerCase());
        if (!found) return false;
        parent = found.id;
      }
      return true;
    };
    const productRows = new Map<string, number>();
    for (const r of active) {
      const p = v(r, 'productName')?.toLowerCase();
      if (p) productRows.set(p, (productRows.get(p) ?? 0) + 1);
    }

    const others = (list: number[] | undefined, me: number) => (list ?? []).filter((n) => n !== me);
    const rowsText = (list: number[]) => (list.length === 1 ? `el renglón ${list[0]}` : `los renglones ${list.join(', ')}`);

    // ── Validación renglón por renglón ──
    return rows.map((r): ValidatedRow<SkuPlan> => {
      const messages: RowMessage[] = [];
      const err = (field: string, message: string) => messages.push({ field, level: 'error', message });
      const warn = (field: string, message: string) => messages.push({ field, level: 'warning', message });
      const info = (field: string, message: string) => messages.push({ field, level: 'info', message });

      const sku = up(v(r, 'skuCode'));
      if (!sku) {
        err('skuCode', 'Falta el SKU maestro.');
        return { rowNumber: r.rowNumber, messages, action: null, plan: null };
      }
      if (!SKU_CODE_REGEX.test(sku)) err('skuCode', `“${sku}” no es un SKU válido: usa letras, números, punto, guion o guion bajo (2 a 40).`);
      if (!r.skipped) {
        const dup = others(skuIdx.get(sku), r.rowNumber);
        if (dup.length) err('skuCode', `El SKU ${sku} también aparece en ${rowsText(dup)}.`);
      }
      const existing = skuByCode.get(sku) ?? null;
      if (!existing && pkOwner.has(sku)) err('skuCode', `${sku} ya está registrado como caja master del SKU ${pkOwner.get(sku)!.skuCode}.`);

      // Nombre y producto
      const nameIn = v(r, 'name');
      const name = nameIn ?? existing?.name ?? sku;
      if (!existing && !nameIn) info('name', 'Sin nombre: se usará el código del SKU. Agrega la columna NOMBRE o edítalo después.');
      const nameChange = existing && nameIn && nameIn !== existing.name ? { from: existing.name, to: nameIn } : null;
      let product: SkuPlan['product'] = null;
      if (!existing) {
        const pName = v(r, 'productName') ?? name;
        product = { name: pName, brand: v(r, 'brand'), category: v(r, 'category') };
        const pl = v(r, 'productName')?.toLowerCase();
        if (pl && productExists.has(pl)) info('productName', `Se agrega como variante del producto existente “${pName}”.`);
        else if (pl && (productRows.get(pl) ?? 0) > 1) info('productName', `Variante del producto “${pName}” (${productRows.get(pl)} SKU en el archivo).`);
        if (product.brand && !brandExists.has(product.brand.toLowerCase())) info('brand', `Se creará la marca “${product.brand}”.`);
        if (product.category && !catPathExists(product.category)) info('category', `Se creará la categoría “${product.category}”.`);
      } else if (v(r, 'brand') || v(r, 'category') || v(r, 'productName')) {
        info('productName', 'El SKU ya existe: producto, marca y categoría no se modifican desde la importación.');
      }

      // Precio y costo
      const price = parseDecimal(v(r, 'basePrice'), 2);
      if (!price.ok) err('basePrice', `Precio inválido: “${v(r, 'basePrice')}”.`);
      const cost = parseDecimal(v(r, 'cost'), 4);
      if (!cost.ok) err('cost', `Costo inválido: “${v(r, 'cost')}”.`);
      if (cost.value && !can(actor, 'costos.ver')) err('cost', 'No tienes permiso para capturar costos.');
      const priceChange = Boolean(price.value && price.value !== existing?.basePrice);
      const costChange = Boolean(cost.value && cost.value !== existing?.currentCost);

      // Código de barras
      let barcode: SkuPlan['barcode'] = null;
      const bcIn = v(r, 'barcode');
      if (bcIn) {
        const pb = parseBarcode(bcIn);
        messages.push(...pb.messages);
        const owner = bcOwner.get(pb.code);
        const dup = r.skipped ? [] : others(bcIdx.get(pb.code), r.rowNumber);
        if (dup.length) err('barcode', `El código ${pb.code} también aparece en ${rowsText(dup)}.`);
        if (owner && owner.masterSkuId !== existing?.id) err('barcode', `El código ${pb.code} ya pertenece al SKU ${owner.skuCode}.`);
        else if (!owner) barcode = { code: pb.code, type: pb.type, primary: !existing || !withPrimary.has(existing.id) };
      }

      // Publicaciones
      const listings: ListingPlan[] = [];
      for (const l of listingsOf.get(r.rowNumber) ?? []) {
        messages.push(...l.messages);
        if (!chId.has(l.plan.channel)) {
          err(l.field, `No existe el canal ${l.plan.channel} en Configuración → Canales.`);
          continue;
        }
        if (!whExists.has(l.plan.warehouse)) {
          err(l.field, `No existe el almacén ${l.plan.warehouse} en Almacenes.`);
          continue;
        }
        const k = lkey(l.plan.channel, l.plan.externalId, l.plan.externalSku);
        const sameRow = (listingsOf.get(r.rowNumber) ?? []).filter((x) => lkey(x.plan.channel, x.plan.externalId, x.plan.externalSku) === k).length;
        if (sameRow > 1) {
          err(l.field, `La oferta ${l.plan.externalSku || l.plan.externalId} aparece dos veces en este renglón (FBL y Vendor deben ser distintas).`);
          continue;
        }
        const dup = r.skipped ? [] : others(listIdx.get(k), r.rowNumber);
        if (dup.length) err(l.field, `${l.plan.label} también aparece en ${rowsText(dup)}.`);
        const owner = listOwner.get(k);
        if (owner && owner.masterSkuId !== existing?.id) err(l.field, `${l.plan.label} ya está ligada al SKU ${owner.skuCode}.`);
        else if (!owner && !l.messages.some((m) => m.level === 'error')) listings.push(l.plan);
      }

      // Caja master
      let pkg: SkuPlan['package'] = null;
      const caseCode = up(v(r, 'caseCode'));
      const units = parseUnits(v(r, 'caseUnits'));
      if (!units.ok) err('caseUnits', `Las piezas por caja deben ser un entero mayor que 0 (“${v(r, 'caseUnits')}”).`);
      if (!caseCode) {
        if (units.value) warn('caseCode', 'Hay piezas por caja pero falta el código de la caja master; se ignoran.');
      } else if (caseCode === sku) {
        warn('caseCode', 'El código de la caja master es igual al SKU; no se registra la caja.');
      } else if (units.ok && !units.value) {
        warn('caseUnits', `Falta el número de piezas de la caja ${caseCode}; la caja no se registra.`);
      } else if (units.value) {
        const dup = r.skipped ? [] : others(caseIdx.get(caseCode), r.rowNumber);
        const owner = pkOwner.get(caseCode);
        const asSku = skuByCode.get(caseCode) ?? (skuIdx.has(caseCode) ? { skuCode: caseCode } : null);
        if (dup.length) err('caseCode', `La caja ${caseCode} también aparece en ${rowsText(dup)}.`);
        else if (asSku) err('caseCode', `El código de caja ${caseCode} es el SKU maestro ${asSku.skuCode}.`);
        else if (owner && owner.masterSkuId !== existing?.id) err('caseCode', `La caja ${caseCode} ya pertenece al SKU ${owner.skuCode}.`);
        else if (owner && owner.units !== units.value) {
          pkg = { code: caseCode, units: units.value, mode: 'actualizar' };
          info('caseUnits', `Se actualizan las piezas de la caja ${caseCode} de ${owner.units} a ${units.value}.`);
        } else if (!owner) {
          pkg = { code: caseCode, units: units.value, mode: 'crear' };
          if (!caseCode.startsWith(sku)) warn('caseCode', `La caja ${caseCode} no empieza con el SKU ${sku}; verifica que corresponda a este producto.`);
        }
      }

      const plan: SkuPlan = {
        skuCode: sku,
        existingSkuId: existing?.id ?? null,
        name,
        nameChange,
        product,
        basePrice: price.value,
        priceChange,
        cost: cost.value,
        costChange,
        barcode,
        listings,
        package: pkg,
      };
      const changed = nameChange || priceChange || costChange || barcode || listings.length || pkg;
      const action = !existing ? 'CREAR' : changed ? 'ACTUALIZAR' : 'SIN_CAMBIOS';
      return { rowNumber: r.rowNumber, messages, action, plan };
    });
  },

  async apply(tx: Tx, rows, ctx) {
    const { actor, audit, batchLabel } = ctx;
    const counts = {
      skusCreados: 0,
      skusActualizados: 0,
      productosCreados: 0,
      marcasCreadas: 0,
      categoriasCreadas: 0,
      codigosBarras: 0,
      publicaciones: 0,
      cajas: 0,
    };

    const chRows = await tx.select({ id: channels.id, code: channels.code }).from(channels);
    const chId = new Map(chRows.map((c) => [c.code, c.id]));
    const whRows = await tx.select({ id: warehouses.id, code: warehouses.code }).from(warehouses);
    const whId = new Map(whRows.map((w) => [w.code, w.id]));

    const brandCache = new Map<string, string>();
    async function ensureBrand(name: string): Promise<string> {
      const key = name.toLowerCase();
      if (brandCache.has(key)) return brandCache.get(key)!;
      const [found] = await tx.select({ id: brands.id }).from(brands).where(sql`lower(${brands.name}) = ${key}`);
      let id = found?.id;
      if (!id) {
        [{ id }] = await tx.insert(brands).values({ name }).returning({ id: brands.id });
        counts.marcasCreadas++;
      }
      brandCache.set(key, id);
      return id;
    }

    const catCache = new Map<string, string>();
    async function ensureCategory(path: string): Promise<string> {
      let parent: string | null = null;
      let acc = '';
      for (const part of path.split('/').map((p) => p.trim()).filter(Boolean)) {
        acc = `${acc}/${part.toLowerCase()}`;
        const cached = catCache.get(acc);
        if (cached) {
          parent = cached;
          continue;
        }
        const parentId: string | null = parent;
        const [found] = await tx
          .select({ id: categories.id })
          .from(categories)
          .where(and(sql`lower(${categories.name}) = ${part.toLowerCase()}`, parentId ? eq(categories.parentId, parentId) : isNull(categories.parentId)));
        let id = found?.id;
        if (!id) {
          [{ id }] = await tx.insert(categories).values({ name: part, parentId }).returning({ id: categories.id });
          counts.categoriasCreadas++;
        }
        catCache.set(acc, id);
        parent = id;
      }
      return parent!;
    }

    const productCache = new Map<string, string>();
    async function ensureProduct(p: NonNullable<SkuPlan['product']>): Promise<string> {
      const key = p.name.toLowerCase();
      if (productCache.has(key)) return productCache.get(key)!;
      const [found] = await tx.select({ id: products.id }).from(products).where(sql`lower(${products.name}) = ${key}`).limit(1);
      let id = found?.id;
      if (!id) {
        const brandId = p.brand ? await ensureBrand(p.brand) : null;
        const categoryId = p.category ? await ensureCategory(p.category) : null;
        [{ id }] = await tx
          .insert(products)
          .values({ name: p.name, brandId, categoryId, createdById: actor.id, updatedById: actor.id })
          .returning({ id: products.id });
        counts.productosCreados++;
      }
      productCache.set(key, id);
      return id;
    }

    for (const { plan } of rows) {
      let skuId = plan.existingSkuId;
      const done: string[] = [];
      if (!skuId) {
        const productId = await ensureProduct(plan.product!);
        [{ id: skuId }] = await tx
          .insert(masterSkus)
          .values({
            skuCode: plan.skuCode,
            productId,
            name: plan.name,
            basePrice: plan.basePrice,
            currentCost: plan.cost,
            status: 'ACTIVO',
            createdById: actor.id,
            updatedById: actor.id,
          })
          .returning({ id: masterSkus.id });
        counts.skusCreados++;
        if (plan.basePrice) await tx.insert(priceHistory).values({ masterSkuId: skuId, price: plan.basePrice, source: 'IMPORTACION', changedById: actor.id });
        if (plan.cost) await tx.insert(costHistory).values({ masterSkuId: skuId, cost: plan.cost, sourceType: 'IMPORTACION', changedById: actor.id });
      } else {
        const patch: Partial<typeof masterSkus.$inferInsert> = {};
        if (plan.nameChange) { patch.name = plan.nameChange.to; done.push(`nombre: ${plan.nameChange.from} → ${plan.nameChange.to}`); }
        if (plan.priceChange) { patch.basePrice = plan.basePrice; done.push(`precio ${plan.basePrice}`); }
        if (plan.costChange) { patch.currentCost = plan.cost; done.push(`costo ${plan.cost}`); }
        if (Object.keys(patch).length) await tx.update(masterSkus).set({ ...patch, updatedById: actor.id }).where(eq(masterSkus.id, skuId));
        if (plan.priceChange) await tx.insert(priceHistory).values({ masterSkuId: skuId, price: plan.basePrice!, source: 'IMPORTACION', changedById: actor.id });
        if (plan.costChange) await tx.insert(costHistory).values({ masterSkuId: skuId, cost: plan.cost!, sourceType: 'IMPORTACION', changedById: actor.id });
        counts.skusActualizados++;
      }

      if (plan.barcode) {
        await tx.insert(skuBarcodes).values({ masterSkuId: skuId, barcode: plan.barcode.code, type: plan.barcode.type, isPrimary: plan.barcode.primary });
        counts.codigosBarras++;
        done.push(`código ${plan.barcode.code}`);
      }
      for (const l of plan.listings) {
        const channelId = chId.get(l.channel)!;
        const [created] = await tx
          .insert(channelListings)
          .values({
            channelId,
            masterSkuId: skuId,
            externalId: l.externalId,
            externalSku: l.externalSku,
            fnsku: l.fnsku,
            fulfillmentModel: l.model,
            fulfillmentWarehouseId: whId.get(l.warehouse)!,
          })
          .returning({ id: channelListings.id });
        await tx
          .update(unmappedCodes)
          .set({ status: 'MAPEADO', resolvedListingId: created.id })
          .where(and(eq(unmappedCodes.channelId, channelId), eq(unmappedCodes.externalId, l.externalId), eq(unmappedCodes.externalSku, l.externalSku)));
        counts.publicaciones++;
        done.push(l.label);
      }
      if (plan.package) {
        if (plan.package.mode === 'crear') {
          await tx.insert(skuPackages).values({ masterSkuId: skuId, code: plan.package.code, type: 'CAJA_MASTER', unitsPerPackage: plan.package.units });
        } else {
          await tx
            .update(skuPackages)
            .set({ unitsPerPackage: plan.package.units })
            .where(sql`upper(${skuPackages.code}) = ${plan.package.code.toUpperCase()}`);
        }
        counts.cajas++;
        done.push(`caja ${plan.package.code} × ${plan.package.units}`);
      }

      await audit.log(tx, actor, {
        action: 'IMPORTAR',
        module: 'productos',
        entity: 'master_skus',
        entityId: skuId,
        summary: `${plan.existingSkuId ? 'Actualizó' : 'Creó'} el SKU ${plan.skuCode} por importación (${batchLabel})`,
        newValues: { cambios: plan.existingSkuId ? done : [`alta ${plan.name}`, ...done] },
      });
    }
    return counts;
  },
};
