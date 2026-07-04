# Lógica Kimi-Only (removida do código)

Este arquivo preserva toda a lógica que tratava exclusivamente do modelo
`moonshotai/kimi-k2.6` (Kimi K2.6) e foi removida do projeto. Caso o Kimi
volte a ser usado no futuro, basta reaplicar os trechos abaixo nos arquivos
indicados.

## Por que foi removida

O Kimi K2.6 tinha um problema recorrente: respondia só com `reasoning_content`
(sem `content` nem `tool_calls`), deixando o OpenCode esperando uma resposta
que nunca vinha. Para contornar isso, foi implementada uma camada complexa
de detecção de resposta incompleta + fallback silencioso para outros modelos.

A lógica funcionava, mas era extensa, exclusiva do Kimi, e não se aplicava
aos outros modelos (GLM, DeepSeek, MiniMax). Com a remoção do Kimi da
cascata, todo esse código morto foi extraído para este arquivo.

---

## 1. `src/normalize.js` — KimiState e buffers

### typedef e factory

```js
/** @typedef {{ kimiEmittedAnswer: boolean, kimiReasoningBuf: string, kimiContentBuf: string, kimiStreamId: string|null, kimiFinishChunkBuf: string|null, kimiDoneBuf: string|null, kimiNeedsFallback: boolean }} KimiState */

export function newKimiState() {
  return {
    kimiEmittedAnswer: false,
    kimiReasoningBuf: '',
    kimiContentBuf: '',
    kimiStreamId: null,
    kimiFinishChunkBuf: null,
    kimiDoneBuf: null,
    kimiNeedsFallback: false,
  };
}
```

### Assinatura de `normalizeSSEEvent`

A função recebia `isKimi` (boolean) e `kimiState` (KimiState|null):

```js
export function normalizeSSEEvent(eventStr, isKimi, kimiState) {
```

### Fast-path forçado para Kimi

No `needsWork`, `isKimi ||` forçava o parse JSON de TODOS os eventos quando
o modelo era Kimi (mesmo os sem `tool_calls`/`content`/`reasoning`/CJK):

```js
const needsWork =
  isKimi ||
  eventStr.includes('"tool_calls"') ||
  eventStr.includes('"content"') ||
  eventStr.includes('"reasoning"') ||
  CJK_TEST.test(eventStr);
if (!needsWork) return eventStr;
```

### Acumulação nos buffers

No final do `normalizeSSEEvent`, acumulava content/reasoning/tool_calls nos
buffers do kimiState:

```js
if (kimiState) {
  if (delta.content) kimiState.kimiContentBuf += delta.content;
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
    kimiState.kimiEmittedAnswer = true;
  }
  if (delta.reasoning_content) kimiState.kimiReasoningBuf += delta.reasoning_content;
}
```

**Nota:** `kimiEmittedAnswer` só virava `true` com `tool_calls` (não com
content não-vazio) — isso era intencional, pois o Kimi podia emitir content
incompleto (ex: `:`, `...`, `{`) que não era uma resposta real.

---

## 2. `src/handler.js` — pumpStream, fallback, retenção

### Detecção `isKimi` em pumpStream

```js
const isKimi = endpoint.model.includes('kimi');
```

### Captura do `kimiStreamId`

No loop de eventos SSE, extraía o `id` do stream do primeiro evento para
reutilizar no fallback (preservando continuidade aos olhos do cliente):

```js
if (isKimi && !kimiState.kimiStreamId) {
  const idMatch = eventStr.match(/"id"\s*:\s*"([^"]+)"/);
  if (idMatch) kimiState.kimiStreamId = idMatch[1];
}
```

### Retenção do finish chunk e `[DONE]`

Para o Kimi, retinha (bufferiza) o chunk de `finish_reason` e o marcador
`[DONE]` em vez de enviá-los imediatamente, para poder disparar fallback
se o Kimi não produziu conteúdo real. A NVIDIA às vezes envia `[DONE]`
antes do finish chunk, então ambos eram bufferizados para garantir a
ordem correta no final:

```js
const isFinish = isKimi && /"finish_reason"\s*:\s*"(?:stop|length|tool_calls)"/.test(eventStr);
const isDone = eventStr.trim() === 'data: [DONE]';
if (isFinish) {
  kimiState.kimiFinishChunkBuf = taggedStr;
} else if (isKimi && isDone) {
  kimiState.kimiDoneBuf = taggedStr;
} else {
  const alive = await writeSSE(res, taggedStr + '\n\n');
  if (!alive) { clientDisconnectedRef.value = true; break; }
}
```

### catch do stream — não re-throw para Kimi

Para não-Kimi, re-lança o erro de stream (para encerrar o handler); para
Kimi, engole o erro intencionalmente para permitir a lógica de fallback
silencioso no `finally`:

```js
} catch (streamErr) {
  if (res.headersSent && !clientRef.value && !isKimi) {
    console.warn(`${ts()} [STREAM] Cortado: ${streamErr.message} — re-thrown para encerramento.`);
    throw streamErr;
  }
  console.warn(`${ts()} [STREAM] Cortado: ${streamErr.message}`);
}
```

### Detecção de resposta incompleta no finally

Após o stream do Kimi terminar, verificava se ele emitiu resposta real
(tool_calls ou content não-vazio/não-truncado). Se não, marcava
`kimiNeedsFallback = true`.

Padrões que DISPARAM fallback (resposta truncada):
- vazio (`""`, `" "`, etc — `trimEnd()` normaliza)
- `:`, `...`, `…` (U+2026), `,`
- `<`, `>`, `{`, `}`, `[`, `]`, `(`, `)`

Padrões que NÃO disparam (resposta genuína):
- `.`, `?`, `!`
- letra ou dígito
- `tool_calls` emitido (sempre)

```js
if (isKimi) {
  const hasToolCalls = kimiState.kimiEmittedAnswer;
  const c = kimiState.kimiContentBuf.trimEnd();
  console.log(`${ts()} [KIMI-FIM] contentLen=${kimiState.kimiContentBuf.length} tail=${JSON.stringify(c.slice(-40))} toolCalls=${hasToolCalls} clientGone=${clientRef.value}`);
  if (!clientRef.value) {
    if (!hasToolCalls && (c === '' || c.endsWith(':') || c.endsWith('...') || c.endsWith('\u2026') || c.endsWith(',') || c.endsWith('<') || c.endsWith('>') || c.endsWith('{') || c.endsWith('}') || c.endsWith('[') || c.endsWith(']') || c.endsWith('(') || c.endsWith(')'))) {
      kimiState.kimiNeedsFallback = true;
      console.log(`${ts()} [${endpoint.name}] Resposta incompleta. Acionando fallback.`);
    } else {
      console.log(`${ts()} [${endpoint.name}] Resposta considerada completa (sem fallback).`);
    }
  } else {
    console.log(`${ts()} [${endpoint.name}] Cliente desconectado — fallback não acionado.`);
  }
}
```

### Bloco de fallback silencioso

Quando `kimiNeedsFallback` era true:

1. Descartava o chunk de finish retido
2. Envia um chunk sintético separador `\n`
3. Criava um novo `fallbackKimiState` e `fallbackTagState`
4. Clonava o body original SEM `KIMI_EXTRA_RULES` (para não vazar regras
   do Kimi no fallback) — usando `fbParsedOriginal` com messages limpas
5. Anexava o raciocínio do Kimi (`kimiReasoningBuf`) como contexto na
   última mensagem do usuário, com o aviso:
   `"Eu mandei essa mesma mensagem pra outra IA e ela me devolveu isso aqui mas não confie cegamente antes de testar:"`
6. Filtrava candidatos excluindo o próprio Kimi
7. Tentava cada modelo não-Kimi em cascata via `runFallback`
8. Se todos falhassem, emitia chunk sintético de erro

```js
let fallbackOk = false;
if (kimiState.kimiNeedsFallback && !clientRef.value) {
  const fallbackStreamId = kimiState.kimiStreamId || 'chatcmpl-fallback';
  kimiState.kimiFinishChunkBuf = null;

  await sendSyntheticChunk(res, fallbackStreamId, '\n', 'proxy-fallback');

  const fallbackTagState = newTagState();
  const fallbackKimiState = newKimiState();
  fallbackKimiState.kimiStreamId = kimiState.kimiStreamId;

  // Clone limpo do body original SEM KIMI_EXTRA_RULES
  const fbParsedOriginal = { ...parsedOriginal, messages: undefined };
  if (Array.isArray(parsedOriginal.messages)) {
    fbParsedOriginal.messages = parsedOriginal.messages.map((m) => ({ ...m }));
  }

  // Anexa raciocínio do Kimi como contexto na última mensagem do usuário
  if (kimiState.kimiReasoningBuf.trim() && Array.isArray(fbParsedOriginal.messages)) {
    const lastUserIdx = fbParsedOriginal.messages.findLastIndex?.((m) => m.role === 'user') ?? -1;
    if (lastUserIdx >= 0) {
      const suffix =
        '\n\n---\nEu mandei essa mesma mensagem pra outra IA e ela me devolveu isso aqui mas não confie cegamente antes de testar:\n\n' +
        kimiState.kimiReasoningBuf.trim();
      const msg = fbParsedOriginal.messages[lastUserIdx];
      if (Array.isArray(msg.content)) {
        const textPart = msg.content.find((p) => p.type === 'text');
        if (textPart) textPart.text += suffix;
        else msg.content.push({ type: 'text', text: suffix });
      } else if (typeof msg.content === 'string') {
        msg.content += suffix;
      }
    }
  }

  // Candidatos excluem o próprio Kimi
  const candidates = cascade.filter(
    (ep) =>
      ep.name !== endpoint.name &&
      Date.now() >= getState(`${ep.provider}:${ep.model}__${ep.physicalKey}`).blockedUntil,
  );

  for (const nextEp of candidates) {
    if (clientRef.value) break;
    const fbStart = Date.now();
    const ok = await runFallback(
      req, res, fbParsedOriginal, nextEp, fallbackStreamId,
      fallbackTagState, fallbackKimiState, clientRef,
    );
    if (ok) {
      recordRequest(nextEp.model, Date.now() - fbStart, true, false);
      fallbackOk = true;
      break;
    } else {
      recordRequest(nextEp.model, Date.now() - fbStart, true, true);
    }
  }

  if (!fallbackOk && !clientRef.value) {
    console.log(`${ts()} [FALLBACK] Todos os modelos falharam.`);
    await sendSyntheticChunk(res, fallbackStreamId, '[Todos os fallbacks falharam]', 'proxy');
    if (!res.__poisoned) {
      await writeSSE(res, 'data: ' + JSON.stringify({
        id: fallbackStreamId, object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000), model: 'proxy',
        choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
      }) + '\n\n');
    }
  }
}
```

### Emissão dos chunks retidos (quando não há fallback)

Se o Kimi não precisou de fallback, emitia o chunk de `finish_reason` e o
`[DONE]` que foram retidos em `pumpStream`, na ordem correta:

```js
} else if (kimiState.kimiFinishChunkBuf) {
  await writeSSE(res, kimiState.kimiFinishChunkBuf + '\n\n');
  if (kimiState.kimiDoneBuf) await writeSSE(res, kimiState.kimiDoneBuf + '\n\n');
} else if (kimiState.kimiDoneBuf) {
  await writeSSE(res, kimiState.kimiDoneBuf + '\n\n');
}
```

### Métricas diferenciadas para fallback Kimi

Se o Kimi precisou fallback e este teve sucesso, registrava o endpoint
primário (Kimi) como erro (para o `/metrics` não contar uma única
requisição do usuário como dois sucessos — primário + fallback):

```js
if (kimiState.kimiNeedsFallback && fallbackOk) {
  recordRequest(endpoint.model, Date.now() - attemptStart, false, true);
} else {
  recordRequest(endpoint.model, Date.now() - attemptStart, false, false);
}
```

### `runFallback` — preservação de stream ID

Dentro de `runFallback`, o `replace` do `id` preservava o stream ID
original do Kimi para o cliente ver o stream como continuação:

```js
const out = fallbackKimiState.kimiStreamId
  ? taggedStr.replace(/"id"\s*:\s*"[^"]*"/g, `"id":"${fallbackStreamId}"`)
  : taggedStr;
```

---

## 3. `src/prepare.js` — KIMI_EXTRA_RULES

### Constante

System prompt extra injetado apenas no Kimi para forçá-lo a emitir resposta
real (`content`) em vez de só raciocínio (`reasoning_content`):

```js
export const KIMI_EXTRA_RULES = [
  '',
  '',
  'CRITICAL OUTPUT FORMAT RULES — YOU MUST FOLLOW THESE:',
  '1. SEPARATE THINKING FROM ANSWER: "reasoning_content" = thinking, "content" = final answer.',
  '2. EVERY response MUST have a "content" field with a real answer.',
  '3. If using tools, emit "tool_calls" AND put a brief summary in "content".',
  '4. NEVER finish a response with only "reasoning_content" and empty "content".',
].join('\n');
```

### Injeção no system prompt

Anexava `KIMI_EXTRA_RULES` ao system prompt existente (ou criava um novo
system message no início) apenas quando o modelo alvo era o Kimi:

```js
if (endpoint.model.includes('kimi')) {
  const sysIdx = body.messages.findIndex((m) => m.role === 'system');
  if (sysIdx >= 0) {
    body.messages[sysIdx].content += KIMI_EXTRA_RULES;
  } else {
    body.messages.unshift({ role: 'system', content: KIMI_EXTRA_RULES.trim() });
  }
}
```

---

## 4. `src/cascade.js` — entrada no MODEL_MAP

```js
'kimi-k2.6': { provider: 'nvidia', model: 'moonshotai/kimi-k2.6' },
```

---

## 5. `src/logger.js` — cor magenta

```js
if (model.includes('kimi-k2.6')) return (s) => `\x1b[35m${s}${RESET}`; // magenta
```

---

## 6. `opencode.jsonc` — configuração do modelo

```jsonc
"moonshotai/kimi-k2.6": {
  "name": "Kimi K2.6 (Nvidia)",
  "limit": {"context": 200000, "output": 65536},
  "options": {
    "stream": true,
    "temperature": 0.7,
    "top_p": 0.95,
    "max_tokens": 65536,
    "chat_template_kwargs": {"thinking": true},
    "stream_options": {"include_usage": true, "continuous_usage_stats": true}
  }
}
```

---

## O que pode ser reaproveitado para outros modelos

### Detecção de resposta incompleta

A lógica de verificar o último caractere do content acumulado
(`trimEnd()` + padrões de truncamento) pode ser generalizada para
qualquer modelo de reasoning que às vezes trunca a resposta. Os
padrões são genéricos: `:`, `...`, `,`, brackets, parens — todos
indicam código/JSON/markup cortado.

### Fallback com reasoning como contexto

A ideia de anexar o `reasoning_content` de um modelo que falhou como
contexto na última mensagem do usuário para o modelo de fallback é
genérica e poderosa. Pode ser aplicada a qualquer modelo que tenha
`reasoning_content` (DeepSeek, GLM com `enable_thinking`).

### Retenção de finish/DONE

Bufferizar o chunk de finish e o `[DONE]` para poder decidir o que
fazer depois do stream terminar é um padrão útil para qualquer cenário
onde se queira pós-processar a resposta antes de finalizá-la.

### Preservação de stream ID no fallback

O `replace` do `id` para manter continuidade do stream aos olhos do
cliente é genérico e pode ser usado em qualquer fallback, não só Kimi.
