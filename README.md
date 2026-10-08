# ERP ECOMMERCE — Sistema Integral de Operaciones

Plataforma ERP web para administrar un negocio de ecommerce multicanal en México (Amazon, Liverpool, Shopify, Mercado Libre y venta directa) con el **SKU maestro** como entidad central.

Diseño completo (arquitectura, modelo de datos, APIs, roles, flujos, wireframes y roadmap): documento **“ERP Ecommerce — Diseño del sistema”** en el proyecto Zanetti de Claude. Las decisiones técnicas que cambiaron respecto al diseño están en [`docs/decisiones.md`](docs/decisiones.md).

## Estado: entrega 1 de 6 del MVP

| Incluido en la entrega 1 | Llega después |
| --- | --- |
| Login con sesiones, bloqueo por intentos, cambio obligatorio de contraseña | Entrega 2: inventario, lotes FIFO, kardex, ajustes, transferencias, conteos |
| Roles y permisos (8 roles iniciales, matriz editable, permiso de campo para costos) | Entrega 3: compras, órdenes de compra, recepciones |
| Auditoría inmutable (la base de datos rechaza UPDATE/DELETE) | Entrega 4: pedidos, devoluciones, importación de reportes Amazon/Liverpool |
| Catálogo: productos, SKU maestros, kits (bundles), códigos de barras con validación EAN/UPC, marcas, categorías | Entrega 5: reabasto, alertas, dashboard de ventas, reportes |
| Canales con cobertura objetivo y comisiones con vigencia (Liverpool 16.43 % → 19.00 % el 8-abr-2026) | Entrega 6: carga inicial y pruebas con datos reales |
| Publicaciones (ASIN, artículo Liverpool, variante Shopify) ligadas al SKU, con modelo de surtido | Fase 2: conectores Amazon SP-API, Liverpool, Shopify, Mercado Libre |
| Cola de códigos sin mapear | Fase 3: importaciones, costo puesto en almacén, rentabilidad |
| Almacenes y ubicaciones: APLIN (propio), Amazon FBA, Liverpool FBL, Liverpool 99 Minutos | Fase 4: finanzas y CFDI |
| Proveedores (ficha básica), búsqueda global (Ctrl K), tablas con filtros guardados, columnas configurables, exportación CSV | |

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

Cubren: CSRF, credenciales, sesión, cambio obligatorio de contraseña, catálogo, kits (y rechazo de kit dentro de kit), EAN-13 con dígito verificador, publicaciones con almacén del canal correcto, código externo único vigente, baja y re-ligado, comisiones sin traslape, permisos del rol Consulta (sin costos, sin crear, sin exportar), último Administrador protegido y auditoría inmutable. El flujo de GitHub Actions (`.github/workflows/ci.yml`) las corre en cada push.

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
