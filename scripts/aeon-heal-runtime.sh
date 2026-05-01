#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/var/www/aeondial/backend"
API_NAME="aeondial-api"
WORKER_NAME="aeondial-worker"
API_PORT="3001"
API_ENTRY="dist/index.js"
WORKER_ENTRY="dist/workers/dialer.js"
API_OUT="/var/log/aeondial/api-out.log"
API_ERR="/var/log/aeondial/api-error.log"
WORKER_OUT="/var/log/aeondial/worker-out-1.log"
WORKER_ERR="/var/log/aeondial/worker-error-1.log"
HEALTH_URL="https://api.aeondial.com/health"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "AEON Runtime Heal"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
date -Is

cd "$APP_DIR"

echo
echo "[1/11] Stop worker so it cannot dial during repair..."
pm2 stop "$WORKER_NAME" || true

echo
echo "[2/11] Delete ALL PM2 API records by name/id..."
API_IDS="$(pm2 jlist 2>/dev/null | node -e "
let s='';
process.stdin.on('data', d => s += d);
process.stdin.on('end', () => {
  try {
    const arr = JSON.parse(s || '[]');
    const ids = arr.filter(p => p.name === 'aeondial-api').map(p => p.pm_id);
    console.log(ids.join(' '));
  } catch { console.log('') }
});
")"

if [ -n "$API_IDS" ]; then
  echo "Deleting API PM2 ids: $API_IDS"
  pm2 delete $API_IDS || true
else
  echo "No API PM2 records found."
fi

echo
echo "[3/11] Delete duplicate backend dist/index.js records regardless of name..."
DIST_IDS="$(pm2 jlist 2>/dev/null | node -e "
let s='';
process.stdin.on('data', d => s += d);
process.stdin.on('end', () => {
  try {
    const arr = JSON.parse(s || '[]');
    const ids = arr.filter(p => {
      const path = p?.pm2_env?.pm_exec_path || '';
      return path.endsWith('/dist/index.js');
    }).map(p => p.pm_id);
    console.log(ids.join(' '));
  } catch { console.log('') }
});
")"

if [ -n "$DIST_IDS" ]; then
  echo "Deleting dist/index.js PM2 ids: $DIST_IDS"
  pm2 delete $DIST_IDS || true
else
  echo "No duplicate dist/index.js records found."
fi

echo
echo "[4/11] Kill any process holding port $API_PORT..."
ss -ltnp | grep ":$API_PORT" || true
lsof -i ":$API_PORT" || true
fuser -k "$API_PORT/tcp" || true
sleep 2

echo
echo "[5/11] Verify port $API_PORT is free..."
if ss -ltnp | grep ":$API_PORT"; then
  echo "[AEON_HEAL_FAIL] Port $API_PORT still occupied."
  lsof -i ":$API_PORT" || true
  exit 1
fi

echo
echo "[6/11] Build backend..."
npm run build

echo
echo "[7/11] Start exactly one API process..."
pm2 start "$API_ENTRY" \
  --name "$API_NAME" \
  --cwd "$APP_DIR" \
  --interpreter node \
  --time \
  --output "$API_OUT" \
  --error "$API_ERR" \
  --update-env

sleep 3

echo
echo "[8/11] Verify exactly one API PM2 record..."
API_COUNT="$(pm2 jlist 2>/dev/null | node -e "
let s='';
process.stdin.on('data', d => s += d);
process.stdin.on('end', () => {
  try {
    const arr = JSON.parse(s || '[]');
    console.log(arr.filter(p => p.name === 'aeondial-api').length);
  } catch { console.log('0') }
});
")"

if [ "$API_COUNT" != "1" ]; then
  echo "[AEON_HEAL_FAIL] Expected exactly one aeondial-api, found $API_COUNT"
  pm2 list
  exit 1
fi

echo
echo "[9/11] Restart worker with current env..."
pm2 restart "$WORKER_NAME" --update-env || pm2 start "$WORKER_ENTRY" \
  --name "$WORKER_NAME" \
  --cwd "$APP_DIR" \
  --interpreter node \
  --time \
  --output "$WORKER_OUT" \
  --error "$WORKER_ERR" \
  --update-env

echo
echo "[10/11] Save PM2 and health check..."
pm2 save
pm2 list

HTTP_CODE="$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" || true)"
echo "Health: $HTTP_CODE"

if [ "$HTTP_CODE" != "200" ]; then
  echo "[AEON_HEAL_FAIL] Health check failed."
  pm2 logs "$API_NAME" --lines 80 --nostream || true
  exit 1
fi

echo
echo "[11/11] Flush logs..."
pm2 flush "$API_NAME" || true
pm2 flush "$WORKER_NAME" || true

echo
echo "[AEON_HEAL_OK] Runtime clean. Exactly one API. API healthy. Worker online. Logs flushed."
