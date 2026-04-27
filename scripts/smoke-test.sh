#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080/api/v1}"
ANA_EMAIL="${ANA_EMAIL:-ana@uni.edu}"
ANA_PASS="${ANA_PASS:-123456}"
ANA_NAME="${ANA_NAME:-Ana}"
LUIS_EMAIL="${LUIS_EMAIL:-luis@uni.edu}"
LUIS_PASS="${LUIS_PASS:-123456}"
LUIS_NAME="${LUIS_NAME:-Luis}"

log() { printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
fail() { printf '\nERROR: %s\n' "$*"; exit 1; }
extract_json_field() {
  # Uso simple para payloads planos como: "field":"value"
  local field="$1"
  sed -n "s/.*\"${field}\":\"\([^\"]*\)\".*/\1/p"
}

post_json() {
  local url="$1"
  local data="$2"
  local auth="${3:-}"
  if [[ -n "$auth" ]]; then
    curl -s -X POST "$url" -H "Authorization: Bearer $auth" -H 'Content-Type: application/json' -d "$data"
  else
    curl -s -X POST "$url" -H 'Content-Type: application/json' -d "$data"
  fi
}

get_json() {
  local url="$1"
  local auth="${2:-}"
  if [[ -n "$auth" ]]; then
    curl -s "$url" -H "Authorization: Bearer $auth"
  else
    curl -s "$url"
  fi
}

wait_for_gateway() {
  local max_wait="${1:-60}"
  local elapsed=0

  while [[ "$elapsed" -lt "$max_wait" ]]; do
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

log "Health check gateway (espera activa)"
if ! wait_for_gateway 60; then
  fail "Gateway no responde en $BASE_URL después de 60s. Verifica que api-gateway y auth-service estén arriba."
fi

log "Register Ana"
REG_ANA="$(post_json "$BASE_URL/auth/register" "{\"email\":\"$ANA_EMAIL\",\"password\":\"$ANA_PASS\",\"display_name\":\"$ANA_NAME\"}")"
echo "$REG_ANA"

log "Register Luis"
REG_LUIS="$(post_json "$BASE_URL/auth/register" "{\"email\":\"$LUIS_EMAIL\",\"password\":\"$LUIS_PASS\",\"display_name\":\"$LUIS_NAME\"}")"
echo "$REG_LUIS"

log "Login Ana"
LOGIN_ANA="$(post_json "$BASE_URL/auth/login" "{\"email\":\"$ANA_EMAIL\",\"password\":\"$ANA_PASS\"}")"
echo "$LOGIN_ANA"
TOKEN_ANA="$(echo "$LOGIN_ANA" | extract_json_field access_token)"
USER_ANA="$(echo "$LOGIN_ANA" | extract_json_field user_id)"
[[ -n "$TOKEN_ANA" ]] || fail "No se pudo extraer TOKEN_ANA del login"
[[ -n "$USER_ANA" ]] || fail "No se pudo extraer USER_ANA del login"

log "Login Luis"
LOGIN_LUIS="$(post_json "$BASE_URL/auth/login" "{\"email\":\"$LUIS_EMAIL\",\"password\":\"$LUIS_PASS\"}")"
echo "$LOGIN_LUIS"
TOKEN_LUIS="$(echo "$LOGIN_LUIS" | extract_json_field access_token)"
USER_LUIS="$(echo "$LOGIN_LUIS" | extract_json_field user_id)"
[[ -n "$TOKEN_LUIS" ]] || fail "No se pudo extraer TOKEN_LUIS del login"
[[ -n "$USER_LUIS" ]] || fail "No se pudo extraer USER_LUIS del login"

log "Crear grupo con Ana"
GROUP_RAW="$(post_json "$BASE_URL/groups" '{"name":"grupo-telematica","description":"Proyecto final"}' "$TOKEN_ANA")"
echo "$GROUP_RAW"
GROUP_ID="$(echo "$GROUP_RAW" | extract_json_field group_id)"
[[ -n "$GROUP_ID" ]] || fail "No se pudo extraer GROUP_ID. Respuesta: $GROUP_RAW"

log "Agregar Luis al grupo"
ADD_RAW="$(post_json "$BASE_URL/groups/$GROUP_ID/members" "{\"member_user_id\":\"$USER_LUIS\"}" "$TOKEN_ANA")"
echo "$ADD_RAW"

log "Crear canal en grupo"
CHANNEL_RAW="$(post_json "$BASE_URL/groups/$GROUP_ID/channels" '{"name":"canal-dev","description":"Canal de desarrollo"}' "$TOKEN_ANA")"
echo "$CHANNEL_RAW"
CHANNEL_ID="$(echo "$CHANNEL_RAW" | extract_json_field channel_id)"
[[ -n "$CHANNEL_ID" ]] || fail "No se pudo extraer CHANNEL_ID. Respuesta: $CHANNEL_RAW"

log "Listar canales del grupo"
CHANNELS_LIST="$(get_json "$BASE_URL/groups/$GROUP_ID/channels" "$TOKEN_ANA")"
echo "$CHANNELS_LIST"

log "Enviar mensaje Ana"
MSG_ANA="$(curl -s -X POST "$BASE_URL/messages/channels/$CHANNEL_ID" \
  -H "Authorization: Bearer $TOKEN_ANA" \
  -H 'Idempotency-Key: msg-ana-1' \
  -H 'Content-Type: application/json' \
  -d '{"body":"Hola equipo"}')"
echo "$MSG_ANA"

log "Enviar mensaje Luis"
MSG_LUIS="$(curl -s -X POST "$BASE_URL/messages/channels/$CHANNEL_ID" \
  -H "Authorization: Bearer $TOKEN_LUIS" \
  -H 'Idempotency-Key: msg-luis-1' \
  -H 'Content-Type: application/json' \
  -d '{"body":"Listo, conectado"}')"
echo "$MSG_LUIS"

log "Listar mensajes"
HISTORY="$(get_json "$BASE_URL/messages/channels/$CHANNEL_ID?limit=20" "$TOKEN_ANA")"
echo "$HISTORY"

log "OK: smoke test completado"
