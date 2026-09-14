#!/bin/sh
set -eu

result_file="${ALEXA_MEDIA_UPDATE_RESULT_FILE:-${DAILY_UPDATE_TRIGGER_DIR:-/run/daily-update-trigger}/alexa-media-result}"
case "$result_file" in
  /*) ;;
  *) echo "ALEXA_MEDIA_UPDATE_RESULT_FILE must be absolute" >&2; exit 64 ;;
esac
[ -r "$result_file" ] || exit 0

line=$(sed -n '1p' "$result_file" | tr '\r\n' ' ' | cut -c1-700)
status=$(printf '%s' "$line" | sed -n 's/.* status=\(running\|success\|current\|failed\|deferred\|rollback\|conflict\).*/\1/p')
target=$(printf '%s' "$line" | sed -n 's/.* target=\(v[0-9][A-Za-z0-9.+-]*\).*/\1/p')
request_id=$(printf '%s' "$line" | sed -n 's/.* request_id=\([A-Za-z0-9_.:-]*\).*/\1/p')
[ -n "$status" ] || { echo "Alexa Media update result is invalid" >&2; exit 65; }
[ -n "$target" ] || target=unknown
[ -n "$request_id" ] || request_id=unknown
printf 'alexa-media-update status=%s target=%s request_id=%s\n' "$status" "$target" "$request_id"
