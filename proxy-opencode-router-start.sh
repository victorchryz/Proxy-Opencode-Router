#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
else
  echo "💥 Arquivo .env não encontrado em $ENV_FILE"
  echo "   Copie .env.example para .env e preencha suas chaves NVIDIA."
  exit 1
fi

if [ -z "$NVIDIA_KEY_1" ] || [ "$NVIDIA_KEY_1" = "nvapi-sua-chave-aqui" ]; then
  echo "💥 NVIDIA_KEY_1 não configurada no .env"
  exit 1
fi

node "$SCRIPT_DIR/proxy-opencode-router.js"
