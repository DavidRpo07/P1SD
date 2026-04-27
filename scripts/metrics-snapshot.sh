#!/usr/bin/env bash
set -euo pipefail
POSTGRES_MESSAGE_DB="${POSTGRES_MESSAGE_DB:-groupsapp_message}"
POSTGRES_NOTIFICATION_DB="${POSTGRES_NOTIFICATION_DB:-groupsapp_notification}"

log() { printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

ensure_container() {
  local name="$1"
  if ! docker ps --format '{{.Names}}' | grep -qx "$name"; then
    echo "Contenedor $name no está corriendo."
    return 1
  fi
  return 0
}

log "Estado contenedores"
docker compose ps

if ensure_container groupsapp-rabbitmq; then
  log "RabbitMQ queues (messages/consumers)"
  docker exec groupsapp-rabbitmq rabbitmqadmin --format=table --sort=name list queues name messages consumers
fi

if ensure_container groupsapp-postgres; then
  log "Outbox (msg.outbox)"
  docker exec -i groupsapp-postgres psql -U groupsapp -d "$POSTGRES_MESSAGE_DB" -c \
    "SELECT COUNT(*) AS total,\
            COUNT(*) FILTER (WHERE published_at IS NULL) AS pending,\
            COUNT(*) FILTER (WHERE attempts > 0) AS retried\
       FROM msg.outbox;"

  log "Distribución de mensajes por shard"
  docker exec -i groupsapp-postgres psql -U groupsapp -d "$POSTGRES_MESSAGE_DB" -c \
    "SELECT shard_id, COUNT(*) AS messages\
       FROM msg.messages\
      GROUP BY shard_id\
      ORDER BY shard_id;"

  log "Notification consumer counters"
  docker exec -i groupsapp-postgres psql -U groupsapp -d "$POSTGRES_NOTIFICATION_DB" -c \
    "SELECT (SELECT COUNT(*) FROM notif.processed_events) AS processed_events,\
            (SELECT COUNT(*) FROM notif.notifications_log) AS notifications_logged;"

  log "Últimos eventos procesados"
  docker exec -i groupsapp-postgres psql -U groupsapp -d "$POSTGRES_NOTIFICATION_DB" -c \
    "SELECT consumer_name,event_id,processed_at\
       FROM notif.processed_events\
      ORDER BY processed_at DESC\
      LIMIT 10;"
fi
