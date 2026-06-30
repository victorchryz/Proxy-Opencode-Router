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

    // JSONC parser seguro (não quebra URLs com //)
    const cleanJson = raw
    .replace(/\/\*[\s\S]*?\*\//g, '') // Remove /* */
    .replace(/(^|[^\\:])\/\/.*$/gm, '$1') // Remove // (mantém http://)
    .replace(/,\s*([}\]])/g, '$1'); // Remove trailing commas

    const config = JSON.parse(cleanJson);
    const models = config.provider?.nvidia?.models || {};
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
fs.watch(configPath).on('change', () => {
  clearTimeout(reloadTimeout);
  reloadTimeout = setTimeout(() => {
    console.log(`${getLogTime()} 🔄 [Config] Arquivo alterado. Recarregando...`);
    loadConfigs();
  }, 1000);
}).on('error', (e) => {
  console.warn('⚠️ Watch error:', e.message);
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

function acquireSlot(req) {
  return new Promise(resolve => {
    const tryAcquire = () => {
      if (activeRequests < MAX_CONCURRENT) {
        activeRequests++;
        resolve(true);
      } else {
        // Se o cliente desistir enquanto espera, remove da fila
        const onClose = () => {
          const idx = waitQueue.indexOf(tryAcquire);
          if (idx !== -1) waitQueue.splice(idx, 1);
          resolve(false);
        };
        req.once('close', onClose);
        waitQueue.push(() => {
          req.off('close', onClose);
          if (req.destroyed) resolve(false);
          else { activeRequests++; resolve(true); }
        });
      }
    };
    tryAcquire();
  });
}

function releaseSlot() {
  activeRequests--;
  if (waitQueue.length > 0) waitQueue.shift()();
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
const backoffScheduleMin = [2, 5, 10, 15, 20, 25, 30, 60];
const endpointState = {};

function getState(id) {
  if (!endpointState[id]) endpointState[id] = { blockedUntil: 0, backoffIndex: 0 };
  return endpointState[id];
}

function applyBackoff(state, endpoint, status, errBody, tag, headers) {
  let abortCascade = false;
  if (status === 400 || status === 401 || status === 403) {
    console.log(`${getLogTime()} 🚨 [CRÍTICO] Erro ${status} em ${tag}. Abortando cascata.`);
    return true;
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
    return false;
  }

  const waitMin = backoffScheduleMin[state.backoffIndex] || 30;
  state.blockedUntil = Date.now() + waitMin * 60 * 1000;
  state.backoffIndex = Math.min(state.backoffIndex + 1, backoffScheduleMin.length - 1);

  console.log(`${getLogTime()} 🛑 [Bloqueio] Erro ${status}. ${tag} bloqueado por ${waitMin} min.`);
  return false;
}

// =====================================================================
// 7. BALANCEADOR DINÂMICO
// =====================================================================
let globalKeyToggle = 1;
let lastUsedModel = null;
let keysUsedSinceReset = new Set();

const DEFAULT_MODEL_ORDER = ['glm', 'kimi', 'deepseek', 'minimax'];
let modelOrder = [...DEFAULT_MODEL_ORDER];

const MODEL_MAP = {
  glm:      { provider: 'nvidia', model: 'z-ai/glm-5.1' },
  kimi:     { provider: 'nvidia', model: 'moonshotai/kimi-k2.6' },
  deepseek: { provider: 'nvidia', model: 'deepseek-ai/deepseek-v4-pro' },
  minimax:  { provider: 'nvidia', model: 'minimaxai/minimax-m3' },
};

function getModelDef(name) {
  const base = MODEL_MAP[name];
  if (!base) return null;
  return { ...base, name };
}

function currentModelList() {
  return modelOrder.map(name => getModelDef(name)).filter(Boolean);
}

function buildDynamicCascade() {
  const provider = PROVIDERS.nvidia;
  globalKeyToggle = (globalKeyToggle + 1) % 2;
  const startKey = globalKeyToggle;

  keysUsedSinceReset.add(startKey);
  if (keysUsedSinceReset.size >= provider.keys.length) {
    modelOrder = [...DEFAULT_MODEL_ORDER];
    keysUsedSinceReset.clear();
  } else if (lastUsedModel) {
    const idx = modelOrder.indexOf(lastUsedModel);
    if (idx >= 0) {
      modelOrder.splice(idx, 1);
      modelOrder.push(lastUsedModel);
    }
  }

  const ordered = currentModelList();

  let cascade = [];
  for (const m of ordered) {
    const physKey = startKey % provider.keys.length;
    const state = getState(`${m.provider}:${m.model}__${physKey}`);
    if (Date.now() >= state.blockedUntil) {
      cascade.push({ ...m, physicalKey: physKey });
    }
  }

  if (cascade.length === 0 && provider.keys.length > 1) {
    const otherKey = (startKey + 1) % 2;
    for (const m of ordered) {
      const physKey = otherKey % provider.keys.length;
      const state = getState(`${m.provider}:${m.model}__${physKey}`);
      if (Date.now() >= state.blockedUntil) {
        cascade.push({ ...m, physicalKey: physKey });
      }
    }
  }

  if (cascade.length === 0) {
    const m = ordered[0];
    cascade.push({ ...m, physicalKey: startKey % provider.keys.length });
  }

  return cascade;
}

// =====================================================================
// 7.5 NORMALIZE HELPER OTIMIZADO
// =====================================================================
const CJK_REGEX_GLOBAL = /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g;
const CJK_REGEX_TEST = /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/;

function injectModelTag(eventStr, model, tagState) {
  if (!eventStr.startsWith('data: ') || eventStr.trim() === 'data: [DONE]') {
    return { eventStr, tags: [] };
  }
  const jsonStr = eventStr.substring(6).trim();
  let parsed;
  try { parsed = JSON.parse(jsonStr); } catch (e) { return { eventStr, tags: [] }; }

  const delta = parsed.choices?.[0]?.delta;
  if (!delta) return { eventStr, tags: [] };

  const tags = [];

  if (delta.reasoning_content && delta.reasoning_content.trim() !== '') {
    delta.reasoning_content = delta.reasoning_content
      .replace(/\[Pensamento: [^\]]+\]\n*/g, '')
      .replace(/\[Resposta: [^\]]+\]\n*/g, '');
    if (tagState.reasoningTaggedModel !== model) {
      tagState.reasoningTaggedModel = model;
      delta.reasoning_content = '[Pensamento: ' + model + ']\n\n' + delta.reasoning_content;
      tags.push('reasoning');
    }
  }

  if (delta.content && delta.content.trim() !== '') {
    delta.content = delta.content
      .replace(/\[Pensamento: [^\]]+\]\n*/g, '')
      .replace(/\[Resposta: [^\]]+\]\n*/g, '');
    if (tagState.contentTaggedModel !== model) {
      tagState.contentTaggedModel = model;
      delta.content = '[Resposta: ' + model + ']\n\n' + delta.content;
      tags.push('content');
    }
  }


  if (tags.length > 0) {
    return { eventStr: 'data: ' + JSON.stringify(parsed), tags };
  }
  return { eventStr, tags };
}

function normalizeSSEEvent(eventStr, isKimi, kimiState) {
  if (!eventStr.startsWith('data: ') || eventStr.trim() === 'data: [DONE]') {
    return eventStr;
  }

  // Fast path: se não tem ferramentas, não é CJK e não é kimi, evita JSON parse
  const needsProcessing = isKimi || eventStr.includes('"tool_calls"') || eventStr.includes('"content"') || CJK_REGEX_TEST.test(eventStr);
  if (!needsProcessing) return eventStr;

  const jsonStr = eventStr.substring(6).trim();
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    return eventStr; // JSON inválido, mantém original
  }

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

    if (delta.content) delta.content = delta.content.replace(CJK_REGEX_GLOBAL, '');
    if (delta.reasoning_content) delta.reasoning_content = delta.reasoning_content.replace(CJK_REGEX_GLOBAL, '');

    if (kimiState) {
      if (delta.content && delta.content.trim() !== '') kimiState.kimiEmittedAnswer = true;
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) kimiState.kimiEmittedAnswer = true;
      if (delta.reasoning_content) {
        kimiState.kimiReasoningBuf += delta.reasoning_content;
      }
    }
  }

  return 'data: ' + JSON.stringify(parsed);
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
// 8. PREPARAÇÃO DO PAYLOAD (Deep Clone Anti-Mutation)
// =====================================================================
function prepareBody(parsedOriginal, endpoint) {
  const body = { ...parsedOriginal };
  body.model = endpoint.model;

  if (body.messages) {
    // DEEP CLONE das mensagens para evitar mutação do parsedOriginal
    body.messages = body.messages.map(msg => ({ ...msg }));

    const TAG_RE = /\[Pensamento: [^\]]+\]\n*|\[Resposta: [^\]]+\]\n*|\[Fallback: [^\]]+\]\n*/g;

    for (const msg of body.messages) {
      if (typeof msg.content === 'string') {
        msg.content = msg.content.replace(TAG_RE, '');
    } else if (Array.isArray(msg.content)) {
      msg.content = msg.content.map(part => ({ ...part }));
      for (const part of msg.content) {
          if (part.type === 'text' && typeof part.text === 'string') {
            part.text = part.text.replace(TAG_RE, '');
          }
        }
      }
      if (typeof msg.reasoning_content === 'string') {
        msg.reasoning_content = msg.reasoning_content.replace(TAG_RE, '');
      }
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length === 0) {
        delete msg.tool_calls;
      }
    }

    if (endpoint.model && endpoint.model.includes('kimi')) {
      const kimiExtra = [
        '\n\nCRITICAL OUTPUT FORMAT RULES — YOU MUST FOLLOW THESE:',
        '1. SEPARATE THINKING FROM ANSWER: "reasoning_content" = thinking, "content" = final answer.',
        '2. EVERY response MUST have a "content" field with a real answer.',
        '3. If using tools, emit "tool_calls" AND put a brief summary in "content".',
        '4. NEVER finish a response with only "reasoning_content" and empty "content".'
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
async function writeSSE(res, data) {
  if (res.writableEnded) return false;
  if (data.includes('data: [DONE]')) res._doneSent = true;
  const ok = res.write(data);
  if (!ok) {
    await new Promise(resolve => res.once('drain', resolve));
  }
  return true;
}

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

  logDebug(`\n=== [OPCODE -> PROXY] ${new Date().toISOString()} ===\n${bodyString}\n`);

  let parsedOriginal = {};
  try {
    if (req.headers['content-type']?.includes('application/json')) {
      parsedOriginal = JSON.parse(bodyString);
    }
  } catch (e) {}

  const acquired = await acquireSlot(req);
  if (!acquired) return; // Cliente desistiu

  let clientDisconnected = false;
  let activeController = null;

  // Aborta tudo se cliente desconectar
  req.on('close', () => {
    clientDisconnected = true;
    if (activeController) activeController.abort();
  });

    let abortCascade = false;

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

        while (tentativas < maxTentativas && !requestComplete && !clientDisconnected) {
          tentativas++;
          await enforceTimeLimit();

          const controller = new AbortController();
          activeController = controller;
          const initialTimer = setTimeout(() => {
            console.warn(`${getLogTime()} 🔴 [Timeout] ${ENV_CONN_TIMEOUT_MS}ms excedido em ${getVisualTag(endpoint.provider, endpoint.model, kIdx)}. Abortando...`);
            controller.abort();
          }, ENV_CONN_TIMEOUT_MS);

          let chunkTimer;
          const resetChunkTimer = (activeCtrl) => {
            clearTimeout(chunkTimer);
            chunkTimer = setTimeout(() => {
              console.warn(`${getLogTime()} 🔴 [Stream] ${ENV_STREAM_TIMEOUT_MS}ms sem dados! Abortando...`);
              activeCtrl.abort();
            }, ENV_STREAM_TIMEOUT_MS);
          };

          let startTime = Date.now();
          try {
            const url = `${provider.baseUrl}${req.url}`;
            const finalBody = prepareBody(parsedOriginal, endpoint);

            const headers = createProxyHeaders(req.headers, provider.baseUrl, provider.keys[kIdx]);

            console.log(`${getLogTime()} 🚀 [Início] -> ${getVisualTag(endpoint.provider, endpoint.model, kIdx)}`);

            const response = await fetch(url, buildFetchOptions(url, req.method, headers, finalBody, controller.signal));

            clearTimeout(initialTimer);
            console.log(`${getLogTime()} 📩 [Resposta] Status ${response.status} em ${((Date.now() - startTime) / 1000).toFixed(2)}s`);

            if (response.status >= 400) {
              clearTimeout(chunkTimer);
              let errBody = '';
              try { errBody = await response.text(); } catch (e) {}

              console.log(`${getLogTime()} ⚠️ [Erro] ${response.status} em ${getVisualTag(endpoint.provider, endpoint.model, kIdx)}: ${errBody.slice(0, 150)}`);
              abortCascade = applyBackoff(state, endpoint, response.status, errBody, getVisualTag(endpoint.provider, endpoint.model, kIdx), response.headers);
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

            // Sucesso! Atualiza lastUsedModel apenas aqui
            lastUsedModel = endpoint.name;
            state.backoffIndex = 0;

            // Rota: modelo que respondeu vai pro final da fila
            const usedIdx = modelOrder.indexOf(endpoint.name);
            if (usedIdx >= 0) {
              modelOrder.splice(usedIdx, 1);
              modelOrder.push(endpoint.name);
            }

            attemptsLog.push(`\x1b[32m✅\x1b[0m ${getVisualTag(endpoint.provider, endpoint.model, kIdx)}`);

            const resHeaders = {};
            response.headers.forEach((value, key) => {
              if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) {
                resHeaders[key] = value;
              }
            });
            res.writeHead(response.status, resHeaders);

            const isKimi = endpoint.model.includes('kimi');
            let kimiState = {
              kimiEmittedAnswer: false,
              kimiReasoningBuf: '',
              kimiFinishChunkBuf: null,
              kimiStreamId: null,
              kimiNeedsFallback: false
            };

            let sseBuffer = '';
            let tagState = { reasoningTaggedModel: null, contentTaggedModel: null };
            resetChunkTimer(controller);

            try {
              for await (let chunk of response.body) {
                if (clientDisconnected) break;
                resetChunkTimer(controller);

                if (chunk instanceof Uint8Array) chunk = Buffer.from(chunk);
                sseBuffer += chunk.toString('utf-8');

                let events = sseBuffer.split('\n\n');
                sseBuffer = events.pop(); // Guarda evento incompleto

                for (let eventStr of events) {
                  if (!eventStr.trim()) continue;

                  if (isKimi && !kimiState.kimiStreamId) {
                    const idMatch = eventStr.match(/"id"\s*:\s*"([^"]+)"/);
                    if (idMatch) kimiState.kimiStreamId = idMatch[1];
                  }

                  eventStr = normalizeSSEEvent(eventStr, isKimi, kimiState);
                  logDebug(`[NVIDIA -> PROXY] ${eventStr}`);
                  const { eventStr: taggedStr, tags } = injectModelTag(eventStr, endpoint.model, tagState);

                  const isFinishChunk = isKimi && /"finish_reason"\s*:\s*"(?:stop|length|tool_calls)"/.test(eventStr);
                  if (isFinishChunk) {
                    kimiState.kimiFinishChunkBuf = taggedStr;
                  } else {
                    await writeSSE(res, taggedStr + '\n\n');
                  }
                }
              }
              // Processa evento final restante no buffer
              if (sseBuffer.trim()) {
                sseBuffer = normalizeSSEEvent(sseBuffer, isKimi, kimiState);
                logDebug(`[NVIDIA -> PROXY] ${sseBuffer}`);
                await writeSSE(res, sseBuffer + '\n\n');
              }
            } catch (streamErr) {
              console.warn(`${getLogTime()} ⚠️ [Stream] Cortado: ${streamErr.message}`);
            } finally {
              clearTimeout(chunkTimer);
              if (isKimi && !kimiState.kimiEmittedAnswer && !clientDisconnected) {
                kimiState.kimiNeedsFallback = true;
                console.log(`${getLogTime()} 🔄 [${endpoint.name}] Sem resposta real (silêncio/corte). Fallback automático.`);
              }
            }

            if (kimiState.kimiNeedsFallback && !clientDisconnected) {
              kimiState.kimiFinishChunkBuf = null;

              const streamId = kimiState.kimiStreamId || 'chatcmpl-fallback';

              const fallbackNotice = 'data: ' + JSON.stringify({
                id: streamId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: endpoint.model,
                choices: [{ delta: { content: '\n[Fallback: modelo anterior não respondeu]\n\n' }, index: 0, finish_reason: null }]
              }) + '\n\n';
              await writeSSE(res, fallbackNotice);

              const fallbackCandidates = orderedEndpoints.filter(ep =>
              ep.name !== endpoint.name &&
              Date.now() >= getState(`${ep.provider}:${ep.model}__${ep.physicalKey}`).blockedUntil
              );
              // Não precisa reordenar: orderedEndpoints já vem com os primários (glm/kimi)
              // antes de deepseek/minimax, então o próximo da lista já é o outro primário.

              let fallbackSuccess = false;

              for (const nextEp of fallbackCandidates) {
                if (clientDisconnected) break;

                const fbProvider = PROVIDERS[nextEp.provider];
                const fkIdx = nextEp.physicalKey;
                const fbUrl = `${fbProvider.baseUrl}${req.url}`;

                const fbController = new AbortController();
                activeController = fbController;
                const fbInitialTimer = setTimeout(() => {
                  console.warn(`${getLogTime()} 🔴 [Fallback Timeout] ${ENV_CONN_TIMEOUT_MS}ms excedido em ${getVisualTag(nextEp.provider, nextEp.model, fkIdx)}. Abortando...`);
                  fbController.abort();
                }, ENV_CONN_TIMEOUT_MS);

                const fbBodyParsed = JSON.parse(prepareBody(parsedOriginal, nextEp));

                if (kimiState.kimiReasoningBuf.trim().length > 0) {
                  const lastUserIdx = fbBodyParsed.messages.findLastIndex(m => m.role === 'user');
                  if (lastUserIdx >= 0) {
                    const reasoningSuffix = '\n\n---\nEu mandei essa mesma mensagem pra outra IA e ela me devolveu isso aqui mas não confie cegamente antes de testar:\n\n' + kimiState.kimiReasoningBuf.trim();
                    const msg = fbBodyParsed.messages[lastUserIdx];
                    if (Array.isArray(msg.content)) {
                      const textPart = msg.content.find(p => p.type === 'text');
                      if (textPart) textPart.text += reasoningSuffix;
                      else msg.content.push({ type: 'text', text: reasoningSuffix });
                    } else if (typeof msg.content === 'string') {
                      msg.content += reasoningSuffix;
                    }
                  }
                }

                const fbBody = JSON.stringify(fbBodyParsed);
                const fbHeaders = createProxyHeaders(req.headers, fbProvider.baseUrl, fbProvider.keys[fkIdx]);

                console.log(`${getLogTime()} 🔁 [Fallback] -> ${getVisualTag(nextEp.provider, nextEp.model, fkIdx)}`);

                try {
                  const fbResponse = await fetch(fbUrl, buildFetchOptions(fbUrl, req.method, fbHeaders, fbBody, fbController.signal));

                  clearTimeout(fbInitialTimer);

                  if (fbResponse.status >= 400) {
                    let fbErrBody = '';
                    try { fbErrBody = await fbResponse.text(); } catch (e) {}
                    console.warn(`${getLogTime()} ⚠️ [Fallback] ${fbResponse.status} em ${getVisualTag(nextEp.provider, nextEp.model, fkIdx)}`);
                    applyBackoff(getState(`${nextEp.provider}:${nextEp.model}__${fkIdx}`), nextEp, fbResponse.status, fbErrBody, getVisualTag(nextEp.provider, nextEp.model, fkIdx), fbResponse.headers);
                    recordRequest(nextEp.model, Date.now() - requestStartTime, true, true);
                    if (abortCascade) break;
                    continue;
                  }

                  getState(`${nextEp.provider}:${nextEp.model}__${fkIdx}`).backoffIndex = 0;

                  let fbSseBuffer = '';
                  const fbIsKimi = nextEp.model.includes('kimi');

                  try {
                    for await (let fbChunk of fbResponse.body) {
                      if (clientDisconnected) break;
                      resetChunkTimer(fbController);
                      if (fbChunk instanceof Uint8Array) fbChunk = Buffer.from(fbChunk);
                      fbSseBuffer += fbChunk.toString('utf-8');

                      let fbEvents = fbSseBuffer.split('\n\n');
                      fbSseBuffer = fbEvents.pop();

                      for (let fbEventStr of fbEvents) {
                        if (!fbEventStr.trim()) continue;

                        fbEventStr = normalizeSSEEvent(fbEventStr, fbIsKimi, kimiState);
                        const { eventStr: fbTaggedStr } = injectModelTag(fbEventStr, nextEp.model, tagState);
                        if (kimiState.kimiStreamId) {
                          fbEventStr = fbTaggedStr.replace(/"id"\s*:\s*"[^"]*"/g, '"id":"' + kimiState.kimiStreamId + '"');
                        }
                        await writeSSE(res, (kimiState.kimiStreamId ? fbEventStr : fbTaggedStr) + '\n\n');
                      }
                    }
                    if (fbSseBuffer.trim()) {
                      fbSseBuffer = normalizeSSEEvent(fbSseBuffer, fbIsKimi, kimiState);
                      const { eventStr: fbTaggedStr } = injectModelTag(fbSseBuffer, nextEp.model, tagState);
                      if (kimiState.kimiStreamId) {
                        fbSseBuffer = fbTaggedStr.replace(/"id"\s*:\s*"[^"]*"/g, '"id":"' + kimiState.kimiStreamId + '"');
                      }
                      await writeSSE(res, (kimiState.kimiStreamId ? fbSseBuffer : fbTaggedStr) + '\n\n');
                    }
                  } catch (fbStreamErr) {
                    console.warn(`${getLogTime()} ⚠️ [Fallback Stream] Cortado: ${fbStreamErr.message}`);
                    recordRequest(nextEp.model, Date.now() - requestStartTime, true, true);
                    continue;
                  }
                  recordRequest(nextEp.model, Date.now() - requestStartTime, true, false);
                  fallbackSuccess = true;
                  break;

                } catch (fbFetchErr) {
                  clearTimeout(fbInitialTimer);
                  if (fbFetchErr.name === 'AbortError') {
                    console.warn(`${getLogTime()} ⏱️ [Fallback Abortado] Timeout em ${getVisualTag(nextEp.provider, nextEp.model, fkIdx)}. Tentando próximo...`);
                  } else {
                    console.error(`${getLogTime()} 💥 [Fallback Fetch] Erro em ${getVisualTag(nextEp.provider, nextEp.model, fkIdx)}:`, fbFetchErr.message);
                  }
                  recordRequest(nextEp.model, Date.now() - requestStartTime, true, true);
                  continue;
                }
              }

              if (!fallbackSuccess && !clientDisconnected) {
                console.log(`${getLogTime()} 🚫 [Fallback] Todos os modelos falharam`);
                await writeSSE(res, 'data: ' + JSON.stringify({
                  id: streamId, object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000), model: 'proxy',
                                                              choices: [{ delta: { content: '[Todos os fallbacks falharam]' }, index: 0, finish_reason: null }]
                }) + '\n\n');
              }
            } else if (kimiState.kimiFinishChunkBuf) {
              // Se não precisou de fallback, manda o finish chunk guardado
              await writeSSE(res, kimiState.kimiFinishChunkBuf + '\n\n');
            }

            // Limpeza final: se o fallback rodou, ele reaproveitou/rearmou o chunkTimer
            // (via resetChunkTimer) e ninguém limpou depois. Sem isso, o timer fica
            // pendurado e dispara um aviso fantasma ~450s depois do request já ter terminado.
            clearTimeout(chunkTimer);

            if (!res.writableEnded) {
              if (!res._doneSent) await writeSSE(res, 'data: [DONE]\n\n');
              res.end();
            }
            recordRequest(endpoint.model, Date.now() - startTime, false, false);
            requestComplete = true;
            break;

          } catch (fetchErr) {
            clearTimeout(initialTimer);
            clearTimeout(chunkTimer);
            if (fetchErr.name === 'AbortError') {
              if (!clientDisconnected) console.warn(`${getLogTime()} ⏱️ [Abortado] Timeout em ${getVisualTag(endpoint.provider, endpoint.model, kIdx)}.`);
            } else {
              console.error(`${getLogTime()} 💥 [Rede] Erro:`, fetchErr.message);
            }
            attemptsLog.push(`\x1b[31m💥\x1b[0m ${getVisualTag(endpoint.provider, endpoint.model, kIdx)}`);
            recordRequest(endpoint.model, Date.now() - startTime, false, true);
            if (tentativas >= maxTentativas || clientDisconnected) continue modelLoop;
          }
        }
        if (requestComplete || clientDisconnected) break;
      }

      const totalTime = ((Date.now() - requestStartTime) / 1000).toFixed(2);
      if (!clientDisconnected) {
        console.log(`${getLogTime()} 📊 [Resumo] Rota: ${attemptsLog.join(' -> ')} | Tempo: ${totalTime}s`);
      }

      if (!requestComplete && !res.headersSent && !clientDisconnected) {
        let minUnblock = Infinity;
        for (const id in endpointState) {
          if (endpointState[id].blockedUntil > Date.now() && endpointState[id].blockedUntil < minUnblock) {
            minUnblock = endpointState[id].blockedUntil;
          }
        }
        const waitSec = Math.ceil((minUnblock - Date.now()) / 1000);

        if (waitSec > 0 && waitSec < 30 * 60) {
          res.writeHead(429, { 'Retry-After': waitSec, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Todos os endpoints bloqueados. Tente em ${waitSec}s.`, type: "proxy_overload" } }));
        } else {
          res.writeHead(503);
          res.end('Serviço indisponível.');
        }
      }

    } catch (err) {
      console.error(`${getLogTime()} 💥 [Crítico] Erro interno:`, err.message);
      if (!res.headersSent && !clientDisconnected) {
        res.writeHead(500);
        res.end('Proxy Error');
      }
    } finally {
      activeController = null;
      releaseSlot();
    }
});

server.listen(ENV_PORT, ENV_HOST, () => {
  console.log(`🛡 Limite Global: ${TARGET_GLOBAL_RPM} RPM (Intervalo de ${MIN_INTERVAL_MS}ms)`);
  console.log(`🛡 Concorrência: ${MAX_CONCURRENT}`);
  console.log(`🛡 Timers: ${ENV_CONN_TIMEOUT_MS}ms conexão inicial | ${ENV_STREAM_TIMEOUT_MS}ms silêncio no stream`);
  console.log('🛡 Erros: Respeita Retry-After. 500+ = escala min. 400/401/403 = Aborto imediato.');
  console.log(`🛡 Host:Port: ${ENV_HOST}:${ENV_PORT} 📊 Métricas: GET http://${ENV_HOST}:${ENV_PORT}/health e http://${ENV_HOST}:${ENV_PORT}/metrics disponíveis.`);
  console.log(`🔌 Chaves físicas ativas: ${PROVIDERS.nvidia.keys.length}`);
  console.log('🔄 Dinâmico: Alterna K1/K2 e NUNCA repete o modelo.');
  console.log('🐛 Debug: Aperte a tecla [D] neste terminal para ligar/desligar o log.');
  console.log('\x1b[36m🚀 Proxy-Opencode-Router v1.0.0 ativo!\x1b[0m\n');
});
