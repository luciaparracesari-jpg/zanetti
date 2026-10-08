#!/usr/bin/env bash
# Respaldo diario de PostgreSQL con retención de 30 días.
# Programar en el VPS (crontab -e):
#   15 3 * * * /opt/erp-ecommerce/deploy/backup.sh >> /var/log/erp-backup.log 2>&1
# Copia además la carpeta backups/ fuera del servidor (S3, otro VPS) para tener respaldo externo.
set -euo pipefail
cd "$(dirname "$0")/.."
STAMP=$(date -u +%Y%m%d-%H%M%S)
FILE="backups/erp-${STAMP}.dump"
mkdir -p backups
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$FILE"
echo "Respaldo creado: $FILE ($(du -h "$FILE" | cut -f1))"
find backups -name 'erp-*.dump' -mtime +30 -delete
# Restaurar: docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < backups/erp-AAAAMMDD-HHMMSS.dump
