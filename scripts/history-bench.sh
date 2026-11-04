#!/usr/bin/env bash
# Starts the app on a database pre-filled with a long history (50k past
# claims, 50k reports, 100k activity rows), then times GET /api/desks and
# measures idle CPU and memory. The app's per-request and per-second cost
# must not grow with history; see CLAUDE.md "Cost stays flat as history grows".
#
#   pnpm bench:history            # prints ms per request, idle CPU, RSS
#
# Fails if a request averages over 50ms or RSS exceeds 200MB (the Fly machine
# has 256MB). Before the fix in this commit: ~450ms and ~380MB.
set -euo pipefail
PORT=8091
DIR=$(mktemp -d)
DB="$DIR/bench.db"
SEED="$(dirname "$0")/history-seed.sql"

start() { DB_PATH="$DB" PORT=$PORT node src/server.ts >/dev/null 2>&1 & echo $!; }
wait_up() { for _ in $(seq 50); do curl -sf "localhost:$PORT/" >/dev/null && return; sleep 0.2; done; echo "app didn't start" >&2; exit 1; }

pid=$(start); wait_up; kill "$pid"; wait "$pid" 2>/dev/null || true
sqlite3 "$DB" < "$SEED"
pid=$(start); wait_up
trap 'kill $pid 2>/dev/null; rm -rf "$DIR"' EXIT

total=0
for _ in $(seq 20); do
  t=$(curl -s -o /dev/null -w "%{time_total}" "localhost:$PORT/api/desks")
  total=$(echo "$total + $t" | bc)
done
ms=$(echo "scale=1; $total * 1000 / 20" | bc)
cpu0=$(ps -o time= -p "$pid"); sleep 10; cpu1=$(ps -o time= -p "$pid")
rss=$(( $(ps -o rss= -p "$pid") / 1024 ))

echo "GET /api/desks: ${ms}ms avg over 20"
echo "idle CPU over 10s: ${cpu0// /} -> ${cpu1// /}"
echo "RSS: ${rss}MB"
fail=0
(( $(echo "$ms > 50" | bc) )) && { echo "✗ requests too slow with long history"; fail=1; }
(( rss > 200 )) && { echo "✗ memory too high for a 256MB machine"; fail=1; }
(( fail == 0 )) && echo "✓ cost is flat with a long history"
exit $fail
