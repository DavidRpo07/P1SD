#!/usr/bin/env bash
set -euo pipefail

COMPOSE_CMD="docker compose"
DLQ_NAME="notification.message-created.dlq"
RETRY_TTL_MS="${NOTIFICATION_RETRY_TTL_MS:-5000}"
MAX_RETRIES="${NOTIFICATION_MAX_RETRIES:-3}"
WAIT_SECONDS=$(( (RETRY_TTL_MS * MAX_RETRIES) / 1000 + 10 ))
POSTGRES_NOTIFICATION_DB="${POSTGRES_NOTIFICATION_DB:-groupsapp_notification}"

log() { printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

get_dlq_count() {
  docker exec -i groupsapp-rabbitmq rabbitmqadmin --format=tsv list queues name messages 2>/dev/null \
    | awk -v q="$DLQ_NAME" '$1==q {print $2}'
}

log "Levantando stack base"
$COMPOSE_CMD up -d --build

log "Contando mensajes actuales en DLQ"
BEFORE_DLQ="$(get_dlq_count)"
BEFORE_DLQ="${BEFORE_DLQ:-0}"
echo "DLQ antes: $BEFORE_DLQ"

log "Activando modo de fallo forzado en notification-service"
NOTIFICATION_FAIL_MODE=always $COMPOSE_CMD up -d --no-deps --build notification-service

log "Generando eventos (smoke test)"
bash scripts/smoke-test.sh

log "Esperando reintentos + movimiento a DLQ (~${WAIT_SECONDS}s)"
sleep "$WAIT_SECONDS"

log "Revisando DLQ"
AFTER_DLQ="$(get_dlq_count)"
AFTER_DLQ="${AFTER_DLQ:-0}"
echo "DLQ después: $AFTER_DLQ"

if [ "$AFTER_DLQ" -le "$BEFORE_DLQ" ]; then
  echo "No aumentó la DLQ. Revisa logs: docker compose logs --tail=200 notification-service"
  exit 1
fi

log "Verificación en PostgreSQL (processed_events y notifications_log)"
docker exec -i groupsapp-postgres psql -U groupsapp -d "$POSTGRES_NOTIFICATION_DB" -c \
  "SELECT consumer_name,event_id,processed_at FROM notif.processed_events ORDER BY processed_at DESC LIMIT 5;"

docker exec -i groupsapp-postgres psql -U groupsapp -d "$POSTGRES_NOTIFICATION_DB" -c \
  "SELECT event_type,created_at FROM notif.notifications_log ORDER BY log_id DESC LIMIT 5;"

log "Restaurando notification-service a modo normal"
NOTIFICATION_FAIL_MODE=off $COMPOSE_CMD up -d --no-deps --build notification-service

log "Demo DLQ completada"
