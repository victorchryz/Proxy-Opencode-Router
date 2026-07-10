# AGENTS.md — OpenCode-Free-Router

Proxy HTTP que roteia requisições OpenCode → NVIDIA API com cascata
de prioridade fixa, anti-repetição cross-key e fallback automático.

## Regras gerais

- **Idioma:** sempre use **pt-br** em documentação, comentários, mensagens de
  commit e comunicação.
- **Commits:** faça commit + push após cada modificação funcional.
- **Verificação pré-commit:** antes de fazer commit, rode `git status` para
  conferir se há outros arquivos modificados além dos que você pretende
  commitar. Se houver, pergunte ao usuário se devem ir no mesmo commit ou
  em separado.
- **Não delete:** nunca delete diretório ou arquivo sem confirmação explícita
  do usuário.
- **Não instale:** nunca instale pacotes, dependências ou ferramentas sem
  confirmação explícita do usuário. Após qualquer instalação, liste o que foi
  instalado para futura desinstalação quando não for mais necessário.
- **Versionamento:** a cada modificação funcional, atualize a versão no banner
  de inicialização do proxy (formato: `v1.0.1`, `v1.1.0`, etc.).

## Como iniciar

```bash
# 1. Copie .env.example para .env e preencha suas chaves NVIDIA
cp .env.example .env

# 2. Inicie com menu interativo (foreground ou daemon)
./start.sh

# Ou direto:
node index.js          # foreground
./start.sh --daemon    # daemon
```

- Proxy escuta em `127.0.0.1:9999/v1` (configurável via env)
- Precisa estar rodando para o OpenCode funcionar com provider `nvidia`
- Para parar: `./stop.sh` (mata foreground e daemon)

## Estrutura do projeto

```
OpenCode-Free-Router/
├── index.js              # Entry point
├── package.json
├── start.sh              # Launcher interativo (foreground/daemon)
├── stop.sh               # Para foreground e daemon
├── opencode.jsonc        # Config do OpenCode (ativo, não template)
├── .env.example          # Template de variáveis
├── .gitignore
├── LICENSE
├── AGENTS.md
├── README.md
└── src/
    ├── cascade.js        # Cascata de prioridade fixa
    ├── handler.js        # Handler principal de requisições
    ├── state.js          # Backoff, RPM limiter, concurrency slots
    ├── providers.js      # Definições de providers e chaves
    ├── config.js         # Loader de .env e hot-reload do opencode.jsonc
    ├── constants.js      # HOP_BY_HOP headers, TAG_RE, SAFE_MODEL_OPTION_KEYS
    ├── prepare.js        # Preparação do body (tags, extra rules)
    ├── normalize.js      # Normalização SSE, strip CJK (opt-in)
    ├── logger.js         # Logging e debug mode
    └── metrics.js        # Endpoints /health e /metrics
```

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
| `PROXY_STRIP_CJK` | 0 | Remove caracteres CJK do stream (1 = ligado) |
| `PROXY_TEST_MODE` | 0 | Usa mock keys em vez de chaves reais (1 = ligado) |

## Comportamentos críticos

### Cascata com prioridade fixa

- **Alternância K1↔K2:** `globalKeyToggle` alterna a chave a cada request
- **lastUsedModel:** anti-repetição — se o modelo usado na última requisição
  bem-sucedida é o primeiro da lista, ele é pulado e o próximo é usado
- **Bloqueio é per-key:** modelo bloqueado em K1 não afeta K2. Se um modelo
  está bloqueado na key atual, o próximo modelo da lista é tentado
- **Fallback de key:** se todos os modelos estão bloqueados na key atual,
  tenta a outra key com a mesma ordem de prioridade
- **Absolute fallback:** se todos os 8 pares (modelo×key) estão bloqueados,
  ignora bloqueios e tenta GLM na key atual

### Backoff

- **400 + DEGRADED:** tratado como 429 — bloqueio de 2 min, **não aborta cascata**
- **400 (sem DEGRADED) / 401 / 403:** aborta cascata imediatamente
- **429 com Retry-After:** respeita o header da API
- **429 sem Retry-After:** backoff escalonado `[1, 2, 3, 5, 7, 8, 9, 10, 15, 20, 30, 60]` min
- **5xx / rede:** backoff exponencial `[2, 5, 10, 15, 20, 25, 30, 60]` min

### Erros → synthetic SSE stream

Todos os erros que antes retornavam JSON (500/429/503/abort) agora emitem um
**stream SSE sintético** com mensagem de erro como conteúdo +
`finish_reason: 'stop'` + `[DONE]`.

### Fallback

Se Modelo retorna só `reasoning_content` (sem `content`/`tool_calls`), o proxy
tenta todos os modelos disponíveis em cascata. O raciocínio do Modelo
é passado como contexto para o fallback.

### Filtros SSE

- CJK stripping **OFF por padrão** (`PROXY_STRIP_CJK=1` para ligar)
- Merge de `tool_calls` fragmentados por `index`
- Remove `tool_calls: []` vazio em mensagens `assistant`

### Sem limite de body

O proxy não impõe limite de tamanho de body — tanto o OpenCode quanto a NVIDIA
já aplicam seus próprios limites de contexto/tokens.

## Endpoints administrativos

- `GET /health` — status, uptime, modelos bloqueados, config de RPM/concorrência
- `GET /metrics` — contadores de requisições, erros, fallbacks, tempo médio de resposta

## Atalhos no terminal

- `D` — liga/desliga modo debug (gera `debug.log`)
- `Ctrl+C` / `Ctrl+D` — encerra o proxy (foreground)

## Configuração do OpenCode

O `opencode.jsonc` neste repo é o config **ativo** (não template).
O proxy faz hot-reload automático (~1s) do arquivo.

- `baseURL`: `http://127.0.0.1:9999/v1`
- `apiKey`: fictício — o proxy injeta a chave real
- `maxConcurrency`: 1 (o proxy já controla concorrência)
- As chaves NVIDIA ficam no **`.env`** (não versionado). O script `start.sh`
  valida presença e valor antes de iniciar.
- `configPath` usa `os.homedir()` como fallback se `$HOME` não existe.

## Versionamento

- Versão exibida no banner ao iniciar.
- **Regra:** a cada modificação funcional, atualize a versão.
- Formato: `v1.0.1`, `v1.1.0`, etc. (semantic versioning simples).
