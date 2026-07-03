const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// =====================================================================
// 0. CONFIGURAÇÃO VIA ENV
// =====================================================================
const ENV_TARGET_RPM        = parseInt(process.env.PROXY_TARGET_RPM, 10) || 40;
const ENV_CONN_TIMEOUT_MS   = parseInt(process.env.PROXY_CONN_TIMEOUT_MS, 10) || 30000;
const ENV_STREAM_TIMEOUT_MS = parseInt(process.env.PROXY_STREAM_TIMEOUT_MS, 10) || 300000;
const ENV_MAX_CONCURRENT    = parseInt(process.env.PROXY_MAX_CONCURRENT, 10) || 1;
const ENV_PORT              = parseInt(process.env.PROXY_PORT, 10) || 9999;
const ENV_HOST              = process.env.PROXY_HOST || '127.0.0.1';

// =====================================================================
// 1. PROVIDERS E CHAVES
// =====================================================================
const PROVIDERS = {
  nvidia: {
    baseUrl: 'https://integrate.api.nvidia.com',
    keys: [
      process.env.NVIDIA_KEY_1 || '',
      process.env.NVIDIA_KEY_2 || '',
    ].filter(k => k),
  },
};

if (PROVIDERS.nvidia.keys.length === 0) {
  console.error('💥 [Crítico] Nenhuma NVIDIA_KEY configurada. Abortando.');
  process.exit(1);
}

// =====================================================================
// 2. DEBUG MODE
// =====================================================================
let DEBUG_MODE = false;
const debugLogPath = path.join(__dirname, 'debug.log');

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (key) => {
    const keyStr = key.toString();
    if (keyStr === '\x03' || keyStr === '\x04') {
      console.log('\nEncerrando proxy...');
      process.exit(0);
    }
    if (keyStr.toLowerCase() === 'd') {
      DEBUG_MODE = !DEBUG_MODE;
      if (DEBUG_MODE) {
        fs.writeFileSync(debugLogPath, `--- DEBUG INICIADO ${new Date().toISOString()} ---\n`);
        console.log(`\n${getLogTime()} 🐛 [Debug] LIGADO! Salvando em ${debugLogPath}\n`);
      } else {
        console.log(`\n${getLogTime()} 🐛 [Debug] DESLIGADO!\n`);
      }
    }
  });
}

function logDebug(text) {
  if (DEBUG_MODE) fs.appendFileSync(debugLogPath, text + '\n');
}

// =====================================================================
// 3. CONFIGS OPENCODE + HOT RELOAD
// =====================================================================
const configPath = path.join(process.env.HOME || os.homedir(), '.config', 'opencode', 'opencode.jsonc');
let modelConfigs = {};

function loadConfigs() {
  try {
    let raw = fs.readFileSync(configPath, 'utf8');
    raw = raw.replace(/^\uFEFF/, '').replace(/\r/g, '');
    const cleanJson = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(?<!:)\/\/.*/g, '')
    .replace(/,\s*([}\]])/g, '$1');

    const config = JSON.parse(cleanJson);
    const models = config.provider.nvidia.models;
    let newConfigs = {};
    for (const modelName in models) {
      const opts = { ...(models[modelName].options || {}) };
      newConfigs[modelName] = opts;
    }
    modelConfigs = newConfigs;
    console.log('✅ Configurações lidas do opencode.jsonc');
} catch (e) {
  console.warn('⚠️ Erro ao ler opencode.jsonc:', e.message);
}
}

loadConfigs();

let reloadTimeout;
fs.watch(configPath, () => {
  clearTimeout(reloadTimeout);
  reloadTimeout = setTimeout(() => {
    console.log(`${getLogTime()} 🔄 [Config] Arquivo alterado. Recarregando...`);
    loadConfigs();
  }, 1000);
});

// =====================================================================
// 4. VISUAL E LOGGING
// =====================================================================
const PROVIDER_LABEL = { nvidia: 'NVDA' };

function getVisualTag(providerName, model, keyIdx) {
  const k = keyIdx + 1;
  const m = model.includes('/') ? model.split('/').pop() : model;
  const ptag = PROVIDER_LABEL[providerName] || providerName.toUpperCase();
  let wrap = s => s;
  if (model.includes('glm'))           wrap = s => `\x1b[31m${s}\x1b[0m`;
  else if (model.includes('kimi'))      wrap = s => `\x1b[35m${s}\x1b[0m`;
  else if (model.includes('deepseek'))  wrap = s => `\x1b[34m${s}\x1b[0m`;
  else if (model.includes('minimax'))   wrap = s => `\x1b[33m${s}\x1b[0m`;
  return `${wrap(m)} [${ptag} K${k}]`;
}

function getLogTime() {
  return `\x1b[90m[${new Date().toTimeString().split(' ')[0]}]\x1b[0m`;
}

// =====================================================================
// 5. CONCORRÊNCIA E RPM
// =====================================================================
const MAX_CONCURRENT = ENV_MAX_CONCURRENT;
let activeRequests = 0;
const waitQueue = [];

function acquireSlot() {
  return new Promise(resolve => {
    if (activeRequests < MAX_CONCURRENT) { activeRequests++; resolve(); }
    else waitQueue.push(resolve);
  });
}
function releaseSlot() {
  activeRequests--;
  if (waitQueue.length > 0) { activeRequests++; waitQueue.shift()(); }
}

const TARGET_GLOBAL_RPM = ENV_TARGET_RPM;
const MIN_INTERVAL_MS = Math.ceil(60000 / TARGET_GLOBAL_RPM);
let lastGlobalRequestTime = 0;

async function enforceTimeLimit() {
  const now = Date.now();
  const waitTime = MIN_INTERVAL_MS - (now - lastGlobalRequestTime);
  if (waitTime > 0) {
    lastGlobalRequestTime = now + waitTime;
    console.log(`${getLogTime()} ⏳ [Limite] Segurando por ${waitTime}ms (${TARGET_GLOBAL_RPM} RPM)`);
    await new Promise(r => setTimeout(r, waitTime));
  } else {
    lastGlobalRequestTime = now;
  }
}

// =====================================================================
// 6. BACKOFF INTELIGENTE
// =====================================================================
const backoffScheduleMin = [1, 5, 10, 15, 20, 25, 30, 60];
const endpointState = {};
let abortCascade = false;

function getState(id) {
  if (!endpointState[id]) endpointState[id] = { blockedUntil: 0, backoffIndex: 0 };
  return endpointState[id];
}

function applyBackoff(state, endpoint, status, errBody, tag, headers) {
  if (status === 400 || status === 401 || status === 403) {
    console.log(`${getLogTime()} 🚨 [CRÍTICO] Erro ${status} em ${tag}. Abortando cascata.`);
    abortCascade = true;
    return;
  }

  let apiRetryAfterMs = 0;
  if (headers) {
    const retryAfter = headers.get('retry-after') || headers.get('x-ratelimit-reset-requests');
    if (retryAfter) {
      const asNum = Number(retryAfter);
      if (!isNaN(asNum)) apiRetryAfterMs = asNum * 1000;
      else {
        const dateMs = Date.parse(retryAfter);
        if (!isNaN(dateMs)) apiRetryAfterMs = dateMs - Date.now();
      }
    }
  }

  if (status === 429 && apiRetryAfterMs > 0) {
    state.blockedUntil = Date.now() + apiRetryAfterMs;
    state.backoffIndex = 0;
    console.log(`${getLogTime()} 🛑 [Bloqueio] API pediu Retry-After. ${tag} bloqueado por ${Math.ceil(apiRetryAfterMs/1000)}s.`);
    return;
  }

  const waitMin = backoffScheduleMin[state.backoffIndex] || 30;
  state.blockedUntil = Date.now() + waitMin * 60 * 1000;
  state.backoffIndex = Math.min(state.backoffIndex + 1, backoffScheduleMin.length - 1);

  console.log(`${getLogTime()} 🛑 [Bloqueio] Erro ${status}. ${tag} bloqueado por ${waitMin} min.`);
}

// =====================================================================
// 7. BALANCEADOR DINÂMICO
// =====================================================================
let globalKeyToggle = 1;
let lastUsedModel = null;

// Ordem de cascata por chave física (K1=0, K2=1)
const KEY_CASCADES = {
  0: [
    { provider: 'nvidia', model: 'z-ai/glm-5.1', name: 'glm' },
    { provider: 'nvidia', model: 'moonshotai/kimi-k2.6', name: 'kimi' },
    { provider: 'nvidia', model: 'deepseek-ai/deepseek-v4-pro', name: 'deepseek' },
    { provider: 'nvidia', model: 'minimaxai/minimax-m3', name: 'minimax' }
  ],
  1: [
    { provider: 'nvidia', model: 'moonshotai/kimi-k2.6', name: 'kimi' },
    { provider: 'nvidia', model: 'z-ai/glm-5.1', name: 'glm' },
    { provider: 'nvidia', model: 'minimaxai/minimax-m3', name: 'minimax' },
    { provider: 'nvidia', model: 'deepseek-ai/deepseek-v4-pro', name: 'deepseek' }
  ]
};

function buildDynamicCascade() {
  const provider = PROVIDERS.nvidia;
  globalKeyToggle = (globalKeyToggle + 1) % provider.keys.length;
  const startKey = globalKeyToggle;
  const baseModels = KEY_CASCADES[startKey];

  // Reordenar sem duplicar último modelo
  let modelsToTry = [];
  for (const m of baseModels) {
    if (m.name !== lastUsedModel) modelsToTry.push(m);
  }
  if (lastUsedModel) {
    const lastM = baseModels.find(m => m.name === lastUsedModel);
    if (lastM) modelsToTry.push(lastM);
  } else {
    modelsToTry = [...baseModels];
  }

  let cascade = [];
  for (let i = 0; i < modelsToTry.length; i++) {
    const m = modelsToTry[i];
    const state = getState(`${m.provider}:${m.model}__${startKey}`);
    if (Date.now() >= state.blockedUntil) {
      cascade.push({ ...m, physicalKey: startKey });
    }
  }

  // Fallback para a outra chave se nada disponível na atual
  if (cascade.length === 0 && provider.keys.length > 1) {
    const otherKey = (startKey + 1) % provider.keys.length;
    for (const m of modelsToTry) {
      const state = getState(`${m.provider}:${m.model}__${otherKey}`);
      if (Date.now() >= state.blockedUntil) {
        cascade.push({ ...m, physicalKey: otherKey });
      }
    }
  }

  if (cascade.length === 0) {
    cascade.push({ ...modelsToTry[0], physicalKey: startKey });
  }

  return cascade;
}

// =====================================================================
// 7.5 NORMALIZE HELPER
// =====================================================================
function normalizeChunkStr(chunkStr, isKimi, kimiState) {
  const events = chunkStr.split('\n\n');
  const newEvents = [];
  for (const event of events) {
    if (event.startsWith('data: ') && event !== 'data: [DONE]') {
      const jsonStr = event.substring(6).trim();
      try {
        const parsed = JSON.parse(jsonStr);
        const choice = parsed.choices?.[0];
        const delta = choice?.delta;

        if (delta) {
          if (isKimi && delta.reasoning !== undefined) delete delta.reasoning;

          if (Array.isArray(delta.tool_calls)) {
            if (delta.tool_calls.length === 0) {
              delete delta.tool_calls;
            } else {
              const merged = {};
              for (const tc of delta.tool_calls) {
                const idx = tc.index !== undefined ? tc.index : 0;
                if (!merged[idx]) merged[idx] = { index: idx };
                if (tc.id) merged[idx].id = tc.id;
                if (tc.type) merged[idx].type = tc.type;
                if (tc.function) {
                  if (!merged[idx].function) merged[idx].function = {};
                  if (tc.function.name) merged[idx].function.name = tc.function.name;
                  if (tc.function.arguments) {
                    merged[idx].function.arguments = (merged[idx].function.arguments || '') + tc.function.arguments;
                  }
                }
              }
              delta.tool_calls = Object.values(merged);
            }
          }

          if (delta.content === null || delta.content === '' || delta.content === ' ') {
            delete delta.content;
          }

          const cjkRegex = /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g;
          if (delta.content) delta.content = delta.content.replace(cjkRegex, '');
          if (delta.reasoning_content) delta.reasoning_content = delta.reasoning_content.replace(cjkRegex, '');

          if (isKimi && kimiState) {
            if (delta.content && delta.content.trim() !== '') kimiState.kimiEmittedAnswer = true;
            if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) kimiState.kimiEmittedAnswer = true;
            if (delta.reasoning_content) kimiState.kimiReasoningBuf += delta.reasoning_content;
          }
        }

        newEvents.push('data: ' + JSON.stringify(parsed));
      } catch (e) {
        newEvents.push(event);
      }
    } else {
      newEvents.push(event);
    }
  }
  return newEvents.join('\n\n');
}

// =====================================================================
// 7.6 HELPERS DEDUP: HEADERS E FETCH OPTIONS
// =====================================================================
function createProxyHeaders(reqHeaders, providerBaseUrl, key) {
  const headers = { ...reqHeaders };
  delete headers['content-length'];
  delete headers['connection'];
  headers.host = new URL(providerBaseUrl).host;
  headers.authorization = `Bearer ${key}`;
  return headers;
}

function buildFetchOptions(url, method, headers, body, signal) {
  return {
    method,
    headers,
    body: method !== 'GET' && method !== 'HEAD' ? body : undefined,
    signal,
  };
}

// Injeta um chunk SSE sintético com reasoning_content (visível no bloco
// de "pensamento" do OpenCode). Usado para anotar "[Pensamento: MODELO]"
// no início de cada stream e "[Fallback - Pensamento: MODELO]" no fallback.
function injectAnnotation(res, tag, model, streamId) {
  const label = model.includes('/') ? model.split('/').pop() : model;
  const text = `[${tag}: ${label}]\n\n`;
  const id = streamId || 'chatcmpl-annot';
  const chunk = 'data: ' + JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }]
  }) + '\n\n';
  try { res.write(Buffer.from(chunk, 'utf-8')); } catch (e) {}
}

// =====================================================================
// 7.7 MÉTRICAS SIMPLES
// =====================================================================
const metrics = {
  requestsTotal: 0,
  requestsByModel: {},
  fallbacksTotal: 0,
  errorsTotal: 0,
  avgResponseTime: 0,
  totalResponseTime: 0,
};

function recordRequest(model, durationMs, isFallback, isError) {
  metrics.requestsTotal++;
  metrics.requestsByModel[model] = (metrics.requestsByModel[model] || 0) + 1;
  if (isFallback) metrics.fallbacksTotal++;
  if (isError) metrics.errorsTotal++;
  metrics.totalResponseTime += durationMs;
  metrics.avgResponseTime = metrics.totalResponseTime / metrics.requestsTotal;
}

// =====================================================================
// 8. PREPARAÇÃO DO PAYLOAD
// =====================================================================
function prepareBody(parsedOriginal, endpoint) {
  const body = { ...parsedOriginal };
  body.model = endpoint.model;

  if (body.messages) {
    body.messages = body.messages.map(msg => {
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length === 0) {
        delete msg.tool_calls;
      }
      return msg;
    });

    // System prompt extra para Kimi: ensina estrutura correta de output
    if (endpoint.model && endpoint.model.includes('kimi')) {
      const kimiExtra = [
        '\n\nCRITICAL OUTPUT FORMAT RULES — YOU MUST FOLLOW THESE:',
        '',
        '1. SEPARATE THINKING FROM ANSWER:',
        '   - "reasoning_content" = your internal thinking process (scratchpad). NEVER put your final answer here.',
        '   - "content" = your visible final answer to the user. This is what they see.',
        '   - These are two DIFFERENT fields. Do NOT duplicate reasoning_content into content or vice versa.',
        '',
        '2. EVERY response MUST have a "content" field with a real answer:',
        '   - If the user asks a question → put the answer in "content"',
        '   - If you need to use a tool → emit "tool_calls" AND put a brief summary in "content"',
        '   - NEVER finish a response with only "reasoning_content" and empty "content".',
        '',
        '3. CORRECT example:',
        '   reasoning_content: "Let me calculate 2+2... _user_version',
        '   content: "The answer is 4."',
        '',
        '4. WRONG example (DO NOT DO THIS):',
        '   reasoning_content: "Let me calculate 2+2... that equals 4. So the answer is 4."',
        '   content: null',
        '   ^ This is WRONG. The user sees nothing.',
        '',
        '5. When using tools:',
        '   reasoning_content: "I need to list files..."',
        '   tool_calls: [{id:"...", type:"function", function:{name:"bash", arguments:"..."}}]',
        '   content: "Let me check the files for you."',
        '',
        '6. SUMMARY: Always put your final answer in "content". Never leave it empty/null.',
      ].join('\n');
      const sysIdx = body.messages.findIndex(m => m.role === 'system');
      if (sysIdx >= 0) {
        body.messages[sysIdx].content += kimiExtra;
      } else {
        body.messages.unshift({ role: 'system', content: kimiExtra.trim() });
      }
    }
  }

  if (parsedOriginal.model && parsedOriginal.model !== endpoint.model) {
    delete body.chat_template_kwargs;
    delete body.reasoning_effort;
    delete body.reasoning_budget;
  }

  if (modelConfigs[endpoint.model]) {
    for (const key in modelConfigs[endpoint.model]) {
      body[key] = modelConfigs[endpoint.model][key];
    }
  }

  return JSON.stringify(body);
}

// =====================================================================
// 9. SERVIDOR E STREAMING
// =====================================================================
const server = http.createServer(async (req, res) => {
  // --- Endpoints administrativos ---
  if (req.url === '/health') {
    const blockedModels = Object.entries(endpointState)
      .filter(([, s]) => s.blockedUntil > Date.now())
      .map(([id, s]) => {
        const remaining = Math.ceil((s.blockedUntil - Date.now()) / 1000);
        return { id, blockedSeconds: remaining };
      });
    const health = {
      status: 'ok',
      uptime: process.uptime(),
      activeRequests,
      blockedModels,
      rpm: TARGET_GLOBAL_RPM,
      concurrent: MAX_CONCURRENT,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(health, null, 2));
  }

  if (req.url === '/metrics') {
    const data = {
      ...metrics,
      uptime: process.uptime(),
      activeRequests,
      blockedModels: Object.keys(endpointState).filter(id => endpointState[id].blockedUntil > Date.now()).length,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(data, null, 2));
  }

  if (!req.url.startsWith('/v1')) { res.writeHead(404); return res.end(); }

  const buffers = [];
  for await (const chunk of req) buffers.push(chunk);
  const bodyString = Buffer.concat(buffers).toString();

  logDebug(`\n========================================================`);
  logDebug(`=== [OPENCODE -> PROXY] ${new Date().toISOString()} ===`);
  logDebug(`========================================================\n${bodyString}\n`);

  let parsedOriginal = {};
  try {
    if (req.headers['content-type']?.includes('application/json')) {
      parsedOriginal = JSON.parse(bodyString);
    }
  } catch (e) {}

  await acquireSlot();

  try {
    const orderedEndpoints = buildDynamicCascade();
    let requestComplete = false;
    let attemptsLog = [];
    const requestStartTime = Date.now();

    const planLog = orderedEndpoints.map(e => getVisualTag(e.provider, e.model, e.physicalKey)).join(' -> ');
    console.log(`${getLogTime()} 🧠 [Plano] ${planLog}`);

    modelLoop: for (const endpoint of orderedEndpoints) {
      const provider = PROVIDERS[endpoint.provider];
      if (!provider || provider.keys.length === 0) continue;

      const preferredKey = endpoint.physicalKey !== undefined ? endpoint.physicalKey : 0;
      const state = getState(`${endpoint.provider}:${endpoint.model}__${preferredKey}`);

      let kIdx = -1;
      if (Date.now() >= state.blockedUntil) kIdx = preferredKey;

      if (kIdx === -1) {
        const rem = Math.ceil((state.blockedUntil - Date.now()) / 1000);
        attemptsLog.push(`⏭️ ${getVisualTag(endpoint.provider, endpoint.model, preferredKey)}[${rem}s]`);
        continue modelLoop;
      }

      if (endpoint !== orderedEndpoints[0]) {
        console.log(`${getLogTime()} 🔁 [Cascata] Roteando para ${getVisualTag(endpoint.provider, endpoint.model, kIdx)}...`);
      }

      let tentativas = 0;
      const maxTentativas = 2;

      while (tentativas < maxTentativas && !requestComplete) {
        tentativas++;
        await enforceTimeLimit();

        const controller = new AbortController();
        const initialTimer = setTimeout(() => {
          console.warn(`${getLogTime()} 🔴 [Timeout] ${ENV_CONN_TIMEOUT_MS}ms excedido em ${getVisualTag(endpoint.provider, endpoint.model, kIdx)}. Abortando...`);
          controller.abort();
        }, ENV_CONN_TIMEOUT_MS);

        let chunkTimer;
        const resetChunkTimer = () => {
          clearTimeout(chunkTimer);
          chunkTimer = setTimeout(() => {
            console.warn(`${getLogTime()} 🔴 [Stream] ${ENV_STREAM_TIMEOUT_MS}ms sem dados! Abortando...`);
            controller.abort();
          }, ENV_STREAM_TIMEOUT_MS);
        };

        try {
          const url = `${provider.baseUrl}${req.url}`;
          const finalBody = prepareBody(parsedOriginal, endpoint);

          logDebug(`\n========================================================`);
          logDebug(`=== [PROXY -> NVIDIA] ${getVisualTag(endpoint.provider, endpoint.model, kIdx)} ===`);
          logDebug(`========================================================\n${finalBody}\n`);

          const headers = createProxyHeaders(req.headers, provider.baseUrl, provider.keys[kIdx]);

          const startTime = Date.now();
          const retryTag = tentativas > 1 ? ` \x1b[33m(Retry ${tentativas})\x1b[0m` : '';
          console.log(`${getLogTime()} 🚀 [Início] -> ${getVisualTag(endpoint.provider, endpoint.model, kIdx)}${retryTag}`);

          lastUsedModel = endpoint.name;

          const response = await fetch(url, buildFetchOptions(url, req.method, headers, finalBody, controller.signal));

          clearTimeout(initialTimer);
          const duration = ((Date.now() - startTime) / 1000).toFixed(2);
          console.log(`${getLogTime()} 📩 [Resposta] Status ${response.status} em ${duration}s`);

          if (response.status >= 400) {
            clearTimeout(chunkTimer);
            let errBody = '';
            try { errBody = await response.text(); } catch (e) {}

            console.log(`${getLogTime()} ⚠️ [Erro] ${response.status} em ${getVisualTag(endpoint.provider, endpoint.model, kIdx)}: ${errBody.slice(0, 150)}`);
            abortCascade = false;
            applyBackoff(state, endpoint, response.status, errBody, getVisualTag(endpoint.provider, endpoint.model, kIdx), response.headers);
            attemptsLog.push(`\x1b[31m❌\x1b[0m ${getVisualTag(endpoint.provider, endpoint.model, kIdx)}`);

            recordRequest(endpoint.model, Date.now() - startTime, false, true);

            if (abortCascade) {
              if (!res.headersSent) {
                res.writeHead(response.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: errBody, type: "proxy_abort_error" } }));
              }
              requestComplete = true;
              break;
            }
            continue modelLoop;
          }

          state.backoffIndex = 0;
          attemptsLog.push(`\x1b[32m✅\x1b[0m ${getVisualTag(endpoint.provider, endpoint.model, kIdx)}`);

          const resHeaders = {};
          response.headers.forEach((value, key) => {
            if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) {
              resHeaders[key] = value;
            }
          });
          res.writeHead(response.status, resHeaders);

          injectAnnotation(res, 'Pensamento', endpoint.model, null);

          let chunkCount = 0;
          const isKimi = endpoint.model.includes('kimi');
          let kimiEmittedAnswer = false;
          let kimiFinishChunkBuf = null;
          let kimiNeedsFallback = false;
          let kimiReasoningBuf = '';
          let kimiStreamId = null;
          resetChunkTimer();

          logDebug(`\n--- [NVIDIA -> PROXY] Stream Start ---\n`);

          try {
            for await (let chunk of response.body) {
              resetChunkTimer();
              if (chunkCount === 0) console.log(`${getLogTime()} 📡 [Stream] Iniciando transferência...`);

              if (chunk instanceof Uint8Array) {
                chunk = Buffer.from(chunk);
              }
              let chunkStr = chunk.toString('utf-8');

              if (isKimi && !kimiStreamId) {
                const idMatch = chunkStr.match(/"id"\s*:\s*"([^"]+)"/);
                if (idMatch) kimiStreamId = idMatch[1];
              }

              logDebug(`\n--- [NVIDIA -> PROXY] (RAW CHUNK) --- endl`);
              logDebug(chunkStr);
              logDebug(`\n`);

              const kimiState = { kimiEmittedAnswer, kimiReasoningBuf };
              chunkStr = normalizeChunkStr(chunkStr, isKimi, kimiState);
              kimiEmittedAnswer = kimiState.kimiEmittedAnswer;
              kimiReasoningBuf = kimiState.kimiReasoningBuf;

              chunk = Buffer.from(chunkStr, 'utf-8');

              logDebug(`\n--- [PROXY -> OPENCODE] (CLEANED CHUNK) ---\n${chunk.toString('utf-8')}\n`);

              const isKimiFinishChunk = isKimi && chunkStr.includes('"finish_reason":"stop"');
              if (isKimi && isKimiFinishChunk) {
                kimiFinishChunkBuf = chunkStr;
              } else {
                res.write(chunk);
              }
              chunkCount++;
            }
          } catch (streamErr) {
            console.warn(`${getLogTime()} ⚠️ [Stream] Cortado: ${streamErr.message}`);
          } finally {
            clearTimeout(chunkTimer);
            logDebug(`\n--- [NVIDIA -> PROXY] Stream End ---\n`);

            if (isKimi && !kimiEmittedAnswer) {
              kimiNeedsFallback = true;
              console.log(`${getLogTime()} 🔄 [Kimi] Sem resposta real (só thinking). Fallback automático para próximo modelo.`);
              logDebug(`\n--- [KIMI AUTO-FALLBACK] No content/tool_calls — cascading ---\n`);
            }
          }

          if (kimiNeedsFallback) {
            // =========================================================
            // KIMI FALLBACK EM CASCATA: tenta todos os modelos não-Kimi
            // disponíveis na ordem da cascata até um responder com sucesso.
            // Se der timeout/erro em um, tenta o próximo.
            // =========================================================
            const fbCandidates = orderedEndpoints.filter(ep =>
              ep.name !== 'kimi' &&
              Date.now() >= getState(`${ep.provider}:${ep.model}__${ep.physicalKey}`).blockedUntil
            );

            if (fbCandidates.length > 0) {
              console.log(`${getLogTime()} 🔁 [Kimi Fallback] Candidatos: ${fbCandidates.map(ep => getVisualTag(ep.provider, ep.model, ep.physicalKey)).join(' -> ')}`);
            }

            let fbSuccess = false;
            for (const nextEp of fbCandidates) {
              if (fbSuccess) break;

              const fbProvider = PROVIDERS[nextEp.provider];
              const fkIdx = nextEp.physicalKey;
              const fbUrl = `${fbProvider.baseUrl}${req.url}`;

              let fbBodyParsed;
              try {
                fbBodyParsed = JSON.parse(prepareBody(parsedOriginal, nextEp));
              } catch (e) {
                fbBodyParsed = JSON.parse(prepareBody(parsedOriginal, nextEp));
              }

              if (kimiReasoningBuf.trim().length > 0) {
                const lastUserIdx = fbBodyParsed.messages.findLastIndex(m => m.role === 'user');
                if (lastUserIdx >= 0) {
                  fbBodyParsed.messages[lastUserIdx].content +=
                    '\n\n---\nEu mandei essa mesma mensagem pra outra IA e ela me devolveu isso aqui mas não confie cegamente antes de testar e/ou confirmar de que realmente está certo:\n\n' +
                    kimiReasoningBuf.trim();
                }
              }

              const fbBody = JSON.stringify(fbBodyParsed);
              const fbHeaders = createProxyHeaders(req.headers, fbProvider.baseUrl, fbProvider.keys[fkIdx]);

              console.log(`${getLogTime()} 🔁 [Kimi Fallback] -> ${getVisualTag(nextEp.provider, nextEp.model, fkIdx)}`);

              logDebug(`\n========================================================`);
              logDebug(`=== [FALLBACK -> NVIDIA] ${getVisualTag(nextEp.provider, nextEp.model, fkIdx)} ===`);
              logDebug(`========================================================\n${fbBody}\n`);

              const fallbackController = new AbortController();
              const fallbackInitialTimer = setTimeout(() => {
                console.warn(`${getLogTime()} 🔴 [Fallback Timeout] ${ENV_CONN_TIMEOUT_MS}ms excedido em ${getVisualTag(nextEp.provider, nextEp.model, fkIdx)}. Abortando...`);
                fallbackController.abort();
              }, ENV_CONN_TIMEOUT_MS);

              try {
                const fbResponse = await fetch(fbUrl, buildFetchOptions(fbUrl, req.method, fbHeaders, fbBody, fallbackController.signal));
                clearTimeout(fallbackInitialTimer);

                if (fbResponse.status >= 400) {
                  let fbErrBody = '';
                  try { fbErrBody = await fbResponse.text(); } catch (e) {}
                  console.warn(`${getLogTime()} ⚠️ [Fallback] ${fbResponse.status} em ${getVisualTag(nextEp.provider, nextEp.model, fkIdx)}. Tentando próximo...`);
                  applyBackoff(getState(`${nextEp.provider}:${nextEp.model}__${fkIdx}`), nextEp, fbResponse.status, fbErrBody, getVisualTag(nextEp.provider, nextEp.model, fkIdx), fbResponse.headers);
                  recordRequest(nextEp.model, Date.now() - requestStartTime, true, true);
                  if (abortCascade) break;
                  continue;
                }

                getState(`${nextEp.provider}:${nextEp.model}__${fkIdx}`).backoffIndex = 0;
                attemptsLog.push(`\x1b[33m🔄\x1b[0m ${getVisualTag(nextEp.provider, nextEp.model, fkIdx)}`);

                const fbResetChunkTimer = (() => {
                  let t;
                  return () => {
                    clearTimeout(t);
                    t = setTimeout(() => {
                      console.warn(`${getLogTime()} 🔴 [Fallback Stream] ${ENV_STREAM_TIMEOUT_MS}ms sem dados! Abortando...`);
                      fallbackController.abort();
                    }, ENV_STREAM_TIMEOUT_MS);
                  };
                })();

                try {
                  const streamId = kimiStreamId || 'chatcmpl-fallback';
                  injectAnnotation(res, 'Fallback - Pensamento', nextEp.model, streamId);

                  for await (let fbChunk of fbResponse.body) {
                    fbResetChunkTimer();
                    if (fbChunk instanceof Uint8Array) fbChunk = Buffer.from(fbChunk);
                    let fbChunkStr = fbChunk.toString('utf-8');

                    logDebug(`\n--- [FALLBACK RAW CHUNK] ---\n${fbChunkStr}\n`);

                    fbChunkStr = normalizeChunkStr(fbChunkStr, nextEp.model.includes('kimi'), null);

                    if (kimiStreamId) {
                      fbChunkStr = fbChunkStr.replace(/"id"\s*:\s*"[^"]*"/, '"id":"' + kimiStreamId + '"');
                    }

                    fbChunk = Buffer.from(fbChunkStr, 'utf-8');
                    logDebug(`\n--- [FALLBACK CLEANED CHUNK] ---\n${fbChunk.toString('utf-8')}\n`);

                    res.write(fbChunk);
                  }

                  recordRequest(nextEp.model, Date.now() - requestStartTime, true, false);
                  fbSuccess = true;
                } catch (fbStreamErr) {
                  console.warn(`${getLogTime()} ⚠️ [Fallback Stream] Cortado em ${getVisualTag(nextEp.provider, nextEp.model, fkIdx)}: ${fbStreamErr.message}. Tentando próximo...`);
                  recordRequest(nextEp.model, Date.now() - requestStartTime, true, true);
                  continue;
                }
              } catch (fbFetchErr) {
                clearTimeout(fallbackInitialTimer);
                if (fbFetchErr.name === 'AbortError') {
                  console.warn(`${getLogTime()} ⏱️ [Fallback Abortado] Timeout em ${getVisualTag(nextEp.provider, nextEp.model, fkIdx)}. Tentando próximo...`);
                } else {
                  console.error(`${getLogTime()} 💥 [Fallback Fetch] Erro em ${getVisualTag(nextEp.provider, nextEp.model, fkIdx)}:`, fbFetchErr.message);
                }
                recordRequest(nextEp.model, Date.now() - requestStartTime, true, true);
                continue;
              }
            }

            if (!fbSuccess && fbCandidates.length > 0) {
              console.log(`${getLogTime()} 🚫 [Kimi Fallback] Todos os candidatos falharam.`);
            } else if (fbCandidates.length === 0) {
              console.log(`${getLogTime()} 🚫 [Kimi Fallback] Nenhum modelo disponível para fallback`);
            }
          }

          if (isKimi && kimiFinishChunkBuf) {
            res.write(Buffer.from(kimiFinishChunkBuf, 'utf-8'));
          }

          recordRequest(endpoint.model, Date.now() - startTime, false, false);
          res.end();
          requestComplete = true;
          break;

        } catch (fetchErr) {
          clearTimeout(initialTimer);
          clearTimeout(chunkTimer);
          if (fetchErr.name === 'AbortError') {
            console.warn(`${getLogTime()} ⏱️ [Abortado] Timeout em ${getVisualTag(endpoint.provider, endpoint.model, kIdx)}.`);
            attemptsLog.push(`\x1b[31m⏱️\x1b[0m ${getVisualTag(endpoint.provider, endpoint.model, kIdx)}${tentativas < maxTentativas ? ' \x1b[33m(Retry)\x1b[0m' : ''}`);
          } else {
            console.error(`${getLogTime()} 💥 [Rede] Erro:`, fetchErr.message);
            attemptsLog.push(`\x1b[31m💥\x1b[0m ${getVisualTag(endpoint.provider, endpoint.model, kIdx)}${tentativas < maxTentativas ? ' \x1b[33m(Retry)\x1b[0m' : ''}`);
          }
          recordRequest(endpoint.model, Date.now() - requestStartTime, false, true);
          if (tentativas >= maxTentativas) continue modelLoop;
        }
      }
      if (requestComplete) break;
    }

    const totalTime = ((Date.now() - requestStartTime) / 1000).toFixed(2);
    if (attemptsLog.length > 1 || !requestComplete) {
      console.log(`${getLogTime()} 📊 [Resumo] Rota: ${attemptsLog.join(' -> ')} | Tempo: ${totalTime}s`);
    } else if (requestComplete) {
      console.log(`${getLogTime()} 📊 [Resumo] ${attemptsLog.join('')} | Tempo: ${totalTime}s`);
    }
    console.log(`${getLogTime()} \x1b[90m${'─'.repeat(50)}\x1b[0m`);

    if (!requestComplete && !res.headersSent) {
      let minUnblock = Infinity;
      for (const id in endpointState) {
        if (endpointState[id].blockedUntil > Date.now() && endpointState[id].blockedUntil < minUnblock) {
          minUnblock = endpointState[id].blockedUntil;
        }
      }
      const waitSec = Math.ceil((minUnblock - Date.now()) / 1000);

      if (waitSec > 0 && waitSec < 30 * 60) {
        console.log(`${getLogTime()} 🛑 [Colapso] Retornando 429 ao cliente (tente em ${waitSec}s).`);
        res.writeHead(429, { 'Retry-After': waitSec, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Todos os endpoints bloqueados. Tente em ${waitSec}s.`, type: "proxy_overload" } }));
      } else {
        res.writeHead(503);
        res.end('Serviço indisponível.');
      }
    }

  } catch (err) {
    console.error(`${getLogTime()} 💥 [Crítico] Erro interno:`, err.message);
    if (!res.headersSent) res.writeHead(500);
    res.end('Proxy Error');
  } finally {
    releaseSlot();
  }
});

server.listen(ENV_PORT, ENV_HOST, () => {
  console.log('\x1b[36m🚀 Proxy-Opencode-Router v1.0.0 ativo!\x1b[0m');
  console.log(`🛡 Limite Global: ${TARGET_GLOBAL_RPM} RPM (Intervalo de ${MIN_INTERVAL_MS}ms)`);
  console.log(`🛡 Concorrência: ${MAX_CONCURRENT}`);
  console.log(`🛡 Timers: ${ENV_CONN_TIMEOUT_MS}ms conexão inicial | ${ENV_STREAM_TIMEOUT_MS}ms silêncio no stream`);
  console.log(`🛡 Host:Port: ${ENV_HOST}:${ENV_PORT}`);
  console.log('🛡 Erros: Respeita Retry-After. 500+ = escala min. 400/401/403 = Aborto imediato.');
  console.log('🔄 Dinâmico: Alterna K1/K2 por requisição e NUNCA repete o modelo.');
  console.log('🧹 Filtro: Anti-Tela Branca + Reparador de Ferramentas + Kimi Real-Time.');
  console.log(`🔌 Chaves físicas ativas: ${PROVIDERS.nvidia.keys.length}`);
  console.log('🐛 Debug: Aperte a tecla [D] neste terminal para ligar/desligar o log.');
  console.log('📊 Métricas: GET /health e /metrics disponíveis.\n');
});
