# Proxy-Opencode-Router

Proxy HTTP modular que roteia requisições do [OpenCode](https://opencode.ai) para a API da NVIDIA, com cascata de prioridade fixa, anti-repetição cross-key e fallback automático.

## Funcionalidades

- **Cascata com prioridade fixa:** `glm-5.2 → deepseek-v4-pro → kimi-k2.6 → minimax-m3`
- **Anti-repetição cross-key:** o último modelo usado é pulado na próxima requisição (K1↔K2)
- **Fallback de key:** se todos os modelos estão bloqueados na key atual, tenta a outra
- **Fallback Kimi automático:** se Kimi retorna só raciocínio (sem resposta), tenta todos os modelos não-Kimi em cascata
- **Backoff inteligente:** escala progressiva em erros 5xx, respeito a `Retry-After` em 429, DEGRADED tratado como 429
- **Synthetic SSE errors:** todos os erros emitem stream SSE com `finish_reason: 'stop'` + `[DONE]` — sem travar o OpenCode
- **Filtros SSE:** CJK stripping (opt-in), merge de `tool_calls`, limpeza de `tool_calls: []`
- **Rate limiting:** RPM global configurável + controle de concorrência
- **Hot-reload:** mudanças no `opencode.jsonc` são recarregadas automaticamente
- **Métricas e health check:** endpoints `/health` e `/metrics`
- **Debug interativo:** tecla `D` no terminal liga/desliga log detalhado

## Modelos suportados

| Prioridade | Modelo |
|---|---|
| 1º | **GLM-5.2** (Thinking) |
| 2º | **DeepSeek V4 Pro** (Thinking) |
| 3º | **Kimi K2.6** |
| 4º | **MiniMax M3** (Thinking) |

> A ordem é fixa. A cada requisição, o último modelo usado é pulado (anti-repetição).

## Início rápido

### 1. Pré-requisitos

- [Node.js](https://nodejs.org/) 18+ (usa `fetch` nativo)
- Chaves de API NVIDIA ([build.nvidia.com](https://build.nvidia.com/))
- [OpenCode](https://opencode.ai) instalado

### 2. Configuração

```bash
git clone https://github.com/victorchryz/Proxy-Opencode-Router.git
cd Proxy-Opencode-Router
cp .env.example .env
```

Edite o `.env` com suas chaves:

```env
NVIDIA_KEY_1=nvapi-sua-chave-aqui
NVIDIA_KEY_2=nvapi-sua-chave-aqui
```

### 3. Inicie o proxy

```bash
./start.sh           # menu interativo (foreground/daemon)
node index.js        # foreground direto
./start.sh --daemon  # daemon direto
```

Para parar: `./stop.sh`

O proxy escuta em `http://127.0.0.1:9999/v1`.

### 4. Configure o OpenCode

O `opencode.jsonc` neste repo já está configurado. O proxy faz hot-reload automático.

- `baseURL`: `http://127.0.0.1:9999/v1`
- `apiKey`: fictício — o proxy injeta a chave real
- `maxConcurrency`: 1 (o proxy já controla concorrência)

## Variáveis de ambiente

| Variável | Default | Descrição |
|---|---|---|
| `NVIDIA_KEY_1` | — | Chave de API NVIDIA (obrigatória) |
| `NVIDIA_KEY_2` | — | Chave de API NVIDIA (opcional) |
| `NVIDIA_BASE_URL` | `https://integrate.api.nvidia.com` | Base URL da API NVIDIA |
| `PROXY_TARGET_RPM` | 40 | Rate limit global (requests/min) |
| `PROXY_CONN_TIMEOUT_MS` | 60000 | Timeout de conexão inicial (ms) |
| `PROXY_STREAM_TIMEOUT_MS` | 90000 | Timeout de silêncio no stream (ms) |
| `PROXY_MAX_CONCURRENT` | 1 | Requisições simultâneas |
| `PROXY_PORT` | 9999 | Porta do proxy |
| `PROXY_HOST` | 127.0.0.1 | Host do proxy |
| `PROXY_STRIP_CJK` | 0 | Remove CJK do stream (1 = ligado) |
| `PROXY_TEST_MODE` | 0 | Mock keys para testes (1 = ligado) |

## Endpoints administrativos

| Endpoint | Descrição |
|---|---|
| `GET /health` | Status, uptime, modelos bloqueados, RPM/concorrência |
| `GET /metrics` | Requisições, erros, fallbacks, tempo médio de resposta |

## Atalhos no terminal

| Tecla | Ação |
|---|---|
| `D` | Liga/desliga modo debug (`debug.log`) |
| `Ctrl+C` | Encerra o proxy (foreground) |

## Comportamento do fallback Kimi

O Kimi K2.6 às vezes retorna apenas `reasoning_content` sem `content`. Quando isso acontece:

1. Proxy detecta que Kimi não emitiu resposta real
2. Coleta o raciocínio do Kimi como contexto
3. Tenta todos os modelos não-Kimi disponíveis em cascata
4. Passa o raciocínio do Kimi junto com a mensagem original
5. Cliente recebe resposta completa do modelo de fallback

## Estrutura do projeto

```
Proxy-Opencode-Router/
├── index.js              # Entry point
├── package.json
├── start.sh              # Launcher interativo (foreground/daemon)
├── stop.sh               # Para foreground e daemon
├── opencode.jsonc        # Config do OpenCode (ativo)
├── .env.example          # Template de variáveis
├── .gitignore
├── LICENSE
├── AGENTS.md
├── README.md
└── src/
    ├── cascade.js        # Cascata de prioridade fixa
    ├── handler.js        # Handler principal
    ├── state.js          # Backoff, RPM, concorrência
    ├── providers.js      # Chaves NVIDIA
    ├── config.js         # Loader de .env, hot-reload
    ├── constants.js      # Headers, regex, safe keys
    ├── prepare.js        # Preparação do body
    ├── normalize.js      # Normalização SSE, CJK
    ├── logger.js         # Logging e debug
    └── metrics.js        # /health e /metrics
```

## Licença

MIT — veja [LICENSE](LICENSE).