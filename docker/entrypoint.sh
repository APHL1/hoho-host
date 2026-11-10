#!/bin/sh
# Démarre en root uniquement pour préparer /data, puis lance l'app avec PUID:PGID
# (Unraid : PUID=99, PGID=100).
# Sécurité : si /data contient des fichiers qui ne sont pas à l'app (ex. tout le
# dossier appdata monté par erreur), on refuse de démarrer et on ne touche à rien.
set -e
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

foreign=""
if [ -d "$DATA_DIR" ]; then
  for entry in "$DATA_DIR"/* "$DATA_DIR"/.[!.]*; do
    [ -e "$entry" ] || continue
    case "$(basename "$entry")" in
      hoho-host.db|hoho-host.db-wal|hoho-host.db-shm|noel.db|noel.db-wal|noel.db-shm|images|backups|lost+found|.DS_Store) ;;
      *) foreign="$foreign $(basename "$entry")" ;;
    esac
  done
fi
if [ -n "$foreign" ]; then
  echo "ERREUR : $DATA_DIR contient des fichiers qui n'appartiennent pas à HoHoHost :$foreign"
  echo "Le volume /data doit pointer vers un dossier dédié (ex. /mnt/user/appdata/hoho-host)."
  echo "Rien n'a été modifié. Corrige le chemin du volume puis redémarre le conteneur."
  exit 1
fi

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null || echo "Attention : impossible de changer le propriétaire de $DATA_DIR"
  exec su-exec "$PUID:$PGID" "$@"
fi
exec "$@"
