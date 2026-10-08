-- Extensiones requeridas por el esquema.
-- pg_trgm: búsqueda global por SKU, nombre, ASIN y códigos externos.
-- btree_gist: restricción de exclusión para vigencias de comisiones sin traslape.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;
