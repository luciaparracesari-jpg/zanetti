CREATE TYPE "public"."container_status" AS ENUM('PLANEADO', 'EN_PRODUCCION', 'EN_NAVIERA', 'EN_ADUANA', 'RECIBIDO', 'PERDIDO', 'CANCELADO');--> statement-breakpoint
CREATE TYPE "public"."sale_line_kind" AS ENUM('VENTA', 'DEVOLUCION');--> statement-breakpoint
CREATE TYPE "public"."sale_source" AS ENUM('IMPORTACION', 'API');--> statement-breakpoint
CREATE TABLE "import_container_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"container_id" uuid NOT NULL,
	"master_sku_id" uuid NOT NULL,
	"supplier_id" uuid,
	"qty" integer NOT NULL,
	"order_date" date NOT NULL,
	"unit_cost" numeric(14, 4),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_container_lines_qty_ck" CHECK (qty > 0)
);
--> statement-breakpoint
CREATE TABLE "import_containers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"status" "container_status" DEFAULT 'EN_PRODUCCION' NOT NULL,
	"etd" date,
	"eta_override" date,
	"capacity_cbm" numeric(8, 2),
	"received_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	"updated_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "sales_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"sale_date" date NOT NULL,
	"master_sku_id" uuid,
	"listing_id" uuid,
	"external_code" text NOT NULL,
	"external_sku" text,
	"order_ref" text,
	"qty" integer NOT NULL,
	"kind" "sale_line_kind" NOT NULL,
	"amount" numeric(14, 2),
	"source" "sale_source" DEFAULT 'IMPORTACION' NOT NULL,
	"source_key" text NOT NULL,
	"import_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_lines_qty_ck" CHECK (qty <> 0)
);
--> statement-breakpoint
CREATE TABLE "sku_aliases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"master_sku_id" uuid NOT NULL,
	"multiplier" integer DEFAULT 1 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	CONSTRAINT "sku_aliases_multiplier_ck" CHECK (multiplier > 0)
);
--> statement-breakpoint
ALTER TABLE "sku_packages" ADD COLUMN "length_mm" integer;--> statement-breakpoint
ALTER TABLE "sku_packages" ADD COLUMN "width_mm" integer;--> statement-breakpoint
ALTER TABLE "sku_packages" ADD COLUMN "height_mm" integer;--> statement-breakpoint
ALTER TABLE "sku_packages" ADD COLUMN "gross_weight_g" integer;--> statement-breakpoint
ALTER TABLE "import_container_lines" ADD CONSTRAINT "import_container_lines_container_id_import_containers_id_fk" FOREIGN KEY ("container_id") REFERENCES "public"."import_containers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_container_lines" ADD CONSTRAINT "import_container_lines_master_sku_id_master_skus_id_fk" FOREIGN KEY ("master_sku_id") REFERENCES "public"."master_skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_container_lines" ADD CONSTRAINT "import_container_lines_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_lines" ADD CONSTRAINT "sales_lines_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_lines" ADD CONSTRAINT "sales_lines_master_sku_id_master_skus_id_fk" FOREIGN KEY ("master_sku_id") REFERENCES "public"."master_skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_lines" ADD CONSTRAINT "sales_lines_listing_id_channel_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."channel_listings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_lines" ADD CONSTRAINT "sales_lines_import_batch_id_data_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."data_import_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_aliases" ADD CONSTRAINT "sku_aliases_master_sku_id_master_skus_id_fk" FOREIGN KEY ("master_sku_id") REFERENCES "public"."master_skus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_container_lines_container_idx" ON "import_container_lines" USING btree ("container_id");--> statement-breakpoint
CREATE INDEX "import_container_lines_sku_idx" ON "import_container_lines" USING btree ("master_sku_id");--> statement-breakpoint
CREATE UNIQUE INDEX "import_containers_code_uq" ON "import_containers" USING btree (upper(code));--> statement-breakpoint
CREATE UNIQUE INDEX "sales_lines_source_key_uq" ON "sales_lines" USING btree ("source_key");--> statement-breakpoint
CREATE INDEX "sales_lines_sku_date_idx" ON "sales_lines" USING btree ("master_sku_id","sale_date");--> statement-breakpoint
CREATE INDEX "sales_lines_channel_date_idx" ON "sales_lines" USING btree ("channel_id","sale_date");--> statement-breakpoint
CREATE INDEX "sales_lines_code_idx" ON "sales_lines" USING btree ("channel_id","external_code");--> statement-breakpoint
CREATE UNIQUE INDEX "sku_aliases_uq" ON "sku_aliases" USING btree (upper(code),"master_sku_id");--> statement-breakpoint
DELETE FROM "system_parameters" WHERE "key" = 'reabasto.ventana_demanda_dias';--> statement-breakpoint
INSERT INTO "system_parameters" ("key", "value", "description") VALUES ('reabasto.parametros', '{"mesesHistoria": 3, "pctQuiebre": 0.3, "factorFba": 1, "factorFbl": 1, "factorAplin": 1, "almexDias": 33, "dhlDias": 17, "colchonFba": 7, "envioFblDias": 10, "colchonFbl": 5, "reservaAplinDias": 30, "redondearCajas": true, "navieraDias": 40, "aduanaDias": 15, "cicloDias": 45, "seguridadDias": 21, "capacidadCbm": 68, "fechaProximoPedido": null, "origenAlmacen": {"AMZ-FBA": "AMZ-FBA", "AMZ-MFN": "AMZ-FBA", "LIVERPOOL": "LIV-FBL", "SHOPIFY": "APLIN"}}'::jsonb, 'Parámetros del cálculo de reabasto (venta base, envíos a FBA y Liverpool, contenedores). Se editan en Reabasto → Parámetros.') ON CONFLICT ("key") DO NOTHING;
