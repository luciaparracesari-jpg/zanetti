CREATE TABLE "sku_channel_economics" (
	"master_sku_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"list_price" numeric(14, 2),
	"fulfillment_per_unit" numeric(14, 2),
	"storage_per_unit" numeric(14, 2),
	"ads_rate" numeric(6, 4),
	"notes" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" uuid,
	CONSTRAINT "sku_channel_economics_master_sku_id_channel_id_pk" PRIMARY KEY("master_sku_id","channel_id"),
	CONSTRAINT "sku_channel_economics_values_ck" CHECK (coalesce(list_price, 0) >= 0 AND coalesce(fulfillment_per_unit, 0) >= 0 AND coalesce(storage_per_unit, 0) >= 0 AND coalesce(ads_rate, 0) BETWEEN 0 AND 1)
);
--> statement-breakpoint
ALTER TABLE "sku_channel_economics" ADD CONSTRAINT "sku_channel_economics_master_sku_id_master_skus_id_fk" FOREIGN KEY ("master_sku_id") REFERENCES "public"."master_skus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_channel_economics" ADD CONSTRAINT "sku_channel_economics_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;