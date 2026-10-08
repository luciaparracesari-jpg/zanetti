import { relations } from 'drizzle-orm';
import {
  attributeValues,
  attributes,
  brands,
  categories,
  costHistory,
  kitComponents,
  masterSkus,
  priceHistory,
  productImages,
  products,
  skuAttributeValues,
  skuBarcodes,
  suppliers,
} from './catalog';
import {
  channelListings,
  channels,
  feeRules,
  unmappedCodes,
  warehouseLocations,
  warehouses,
} from './channels';
import {
  permissions,
  rolePermissions,
  roles,
  sessions,
  userRoles,
  userWarehouses,
  users,
} from './security';

export const usersRelations = relations(users, ({ many }) => ({
  roles: many(userRoles),
  sessions: many(sessions),
  warehouses: many(userWarehouses),
}));

export const rolesRelations = relations(roles, ({ many }) => ({
  permissions: many(rolePermissions),
  users: many(userRoles),
}));

export const permissionsRelations = relations(permissions, ({ many }) => ({
  roles: many(rolePermissions),
}));

export const rolePermissionsRelations = relations(rolePermissions, ({ one }) => ({
  role: one(roles, { fields: [rolePermissions.roleId], references: [roles.id] }),
  permission: one(permissions, {
    fields: [rolePermissions.permissionId],
    references: [permissions.id],
  }),
}));

export const userRolesRelations = relations(userRoles, ({ one }) => ({
  user: one(users, { fields: [userRoles.userId], references: [users.id] }),
  role: one(roles, { fields: [userRoles.roleId], references: [roles.id] }),
}));

export const userWarehousesRelations = relations(userWarehouses, ({ one }) => ({
  user: one(users, { fields: [userWarehouses.userId], references: [users.id] }),
  warehouse: one(warehouses, {
    fields: [userWarehouses.warehouseId],
    references: [warehouses.id],
  }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const brandsRelations = relations(brands, ({ many }) => ({
  products: many(products),
}));

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  parent: one(categories, {
    fields: [categories.parentId],
    references: [categories.id],
    relationName: 'categoryTree',
  }),
  children: many(categories, { relationName: 'categoryTree' }),
  products: many(products),
}));

export const attributesRelations = relations(attributes, ({ many }) => ({
  values: many(attributeValues),
}));

export const attributeValuesRelations = relations(attributeValues, ({ one }) => ({
  attribute: one(attributes, {
    fields: [attributeValues.attributeId],
    references: [attributes.id],
  }),
}));

export const productsRelations = relations(products, ({ one, many }) => ({
  brand: one(brands, { fields: [products.brandId], references: [brands.id] }),
  category: one(categories, { fields: [products.categoryId], references: [categories.id] }),
  skus: many(masterSkus),
}));

export const suppliersRelations = relations(suppliers, ({ many }) => ({
  skus: many(masterSkus),
}));

export const masterSkusRelations = relations(masterSkus, ({ one, many }) => ({
  product: one(products, { fields: [masterSkus.productId], references: [products.id] }),
  preferredSupplier: one(suppliers, {
    fields: [masterSkus.preferredSupplierId],
    references: [suppliers.id],
  }),
  barcodes: many(skuBarcodes),
  components: many(kitComponents, { relationName: 'kitParent' }),
  usedInKits: many(kitComponents, { relationName: 'kitComponent' }),
  listings: many(channelListings),
  attributes: many(skuAttributeValues),
  images: many(productImages),
  priceHistory: many(priceHistory),
  costHistory: many(costHistory),
}));

export const skuAttributeValuesRelations = relations(skuAttributeValues, ({ one }) => ({
  masterSku: one(masterSkus, {
    fields: [skuAttributeValues.masterSkuId],
    references: [masterSkus.id],
  }),
  attribute: one(attributes, {
    fields: [skuAttributeValues.attributeId],
    references: [attributes.id],
  }),
  attributeValue: one(attributeValues, {
    fields: [skuAttributeValues.attributeValueId],
    references: [attributeValues.id],
  }),
}));

export const skuBarcodesRelations = relations(skuBarcodes, ({ one }) => ({
  masterSku: one(masterSkus, { fields: [skuBarcodes.masterSkuId], references: [masterSkus.id] }),
}));

export const kitComponentsRelations = relations(kitComponents, ({ one }) => ({
  kit: one(masterSkus, {
    fields: [kitComponents.kitSkuId],
    references: [masterSkus.id],
    relationName: 'kitParent',
  }),
  component: one(masterSkus, {
    fields: [kitComponents.componentSkuId],
    references: [masterSkus.id],
    relationName: 'kitComponent',
  }),
}));

export const productImagesRelations = relations(productImages, ({ one }) => ({
  masterSku: one(masterSkus, { fields: [productImages.masterSkuId], references: [masterSkus.id] }),
}));

export const priceHistoryRelations = relations(priceHistory, ({ one }) => ({
  masterSku: one(masterSkus, { fields: [priceHistory.masterSkuId], references: [masterSkus.id] }),
  channel: one(channels, { fields: [priceHistory.channelId], references: [channels.id] }),
}));

export const costHistoryRelations = relations(costHistory, ({ one }) => ({
  masterSku: one(masterSkus, { fields: [costHistory.masterSkuId], references: [masterSkus.id] }),
}));

export const channelsRelations = relations(channels, ({ many }) => ({
  listings: many(channelListings),
  feeRules: many(feeRules),
  warehouses: many(warehouses),
  unmapped: many(unmappedCodes),
}));

export const warehousesRelations = relations(warehouses, ({ one, many }) => ({
  channel: one(channels, { fields: [warehouses.channelId], references: [channels.id] }),
  locations: many(warehouseLocations),
  users: many(userWarehouses),
}));

export const warehouseLocationsRelations = relations(warehouseLocations, ({ one }) => ({
  warehouse: one(warehouses, {
    fields: [warehouseLocations.warehouseId],
    references: [warehouses.id],
  }),
}));

export const channelListingsRelations = relations(channelListings, ({ one }) => ({
  channel: one(channels, { fields: [channelListings.channelId], references: [channels.id] }),
  masterSku: one(masterSkus, {
    fields: [channelListings.masterSkuId],
    references: [masterSkus.id],
  }),
  fulfillmentWarehouse: one(warehouses, {
    fields: [channelListings.fulfillmentWarehouseId],
    references: [warehouses.id],
  }),
}));

export const feeRulesRelations = relations(feeRules, ({ one }) => ({
  channel: one(channels, { fields: [feeRules.channelId], references: [channels.id] }),
  category: one(categories, { fields: [feeRules.categoryId], references: [categories.id] }),
  masterSku: one(masterSkus, { fields: [feeRules.masterSkuId], references: [masterSkus.id] }),
}));

export const unmappedCodesRelations = relations(unmappedCodes, ({ one }) => ({
  channel: one(channels, { fields: [unmappedCodes.channelId], references: [channels.id] }),
  resolvedListing: one(channelListings, {
    fields: [unmappedCodes.resolvedListingId],
    references: [channelListings.id],
  }),
}));
