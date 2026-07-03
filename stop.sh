#!/bin/bash
# stop.sh — Para o proxy (funciona para foreground e daemon).

PROXY_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="${PROXY_DIR}/proxy.pid"
LOG_FILE="${PROXY_DIR}/proxy.log"

stoped_something=false

# 1. Tenta parar via PID file (daemon)
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    sleep 2
    kill -9 "$PID" 2>/dev/null
    echo "✅ Proxy stopped (daemon PID $PID)"
    stoped_something=true
  else
    echo "ℹ️  PID file exists but process not running"
  fi
  rm -f "$PID_FILE"
fi

# 2. Mata instâncias foreground que não tenham PID file (busca por padrão)
if command -v pgrep &>/dev/null; then
  PIDS=$(pgrep -f "node.*${PROXY_DIR}/index.js" 2>/dev/null)
  if [ -n "$PIDS" ]; then
    echo "$PIDS" | while read -r pid; do
      kill "$pid" 2>/dev/null
      echo "✅ Killed foreground instance (PID $pid)"
    done
    stoped_something=true
  fi
fi

# 3. Último recurso: pkill amplo
if [ "$stoped_something" = false ]; then
  if pkill -f "node.*index.js" 2>/dev/null; then
    echo "✅ Proxy stopped (by pattern)"
    stoped_something=true
  fi
fi

if [ "$stoped_something" = false ]; then
  echo "ℹ️  No proxy running"
fi

echo ""
echo "To see recent logs:"
echo "  tail -n 50 ${LOG_FILE}"
