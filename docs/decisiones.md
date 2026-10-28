# Decisiones técnicas

Registro de decisiones que complementan o ajustan el documento de diseño. La más reciente va primero.

| Fecha | Decisión | Motivo |
| --- | --- | --- |
| 2026-10-28 | El SKU maestro usa los códigos actuales del catálogo (FNSKU X00…, ASIN B0… y códigos propios como DEB-YRP), no una numeración nueva ZNT-#####. | Es la clave que ya usan las ventas, el Power BI y las etiquetas de Amazon; cambiarla obligaría a mantener una tabla de equivalencias. |
| 2026-10-28 | Liverpool: el código externo de la publicación es el número de artículo y el SKU externo es el SKU de oferta (1138782090 / 1138782090-FBL). Las ofertas Vendor sin artículo (OF22) se registran con el SKU de oferta en ambos campos; el código externo se puede corregir después. | El reporte de ventas de Liverpool identifica el producto por artículo. FBL y Vendor del mismo artículo conviven porque su SKU de oferta es distinto. |
| 2026-10-28 | Las cajas master son empaques del SKU (`sku_packages`: código único y piezas), no SKU aparte. | Una caja no tiene inventario propio: es una forma de contar piezas del mismo SKU en recepciones y envíos a FBA/FBL. |
| 2026-10-28 | Importación genérica en lotes (`data_import_batches` / `data_import_rows`): cargar, validar, corregir, confirmar; se aplica en una transacción y se revalida al confirmar. | Requisito 23 del planteamiento: nunca sobrescribir sin confirmación. Las siguientes plantillas (inventario inicial, proveedores, costos) reutilizan el mismo flujo. |
| 2026-10-28 | La importación nunca borra ni mueve SKU entre productos; en un SKU existente sólo agrega códigos, publicaciones y cajas, y actualiza nombre, precio o costo si vienen en el archivo. | Reimportar el archivo maestro debe ser seguro. |
| 2026-10-08 | **Drizzle ORM en lugar de Prisma.** | El planteamiento pide “Prisma o equivalente”. Drizzle es TypeScript puro: no descarga motores binarios al instalar ni al desplegar en el VPS, y expresa en el propio esquema los índices parciales, índices por expresión (`upper(sku_code)`, `lower(email)`) y restricciones CHECK del diseño. Las reglas que tampoco expresa (exclusión de vigencias, triggers) viven en migraciones SQL versionadas. |
| 2026-10-08 | Correlaciones de subconsultas con nombre de tabla explícito (`"brands"."id"`). | En consultas de una sola tabla, Drizzle omite el nombre de la tabla en columnas dentro de `sql` del SELECT; una subconsulta como `p.brand_id = "id"` se resolvería contra la tabla interna y contaría mal. |
| 2026-10-08 | Liverpool FBL y Liverpool 99 Minutos son almacenes del canal Liverpool; Liverpool Vendor surte desde APLIN. | Confirmado por el negocio. Cada publicación guarda su modelo de surtido y su almacén. |
| 2026-10-08 | Amazon FBA es un almacén separado de APLIN. | Confirmado por el negocio; evita contar dos veces el mismo stock. |
| 2026-10-08 | Mercado Libre queda dado de alta en pausa; Shopify activo. | Confirmado por el negocio. |
| 2026-10-08 | Cobertura objetivo: Amazon 90 días, Liverpool 45 días (campo `coverage_days` del canal). | Confirmado por el negocio. |
| 2026-10-08 | La validación vive en esquemas zod de `@erp/shared` y la ejecuta la API; el frontend pinta los errores 422 por campo. | Una sola fuente de verdad para reglas de negocio. |
| 2026-10-08 | Sesiones en base de datos (no JWT). | Revocación inmediata al desactivar un usuario o cambiar contraseña. |
| 2026-10-08 | Kits: un kit no puede ser componente de otro kit (trigger en la base de datos). | Evita ciclos y explosiones de inventario anidadas. |
| 2026-10-08 | Un código externo vigente apunta a un solo SKU por canal (índice único parcial `WHERE valid_to IS NULL`); la baja conserva el historial. | Datos reales: hay artículos de Liverpool con dos códigos y códigos con dos artículos. |
