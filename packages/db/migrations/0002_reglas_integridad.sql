-- Reglas de integridad que el esquema de Drizzle no expresa.

-- 1) Bitácoras de sólo inserción: auditoría (y, en la entrega 2, movimientos de inventario).
CREATE OR REPLACE FUNCTION erp_forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% es de solo inserción; corrige con un registro nuevo', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_logs_immutable
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION erp_forbid_change();
--> statement-breakpoint

-- 2) Comisiones: dos reglas del mismo canal, tipo y alcance no pueden traslapar vigencias.
ALTER TABLE fee_rules ADD CONSTRAINT fee_rules_no_overlap EXCLUDE USING gist (
  channel_id WITH =,
  fee_type WITH =,
  (coalesce(category_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
  (coalesce(master_sku_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
  daterange(valid_from, valid_to, '[]') WITH &&
);
--> statement-breakpoint

-- 3) Un kit no puede ser componente de otro kit (evita ciclos y explosiones anidadas).
CREATE OR REPLACE FUNCTION erp_kit_component_check() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM master_skus WHERE id = NEW.component_sku_id AND is_kit) THEN
    RAISE EXCEPTION 'Un kit no puede ser componente de otro kit' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM master_skus WHERE id = NEW.kit_sku_id AND is_kit) THEN
    RAISE EXCEPTION 'El SKU padre debe estar marcado como kit' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER kit_components_check
  BEFORE INSERT OR UPDATE ON kit_components
  FOR EACH ROW EXECUTE FUNCTION erp_kit_component_check();
