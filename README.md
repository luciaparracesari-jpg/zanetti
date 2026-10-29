# ERP ECOMMERCE — Sistema Integral de Operaciones

Plataforma ERP web para administrar un negocio de ecommerce multicanal en México (Amazon, Liverpool, Shopify, Mercado Libre y venta directa) con el **SKU maestro** como entidad central.

Diseño completo (arquitectura, modelo de datos, APIs, roles, flujos, wireframes y roadmap): documento **“ERP Ecommerce — Diseño del sistema”** en el proyecto Zanetti de Claude. Las decisiones técnicas que cambiaron respecto al diseño están en [`docs/decisiones.md`](docs/decisiones.md).

## Estado: entregas 1 y 2 de 6 del MVP

| Incluido en las entregas 1 y 2 | Llega después |
| --- | --- |
| **Inventario (entrega 2):** existencias por almacén y ubicación, lotes FIFO, kardex con saldo, ajustes con autorización, transferencias APLIN ⇄ FBA/FBL por pieza o caja master, conteos físicos ciegos, inventario inicial desde Excel | |
| Login con sesiones, bloqueo por intentos, cambio obligatorio de contraseña | |
| Roles y permisos (8 roles iniciales, matriz editable, permiso de campo para costos) | Entrega 3: compras, órdenes de compra, recepciones |
| Auditoría inmutable (la base de datos rechaza UPDATE/DELETE) | Entrega 4: pedidos, devoluciones, importación de reportes Amazon/Liverpool |
| Catálogo: productos, SKU maestros, kits (bundles), códigos de barras con validación EAN/UPC, marcas, categorías | Entrega 5: reabasto, alertas, dashboard de ventas, reportes |
| Canales con cobertura objetivo y comisiones con vigencia (Liverpool 16.43 % → 19.00 % el 8-abr-2026) | Entrega 6: carga inicial y pruebas con datos reales |
| Publicaciones (ASIN, artículo Liverpool, variante Shopify) ligadas al SKU, con modelo de surtido | Fase 2: conectores Amazon SP-API, Liverpool, Shopify, Mercado Libre |
| Cola de códigos sin mapear | Fase 3: importaciones, costo puesto en almacén, rentabilidad |
| Almacenes y ubicaciones: APLIN (propio), Amazon FBA, Liverpool FBL, Liverpool 99 Minutos | Fase 4: finanzas y CFDI |
| Proveedores (ficha básica), búsqueda global (Ctrl K), tablas con filtros guardados, columnas configurables, exportación CSV | |
| Importación desde Excel/CSV con vista previa, corrección y confirmación; cajas master por SKU | |

## Importar el catálogo desde Excel

Menú **Productos → Importar desde Excel** (o el botón en SKU maestros):

1. Elige el tipo de información y, si hace falta, descarga la plantilla (trae una hoja de instrucciones).
2. Carga el archivo `.xlsx` o `.csv` (hasta 5 MB y 5,000 renglones). El encabezado puede estar en cualquiera de los primeros 20 renglones y las columnas pueden venir en cualquier orden.
3. Revisa la vista previa: cada renglón dice si es válido, tiene advertencias o errores, y qué se hará (crear o actualizar). Haz clic en un renglón para corregirlo u omítelo.
4. Confirma. Todo se aplica en una sola transacción; si algo cambió desde la vista previa, se revalida y no se importa nada con errores.

La plantilla **SKU maestro y publicaciones** reconoce el formato de `ERP_ZANETTI.xlsx` (SKU MAESTRO, ID LIVERPOOL FBL/99 MIN, ID LIVERPOOL VENDOR, ASIN AMAZON, UPC-EAN, SKU CAJA MASTER, PIEZAS CAJA MASTER) y columnas opcionales: NOMBRE, PRODUCTO, MARCA, CATEGORIA, SKU AMAZON, SHOPIFY VARIANT ID, SKU SHOPIFY, PRECIO LISTA y COSTO. Reimportar el mismo archivo no duplica nada: sólo agrega lo que falta.

| Columna | Se registra como |
| --- | --- |
| ASIN AMAZON | Publicación de Amazon con stock en Amazon FBA; si el SKU empieza con X00 también se guarda como FNSKU |
| ID LIVERPOOL FBL/99 MIN | Publicación de Liverpool con stock en Liverpool FBL (o 99 Minutos si el código contiene “99”); el número inicial es el artículo |
| ID LIVERPOOL VENDOR | Publicación de Liverpool surtida desde la bodega APLIN; si no trae número de artículo (p. ej. `OF22`) se registra con el SKU de oferta y el artículo se captura después |
| UPC-EAN | Código de barras principal (UPC 12 o EAN-13 con dígito verificador) |
| SKU CAJA MASTER + PIEZAS | Caja master del SKU, que se encuentra con la búsqueda global |

## Inventario

Menú **Inventario**. Todo cambio de existencia pasa por un solo motor (`packages/domain`, `postMovement`) que escribe un movimiento inmutable por lote:

- **Existencias**: físico por almacén, apartado, disponible y en tránsito, con valor al costo (sólo con el permiso “Costos y márgenes”). Disponible = físico − cuarentena/merma − reservado (pedidos) − comprometido (transferencias autorizadas).
- **Lotes FIFO**: cada entrada crea un lote con su costo; las salidas consumen el más antiguo. En una transferencia el lote viaja con su costo, así FBA y FBL quedan valuados igual que en APLIN.
- **Sin negativos**: una salida que no alcanza se rechaza mostrando lo disponible. Sólo el Administrador puede autorizarla (casilla explícita); el faltante queda marcado y la siguiente entrada lo cubre primero.
- **Ajustes**: borrador → aplicar. Si el valor supera `ajustes.umbral_autorizacion_mxn` (Configuración → Empresa y parámetros) y quien aplica no puede autorizar, queda “Por autorizar”.
- **Transferencias**: borrador → autorizar (aparta en el origen) → enviar (sale FIFO y queda en tránsito) → recibir (una o varias recepciones; se puede cerrar con diferencias). Se captura por piezas o escaneando la caja master.
- **Conteos físicos**: al abrir se toma la foto de la existencia; al cerrar se ajusta sólo contado − foto, así no se pierden las ventas o envíos que ocurran mientras se cuenta. En conteo ciego, quien captura no ve el sistema. Cerrar requiere autorizar ajustes.
- **Kardex** por SKU con saldo y valor acumulados; **movimientos** filtrables por almacén, tipo, documento y fechas; exportación CSV.
- **Kits**: no tienen existencia propia; su disponible es el del componente que alcance para menos kits.

### Cargar el inventario inicial

**Inventario → Inventario inicial** (requiere autorizar ajustes y ver costos). Columnas: `SKU MAESTRO`, `ALMACEN` (APLIN, AMZ-FBA, LIV-FBL, LIV-99MIN; también FBA, FBL o 99 MIN), `UBICACION` (por omisión GEN), `CANTIDAD`, `COSTO UNITARIO` (MXN sin IVA), `LOTE` y `FECHA ENTRADA` (define el orden FIFO). Si falta el costo se usa el del SKU y el lote queda “provisional”. El mismo lote en varios almacenes se repite con el mismo costo.

## Stack

- **Monorepo** pnpm + Turborepo, TypeScript estricto.
- **apps/api** — NestJS (Node 22), REST en `/api/v1`, validación con zod.
- **apps/web** — Next.js 15 (App Router), React 19, Tailwind 4, TanStack Query.
- **packages/db** — PostgreSQL 16 + Drizzle ORM: esquema, migraciones SQL versionadas y datos semilla.
- **packages/shared** — permisos, etiquetas y esquemas zod compartidos por API y web.

```text
apps/api          API REST (NestJS)
apps/web          Pantallas (Next.js)
packages/db       Esquema Drizzle, migraciones, seed, hash de contraseñas
packages/domain   Motor de inventario: movimientos, lotes FIFO, reservas, folios
packages/shared   Permisos, etiquetas en español, validaciones zod
deploy/           Caddyfile y script de respaldos
docs/             Decisiones técnicas
```

## Desarrollo local

Requisitos: Node 22, pnpm 10 (`corepack enable`) y PostgreSQL 16.

```bash
cp .env.example .env              # ajusta DATABASE_URL y SEED_ADMIN_PASSWORD
pnpm install
pnpm --filter @erp/shared build
pnpm --filter @erp/db build
pnpm --filter @erp/domain build
pnpm db:migrate                   # crea tablas, índices, triggers y restricciones
pnpm db:seed                      # roles, permisos, canales, almacenes, comisiones y usuario administrador
pnpm dev                          # API en :4000 y web en :3000
```

Entra a http://localhost:3000 con `SEED_ADMIN_EMAIL` y `SEED_ADMIN_PASSWORD`; el sistema pedirá cambiar la contraseña la primera vez. Si dejas `SEED_ADMIN_PASSWORD` vacío, el seed genera una temporal y la imprime una sola vez.

El navegador sólo habla con Next.js; Next.js reenvía `/api/*` a la API (`API_URL`). Así la cookie de sesión es de primer nivel y ninguna credencial queda expuesta en el frontend.

### Cambios al esquema

1. Edita `packages/db/src/schema/*.ts`.
2. `pnpm db:generate` crea la migración SQL en `packages/db/migrations/`.
3. Para reglas que Drizzle no expresa (triggers, exclusiones): `pnpm --filter @erp/db generate:custom --name=descripcion` y escribe el SQL.
4. `pnpm --filter @erp/db build && pnpm db:migrate`.

## Pruebas

Las pruebas de punta a punta corren contra una API en marcha y una base de desarrollo (crean datos con sufijo único; no las corras contra producción):

```bash
cd apps/api
ADMIN_EMAIL=admin@zanetti.mx ADMIN_PASSWORD='<contraseña actual>' ADMIN_NEW_PASSWORD='<otra>' \
DATABASE_URL=postgresql://erp:erp@localhost:5432/erp pnpm test
```

`test/inventory.test.mjs` cubre el inventario: FIFO con costos, rechazo y autorización de negativos, dos salidas simultáneas sobre la misma existencia (sólo una pasa), kits, cuarentena, transferencias por caja master (apartar, cancelar, enviar, recepción parcial y cierre con diferencias), conteo con movimientos posteriores a la foto, umbral de autorización, costos ocultos sin permiso, inventario inicial desde CSV y que el kardex sea de sólo inserción.

Los archivos de prueba corren uno tras otro (`--test-concurrency=1`): el primero cambia la contraseña inicial del Administrador y en paralelo se pisarían. El login admite 10 intentos por minuto por IP y las pruebas abren varias sesiones: arranca la API de pruebas con `LOGIN_THROTTLE_LIMIT=200` (como en CI); nunca lo subas en producción.

`test/imports.test.mjs` cubre la importación: encabezado en el segundo renglón, espacios invisibles, duplicados, dígito verificador, corrección y omisión de renglones, bloqueo con errores, aplicación, reimportación sin duplicar y conflictos con datos existentes.

Las demás pruebas cubren: CSRF, credenciales, sesión, cambio obligatorio de contraseña, catálogo, kits (y rechazo de kit dentro de kit), EAN-13 con dígito verificador, publicaciones con almacén del canal correcto, código externo único vigente, baja y re-ligado, comisiones sin traslape, permisos del rol Consulta (sin costos, sin crear, sin exportar), último Administrador protegido y auditoría inmutable. El flujo de GitHub Actions (`.github/workflows/ci.yml`) las corre en cada push.

## Despliegue en el VPS

```bash
git clone <repo> /opt/erp-ecommerce && cd /opt/erp-ecommerce
cp .env.example .env    # DOMAIN, POSTGRES_PASSWORD, DATABASE_URL con host "db", WEB_ORIGIN https, COOKIE_SECURE=true
docker compose build
docker compose up -d db
docker compose run --rm api node packages/db/dist/migrate.js
docker compose run --rm api node packages/db/dist/seed.js
docker compose up -d
```

- Caddy publica 80/443 y obtiene el certificado HTTPS; API y base de datos quedan en la red interna.
- Respaldos: `deploy/backup.sh` (pg_dump diario con 30 días de retención). Prográmalo con cron y copia `backups/` fuera del servidor.
- Actualizar: `git pull && docker compose build && docker compose run --rm api node packages/db/dist/migrate.js && docker compose up -d`.

## Seguridad

- Contraseñas con Argon2id; sesiones en base de datos con cookie httpOnly y SameSite=Lax; revocación inmediata.
- Bloqueo de 15 minutos tras 5 intentos fallidos; límite de 10 intentos de login por minuto por IP.
- Toda petición que modifica datos exige el encabezado `x-erp-client` (defensa CSRF).
- Guard global que **falla cerrado**: una ruta sin permiso declarado se rechaza.
- “Costos y márgenes” es un permiso de campo: sin él la API omite costo y margen en respuestas y exportaciones.
- Consultas parametrizadas (Drizzle) y React escapan entrada del usuario (SQL injection y XSS). Encabezados de seguridad con Helmet y Next.js.
- Las credenciales de integraciones (fase 2) se guardarán cifradas con AES-256-GCM usando `CREDENTIALS_KEY`; nunca en el código ni en el frontend.
