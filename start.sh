#!/bin/bash
# start.sh — Inicia o proxy em modo foreground (interativo) ou daemon (background).

PROXY_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="${PROXY_DIR}/proxy.log"
PID_FILE="${PROXY_DIR}/proxy.pid"

# Cores para o menu
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Parse de argumentos
MODE=""
case "${1:-}" in
  --foreground|-f)
    MODE="foreground"
    ;;
  --daemon|-d)
    MODE="daemon"
    ;;
  --help|-h)
    echo "Uso: $0 [OPÇÃO]"
    echo ""
    echo "Opções:"
    echo "  --foreground, -f   Executa no terminal atual (logs visíveis, Ctrl+C para parar)"
    echo "  --daemon,    -d   Executa em background (use ./stop.sh para parar)"
    echo "  --help,      -h   Mostra esta ajuda"
    echo ""
    echo "Sem argumentos: exibe menu interativo."
    exit 0
    ;;
  "")
    # Sem argumentos: mostra menu interativo
    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║     🚀 nvidia-opencode-proxy — Inicialização ║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════════╝${NC}"
    echo ""
    echo "Como deseja executar o proxy?"
    echo ""
    echo -e "  ${GREEN}1)${NC} Foreground — logs no terminal, ${YELLOW}Ctrl+C${NC} para parar"
    echo -e "  ${GREEN}2)${NC} Daemon    — roda em background, use ${YELLOW}./stop.sh${NC} para parar"
    echo ""
    read -p "Escolha (1 ou 2): " choice
    case "$choice" in
      1) MODE="foreground" ;;
      2) MODE="daemon" ;;
      *) echo "❌ Opção inválida. Use 1 ou 2."; exit 1 ;;
    esac
    ;;
  *)
    echo "❌ Opção desconhecida: $1"
    echo "Use --help para ver as opções disponíveis."
    exit 1
    ;;
esac

# Se já houver um daemon rodando, mata antes
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "🔄 Parando instância anterior (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null
    sleep 1
    kill -9 "$OLD_PID" 2>/dev/null
  fi
  rm -f "$PID_FILE"
fi
pkill -9 -f "node.*index.js" 2>/dev/null
sleep 1

# Trunca o log
: > "$LOG_FILE"

if [ "$MODE" = "foreground" ]; then
  # ── MODO FOREGROUND ──────────────────────────────────────────
  echo ""
  echo -e "${GREEN}✅ Iniciando em modo FOREGROUND${NC}"
  echo -e "   Logs aparecem aqui no terminal."
  echo -e "   Pressione ${YELLOW}Ctrl+C${NC} para parar."
  echo ""
  cd "$PROXY_DIR"
  exec node index.js
else
  # ── MODO DAEMON ──────────────────────────────────────────────
  echo ""
  echo -e "${GREEN}✅ Iniciando em modo DAEMON${NC}"
  echo -e "   Logs salvos em: ${CYAN}${LOG_FILE}${NC}"
  echo ""

  # Double-fork: parent forks child, child forks grandchild and exits.
  # Grandchild é reparentado para o init (PID 1) e fica totalmente desanexado.
  (
    (
      cd "$PROXY_DIR"
      exec node index.js >> "$LOG_FILE" 2>&1
    ) &
    echo $! > "$PID_FILE"
    exit
  ) &

  sleep 2

  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
      echo -e "   Proxy ativo! PID: ${CYAN}${PID}${NC}"
      echo ""
      read -p "Acompanhar log em tempo real? (s/n): " tail_choice
      case "$tail_choice" in
        s|S|sim|SIM)
          echo ""
          echo -e "${YELLOW}── Log em tempo real (Ctrl+C para sair do log, proxy continua) ──${NC}"
          echo ""
          tail -f "$LOG_FILE"
          ;;
        *)
          echo ""
          echo "Para ver os logs:  tail -f $LOG_FILE"
          echo "Para parar:        ./stop.sh"
          ;;
      esac
    else
      echo "❌ Proxy process $PID não está rodando"
      rm -f "$PID_FILE"
      exit 1
    fi
  else
    echo "❌ PID file não foi criado"
    exit 1
  fi
fi
