#!/usr/bin/env bash
# ============================================================
# migrate-userid-to-uuid.sh
# Backs up the database, then migrates all numeric user IDs
# to UUIDs in-place.
#
# Usage: ./migrate-userid-to-uuid.sh
#
# Env vars (or edit defaults below):
#   DB_HOST, DB_PORT, DB_USER, DB_PASS, DB_NAME
# ============================================================
set -euo pipefail

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-3306}"
DB_USER="${DB_USER:-shadi}"
DB_PASS="${DB_PASS:-password}"
DB_NAME="${DB_NAME:-shado_cloud_nestjs}"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="backup_${DB_NAME}_${TIMESTAMP}.sql.gz"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

MYSQL="mysql -h${DB_HOST} -P${DB_PORT} -u${DB_USER} -p${DB_PASS} ${DB_NAME}"

echo "=== UUID Migration for ${DB_NAME} ==="
echo ""

# ── Step 1: Backup ──────────────────────────────────────────
echo "[1/5] Backing up database to ${BACKUP_FILE} ..."
mysqldump -h"${DB_HOST}" -P"${DB_PORT}" -u"${DB_USER}" -p"${DB_PASS}" \
  --single-transaction --routines --triggers \
  "${DB_NAME}" | gzip > "${SCRIPT_DIR}/${BACKUP_FILE}"
echo "       Backup complete: ${SCRIPT_DIR}/${BACKUP_FILE}"

# ── Step 2: Discover FK constraint names ────────────────────
echo "[2/5] Discovering foreign key constraints ..."

get_fk() {
  local table=$1
  local column=$2
  $MYSQL -N -e "
    SELECT CONSTRAINT_NAME
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = '${DB_NAME}'
      AND TABLE_NAME = '${table}'
      AND COLUMN_NAME = '${column}'
      AND REFERENCED_TABLE_NAME = 'user'
    LIMIT 1;
  "
}

FK_UPLOADED_FILE=$(get_fk "uploaded_file" "userId")
FK_TEMP_URL=$(get_fk "temp_url" "userId")
FK_LOG=$(get_fk "log" "userId")
FK_ENCRYPTED_PASSWORD=$(get_fk "encrypted_password" "userId")
FK_SEARCH_STATS=$(get_fk "search_stats" "userId")
FK_FILE_ACCESS_STATS=$(get_fk "file_access_stats" "userId")
FK_PLAYLIST=$(get_fk "playlist" "userId")
FK_PLAY_HISTORY=$(get_fk "play_history" "userId")

echo "       Found FKs:"
echo "         uploaded_file:      ${FK_UPLOADED_FILE:-NONE}"
echo "         temp_url:           ${FK_TEMP_URL:-NONE}"
echo "         log:                ${FK_LOG:-NONE}"
echo "         encrypted_password: ${FK_ENCRYPTED_PASSWORD:-NONE}"
echo "         search_stats:       ${FK_SEARCH_STATS:-NONE}"
echo "         file_access_stats:  ${FK_FILE_ACCESS_STATS:-NONE}"
echo "         playlist:           ${FK_PLAYLIST:-NONE}"
echo "         play_history:       ${FK_PLAY_HISTORY:-NONE}"

# ── Step 3: Drop all FK constraints ────────────────────────
echo "[3/5] Dropping foreign key constraints ..."

drop_fk() {
  local table=$1
  local fk=$2
  if [ -n "$fk" ]; then
    $MYSQL -e "ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${fk}\`;"
    echo "       Dropped ${table}.${fk}"
  fi
}

drop_fk "uploaded_file" "$FK_UPLOADED_FILE"
drop_fk "temp_url" "$FK_TEMP_URL"
drop_fk "log" "$FK_LOG"
drop_fk "encrypted_password" "$FK_ENCRYPTED_PASSWORD"
drop_fk "search_stats" "$FK_SEARCH_STATS"
drop_fk "file_access_stats" "$FK_FILE_ACCESS_STATS"
drop_fk "playlist" "$FK_PLAYLIST"
drop_fk "play_history" "$FK_PLAY_HISTORY"

# ── Step 4: Migrate IDs ───────────────────────────────────
echo "[4/5] Running migration ..."

$MYSQL <<'EOSQL'

-- Create UUID mapping for every existing user
CREATE TEMPORARY TABLE _user_uuid_map (
  old_id INT PRIMARY KEY,
  new_id CHAR(36) NOT NULL
);
INSERT INTO _user_uuid_map (old_id, new_id)
SELECT id, UUID() FROM user;

-- ── Convert all FK columns to VARCHAR(36) first ──
ALTER TABLE uploaded_file MODIFY userId VARCHAR(36);
ALTER TABLE temp_url MODIFY userId VARCHAR(36);
ALTER TABLE log MODIFY userId VARCHAR(36);
ALTER TABLE encrypted_password MODIFY userId VARCHAR(36);
ALTER TABLE search_stats MODIFY userId VARCHAR(36);
ALTER TABLE file_access_stats MODIFY userId VARCHAR(36);
ALTER TABLE service_function MODIFY user_id VARCHAR(36);
ALTER TABLE playlist MODIFY userId VARCHAR(36);
ALTER TABLE play_history MODIFY userId VARCHAR(36);

-- ── Update all FK columns with UUIDs ──
UPDATE uploaded_file f JOIN _user_uuid_map m ON f.userId = m.old_id SET f.userId = m.new_id;
UPDATE temp_url t JOIN _user_uuid_map m ON t.userId = m.old_id SET t.userId = m.new_id;
UPDATE log l JOIN _user_uuid_map m ON l.userId = m.old_id SET l.userId = m.new_id;
UPDATE encrypted_password e JOIN _user_uuid_map m ON e.userId = m.old_id SET e.userId = m.new_id;
UPDATE search_stats s JOIN _user_uuid_map m ON s.userId = m.old_id SET s.userId = m.new_id;
UPDATE file_access_stats f JOIN _user_uuid_map m ON f.userId = m.old_id SET f.userId = m.new_id;
UPDATE service_function sf JOIN _user_uuid_map m ON sf.user_id = m.old_id SET sf.user_id = m.new_id;
UPDATE playlist p JOIN _user_uuid_map m ON p.userId = m.old_id SET p.userId = m.new_id;
UPDATE play_history ph JOIN _user_uuid_map m ON ph.userId = m.old_id SET ph.userId = m.new_id;

-- ── Convert user PK ──
ALTER TABLE user DROP PRIMARY KEY;
ALTER TABLE user MODIFY id VARCHAR(36) NOT NULL;
UPDATE user u JOIN _user_uuid_map m ON u.id = m.old_id SET u.id = m.new_id;
ALTER TABLE user MODIFY id CHAR(36) NOT NULL;
ALTER TABLE user ADD PRIMARY KEY (id);

-- ── Finalize FK column types to CHAR(36) ──
ALTER TABLE uploaded_file MODIFY userId CHAR(36);
ALTER TABLE temp_url MODIFY userId CHAR(36);
ALTER TABLE log MODIFY userId CHAR(36);
ALTER TABLE encrypted_password MODIFY userId CHAR(36);
ALTER TABLE search_stats MODIFY userId CHAR(36);
ALTER TABLE file_access_stats MODIFY userId CHAR(36);
ALTER TABLE service_function MODIFY user_id CHAR(36);
ALTER TABLE playlist MODIFY userId CHAR(36);
ALTER TABLE play_history MODIFY userId CHAR(36);

-- ── Re-add foreign key constraints ──
ALTER TABLE uploaded_file ADD CONSTRAINT fk_uploaded_file_user FOREIGN KEY (userId) REFERENCES user(id);
ALTER TABLE temp_url ADD CONSTRAINT fk_temp_url_user FOREIGN KEY (userId) REFERENCES user(id);
ALTER TABLE log ADD CONSTRAINT fk_log_user FOREIGN KEY (userId) REFERENCES user(id);
ALTER TABLE encrypted_password ADD CONSTRAINT fk_encrypted_password_user FOREIGN KEY (userId) REFERENCES user(id);
ALTER TABLE search_stats ADD CONSTRAINT fk_search_stats_user FOREIGN KEY (userId) REFERENCES user(id);
ALTER TABLE file_access_stats ADD CONSTRAINT fk_file_access_stats_user FOREIGN KEY (userId) REFERENCES user(id);
ALTER TABLE playlist ADD CONSTRAINT fk_playlist_user FOREIGN KEY (userId) REFERENCES user(id);
ALTER TABLE play_history ADD CONSTRAINT fk_play_history_user FOREIGN KEY (userId) REFERENCES user(id);

DROP TEMPORARY TABLE _user_uuid_map;

EOSQL

echo "       SQL migration complete."

# ── Step 5: Verify ─────────────────────────────────────────
echo "[5/5] Verifying ..."

SAMPLE=$($MYSQL -N -e "SELECT id FROM user LIMIT 1;")
if [[ "$SAMPLE" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo "       ✅ Migration verified — user.id is now UUID: ${SAMPLE}"
else
  echo "       ❌ VERIFICATION FAILED — user.id does not look like a UUID: ${SAMPLE}"
  echo "       Run rollback: ./rollback-uuid-migration.sh ${BACKUP_FILE}"
  exit 1
fi

echo ""
echo "=== Migration complete ==="
echo "Backup saved at: ${SCRIPT_DIR}/${BACKUP_FILE}"
echo "To rollback:     ./rollback-uuid-migration.sh ${BACKUP_FILE}"
