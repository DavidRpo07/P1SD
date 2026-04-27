#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080/api/v1}"

log() { printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
fail() { printf '\nERROR: %s\n' "$*"; exit 1; }

extract_json_field() {
  local field="$1"
  sed -n "s/.*\"${field}\":\"\([^\"]*\)\".*/\1/p"
}

request() {
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

  local http_code
  http_code="$(curl "${args[@]}")"
  echo "$http_code"
  cat "$tmp_body"
  rm -f "$tmp_body"
}

log "Health check gateway"
status="$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/auth/login" || true)"
if [[ "$status" == "000" || "$status" == "502" || "$status" == "503" || "$status" == "504" ]]; then
  fail "Gateway no disponible en $BASE_URL"
fi

suffix="$(date +%s)-$RANDOM"
ana_email="anafile+$suffix@uni.edu"
ana_pass="123456"

log "Register + Login"
raw="$(request POST "$BASE_URL/auth/register" "{\"email\":\"$ana_email\",\"password\":\"$ana_pass\",\"display_name\":\"Ana File\"}")"
status="$(echo "$raw" | sed -n '1p')"
[[ "$status" == "201" ]] || fail "register failed: $raw"

raw="$(request POST "$BASE_URL/auth/login" "{\"email\":\"$ana_email\",\"password\":\"$ana_pass\"}")"
status="$(echo "$raw" | sed -n '1p')"
body="$(echo "$raw" | sed -n '2,$p')"
[[ "$status" == "201" ]] || fail "login failed: $raw"
token_ana="$(echo "$body" | extract_json_field access_token)"
[[ -n "$token_ana" ]] || fail "token vacío"

log "Crear grupo"
raw="$(request POST "$BASE_URL/groups" '{"name":"grupo-files","description":"test adjuntos"}' "$token_ana")"
status="$(echo "$raw" | sed -n '1p')"
body="$(echo "$raw" | sed -n '2,$p')"
[[ "$status" == "201" ]] || fail "create group failed: $raw"
group_id="$(echo "$body" | extract_json_field group_id)"
[[ -n "$group_id" ]] || fail "group_id vacío"

FILE_PATH="/tmp/groupsapp-demo-attach.txt"
echo "hola archivo $(date +%s)" > "$FILE_PATH"
FILE_SIZE="$(wc -c < "$FILE_PATH" | tr -d ' ')"

log "Crear upload URL"
raw="$(request POST "$BASE_URL/files/upload-url" "{\"file_name\":\"demo.txt\",\"content_type\":\"text/plain\",\"size_bytes\":$FILE_SIZE}" "$token_ana")"
status="$(echo "$raw" | sed -n '1p')"
body="$(echo "$raw" | sed -n '2,$p')"
[[ "$status" == "201" ]] || fail "upload-url failed: $raw"
attachment_id="$(echo "$body" | extract_json_field attachment_id)"
upload_url="$(echo "$body" | extract_json_field upload_url)"
[[ -n "$attachment_id" ]] || fail "attachment_id vacío"
[[ -n "$upload_url" ]] || fail "upload_url vacío"

log "Subir archivo a S3"
upload_status="$(curl -s -o /tmp/groupsapp-upload-response.txt -w '%{http_code}' -X PUT "$upload_url" -H 'Content-Type: text/plain' --data-binary "@$FILE_PATH")"
[[ "$upload_status" == "200" ]] || fail "upload PUT falló con status=$upload_status"

log "Completar upload"
raw="$(request POST "$BASE_URL/files/$attachment_id/complete" "" "$token_ana")"
status="$(echo "$raw" | sed -n '1p')"
[[ "$status" == "201" ]] || fail "complete failed: $raw"

log "Enviar mensaje con attachment_ids"
raw="$(request POST "$BASE_URL/messages/channels/$group_id" "{\"body\":\"mensaje con archivo\",\"attachment_ids\":[\"$attachment_id\"]}" "$token_ana" "idem-file-$suffix")"
status="$(echo "$raw" | sed -n '1p')"
body="$(echo "$raw" | sed -n '2,$p')"
[[ "$status" == "201" ]] || fail "send message failed: $raw"
echo "$body" | grep -q "$attachment_id" || fail "el attachment no apareció en SendMessageResponse"

log "Listar mensajes y validar adjunto"
raw="$(request GET "$BASE_URL/messages/channels/$group_id?limit=20" "" "$token_ana")"
status="$(echo "$raw" | sed -n '1p')"
body="$(echo "$raw" | sed -n '2,$p')"
[[ "$status" == "200" ]] || fail "list messages failed: $raw"
echo "$body" | grep -q "$attachment_id" || fail "el attachment no apareció en listado"

log "OK: file-attachment-test completado"
echo "attachment_id=$attachment_id"
