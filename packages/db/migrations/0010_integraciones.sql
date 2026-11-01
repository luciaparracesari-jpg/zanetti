CREATE TYPE "public"."channel_order_kind" AS ENUM('ENVIO_FBA', 'ENVIO_FBL', 'LIVERPOOL_VENDOR', 'SHOPIFY_ZANETTI', 'SHOPIFY_LEANTRAVEL', 'OTRO');--> statement-breakpoint
CREATE TYPE "public"."integration_provider" AS ENUM('APLIN', 'SHOPIFY', 'AMAZON_SP_API', 'MERCADO_LIBRE', 'LIVERPOOL');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('ACTIVA', 'PAUSADA');--> statement-breakpoint
CREATE TYPE "public"."sync_run_status" AS ENUM('EN_CURSO', 'OK', 'ERROR');--> statement-breakpoint
CREATE TABLE "channel_catalog_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"external_sku" text NOT NULL,
	"name" text,
	"barcode" text,
	"pieces_per_box" integer,
	"master_sku_id" uuid,
	"matched_by" text,
	"on_hand" integer,
	"available" integer,
	"committed" integer,
	"booked" integer,
	"unavailable" integer,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_order_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"external_line_id" text NOT NULL,
	"external_sku" text NOT NULL,
	"master_sku_id" uuid,
	"quantity" integer NOT NULL,
	"booked_quantity" integer,
	"packed_quantity" integer,
	"price" numeric(14, 2)
);
--> statement-breakpoint
CREATE TABLE "channel_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"order_number" text NOT NULL,
	"kind" "channel_order_kind" NOT NULL,
	"type" text,
	"status" text,
	"substatus" text,
	"source" text,
	"stock_ok" boolean,
	"pieces" integer DEFAULT 0 NOT NULL,
	"total" numeric(14, 2),
	"external_created_at" timestamp with time zone,
	"external_updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"credentials_ref" text NOT NULL,
	"warehouse_id" uuid,
	"channel_id" uuid,
	"status" "integration_status" DEFAULT 'ACTIVA' NOT NULL,
	"settings" jsonb,
	"last_sync_at" timestamp with time zone,
	"last_sync_ok" boolean,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	"updated_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "integration_sync_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"status" "sync_run_status" DEFAULT 'EN_CURSO' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"stats" jsonb,
	"error" text,
	"triggered_by_id" uuid
);
--> statement-breakpoint
ALTER TABLE "channel_catalog_items" ADD CONSTRAINT "channel_catalog_items_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_catalog_items" ADD CONSTRAINT "channel_catalog_items_master_sku_id_master_skus_id_fk" FOREIGN KEY ("master_sku_id") REFERENCES "public"."master_skus"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_order_lines" ADD CONSTRAINT "channel_order_lines_order_id_channel_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."channel_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_order_lines" ADD CONSTRAINT "channel_order_lines_master_sku_id_master_skus_id_fk" FOREIGN KEY ("master_sku_id") REFERENCES "public"."master_skus"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_orders" ADD CONSTRAINT "channel_orders_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_sync_runs" ADD CONSTRAINT "integration_sync_runs_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_catalog_items_uq" ON "channel_catalog_items" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE INDEX "channel_catalog_items_sku_idx" ON "channel_catalog_items" USING btree ("master_sku_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_order_lines_uq" ON "channel_order_lines" USING btree ("order_id","external_line_id");--> statement-breakpoint
CREATE INDEX "channel_order_lines_sku_idx" ON "channel_order_lines" USING btree ("master_sku_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_orders_uq" ON "channel_orders" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE INDEX "channel_orders_number_idx" ON "channel_orders" USING btree ("connection_id","order_number");--> statement-breakpoint
CREATE INDEX "channel_orders_kind_idx" ON "channel_orders" USING btree ("connection_id","kind","external_created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_connections_code_uq" ON "integration_connections" USING btree (upper(code));--> statement-breakpoint
CREATE INDEX "integration_sync_runs_conn_idx" ON "integration_sync_runs" USING btree ("connection_id","started_at");