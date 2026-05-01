#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/var/www/aeondial/backend"
API_NAME="aeondial-api"
WORKER_NAME="aeondial-worker"
PORT="3001"
HEALTH_URL="https://api.aeondial.com/health"
HEAL_SCRIPT="$APP_DIR/scripts/aeon-heal-runtime.sh"
LOCK_FILE="/tmp/aeon-runtime-watchdog.lock"
LOG_FILE="/var/log/aeondial/aeon-watchdog.log"

mkdir -p /var/log/aeondial

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "$(date -Is) [WATCHDOG_SKIP] Another watchdog run is active." >> "$LOG_FILE"
  exit 0
fi

cd "$APP_DIR"

log() {
  echo "$(date -Is) $*" | tee -a "$LOG_FILE"
}

pm2_status() {
  pm2 jlist 2>/dev/null | node -e "
let s='';
process.stdin.on('data',d=>s+=d);
process.stdin.on('end',()=>{
  try {
    const arr=JSON.parse(s || '[]');
    const p=arr.find(x=>x.name===process.argv[1]);
    console.log(p?.pm2_env?.status || 'missing');
  } catch(e) { console.log('unknown') }
});
" "$1"
}

pm2_count_by_name() {
  pm2 jlist 2>/dev/null | node -e "
let s='';
process.stdin.on('data',d=>s+=d);
process.stdin.on('end',()=>{
  try {
    const arr=JSON.parse(s || '[]');
    console.log(arr.filter(x=>x.name===process.argv[1]).length);
  } catch(e) { console.log('0') }
});
" "$1"
}

PORT_PIDS="$(lsof -ti tcp:"$PORT" 2>/dev/null | tr '\n' ' ' | xargs || true)"
PORT_COUNT="$(lsof -ti tcp:"$PORT" 2>/dev/null | wc -l | tr -d ' ')"
API_STATUS="$(pm2_status "$API_NAME")"
WORKER_STATUS="$(pm2_status "$WORKER_NAME")"
API_COUNT="$(pm2_count_by_name "$API_NAME")"
HTTP_CODE="$(curl -s --max-time 4 -o /dev/null -w "%{http_code}" "$HEALTH_URL" || true)"

NEEDS_HEAL=0
REASONS=()

if [ "$API_COUNT" != "1" ]; then
  NEEDS_HEAL=1
  REASONS+=("api_count=$API_COUNT")
fi

if [ "$API_STATUS" != "online" ]; then
  NEEDS_HEAL=1
  REASONS+=("api_status=$API_STATUS")
fi

if [ "$WORKER_STATUS" != "online" ]; then
  NEEDS_HEAL=1
  REASONS+=("worker_status=$WORKER_STATUS")
fi

if [ "$HTTP_CODE" != "200" ]; then
  NEEDS_HEAL=1
  REASONS+=("health=$HTTP_CODE")
fi

if [ "$PORT_COUNT" -gt 1 ]; then
  NEEDS_HEAL=1
  REASONS+=("multiple_port_${PORT}_listeners=$PORT_PIDS")
fi

if [ "$NEEDS_HEAL" -eq 0 ]; then
  log "[WATCHDOG_OK] api=$API_STATUS api_count=$API_COUNT worker=$WORKER_STATUS health=$HTTP_CODE port_count=$PORT_COUNT port_pids=${PORT_PIDS:-none}"
  exit 0
fi

log "[WATCHDOG_HEAL] reasons=${REASONS[*]}"

if "$HEAL_SCRIPT" >> "$LOG_FILE" 2>&1; then
  log "[WATCHDOG_HEAL_OK]"
  exit 0
else
  log "[WATCHDOG_HEAL_FAIL]"
  exit 1
fi
