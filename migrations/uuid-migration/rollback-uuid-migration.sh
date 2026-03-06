#!/usr/bin/env bash
# ============================================================
# rollback-uuid-migration.sh
# Restores the database from a backup created by the migration.
#
# Usage: ./rollback-uuid-migration.sh <backup_file.sql.gz>
# ============================================================
set -euo pipefail

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-3306}"
DB_USER="${DB_USER:-root}"
DB_PASS="${DB_PASS:-}"
DB_NAME="${DB_NAME:-shado_cloud}"

BACKUP_FILE="${1:-}"

if [ -z "$BACKUP_FILE" ]; then
  echo "Usage: $0 <backup_file.sql.gz>"
  echo ""
  echo "Available backups:"
  ls -1 "$(dirname "$0")"/backup_*.sql.gz 2>/dev/null || echo "  (none found)"
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "Error: Backup file not found: ${BACKUP_FILE}"
  exit 1
fi

echo "=== UUID Migration Rollback ==="
echo "Restoring ${DB_NAME} from ${BACKUP_FILE} ..."
echo ""
echo "⚠️  This will DROP and recreate the ${DB_NAME} database."
echo "    All data since the backup will be LOST."
echo ""
read -p "Type 'yes' to confirm: " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "Aborted."
  exit 0
fi

echo "[1/2] Dropping and recreating database ..."
mysql -h"${DB_HOST}" -P"${DB_PORT}" -u"${DB_USER}" -p"${DB_PASS}" -e "
  DROP DATABASE IF EXISTS \`${DB_NAME}\`;
  CREATE DATABASE \`${DB_NAME}\`;
"

echo "[2/2] Restoring from backup ..."
gunzip -c "$BACKUP_FILE" | mysql -h"${DB_HOST}" -P"${DB_PORT}" -u"${DB_USER}" -p"${DB_PASS}" "${DB_NAME}"

echo ""
echo "✅ Rollback complete. Database restored to pre-migration state."
