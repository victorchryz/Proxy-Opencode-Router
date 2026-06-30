# Proxy-Opencode-Router

Proxy HTTP que roteia requisições do [OpenCode](https://opencode.ai) para a API da NVIDIA, com cascata inteligente de modelos, rotação de chaves, fallback automático e métricas.

## Funcionalidades

- **Cascata por chave:** cada chave NVIDIA tem sua própria ordem de preferência de modelos
- **Fallback Kimi automático:** se o Kimi retorna só raciocínio (sem resposta visível), o proxy tenta todos os modelos não-Kimi disponíveis em cascata até obter uma resposta
- **Rotação K1↔K2:** alterna entre chaves a cada request para distribuir carga
- **Anti-repetição:** o último modelo usado é movido para o fim da fila daquela chave
- **Backoff inteligente:** escala progressiva em erros 5xx, respeito a `Retry-After` em 429, aborto imediato em 400/401/403
- **Filtros SSE:** remoção de caracteres CJK, merge de `tool_calls` fragmentados, limpeza de `tool_calls: []`
- **Rate limiting:** RPM global configurável + controle de concorrência
- **Hot-reload:** mudanças em `~/.config/opencode/opencode.jsonc` são recarregadas automaticamente
- **Métricas e health check:** endpoints administrativos para monitoramento
- **Debug interativo:** tecla `D` no terminal liga/desliga log detalhado

## Modelos suportados

| Modelo | Chave K1 (ordem) | Chave K2 (ordem) |
|---|---|---|
| **GLM-5.1** (Thinking) | 1º | 2º |
| **Kimi-K2.6** | 2º | 1º |
| **DeepSeek V4 Pro** (Thinking) | 3º | 4º |
| **MiniMax M3** (Thinking) | 4º | 3º |

> **Dica:** a ordem na tabela acima reflete a preferência padrão. A cada request bem-sucedido, o modelo usado vai para o **final da fila** (anti-repetição). A fila é compartilhada entre K1 e K2 e só reseta quando ambas as chaves foram utilizadas.

## Início rápido

### 1. Pré-requisitos

- [Node.js](https://nodejs.org/) 18+ (usa `fetch` nativo)
- Chaves de API NVIDIA (obtenha em [build.nvidia.com](https://build.nvidia.com/))
- [OpenCode](https://opencode.ai) instalado

### 2. Configuração

```bash
# Clone o repositório
git clone https://github.com/victorchryz/Proxy-Opencode-Router.git
cd Proxy-Opencode-Router

# Copie o template de variáveis e preencha suas chaves
cp .env.example .env
```

Edite o `.env` com suas chaves:

```env
NVIDIA_KEY_1=nvapi-sua-chave-aqui
NVIDIA_KEY_2=nvapi-sua-chave-aqui
```

### 3. Inicie o proxy

```bash
bash proxy-opencode-router-start.sh
```

O proxy escuta em `http://127.0.0.1:9999/v1`.

### 4. Configure o OpenCode

Copie o `opencode.jsonc` deste repo para `~/.config/opencode/opencode.jsonc`:

```bash
mkdir -p ~/.config/opencode
cp opencode.jsonc ~/.config/opencode/opencode.jsonc
```

> O `apiKey` no config é fictício — o proxy injeta a chave real automaticamente.

> **Atenção — limite de context:** todos os modelos no `opencode.jsonc` devem usar o **mesmo valor de `context`**, correspondente ao **menor limite** entre eles. Exemplo: Kimi e MiniMax suportam 1M tokens, mas GLM-5.1 limita a 131072 — portanto **todos** usam `"context": 131072`. Se um modelo com limite menor receber um contexto acumulado que ultrapassa o seu máximo, a requisição vai falhar. Usar o menor valor garante compatibilidade durante a cascata.
>
> **Atenção — output vs max_tokens:** os campos `limit.output` e `options.max_tokens` de cada modelo devem ter o **mesmo valor**. Exemplo: se `"limit": {"output": 32768}`, então `"options": {"max_tokens": 32768}`.

## Variáveis de ambiente

| Variável | Default | Descrição |
|---|---|---|
| `NVIDIA_KEY_1` | — | Chave de API NVIDIA (obrigatória) |
| `NVIDIA_KEY_2` | — | Chave de API NVIDIA (opcional) |
| `PROXY_TARGET_RPM` | 40 | Rate limit global (requests/min) |
| `PROXY_CONN_TIMEOUT_MS` | 30000 | Timeout de conexão inicial (ms) |
| `PROXY_STREAM_TIMEOUT_MS` | 300000 | Timeout de silêncio no stream (ms) |
| `PROXY_MAX_CONCURRENT` | 1 | Requisições simultâneas |
| `PROXY_PORT` | 9999 | Porta do proxy |
| `PROXY_HOST` | 127.0.0.1 | Host do proxy |

## Endpoints administrativos

| Endpoint | Descrição |
|---|---|
| `GET /health` | Status, uptime, modelos bloqueados, config de RPM/concorrência |
| `GET /metrics` | Contadores de requisições, erros, fallbacks, tempo médio de resposta |

## Atalhos no terminal

| Tecla | Ação |
|---|---|
| `D` | Liga/desliga modo debug (gera `debug.log`) |
| `Ctrl+C` / `Ctrl+D` | Encerra o proxy |

## Comportamento do fallback Kimi

O Kimi-K2.6 às vezes retorna apenas `reasoning_content` (raciocínio interno) sem `content` (resposta visível). Quando isso acontece:

1. O proxy detecta que o Kimi não emitiu resposta real
2. Coleta o raciocínio do Kimi como contexto
3. Tenta **todos os modelos não-Kimi disponíveis** em cascata (na ordem da chave usada)
4. Passa o raciocínio do Kimi junto com a mensagem original para o próximo modelo
5. Se um modelo falha (timeout/erro), tenta o próximo automaticamente
6. O cliente recebe uma resposta completa do modelo de fallback

## Segurança

- As chaves de API ficam no arquivo `.env` (não versionado)
- O script de inicialização valida a presença e o valor das chaves antes de iniciar
- O campo `apiKey` no config do OpenCode é fictício — o proxy injeta a chave real

## Estrutura do projeto

```
Proxy-Opencode-Router/
├── AGENTS.md                        # Guia para agentes OpenCode
├── .env.example                     # Template de variáveis de ambiente
├── .gitignore
├── opencode.jsonc                    # Template de config do OpenCode
├── proxy-opencode-router.js          # Servidor proxy
└── proxy-opencode-router-start.sh    # Script de inicialização
```

## Licença

Este projeto é de uso pessoal. Veja [LICENSE](LICENSE) para detalhes.
