#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080/api/v1}"
WAIT_SECONDS="${WAIT_SECONDS:-60}"
ASYNC_WAIT_SECONDS="${ASYNC_WAIT_SECONDS:-8}"
POSTGRES_MESSAGE_DB="${POSTGRES_MESSAGE_DB:-groupsapp_message}"
POSTGRES_NOTIFICATION_DB="${POSTGRES_NOTIFICATION_DB:-groupsapp_notification}"
API_ONLY="${API_ONLY:-0}"

log() { printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
fail() { printf '\nERROR: %s\n' "$*"; exit 1; }

extract_json_field() {
  local field="$1"
  sed -n "s/.*\"${field}\":\"\([^\"]*\)\".*/\1/p"
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  if [[ "$expected" != "$actual" ]]; then
    fail "$label: esperado=$expected actual=$actual"
  fi
}

assert_non_empty() {
  local value="$1"
  local label="$2"
  [[ -n "$value" ]] || fail "$label vacío"
}

wait_for_gateway() {
  local elapsed=0
  while [[ "$elapsed" -lt "$WAIT_SECONDS" ]]; do
    local status
    status="$(curl -s --max-time 2 -o /dev/null -w '%{http_code}' "$BASE_URL/auth/login" || true)"
    if [[ "$status" != "000" && "$status" != "502" && "$status" != "503" && "$status" != "504" ]]; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

wait_for_db_table() {
  local db="$1"
  local table="$2"
  local elapsed=0
  while [[ "$elapsed" -lt "$WAIT_SECONDS" ]]; do
    local exists
    exists="$(docker exec -i groupsapp-postgres psql -U groupsapp -d "$db" -t -A -c "SELECT to_regclass('$table') IS NOT NULL;" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ "$exists" == "t" ]]; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

request() {
  # Output:
  # line1: HTTP status code
  # line2+: body
  local method="$1"
  local url="$2"
  local data="${3:-}"
  local auth="${4:-}"
  local idem="${5:-}"

  local tmp_body
  tmp_body="$(mktemp)"

  local -a args
  args=(-s -o "$tmp_body" -w '%{http_code}' -X "$method" "$url")

  if [[ -n "$data" ]]; then
    args+=( -H 'Content-Type: application/json' -d "$data" )
  fi
  if [[ -n "$auth" ]]; then
    args+=( -H "Authorization: Bearer $auth" )
  fi
  if [[ -n "$idem" ]]; then
    args+=( -H "Idempotency-Key: $idem" )
  fi

  local status
  status="$(curl "${args[@]}")"
  echo "$status"
  cat "$tmp_body"
  rm -f "$tmp_body"
}

db_scalar() {
  local db="$1"
  local sql="$2"
  docker exec -i groupsapp-postgres psql -U groupsapp -d "$db" -t -A -c "$sql" | tr -d '[:space:]'
}

log "Esperando gateway"
if ! wait_for_gateway; then
  fail "Gateway no responde en $BASE_URL"
fi

if [[ "$API_ONLY" != "1" ]]; then
  log "Esperando tablas de message/notification"
  if ! wait_for_db_table "$POSTGRES_MESSAGE_DB" "msg.outbox"; then
    fail "Tabla msg.outbox no está lista en $POSTGRES_MESSAGE_DB"
  fi
  if ! wait_for_db_table "$POSTGRES_NOTIFICATION_DB" "notif.processed_events"; then
    fail "Tabla notif.processed_events no está lista en $POSTGRES_NOTIFICATION_DB"
  fi
fi

suffix="$(date +%s)-$RANDOM"
ana_email="ana+$suffix@uni.edu"
luis_email="luis+$suffix@uni.edu"
ana_pass="123456"
luis_pass="123456"

if [[ "$API_ONLY" != "1" ]]; then
  log "Snapshot contadores iniciales"
  outbox_before="$(db_scalar "$POSTGRES_MESSAGE_DB" "SELECT COUNT(*) FROM msg.outbox;")"
  processed_before="$(db_scalar "$POSTGRES_NOTIFICATION_DB" "SELECT COUNT(*) FROM notif.processed_events;")"
  notif_before="$(db_scalar "$POSTGRES_NOTIFICATION_DB" "SELECT COUNT(*) FROM notif.notifications_log;")"
fi

log "Register Ana"
raw="$(request POST "$BASE_URL/auth/register" "{\"email\":\"$ana_email\",\"password\":\"$ana_pass\",\"display_name\":\"Ana\"}")"
status="$(echo "$raw" | sed -n '1p')"
body="$(echo "$raw" | sed -n '2,$p')"
assert_eq "201" "$status" "register Ana"
ana_user_id="$(echo "$body" | extract_json_field user_id)"
assert_non_empty "$ana_user_id" "ana_user_id"

log "Duplicate register Ana => 409"
raw="$(request POST "$BASE_URL/auth/register" "{\"email\":\"$ana_email\",\"password\":\"$ana_pass\",\"display_name\":\"Ana\"}")"
status="$(echo "$raw" | sed -n '1p')"
body="$(echo "$raw" | sed -n '2,$p')"
assert_eq "409" "$status" "duplicate register Ana"
echo "$body" | grep -q 'AUTH_EMAIL_EXISTS' || fail "mensaje esperado AUTH_EMAIL_EXISTS"

log "Register Luis"
raw="$(request POST "$BASE_URL/auth/register" "{\"email\":\"$luis_email\",\"password\":\"$luis_pass\",\"display_name\":\"Luis\"}")"
status="$(echo "$raw" | sed -n '1p')"
body="$(echo "$raw" | sed -n '2,$p')"
assert_eq "201" "$status" "register Luis"
luis_user_id="$(echo "$body" | extract_json_field user_id)"
assert_non_empty "$luis_user_id" "luis_user_id"

log "Login Ana"
raw="$(request POST "$BASE_URL/auth/login" "{\"email\":\"$ana_email\",\"password\":\"$ana_pass\"}")"
status="$(echo "$raw" | sed -n '1p')"
body="$(echo "$raw" | sed -n '2,$p')"
assert_eq "201" "$status" "login Ana"
token_ana="$(echo "$body" | extract_json_field access_token)"
assert_non_empty "$token_ana" "token_ana"

log "Login Luis"
raw="$(request POST "$BASE_URL/auth/login" "{\"email\":\"$luis_email\",\"password\":\"$luis_pass\"}")"
status="$(echo "$raw" | sed -n '1p')"
body="$(echo "$raw" | sed -n '2,$p')"
assert_eq "201" "$status" "login Luis"
token_luis="$(echo "$body" | extract_json_field access_token)"
assert_non_empty "$token_luis" "token_luis"

log "Presencia automática tras login"
raw="$(request GET "$BASE_URL/presence/$ana_user_id" "" "$token_luis")"
status="$(echo "$raw" | sed -n '1p')"
body="$(echo "$raw" | sed -n '2,$p')"
assert_eq "200" "$status" "get presence auto online"
echo "$body" | grep -q '"online":true' || fail "presence online esperado true"

log "Heartbeat de presencia (sin botón manual)"
raw="$(request POST "$BASE_URL/presence/heartbeat" "" "$token_ana")"
status="$(echo "$raw" | sed -n '1p')"
assert_eq "200" "$status" "presence heartbeat"

log "DM sin contacto => 403"
raw="$(request POST "$BASE_URL/messages/direct/$luis_user_id" '{"body":"hola directo"}' "$token_ana" 'idem-dm-blocked')"
status="$(echo "$raw" | sed -n '1p')"
assert_eq "403" "$status" "dm sin contacto"

log "Agregar contacto Ana -> Luis"
raw="$(request POST "$BASE_URL/users/contacts" "{\"contact_user_id\":\"$luis_user_id\"}" "$token_ana")"
status="$(echo "$raw" | sed -n '1p')"
assert_eq "201" "$status" "add contact"

log "Agregar contacto a sí mismo => 400"
raw="$(request POST "$BASE_URL/users/contacts" "{\"contact_user_id\":\"$ana_user_id\"}" "$token_ana")"
status="$(echo "$raw" | sed -n '1p')"
assert_eq "400" "$status" "self contact"

log "DM con contacto + idempotencia"
raw_dm1="$(request POST "$BASE_URL/messages/direct/$luis_user_id" '{"body":"hola directo ok"}' "$token_ana" 'idem-dm-1')"
status_dm1="$(echo "$raw_dm1" | sed -n '1p')"
body_dm1="$(echo "$raw_dm1" | sed -n '2,$p')"
assert_eq "201" "$status_dm1" "dm send 1"
dm1_id="$(echo "$body_dm1" | extract_json_field message_id)"
assert_non_empty "$dm1_id" "dm1_id"

raw_dm2="$(request POST "$BASE_URL/messages/direct/$luis_user_id" '{"body":"hola directo duplicado"}' "$token_ana" 'idem-dm-1')"
status_dm2="$(echo "$raw_dm2" | sed -n '1p')"
body_dm2="$(echo "$raw_dm2" | sed -n '2,$p')"
assert_eq "201" "$status_dm2" "dm send 2 idem"
dm2_id="$(echo "$body_dm2" | extract_json_field message_id)"
assert_eq "$dm1_id" "$dm2_id" "idempotencia dm"

log "Listar DM"
raw="$(request GET "$BASE_URL/messages/direct/$luis_user_id?limit=20" "" "$token_ana")"
status="$(echo "$raw" | sed -n '1p')"
body="$(echo "$raw" | sed -n '2,$p')"
assert_eq "200" "$status" "listar dm"
echo "$body" | grep -q "$dm1_id" || fail "listar dm no incluye mensaje"

log "Marcar delivered/read"
raw="$(request POST "$BASE_URL/messages/$dm1_id/delivered" "" "$token_luis")"
status="$(echo "$raw" | sed -n '1p')"
assert_eq "201" "$status" "mark delivered"
raw="$(request POST "$BASE_URL/messages/$dm1_id/read" "" "$token_luis")"
status="$(echo "$raw" | sed -n '1p')"
assert_eq "201" "$status" "mark read"

log "Idempotencia delivered/read (segundo intento no duplica)"
raw="$(request POST "$BASE_URL/messages/$dm1_id/delivered" "" "$token_luis")"
status="$(echo "$raw" | sed -n '1p')"
assert_eq "201" "$status" "mark delivered idem"
raw="$(request POST "$BASE_URL/messages/$dm1_id/read" "" "$token_luis")"
status="$(echo "$raw" | sed -n '1p')"
assert_eq "201" "$status" "mark read idem"

if [[ "$API_ONLY" != "1" ]]; then
  delivery_count="$(db_scalar "$POSTGRES_MESSAGE_DB" "SELECT COUNT(*) FROM msg.delivery_receipts WHERE message_id = '$dm1_id' AND user_id = '$luis_user_id';")"
  read_count="$(db_scalar "$POSTGRES_MESSAGE_DB" "SELECT COUNT(*) FROM msg.read_receipts WHERE message_id = '$dm1_id' AND user_id = '$luis_user_id';")"
  assert_eq "1" "$delivery_count" "delivery_receipts idempotencia"
  assert_eq "1" "$read_count" "read_receipts idempotencia"
fi

log "Bloqueo Luis -> Ana"
raw="$(request POST "$BASE_URL/users/blocks" "{\"blocked_user_id\":\"$ana_user_id\"}" "$token_luis")"
status="$(echo "$raw" | sed -n '1p')"
assert_eq "201" "$status" "block user"

log "DM bloqueado en ambos sentidos => 403"
raw="$(request POST "$BASE_URL/messages/direct/$luis_user_id" '{"body":"no debe pasar"}' "$token_ana" 'idem-dm-after-block-a')"
status="$(echo "$raw" | sed -n '1p')"
assert_eq "403" "$status" "dm blocked ana->luis"
raw="$(request POST "$BASE_URL/messages/direct/$ana_user_id" '{"body":"no debe pasar"}' "$token_luis" 'idem-dm-after-block-l')"
status="$(echo "$raw" | sed -n '1p')"
assert_eq "403" "$status" "dm blocked luis->ana"

log "Crear grupo A"
raw="$(request POST "$BASE_URL/groups" '{"name":"grupo-A","description":"test"}' "$token_ana")"
status="$(echo "$raw" | sed -n '1p')"
body="$(echo "$raw" | sed -n '2,$p')"
assert_eq "201" "$status" "crear grupo A"
group_a="$(echo "$body" | extract_json_field group_id)"
assert_non_empty "$group_a" "group_a"

log "Agregar Luis a grupo A"
raw="$(request POST "$BASE_URL/groups/$group_a/members" "{\"member_user_id\":\"$luis_user_id\"}" "$token_ana")"
status="$(echo "$raw" | sed -n '1p')"
assert_eq "201" "$status" "add member grupo A"

log "Crear canal en grupo A"
raw="$(request POST "$BASE_URL/groups/$group_a/channels" '{"name":"canal-dev","description":"Canal de desarrollo"}' "$token_ana")"
status="$(echo "$raw" | sed -n '1p')"
body="$(echo "$raw" | sed -n '2,$p')"
assert_eq "201" "$status" "create channel grupo A"
channel_a="$(echo "$body" | extract_json_field channel_id)"
assert_non_empty "$channel_a" "channel_a"

log "Listar canales de grupo A"
raw="$(request GET "$BASE_URL/groups/$group_a/channels" "" "$token_luis")"
status="$(echo "$raw" | sed -n '1p')"
body="$(echo "$raw" | sed -n '2,$p')"
assert_eq "200" "$status" "list channels grupo A"
echo "$body" | grep -q "$channel_a" || fail "list channels no incluye channel_a"

log "Enviar en canal creado (Luis aún miembro)"
raw="$(request POST "$BASE_URL/messages/channels/$channel_a" '{"body":"hola canal dev"}' "$token_luis" 'idem-channel-a-luis')"
status="$(echo "$raw" | sed -n '1p')"
assert_eq "201" "$status" "send msg channel_a luis"

log "Sacar Luis del grupo A"
raw="$(request DELETE "$BASE_URL/groups/$group_a/members/$luis_user_id" "" "$token_ana")"
status="$(echo "$raw" | sed -n '1p')"
assert_eq "200" "$status" "remove member grupo A"

log "Luis ya no puede enviar en grupo A => 403"
raw="$(request POST "$BASE_URL/messages/channels/$group_a" '{"body":"mensaje no permitido"}' "$token_luis" 'idem-removed-member')"
status="$(echo "$raw" | sed -n '1p')"
assert_eq "403" "$status" "send after remove member"

log "Luis ya no puede enviar en canal creado => 403"
raw="$(request POST "$BASE_URL/messages/channels/$channel_a" '{"body":"mensaje no permitido en canal"}' "$token_luis" 'idem-removed-member-channel')"
status="$(echo "$raw" | sed -n '1p')"
assert_eq "403" "$status" "send after remove member channel"

log "Idempotencia en mismo canal (debe devolver mismo message_id)"
raw1="$(request POST "$BASE_URL/messages/channels/$group_a" '{"body":"hola-a"}' "$token_ana" 'idem-shared')"
status1="$(echo "$raw1" | sed -n '1p')"
body1="$(echo "$raw1" | sed -n '2,$p')"
assert_eq "201" "$status1" "send msg1 grupo A"
msg1_id="$(echo "$body1" | extract_json_field message_id)"
assert_non_empty "$msg1_id" "msg1_id"

raw2="$(request POST "$BASE_URL/messages/channels/$group_a" '{"body":"hola-a-duplicado"}' "$token_ana" 'idem-shared')"
status2="$(echo "$raw2" | sed -n '1p')"
body2="$(echo "$raw2" | sed -n '2,$p')"
assert_eq "201" "$status2" "send msg2 grupo A idem"
msg2_id="$(echo "$body2" | extract_json_field message_id)"
assert_eq "$msg1_id" "$msg2_id" "idempotencia mismo canal"

log "Crear grupo B"
raw="$(request POST "$BASE_URL/groups" '{"name":"grupo-B","description":"test"}' "$token_ana")"
status="$(echo "$raw" | sed -n '1p')"
body="$(echo "$raw" | sed -n '2,$p')"
assert_eq "201" "$status" "crear grupo B"
group_b="$(echo "$body" | extract_json_field group_id)"
assert_non_empty "$group_b" "group_b"

log "Idempotencia en canal distinto (debe crear message_id nuevo)"
raw3="$(request POST "$BASE_URL/messages/channels/$group_b" '{"body":"hola-b"}' "$token_ana" 'idem-shared')"
status3="$(echo "$raw3" | sed -n '1p')"
body3="$(echo "$raw3" | sed -n '2,$p')"
assert_eq "201" "$status3" "send msg grupo B"
msg3_id="$(echo "$body3" | extract_json_field message_id)"
assert_non_empty "$msg3_id" "msg3_id"
if [[ "$msg3_id" == "$msg1_id" ]]; then
  fail "idempotencia mal scopeada: mismo message_id en canal distinto"
fi

log "Esperar pipeline outbox -> consumer"
sleep "$ASYNC_WAIT_SECONDS"

if [[ "$API_ONLY" != "1" ]]; then
  outbox_after="$(db_scalar "$POSTGRES_MESSAGE_DB" "SELECT COUNT(*) FROM msg.outbox;")"
  processed_after="$(db_scalar "$POSTGRES_NOTIFICATION_DB" "SELECT COUNT(*) FROM notif.processed_events;")"
  notif_after="$(db_scalar "$POSTGRES_NOTIFICATION_DB" "SELECT COUNT(*) FROM notif.notifications_log;")"

  outbox_delta=$((outbox_after - outbox_before))
  processed_delta=$((processed_after - processed_before))
  notif_delta=$((notif_after - notif_before))

  echo "outbox_delta=$outbox_delta processed_delta=$processed_delta notif_delta=$notif_delta"

  if (( outbox_delta < 5 )); then
    fail "outbox_delta esperado >= 5"
  fi
  if (( processed_delta < 2 )); then
    fail "processed_delta esperado >= 2"
  fi
  if (( notif_delta < 2 )); then
    fail "notif_delta esperado >= 2"
  fi
else
  echo "API_ONLY=1: se omiten validaciones internas de PostgreSQL/outbox/consumer."
fi

log "OK: integration test completado"
