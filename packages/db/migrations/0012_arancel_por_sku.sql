ALTER TABLE "master_skus" ADD COLUMN "duty_rate" numeric(6, 4);--> statement-breakpoint
ALTER TABLE "import_container_lines" ADD COLUMN "duty_unit_cost" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "import_containers" ADD COLUMN "duty_fx_rate" numeric(12, 4);