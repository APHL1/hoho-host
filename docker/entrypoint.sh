#!/bin/sh
# Démarre en root uniquement pour donner le dossier /data à PUID:PGID,
# puis lance l'app sans les droits root (Unraid : PUID=99, PGID=100).
set -e
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null || echo "Attention : impossible de changer le propriétaire de $DATA_DIR"
  exec su-exec "$PUID:$PGID" "$@"
fi
exec "$@"
