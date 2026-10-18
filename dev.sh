#!/usr/bin/env bash
# Fire-3d dev runner: backend API on :8710 + Vite on :5173 together; Ctrl-C stops both.
#
#   ./dev.sh             real API  (uvicorn fire3d.api.app:app; live refresh loop + live auto-build on)
#   ./dev.sh --no-live   real API without the live refresh loop / auto-build (FIRE3D_LIVE=0)
#   ./dev.sh --reload    real API that restarts when backend code changes (for backend development). A restart kills
#                        builds in progress, so live auto-build is off unless FIRE3D_AUTO_BUILD_LIVE=1 is set.
#   ./dev.sh --fixture   fixture server instead (backend/scripts/serve_fixture.py, bundles from disk)
#   Options combine, e.g. ./dev.sh --reload --no-live.
#
# Env: API_PORT (8710), WEB_PORT (5173), VITE_API_TARGET (default http://localhost:$API_PORT),
#      FIRE3D_DATA_DIR / FIRE3D_CACHE_DIR (backend data locations), FIRE3D_LIVE, FIRE3D_AUTO_BUILD_LIVE.
# Port 8000 belongs to another local app: never use it for Fire-3d.
set -uo pipefail
set -m   # job control: each background job gets its own process group, so cleanup can kill whole trees

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_PORT="${API_PORT:-8710}"
WEB_PORT="${WEB_PORT:-5173}"
MODE="api"
RELOAD=0
for arg in "$@"; do
  case "$arg" in
    --fixture) MODE="fixture" ;;
    --no-live) export FIRE3D_LIVE=0 ;;
    --reload) RELOAD=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done
RELOAD_ARGS=()
if [[ "$RELOAD" == "1" ]]; then
  RELOAD_ARGS=(--reload --reload-dir fire3d)
  export FIRE3D_AUTO_BUILD_LIVE="${FIRE3D_AUTO_BUILD_LIVE:-0}"   # a code reload would kill builds in progress
fi
if [[ "$API_PORT" == "8000" || "$WEB_PORT" == "8000" ]]; then
  echo "dev.sh: port 8000 is used by another local app; pick another port (default API 8710)" >&2
  exit 2
fi

PIDS=()
cleanup() {
  trap - INT TERM EXIT
  echo
  echo "dev.sh: stopping..."
  for pid in "${PIDS[@]:-}"; do
    [[ -n "$pid" ]] && kill -TERM -- "-$pid" 2>/dev/null
  done
  sleep 1
  for pid in "${PIDS[@]:-}"; do
    [[ -n "$pid" ]] && kill -KILL -- "-$pid" 2>/dev/null
  done
  exit 0
}
trap cleanup INT TERM EXIT

if [[ "$MODE" == "fixture" ]]; then
  (cd "$ROOT/backend" && exec uv run python scripts/serve_fixture.py --port "$API_PORT") &
else
  (cd "$ROOT/backend" && exec uv run uvicorn fire3d.api.app:app ${RELOAD_ARGS[@]+"${RELOAD_ARGS[@]}"} --host 127.0.0.1 --port "$API_PORT") &
fi
PIDS+=("$!")

(cd "$ROOT/web" && PORT="$WEB_PORT" VITE_API_TARGET="${VITE_API_TARGET:-http://localhost:$API_PORT}" exec npm run dev) &
PIDS+=("$!")

LIVE_NOTE=""
if [[ "$MODE" == "api" ]]; then
  if [[ "${FIRE3D_LIVE:-1}" =~ ^(0|false|no|off)$ ]]; then LIVE_NOTE=" (live loop off)"; else LIVE_NOTE=" (live loop on; --no-live to disable)"; fi
  if [[ "$RELOAD" == "1" ]]; then LIVE_NOTE="$LIVE_NOTE (auto-reload; live auto-build ${FIRE3D_AUTO_BUILD_LIVE})"; fi
fi
echo "dev.sh: API ($MODE$LIVE_NOTE) on http://127.0.0.1:$API_PORT   web on http://localhost:$WEB_PORT   (Ctrl-C to stop)"
wait
