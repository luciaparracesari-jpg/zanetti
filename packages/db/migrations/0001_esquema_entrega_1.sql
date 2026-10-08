CREATE TYPE "public"."barcode_type" AS ENUM('EAN13', 'UPC', 'CODE128', 'INTERNO');--> statement-breakpoint
CREATE TYPE "public"."channel_status" AS ENUM('ACTIVO', 'PAUSADO', 'INACTIVO');--> statement-breakpoint
CREATE TYPE "public"."channel_type" AS ENUM('MARKETPLACE', 'TIENDA_PROPIA', 'DIRECTO');--> statement-breakpoint
CREATE TYPE "public"."cost_method" AS ENUM('FIFO', 'PROMEDIO');--> statement-breakpoint
CREATE TYPE "public"."fee_base" AS ENUM('VENTA_CON_IVA', 'VENTA_NETA', 'DESPUES_DESCUENTO');--> statement-breakpoint
CREATE TYPE "public"."fee_type" AS ENUM('COMISION', 'ENVIO', 'ALMACENAJE', 'OTRO');--> statement-breakpoint
CREATE TYPE "public"."fulfillment_model" AS ENUM('BODEGA_PROPIA', 'FULFILLMENT_CANAL');--> statement-breakpoint
CREATE TYPE "public"."listing_status" AS ENUM('ACTIVA', 'PAUSADA', 'INACTIVA');--> statement-breakpoint
CREATE TYPE "public"."location_type" AS ENUM('RECEPCION', 'ALMACENAJE', 'PICKING', 'CUARENTENA', 'EMBARQUE', 'MERMA');--> statement-breakpoint
CREATE TYPE "public"."record_status" AS ENUM('ACTIVO', 'INACTIVO');--> statement-breakpoint
CREATE TYPE "public"."sku_status" AS ENUM('BORRADOR', 'ACTIVO', 'DESCONTINUADO', 'INACTIVO');--> statement-breakpoint
CREATE TYPE "public"."unmapped_status" AS ENUM('PENDIENTE', 'MAPEADO', 'IGNORADO');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('ACTIVO', 'BLOQUEADO', 'INACTIVO');--> statement-breakpoint
CREATE TYPE "public"."warehouse_type" AS ENUM('PROPIO', 'OPERADOR_LOGISTICO', 'FULFILLMENT_CANAL', 'CONSIGNACION');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"user_email" text,
	"action" text NOT NULL,
	"module" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"summary" text,
	"old_values" jsonb,
	"new_values" jsonb,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"module" text NOT NULL,
	"action" text NOT NULL,
	CONSTRAINT "permissions_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip" text,
	"user_agent" text,
	CONSTRAINT "sessions_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "user_warehouses" (
	"user_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	CONSTRAINT "user_warehouses_user_id_warehouse_id_pk" PRIMARY KEY("user_id","warehouse_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"status" "user_status" DEFAULT 'ACTIVO' NOT NULL,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"legal_name" text NOT NULL,
	"trade_name" text,
	"rfc" text,
	"timezone" text DEFAULT 'America/Mexico_City' NOT NULL,
	"base_currency" text DEFAULT 'MXN' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_settings_singleton_ck" CHECK (id = 1)
);
--> statement-breakpoint
CREATE TABLE "currencies" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"symbol" text NOT NULL,
	"decimals" integer DEFAULT 2 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exchange_rates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"currency_code" text NOT NULL,
	"rate" numeric(14, 6) NOT NULL,
	"source" text DEFAULT 'DOF' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_filters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"table_key" text NOT NULL,
	"name" text NOT NULL,
	"filter" jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_parameters" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"description" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "tax_rates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"rate" numeric(7, 4) NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date
);
--> statement-breakpoint
CREATE TABLE "attribute_values" (
	"id" uuid PRIMARY KEY NOT NULL,
	"attribute_id" uuid NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attributes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "attributes_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "brands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" "record_status" DEFAULT 'ACTIVO' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"status" "record_status" DEFAULT 'ACTIVO' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_history" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "cost_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"master_sku_id" uuid NOT NULL,
	"cost" numeric(14, 4) NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text,
	"changed_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "kit_components" (
	"kit_sku_id" uuid NOT NULL,
	"component_sku_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "kit_components_kit_sku_id_component_sku_id_pk" PRIMARY KEY("kit_sku_id","component_sku_id"),
	CONSTRAINT "kit_components_qty_ck" CHECK (quantity > 0),
	CONSTRAINT "kit_components_self_ck" CHECK (kit_sku_id <> component_sku_id)
);
--> statement-breakpoint
CREATE TABLE "master_skus" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sku_code" text NOT NULL,
	"product_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_kit" boolean DEFAULT false NOT NULL,
	"weight_g" integer,
	"length_mm" integer,
	"width_mm" integer,
	"height_mm" integer,
	"base_price" numeric(14, 2),
	"cost_method" "cost_method" DEFAULT 'FIFO' NOT NULL,
	"current_cost" numeric(14, 4),
	"avg_cost" numeric(14, 4),
	"preferred_supplier_id" uuid,
	"lead_time_days" integer,
	"safety_days" integer,
	"min_qty" integer,
	"max_qty" integer,
	"status" "sku_status" DEFAULT 'ACTIVO' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	"updated_by_id" uuid,
	CONSTRAINT "master_skus_dims_ck" CHECK (coalesce(weight_g, 0) >= 0 AND coalesce(length_mm, 0) >= 0 AND coalesce(width_mm, 0) >= 0 AND coalesce(height_mm, 0) >= 0),
	CONSTRAINT "master_skus_minmax_ck" CHECK (min_qty IS NULL OR max_qty IS NULL OR min_qty <= max_qty)
);
--> statement-breakpoint
CREATE TABLE "price_history" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "price_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"master_sku_id" uuid NOT NULL,
	"channel_id" uuid,
	"price" numeric(14, 2) NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"changed_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "product_images" (
	"id" uuid PRIMARY KEY NOT NULL,
	"master_sku_id" uuid NOT NULL,
	"url" text NOT NULL,
	"alt" text,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"brand_id" uuid,
	"category_id" uuid,
	"status" "record_status" DEFAULT 'ACTIVO' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	"updated_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "sku_attribute_values" (
	"master_sku_id" uuid NOT NULL,
	"attribute_id" uuid NOT NULL,
	"attribute_value_id" uuid NOT NULL,
	CONSTRAINT "sku_attribute_values_master_sku_id_attribute_id_pk" PRIMARY KEY("master_sku_id","attribute_id")
);
--> statement-breakpoint
CREATE TABLE "sku_barcodes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"master_sku_id" uuid NOT NULL,
	"barcode" text NOT NULL,
	"type" "barcode_type" DEFAULT 'EAN13' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sku_barcodes_barcode_unique" UNIQUE("barcode")
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text,
	"name" text NOT NULL,
	"legal_name" text,
	"tax_id" text,
	"country" text DEFAULT 'MX' NOT NULL,
	"currency_code" text DEFAULT 'MXN' NOT NULL,
	"payment_terms" text,
	"lead_time_days" integer,
	"moq" integer,
	"contact_name" text,
	"email" text,
	"phone" text,
	"rating" integer,
	"status" "record_status" DEFAULT 'ACTIVO' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "channel_listings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"master_sku_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"external_sku" text DEFAULT '' NOT NULL,
	"fnsku" text,
	"units_per_listing" integer DEFAULT 1 NOT NULL,
	"title" text,
	"price" numeric(14, 2),
	"fulfillment_model" "fulfillment_model" DEFAULT 'BODEGA_PROPIA' NOT NULL,
	"fulfillment_warehouse_id" uuid,
	"status" "listing_status" DEFAULT 'ACTIVA' NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_listings_units_ck" CHECK (units_per_listing > 0),
	CONSTRAINT "channel_listings_valid_ck" CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" "channel_type" NOT NULL,
	"status" "channel_status" DEFAULT 'ACTIVO' NOT NULL,
	"coverage_days" integer,
	"settings" jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channels_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "fee_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"category_id" uuid,
	"master_sku_id" uuid,
	"name" text NOT NULL,
	"fee_type" "fee_type" DEFAULT 'COMISION' NOT NULL,
	"rate" numeric(7, 4),
	"fixed_amount" numeric(14, 2),
	"base" "fee_base" DEFAULT 'VENTA_CON_IVA' NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_rules_amount_ck" CHECK (rate IS NOT NULL OR fixed_amount IS NOT NULL),
	CONSTRAINT "fee_rules_valid_ck" CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
--> statement-breakpoint
CREATE TABLE "unmapped_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"external_sku" text DEFAULT '' NOT NULL,
	"title" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"status" "unmapped_status" DEFAULT 'PENDIENTE' NOT NULL,
	"resolved_listing_id" uuid
);
--> statement-breakpoint
CREATE TABLE "warehouse_locations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text,
	"type" "location_type" DEFAULT 'ALMACENAJE' NOT NULL,
	"status" "record_status" DEFAULT 'ACTIVO' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" "warehouse_type" NOT NULL,
	"channel_id" uuid,
	"address" text,
	"city" text,
	"state" text,
	"zip" text,
	"allow_negative" boolean DEFAULT false NOT NULL,
	"status" "record_status" DEFAULT 'ACTIVO' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "warehouses_code_unique" UNIQUE("code"),
	CONSTRAINT "warehouses_channel_ck" CHECK (type NOT IN ('FULFILLMENT_CANAL', 'CONSIGNACION') OR channel_id IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_warehouses" ADD CONSTRAINT "user_warehouses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_warehouses" ADD CONSTRAINT "user_warehouses_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_currency_code_currencies_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_filters" ADD CONSTRAINT "saved_filters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribute_values" ADD CONSTRAINT "attribute_values_attribute_id_attributes_id_fk" FOREIGN KEY ("attribute_id") REFERENCES "public"."attributes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_history" ADD CONSTRAINT "cost_history_master_sku_id_master_skus_id_fk" FOREIGN KEY ("master_sku_id") REFERENCES "public"."master_skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kit_components" ADD CONSTRAINT "kit_components_kit_sku_id_master_skus_id_fk" FOREIGN KEY ("kit_sku_id") REFERENCES "public"."master_skus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kit_components" ADD CONSTRAINT "kit_components_component_sku_id_master_skus_id_fk" FOREIGN KEY ("component_sku_id") REFERENCES "public"."master_skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_skus" ADD CONSTRAINT "master_skus_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_skus" ADD CONSTRAINT "master_skus_preferred_supplier_id_suppliers_id_fk" FOREIGN KEY ("preferred_supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_master_sku_id_master_skus_id_fk" FOREIGN KEY ("master_sku_id") REFERENCES "public"."master_skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_master_sku_id_master_skus_id_fk" FOREIGN KEY ("master_sku_id") REFERENCES "public"."master_skus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_attribute_values" ADD CONSTRAINT "sku_attribute_values_master_sku_id_master_skus_id_fk" FOREIGN KEY ("master_sku_id") REFERENCES "public"."master_skus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_attribute_values" ADD CONSTRAINT "sku_attribute_values_attribute_id_attributes_id_fk" FOREIGN KEY ("attribute_id") REFERENCES "public"."attributes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_attribute_values" ADD CONSTRAINT "sku_attribute_values_attribute_value_id_attribute_values_id_fk" FOREIGN KEY ("attribute_value_id") REFERENCES "public"."attribute_values"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_barcodes" ADD CONSTRAINT "sku_barcodes_master_sku_id_master_skus_id_fk" FOREIGN KEY ("master_sku_id") REFERENCES "public"."master_skus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_listings" ADD CONSTRAINT "channel_listings_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_listings" ADD CONSTRAINT "channel_listings_master_sku_id_master_skus_id_fk" FOREIGN KEY ("master_sku_id") REFERENCES "public"."master_skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_listings" ADD CONSTRAINT "channel_listings_fulfillment_warehouse_id_warehouses_id_fk" FOREIGN KEY ("fulfillment_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_rules" ADD CONSTRAINT "fee_rules_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_rules" ADD CONSTRAINT "fee_rules_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_rules" ADD CONSTRAINT "fee_rules_master_sku_id_master_skus_id_fk" FOREIGN KEY ("master_sku_id") REFERENCES "public"."master_skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unmapped_codes" ADD CONSTRAINT "unmapped_codes_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unmapped_codes" ADD CONSTRAINT "unmapped_codes_resolved_listing_id_channel_listings_id_fk" FOREIGN KEY ("resolved_listing_id") REFERENCES "public"."channel_listings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_locations" ADD CONSTRAINT "warehouse_locations_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_occurred_idx" ON "audit_logs" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "audit_logs_user_idx" ON "audit_logs" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "permissions_module_action_uq" ON "permissions" USING btree ("module","action");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree (lower(email));--> statement-breakpoint
CREATE UNIQUE INDEX "exchange_rates_uq" ON "exchange_rates" USING btree ("date","currency_code","source");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_filters_uq" ON "saved_filters" USING btree ("user_id","table_key","name");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_rates_code_from_uq" ON "tax_rates" USING btree ("code","valid_from");--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_values_uq" ON "attribute_values" USING btree ("attribute_id","value");--> statement-breakpoint
CREATE UNIQUE INDEX "brands_name_uq" ON "brands" USING btree (lower(name));--> statement-breakpoint
CREATE UNIQUE INDEX "categories_child_name_uq" ON "categories" USING btree ("parent_id",lower(name)) WHERE parent_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_root_name_uq" ON "categories" USING btree (lower(name)) WHERE parent_id IS NULL;--> statement-breakpoint
CREATE INDEX "cost_history_sku_idx" ON "cost_history" USING btree ("master_sku_id","valid_from");--> statement-breakpoint
CREATE UNIQUE INDEX "master_skus_code_uq" ON "master_skus" USING btree (upper(sku_code));--> statement-breakpoint
CREATE INDEX "master_skus_product_idx" ON "master_skus" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "master_skus_status_idx" ON "master_skus" USING btree ("status");--> statement-breakpoint
CREATE INDEX "master_skus_code_trgm" ON "master_skus" USING gin (sku_code gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "master_skus_name_trgm" ON "master_skus" USING gin (name gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "price_history_sku_idx" ON "price_history" USING btree ("master_sku_id","valid_from");--> statement-breakpoint
CREATE INDEX "product_images_sku_idx" ON "product_images" USING btree ("master_sku_id","position");--> statement-breakpoint
CREATE INDEX "products_brand_idx" ON "products" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "products_category_idx" ON "products" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "products_name_trgm" ON "products" USING gin (name gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "sku_barcodes_sku_idx" ON "sku_barcodes" USING btree ("master_sku_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sku_barcodes_primary_uq" ON "sku_barcodes" USING btree ("master_sku_id") WHERE is_primary;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_listings_active_uq" ON "channel_listings" USING btree ("channel_id","external_id","external_sku") WHERE valid_to IS NULL;--> statement-breakpoint
CREATE INDEX "channel_listings_sku_idx" ON "channel_listings" USING btree ("master_sku_id");--> statement-breakpoint
CREATE INDEX "channel_listings_ext_trgm" ON "channel_listings" USING gin (external_id gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "channel_listings_extsku_trgm" ON "channel_listings" USING gin (external_sku gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "fee_rules_channel_idx" ON "fee_rules" USING btree ("channel_id","valid_from");--> statement-breakpoint
CREATE UNIQUE INDEX "unmapped_codes_uq" ON "unmapped_codes" USING btree ("channel_id","external_id","external_sku");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouse_locations_code_uq" ON "warehouse_locations" USING btree ("warehouse_id",upper(code));