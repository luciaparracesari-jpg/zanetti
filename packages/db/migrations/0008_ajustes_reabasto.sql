CREATE TABLE "replenishment_overrides" (
	"master_sku_id" uuid PRIMARY KEY NOT NULL,
	"include_in_orders" boolean DEFAULT true NOT NULL,
	"manual_daily_demand" numeric(10, 3),
	"notes" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" uuid
);
--> statement-breakpoint
ALTER TABLE "replenishment_overrides" ADD CONSTRAINT "replenishment_overrides_master_sku_id_master_skus_id_fk" FOREIGN KEY ("master_sku_id") REFERENCES "public"."master_skus"("id") ON DELETE cascade ON UPDATE no action;