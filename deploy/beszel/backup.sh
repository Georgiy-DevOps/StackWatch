#!/usr/bin/env bash
# Онлайн-бэкап Beszel hub без остановки: консистентные копии SQLite через .backup,
# плюс ключ hub. Архив шифруется публичным ключом age — на сервере нет секрета для расшифровки,
# поэтому утёкший бэкап бесполезен атакующему (как зашифрованный сейв без ключа).
#
# Использование (cron, ежедневно в 03:30):
#   30 3 * * * AGE_RECIPIENT=age1... /opt/beszel/backup.sh >>/var/log/beszel-backup.log 2>&1
# Зависимости: sqlite3, age (apt install sqlite3 age)
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="${DATA_DIR:-$HERE/data/hub}"
BACKUP_DIR="${BACKUP_DIR:-$HERE/backups}"
KEEP="${KEEP:-14}"
AGE_RECIPIENT="${AGE_RECIPIENT:-}"

if [[ -z "$AGE_RECIPIENT" ]]; then
  echo "ОШИБКА: задайте AGE_RECIPIENT (публичный ключ age). Незашифрованный бэкап содержит приватный ключ hub." >&2
  exit 1
fi
for bin in sqlite3 age tar; do
  command -v "$bin" >/dev/null || { echo "ОШИБКА: нет $bin" >&2; exit 1; }
done
[[ -f "$DATA_DIR/data.db" ]] || { echo "ОШИБКА: не найден $DATA_DIR/data.db" >&2; exit 1; }

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# .backup безопасен при работающем hub (учитывает WAL), в отличие от простого cp
for db in data.db auxiliary.db; do
  if [[ -f "$DATA_DIR/$db" ]]; then
    sqlite3 "$DATA_DIR/$db" ".backup '$WORK/$db'"
    # Проверка целостности копии — битый бэкап хуже отсутствующего
    [[ "$(sqlite3 "$WORK/$db" 'PRAGMA integrity_check;')" == "ok" ]] \
      || { echo "ОШИБКА: integrity_check не пройден для $db" >&2; exit 1; }
  fi
done
# Ключ hub: без него после восстановления придётся перепривязывать всех агентов
for f in id_ed25519 id_ed25519.pub; do
  [[ -f "$DATA_DIR/$f" ]] && cp -p "$DATA_DIR/$f" "$WORK/"
done

mkdir -p "$BACKUP_DIR"
OUT="$BACKUP_DIR/beszel-$STAMP.tar.gz.age"
tar -C "$WORK" -czf - . | age -r "$AGE_RECIPIENT" -o "$OUT.part"
mv "$OUT.part" "$OUT"
echo "OK: $OUT ($(du -h "$OUT" | cut -f1))"

# Ротация: оставляем последние $KEEP архивов
ls -1t "$BACKUP_DIR"/beszel-*.tar.gz.age 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f --

# Восстановление (на машине с приватным ключом age):
#   age -d -i key.txt beszel-<STAMP>.tar.gz.age | tar -xz -C ./data/hub
# Перед этим: docker compose stop beszel. После: docker compose start beszel.
