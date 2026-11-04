CREATE TYPE "public"."attachment_kind" AS ENUM('ORDEN', 'PROFORMA', 'FACTURA', 'PACKING_LIST', 'BL', 'PEDIMENTO', 'COMPROBANTE_PAGO', 'FACTURA_GASTO', 'OTRO');--> statement-breakpoint
CREATE TYPE "public"."container_cost_status" AS ENUM('ABIERTO', 'CERRADO');--> statement-breakpoint
CREATE TYPE "public"."cost_allocation_basis" AS ENUM('PIEZAS', 'CBM', 'VALOR');--> statement-breakpoint
CREATE TYPE "public"."purchase_order_status" AS ENUM('BORRADOR', 'ENVIADA', 'CONFIRMADA', 'RECIBIDA', 'CANCELADA');--> statement-breakpoint
CREATE SEQUENCE "public"."purchase_order_folio_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"kind" "attachment_kind" DEFAULT 'OTRO' NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"data" "bytea" NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	CONSTRAINT "attachments_entity_ck" CHECK (entity_type IN ('PURCHASE_ORDER', 'CONTAINER')),
	CONSTRAINT "attachments_size_ck" CHECK (size_bytes > 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_order_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"po_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"master_sku_id" uuid NOT NULL,
	"supplier_sku" text,
	"qty" integer NOT NULL,
	"unit_price" numeric(14, 4),
	"notes" text,
	CONSTRAINT "purchase_order_items_sku_uq" UNIQUE("po_id","master_sku_id"),
	CONSTRAINT "purchase_order_items_qty_ck" CHECK (qty > 0),
	CONSTRAINT "purchase_order_items_price_ck" CHECK (unit_price IS NULL OR unit_price >= 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_order_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"po_id" uuid NOT NULL,
	"paid_at" date NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"fx_rate" numeric(12, 4),
	"reference" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	CONSTRAINT "purchase_order_payments_amount_ck" CHECK (amount > 0),
	CONSTRAINT "purchase_order_payments_fx_ck" CHECK (fx_rate IS NULL OR fx_rate > 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"folio" text NOT NULL,
	"supplier_id" uuid NOT NULL,
	"supplier_ref" text,
	"order_date" date NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"fx_rate" numeric(12, 4),
	"incoterm" text,
	"payment_terms" text,
	"expected_date" date,
	"status" "purchase_order_status" DEFAULT 'BORRADOR' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	"updated_by_id" uuid,
	CONSTRAINT "purchase_orders_folio_unique" UNIQUE("folio"),
	CONSTRAINT "purchase_orders_currency_ck" CHECK (currency IN ('MXN', 'USD', 'CNY')),
	CONSTRAINT "purchase_orders_fx_ck" CHECK (fx_rate IS NULL OR fx_rate > 0)
);
--> statement-breakpoint
CREATE TABLE "container_costs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"container_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"concept" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text DEFAULT 'MXN' NOT NULL,
	"fx_rate" numeric(12, 4),
	"basis" "cost_allocation_basis" DEFAULT 'PIEZAS' NOT NULL,
	"invoice_ref" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	CONSTRAINT "container_costs_amount_ck" CHECK (amount >= 0),
	CONSTRAINT "container_costs_currency_ck" CHECK (currency IN ('MXN', 'USD', 'CNY')),
	CONSTRAINT "container_costs_fx_ck" CHECK (fx_rate IS NULL OR fx_rate > 0)
);
--> statement-breakpoint
ALTER TABLE "import_container_lines" ADD COLUMN "merch_unit_cost" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "import_container_lines" ADD COLUMN "expense_unit_cost" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "import_container_lines" ADD COLUMN "po_item_id" uuid;--> statement-breakpoint
ALTER TABLE "import_container_lines" ADD COLUMN "qty_received" integer;--> statement-breakpoint
ALTER TABLE "import_containers" ADD COLUMN "pedimento" text;--> statement-breakpoint
ALTER TABLE "import_containers" ADD COLUMN "invoice_ref" text;--> statement-breakpoint
ALTER TABLE "import_containers" ADD COLUMN "fx_rate" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "import_containers" ADD COLUMN "cost_status" "container_cost_status" DEFAULT 'ABIERTO' NOT NULL;--> statement-breakpoint
ALTER TABLE "import_containers" ADD COLUMN "cost_closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "import_containers" ADD COLUMN "cost_closed_by_id" uuid;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_master_sku_id_master_skus_id_fk" FOREIGN KEY ("master_sku_id") REFERENCES "public"."master_skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_payments" ADD CONSTRAINT "purchase_order_payments_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container_costs" ADD CONSTRAINT "container_costs_container_id_import_containers_id_fk" FOREIGN KEY ("container_id") REFERENCES "public"."import_containers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_entity_idx" ON "attachments" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "purchase_order_items_sku_idx" ON "purchase_order_items" USING btree ("master_sku_id");--> statement-breakpoint
CREATE INDEX "purchase_order_payments_po_idx" ON "purchase_order_payments" USING btree ("po_id","paid_at");--> statement-breakpoint
CREATE INDEX "purchase_orders_supplier_idx" ON "purchase_orders" USING btree ("supplier_id","status");--> statement-breakpoint
CREATE INDEX "container_costs_container_idx" ON "container_costs" USING btree ("container_id");--> statement-breakpoint
ALTER TABLE "import_container_lines" ADD CONSTRAINT "import_container_lines_po_item_id_purchase_order_items_id_fk" FOREIGN KEY ("po_item_id") REFERENCES "public"."purchase_order_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_container_lines_po_item_idx" ON "import_container_lines" USING btree ("po_item_id");