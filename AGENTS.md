# AGENTS.md — Proxy-Opencode

Proxy HTTP que roteia requisições OpenCode → NVIDIA API.

## Como iniciar

```bash
# 1. Copie .env.example para .env e preencha suas chaves NVIDIA
cp .env.example .env

# 2. Rode o script
bash proxy-opencode-router-start.sh
```

- Proxy escuta em `127.0.0.1:9999/v1` (configurável via env)
- Precisa estar rodando para o OpenCode funcionar com provider `nvidia`

## Configuração: o que não é óbvio

- O `opencode.jsonc` deste repo é **template**. O proxy lê de `~/.config/opencode/opencode.jsonc` (hot-reload automático, ~1s).
- No config do OpenCode, `baseURL` deve apontar para `http://127.0.0.1:9999/v1` e `apiKey` é fictício — o proxy injeta a chave real.
- As chaves NVIDIA ficam no **`.env`** (não versionado). O script `.sh` valida presença e valor antes de iniciar.
- `configPath` usa `os.homedir()` como fallback se `$HOME` não existe.

## Variáveis de ambiente (configuráveis)

| Variável | Default | Descrição |
|---|---|---|
| `PROXY_TARGET_RPM` | 40 | Rate limit global (requests por minuto) |
| `PROXY_CONN_TIMEOUT_MS` | 30000 | Timeout de conexão inicial (ms) |
| `PROXY_STREAM_TIMEOUT_MS` | 300000 | Timeout de silêncio no stream (ms) |
| `PROXY_MAX_CONCURRENT` | 1 | Requisições simultâneas |
| `PROXY_PORT` | 9999 | Porta do proxy |
| `PROXY_HOST` | 127.0.0.1 | Host do proxy |
| `NVIDIA_KEY_1` | — | Chave de API NVIDIA (obrigatória) |
| `NVIDIA_KEY_2` | — | Chave de API NVIDIA (opcional) |

## Comportamentos críticos

- **Rate limit:** `PROXY_TARGET_RPM` RPM global, `PROXY_MAX_CONCURRENT` concorrentes. Requisições entram em fila.
- **Cascata por chave:** cada chave física tem sua própria ordem de preferência:
  - **K1:** `glm-5.1` → `kimi-k2.6` → `deepseek-v4-pro` → `minimax-m3`
  - **K2:** `kimi-k2.6` → `glm-5.1` → `minimax-m3` → `deepseek-v4-pro`
- **Alternância:** K1↔K2 a cada request. O último modelo usado é sempre movido para o fim da fila daquela chave (anti-repetição).
- **Backoff (5xx):** `[1, 5, 10, 15, 20, 25, 30, 60]` min. 429 respeita `Retry-After`. 400/401/403 abortam a cascata imediatamente.
- **Fallback Kimi:** se Kimi retorna só `reasoning_content` (sem `content`/`tool_calls`), o proxy tenta **todos os modelos não-Kimi disponíveis em cascata** (na ordem da chave) até um responder com sucesso. O raciocínio do Kimi é passado como contexto. Se um modelo falha (timeout/erro), o próximo é tentado automaticamente.
- **Filtros SSE:** remove CJK de `content`/`reasoning_content`, mergeia `tool_calls` fragmentados por `index`, remove `tool_calls: []` vazio em mensagens `assistant`.

## Endpoints administrativos

- `GET /health` — status, uptime, modelos bloqueados, config de RPM/concorrência
- `GET /metrics` — contadores de requisições, erros, fallbacks, tempo médio de resposta

## Atalhos no terminal

- `D` — liga/desliga modo debug (gera `debug.log` ao lado do `.js`)
- `Ctrl+C` / `Ctrl+D` — encerra o proxy

## Atenção

- **Nunca** commite o `.env` — ele está no `.gitignore`.
- Sem `package.json`, testes, lint, formatter ou CI. Mudanças exigem teste manual.
