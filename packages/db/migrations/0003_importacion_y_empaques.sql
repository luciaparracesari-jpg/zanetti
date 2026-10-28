CREATE TYPE "public"."import_batch_status" AS ENUM('VALIDADO', 'APLICADO', 'CANCELADO');--> statement-breakpoint
CREATE TYPE "public"."import_row_action" AS ENUM('CREAR', 'ACTUALIZAR', 'SIN_CAMBIOS');--> statement-breakpoint
CREATE TYPE "public"."import_row_status" AS ENUM('VALIDO', 'ADVERTENCIA', 'ERROR', 'OMITIDO');--> statement-breakpoint
CREATE TYPE "public"."package_type" AS ENUM('CAJA_MASTER', 'CAJA_INTERIOR', 'TARIMA');--> statement-breakpoint
CREATE TABLE "sku_packages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"master_sku_id" uuid NOT NULL,
	"code" text NOT NULL,
	"type" "package_type" DEFAULT 'CAJA_MASTER' NOT NULL,
	"units_per_package" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sku_packages_units_ck" CHECK (units_per_package > 0)
);
--> statement-breakpoint
CREATE TABLE "data_import_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"template" text NOT NULL,
	"file_name" text NOT NULL,
	"sheet_name" text,
	"status" "import_batch_status" DEFAULT 'VALIDADO' NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"file_messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"result" jsonb,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"validated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_by_id" uuid,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "data_import_rows" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "data_import_rows_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"batch_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"raw" jsonb NOT NULL,
	"edits" jsonb,
	"status" "import_row_status" NOT NULL,
	"action" "import_row_action",
	"skipped" boolean DEFAULT false NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"plan" jsonb
);
--> statement-breakpoint
ALTER TABLE "sku_packages" ADD CONSTRAINT "sku_packages_master_sku_id_master_skus_id_fk" FOREIGN KEY ("master_sku_id") REFERENCES "public"."master_skus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_import_batches" ADD CONSTRAINT "data_import_batches_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_import_batches" ADD CONSTRAINT "data_import_batches_applied_by_id_users_id_fk" FOREIGN KEY ("applied_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_import_rows" ADD CONSTRAINT "data_import_rows_batch_id_data_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."data_import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sku_packages_code_uq" ON "sku_packages" USING btree (upper(code));--> statement-breakpoint
CREATE INDEX "sku_packages_sku_idx" ON "sku_packages" USING btree ("master_sku_id");--> statement-breakpoint
CREATE INDEX "sku_packages_code_trgm" ON "sku_packages" USING gin (code gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "data_import_batches_created_idx" ON "data_import_batches" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "data_import_rows_uq" ON "data_import_rows" USING btree ("batch_id","row_number");--> statement-breakpoint
CREATE INDEX "data_import_rows_status_idx" ON "data_import_rows" USING btree ("batch_id","status");