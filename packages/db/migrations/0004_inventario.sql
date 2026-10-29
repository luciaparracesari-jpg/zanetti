CREATE TYPE "public"."adjustment_reason" AS ENUM('MERMA', 'DANO', 'ROBO', 'CADUCIDAD', 'ERROR_CAPTURA', 'CONCILIACION_CANAL', 'INVENTARIO_INICIAL', 'OTRO');--> statement-breakpoint
CREATE TYPE "public"."adjustment_status" AS ENUM('BORRADOR', 'POR_AUTORIZAR', 'APLICADO', 'CANCELADO');--> statement-breakpoint
CREATE TYPE "public"."count_status" AS ENUM('ABIERTO', 'CERRADO', 'CANCELADO');--> statement-breakpoint
CREATE TYPE "public"."lot_cost_status" AS ENUM('PROVISIONAL', 'FINAL');--> statement-breakpoint
CREATE TYPE "public"."movement_type" AS ENUM('INVENTARIO_INICIAL', 'ENTRADA_COMPRA', 'ENTRADA_IMPORTACION', 'SALIDA_VENTA', 'DEVOLUCION_CLIENTE', 'DEVOLUCION_PROVEEDOR', 'AJUSTE_ENTRADA', 'AJUSTE_SALIDA', 'CONTEO_AJUSTE', 'TRANSFER_SALIDA', 'TRANSFER_ENTRADA', 'REUBICACION', 'ARMADO_KIT', 'DESARMADO_KIT', 'REVALUACION_COSTO');--> statement-breakpoint
CREATE TYPE "public"."reservation_source" AS ENUM('PEDIDO', 'TRANSFERENCIA');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('ACTIVA', 'CONSUMIDA', 'LIBERADA');--> statement-breakpoint
CREATE TYPE "public"."transfer_status" AS ENUM('BORRADOR', 'AUTORIZADA', 'ENVIADA', 'RECIBIDA', 'RECIBIDA_CON_DIFERENCIAS', 'CANCELADA');--> statement-breakpoint
CREATE SEQUENCE "public"."adjustment_folio_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "public"."count_folio_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "public"."lot_code_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "public"."transfer_folio_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "inventory_adjustment_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"adjustment_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"master_sku_id" uuid NOT NULL,
	"location_id" uuid,
	"lot_id" uuid,
	"qty" integer NOT NULL,
	"unit_cost" numeric(14, 4),
	"notes" text,
	CONSTRAINT "inventory_adjustment_items_qty_ck" CHECK (qty <> 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_adjustments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"folio" text NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"reason" "adjustment_reason" NOT NULL,
	"notes" text,
	"status" "adjustment_status" DEFAULT 'BORRADOR' NOT NULL,
	"total_value" numeric(16, 2),
	"created_by_id" uuid,
	"authorized_by_id" uuid,
	"authorized_at" timestamp with time zone,
	"applied_by_id" uuid,
	"applied_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_adjustments_folio_unique" UNIQUE("folio")
);
--> statement-breakpoint
CREATE TABLE "inventory_balances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"master_sku_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"lot_id" uuid,
	"qty" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_balances_key_uq" UNIQUE NULLS NOT DISTINCT("master_sku_id","warehouse_id","location_id","lot_id"),
	CONSTRAINT "inventory_balances_lot_qty_ck" CHECK (lot_id IS NULL OR qty >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_count_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"count_id" uuid NOT NULL,
	"master_sku_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"system_qty" integer NOT NULL,
	"counted_qty" integer,
	"counted_by_id" uuid,
	"counted_at" timestamp with time zone,
	CONSTRAINT "inventory_count_lines_uq" UNIQUE("count_id","master_sku_id","location_id"),
	CONSTRAINT "inventory_count_lines_qty_ck" CHECK (counted_qty IS NULL OR counted_qty >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_counts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"folio" text NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"location_id" uuid,
	"status" "count_status" DEFAULT 'ABIERTO' NOT NULL,
	"blind" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_by_id" uuid,
	"frozen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_by_id" uuid,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_counts_folio_unique" UNIQUE("folio")
);
--> statement-breakpoint
CREATE TABLE "inventory_lots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"master_sku_id" uuid NOT NULL,
	"lot_code" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"initial_qty" integer NOT NULL,
	"unit_cost" numeric(14, 4) NOT NULL,
	"cost_status" "lot_cost_status" DEFAULT 'FINAL' NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text,
	"supplier_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_lots_qty_ck" CHECK (initial_qty > 0),
	CONSTRAINT "inventory_lots_cost_ck" CHECK (unit_cost >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory_movements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"type" "movement_type" NOT NULL,
	"master_sku_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"lot_id" uuid,
	"qty" integer NOT NULL,
	"unit_cost" numeric(14, 4) NOT NULL,
	"total_cost" numeric(16, 4) NOT NULL,
	"document_type" text NOT NULL,
	"document_id" text NOT NULL,
	"document_folio" text,
	"document_line" integer,
	"channel_id" uuid,
	"user_id" uuid,
	"notes" text,
	"reversal_of_id" bigint,
	"negative_authorized_by_id" uuid,
	"idempotency_key" text,
	CONSTRAINT "inventory_movements_idempotencyKey_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "inventory_movements_qty_ck" CHECK (qty <> 0 OR type = 'REVALUACION_COSTO')
);
--> statement-breakpoint
CREATE TABLE "inventory_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"master_sku_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"source_type" "reservation_source" NOT NULL,
	"source_id" uuid NOT NULL,
	"source_line" integer,
	"status" "reservation_status" DEFAULT 'ACTIVA' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "inventory_reservations_qty_ck" CHECK (qty > 0)
);
--> statement-breakpoint
CREATE TABLE "stock_transfer_item_lots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"item_id" uuid NOT NULL,
	"lot_id" uuid,
	"qty" integer NOT NULL,
	"qty_received" integer DEFAULT 0 NOT NULL,
	"unit_cost" numeric(14, 4) NOT NULL,
	CONSTRAINT "stock_transfer_item_lots_qty_ck" CHECK (qty > 0 AND qty_received >= 0 AND qty_received <= qty)
);
--> statement-breakpoint
CREATE TABLE "stock_transfer_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"transfer_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"master_sku_id" uuid NOT NULL,
	"qty_requested" integer NOT NULL,
	"package_id" uuid,
	"package_qty" integer,
	"qty_shipped" integer,
	"qty_received" integer,
	"notes" text,
	CONSTRAINT "stock_transfer_items_sku_uq" UNIQUE("transfer_id","master_sku_id"),
	CONSTRAINT "stock_transfer_items_qty_ck" CHECK (qty_requested > 0 AND coalesce(qty_shipped, 0) >= 0 AND coalesce(qty_received, 0) >= 0),
	CONSTRAINT "stock_transfer_items_recv_ck" CHECK (qty_received IS NULL OR qty_received <= qty_shipped)
);
--> statement-breakpoint
CREATE TABLE "stock_transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"folio" text NOT NULL,
	"origin_warehouse_id" uuid NOT NULL,
	"destination_warehouse_id" uuid NOT NULL,
	"status" "transfer_status" DEFAULT 'BORRADOR' NOT NULL,
	"reference" text,
	"notes" text,
	"created_by_id" uuid,
	"authorized_by_id" uuid,
	"authorized_at" timestamp with time zone,
	"shipped_by_id" uuid,
	"shipped_at" timestamp with time zone,
	"received_by_id" uuid,
	"received_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_transfers_folio_unique" UNIQUE("folio"),
	CONSTRAINT "stock_transfers_wh_ck" CHECK (origin_warehouse_id <> destination_warehouse_id)
);
--> statement-breakpoint
ALTER TABLE "inventory_adjustment_items" ADD CONSTRAINT "inventory_adjustment_items_adjustment_id_inventory_adjustments_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "public"."inventory_adjustments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustment_items" ADD CONSTRAINT "inventory_adjustment_items_master_sku_id_master_skus_id_fk" FOREIGN KEY ("master_sku_id") REFERENCES "public"."master_skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustment_items" ADD CONSTRAINT "inventory_adjustment_items_location_id_warehouse_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustment_items" ADD CONSTRAINT "inventory_adjustment_items_lot_id_inventory_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."inventory_lots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_authorized_by_id_users_id_fk" FOREIGN KEY ("authorized_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_applied_by_id_users_id_fk" FOREIGN KEY ("applied_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_master_sku_id_master_skus_id_fk" FOREIGN KEY ("master_sku_id") REFERENCES "public"."master_skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_location_id_warehouse_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_lot_id_inventory_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."inventory_lots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_count_lines" ADD CONSTRAINT "inventory_count_lines_count_id_inventory_counts_id_fk" FOREIGN KEY ("count_id") REFERENCES "public"."inventory_counts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_count_lines" ADD CONSTRAINT "inventory_count_lines_master_sku_id_master_skus_id_fk" FOREIGN KEY ("master_sku_id") REFERENCES "public"."master_skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_count_lines" ADD CONSTRAINT "inventory_count_lines_location_id_warehouse_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_count_lines" ADD CONSTRAINT "inventory_count_lines_counted_by_id_users_id_fk" FOREIGN KEY ("counted_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_location_id_warehouse_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_closed_by_id_users_id_fk" FOREIGN KEY ("closed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_master_sku_id_master_skus_id_fk" FOREIGN KEY ("master_sku_id") REFERENCES "public"."master_skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_master_sku_id_master_skus_id_fk" FOREIGN KEY ("master_sku_id") REFERENCES "public"."master_skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_location_id_warehouse_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_lot_id_inventory_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."inventory_lots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_negative_authorized_by_id_users_id_fk" FOREIGN KEY ("negative_authorized_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_master_sku_id_master_skus_id_fk" FOREIGN KEY ("master_sku_id") REFERENCES "public"."master_skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_item_lots" ADD CONSTRAINT "stock_transfer_item_lots_item_id_stock_transfer_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."stock_transfer_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_item_lots" ADD CONSTRAINT "stock_transfer_item_lots_lot_id_inventory_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."inventory_lots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_transfer_id_stock_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."stock_transfers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_master_sku_id_master_skus_id_fk" FOREIGN KEY ("master_sku_id") REFERENCES "public"."master_skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_package_id_sku_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."sku_packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_origin_warehouse_id_warehouses_id_fk" FOREIGN KEY ("origin_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_destination_warehouse_id_warehouses_id_fk" FOREIGN KEY ("destination_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_authorized_by_id_users_id_fk" FOREIGN KEY ("authorized_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_shipped_by_id_users_id_fk" FOREIGN KEY ("shipped_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_received_by_id_users_id_fk" FOREIGN KEY ("received_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_adjustment_items_adj_idx" ON "inventory_adjustment_items" USING btree ("adjustment_id");--> statement-breakpoint
CREATE INDEX "inventory_adjustments_status_idx" ON "inventory_adjustments" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "inventory_balances_sku_wh_idx" ON "inventory_balances" USING btree ("master_sku_id","warehouse_id");--> statement-breakpoint
CREATE INDEX "inventory_balances_wh_idx" ON "inventory_balances" USING btree ("warehouse_id");--> statement-breakpoint
CREATE INDEX "inventory_balances_lot_idx" ON "inventory_balances" USING btree ("lot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_lots_code_uq" ON "inventory_lots" USING btree ("master_sku_id",upper(lot_code));--> statement-breakpoint
CREATE INDEX "inventory_lots_fifo_idx" ON "inventory_lots" USING btree ("master_sku_id","received_at");--> statement-breakpoint
CREATE INDEX "inventory_movements_sku_idx" ON "inventory_movements" USING btree ("master_sku_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "inventory_movements_wh_idx" ON "inventory_movements" USING btree ("warehouse_id","occurred_at");--> statement-breakpoint
CREATE INDEX "inventory_movements_doc_idx" ON "inventory_movements" USING btree ("document_type","document_id");--> statement-breakpoint
CREATE INDEX "inventory_movements_lot_idx" ON "inventory_movements" USING btree ("lot_id");--> statement-breakpoint
CREATE INDEX "inventory_movements_type_idx" ON "inventory_movements" USING btree ("type","occurred_at");--> statement-breakpoint
CREATE INDEX "inventory_reservations_active_idx" ON "inventory_reservations" USING btree ("master_sku_id","warehouse_id") WHERE status = 'ACTIVA';--> statement-breakpoint
CREATE INDEX "inventory_reservations_source_idx" ON "inventory_reservations" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "stock_transfer_item_lots_item_idx" ON "stock_transfer_item_lots" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "stock_transfers_status_idx" ON "stock_transfers" USING btree ("status","created_at");