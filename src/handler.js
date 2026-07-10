// src/handler.js
// Main HTTP request handler: cascade dispatch, streaming, fallback, and
// exhaustive error handling for NVIDIA / OpenCode edge cases.

import http from 'node:http';
import { ENV } from './config.js';
import { PROVIDERS } from './providers.js';
import {
  acquireSlot,
  releaseSlot,
  enforceTimeLimit,
  getState,
  applyBackoff,
  blockedEndpoints,
  earliestUnblockMs,
  activeCount,
  applyTimeoutCeilingBackoff,
} from './state.js';
import { buildDynamicCascade, buildCascadeForKey, setLastUsedModel } from './cascade.js';
import {
  normalizeSSEEvent,
  injectModelTag,
  newTagState,
} from './normalize.js';
import { createProxyHeaders, prepareBody } from './prepare.js';
import { recordRequest, snapshot as metricsSnapshot } from './metrics.js';
import { ts, visualTag, debug, isDebug } from './logger.js';
import { HOP_BY_HOP } from './constants.js';

/**
 * Write an SSE chunk to the client; awaits backpressure drain.
 *
 * Returns `false` if the write should be considered fatal (socket ended or
 * drain timed out twice in a row). Callers check the return value and stop
 * pumping when it's false, so a dead client can't stall a large stream.
 *
 * @param {import('http').ServerResponse} res
 * @param {string} data
 * @returns {Promise<boolean>}
 */
async function writeSSE(res, data) {
  if (res.writableEnded || res.destroyed) return false;
  if (data.includes('data: [DONE]')) res.__doneSent = true;
  const ok = res.write(data);
  if (!ok) {
    // Cap the drain wait so a dead socket can't hang the handler forever.
    // Clean up BOTH handles regardless of which wins, so we don't leak
    // pending timeouts or dangling 'drain' listeners over a long stream.
    let drainResolve, timeoutHandle;
    await Promise.race([
      new Promise((r) => {
        drainResolve = r;
        res.once('drain', r);
      }),
      new Promise((r) => {
        timeoutHandle = setTimeout(r, 5000);
      }),
    ]);
    res.off('drain', drainResolve);
    clearTimeout(timeoutHandle);
    if (!res.writableNeedDrain) {
      // Drain resolved naturally — safe to continue.
      return true;
    }
    // Still needs drain after 5s → socket is likely dead. Poison it.
    console.warn(`${ts()} [STREAM] Drain timeout (5s) — socket provavelmente morto, parando writes.`);
    try { res.destroy(); } catch { /* ignore */ }
    return false;
  }
  return true;
}

/** Build a self-resetting stream-idle timer; returns { reset, clear }. */
function makeChunkTimer(ms, onTimeout) {
  let h = setTimeout(onTimeout, ms);
  return {
    reset() {
      clearTimeout(h);
      h = setTimeout(onTimeout, ms);
    },
    clear() {
      clearTimeout(h);
    },
  };
}

async function sendErrorStream(res, streamId, content) {
  try {
    await writeSSE(
      res,
      'data: ' + JSON.stringify({
        id: streamId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'proxy',
        choices: [{ delta: { content }, index: 0, finish_reason: null }],
      }) + '\n\n',
    );
    await writeSSE(res, 'data: ' + JSON.stringify({
      id: streamId, object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000), model: 'proxy',
      choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
    }) + '\n\n');
    if (!res.__doneSent) await writeSSE(res, 'data: [DONE]\n\n');
    res.end();
  } catch (e) {
    console.warn(`${ts()} [STREAM-FALHOU] Erro ao encerrar: ${e.message}`);
    try { res.destroy(); } catch { /* ignore */ }
  }
}

/** Read the entire request body into a string. No size cap — both the client
 *  (opencode) and the upstream API (NVIDIA) enforce their own limits. */
async function readBody(req) {
  const chunks = [];
  for await (const c of req) {
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Stream one upstream response into the client, applying normalization & tags.
 *
 * Buffers chunks internally until the first useful content delta arrives.
 * Only then does it call res.writeHead() and flush the buffer — so if the
 * stream stalls or aborts before producing any useful content, the caller can
 * silently fall back to the next cascade endpoint without the client noticing.
 *
 * The finish_reason chunk and [DONE] marker are retained (not sent immediately)
 * so the caller can decide whether to emit them or trigger a fallback after the
 * stream ends (e.g. when the response is incomplete — no finish_reason).
 *
 * @param {import('http').ServerResponse} res
 * @param {Record<string,string>} resHeaders — upstream response headers (already
 *   filtered of hop-by-hop). Only used if we actually writeHead.
 * @returns {Promise<{ hadUsefulContent: boolean, headersSent: boolean, stalled: boolean, streamId: string|null, maxChunkGap: number, contentBuf: string, reasoningBuf: string, finishReason: string|null, finishChunkBuf: string|null, doneBuf: string|null }>}
 */
async function pumpStream(response, res, resHeaders, endpoint, tagState, controller, chunkTimer, clientDisconnectedRef, streamIdOverride = null) {
  let sseBuffer = '';
  let headersSent = streamIdOverride !== null;
  let hadUsefulContent = streamIdOverride !== null;
  let stalled = false;
  let streamId = streamIdOverride;
  let maxChunkGap = 0;
  let lastChunkTime = Date.now();
  let contentBuf = '';
  let reasoningBuf = '';
  let finishReason = null;
  let finishChunkBuf = null;
  let doneBuf = null;
  /** @type {string[]} */
  const pendingChunks = [];
  chunkTimer.reset();

  async function processEvent(eventStr) {
    if (!streamId) {
      const idMatch = eventStr.match(/"id"\s*:\s*"([^"]+)"/);
      if (idMatch) streamId = idMatch[1];
    }

    if (eventStr.trim() === 'data: [DONE]') {
      doneBuf = eventStr;
      return;
    }

    let parsed = null;
    if (eventStr.startsWith('data: ')) {
      try { parsed = JSON.parse(eventStr.substring(6).trim()); } catch {}
    }
    const choice = parsed?.choices?.[0];
    const delta = choice?.delta;
    const finish = choice?.finish_reason;

    if (delta) {
      if (typeof delta.content === 'string') contentBuf += delta.content;
      if (typeof delta.reasoning_content === 'string') reasoningBuf += delta.reasoning_content;
    }

    if (!headersSent) {
      if (delta && ((typeof delta.content === 'string' && delta.content.trim()) || (Array.isArray(delta.tool_calls) && delta.tool_calls.length) || (typeof delta.reasoning_content === 'string' && delta.reasoning_content.trim()))) {
        headersSent = true;
        hadUsefulContent = true;
        res.writeHead(200, resHeaders);
        for (const pending of pendingChunks) {
          const alive = await writeSSE(res, pending);
          if (!alive) { clientDisconnectedRef.value = true; break; }
        }
        pendingChunks.length = 0;
      }
    }

    let out = injectModelTag(eventStr, endpoint.model, tagState);
    if (streamIdOverride) {
      out = out.replace(/"id"\s*:\s*"[^"]*"/g, `"id":"${streamIdOverride}"`);
    }

    if (finish) {
      finishReason = finish;
      finishChunkBuf = out;
      return;
    }

    if (headersSent) {
      const alive = await writeSSE(res, out + '\n\n');
      if (!alive) clientDisconnectedRef.value = true;
    } else {
      pendingChunks.push(out + '\n\n');
    }
  }

  try {
    for await (let chunk of response.body) {
      if (clientDisconnectedRef.value) break;
      chunkTimer.reset();

      const now = Date.now();
      const gap = now - lastChunkTime;
      if (gap > maxChunkGap) maxChunkGap = gap;
      lastChunkTime = now;

      if (chunk instanceof Uint8Array) chunk = Buffer.from(chunk);
      sseBuffer += chunk.toString('utf-8');

      const events = sseBuffer.split('\n\n');
      sseBuffer = events.pop() ?? '';

      for (let eventStr of events) {
        if (!eventStr.trim()) continue;
        eventStr = normalizeSSEEvent(eventStr);
        debug(`[UPSTREAM -> PROXY] ${eventStr}`);
        await processEvent(eventStr);
        if (clientDisconnectedRef.value) break;
      }
    }
  } catch (streamErr) {
    if (streamErr?.name === 'AbortError' && headersSent) {
      stalled = true;
    } else {
      throw streamErr;
    }
  }

  if (!stalled && sseBuffer.trim() && !clientDisconnectedRef.value) {
    const trimmed = sseBuffer.trim();
    if (trimmed.startsWith('data: ')) {
      if (trimmed !== 'data: [DONE]') {
        try { JSON.parse(trimmed.substring(6).trim()); }
        catch { console.warn(`${ts()} [STREAM] Frame parcial (JSON inválido) — enviando mesmo assim.`); }
      }
      sseBuffer = normalizeSSEEvent(sseBuffer);
      debug(`[UPSTREAM -> PROXY] ${sseBuffer}`);
      await processEvent(sseBuffer);
    }
  }

  return { hadUsefulContent, headersSent, stalled, streamId, maxChunkGap, contentBuf, reasoningBuf, finishReason, finishChunkBuf, doneBuf };
}

async function runStallFallback(req, res, parsedOriginal, nextEp, stallStreamId, clientDisconnectedRef) {
  const provider = PROVIDERS[nextEp.provider];
  const fkIdx = nextEp.physicalKey;
  const url = `${provider.baseUrl}${req.url}`;

  const controller = new AbortController();
  const initialTimer = setTimeout(() => controller.abort(), ENV.connTimeoutMs);
  const chunkTimer = makeChunkTimer(ENV.streamTimeoutMs, () => {
    console.warn(`${ts()} [STALL-FALLBACK] ${ENV.streamTimeoutMs}ms sem dados. Abortando...`);
    controller.abort();
  });

  try {
    const body = prepareBody(parsedOriginal, nextEp);
    const headers = createProxyHeaders(req.headers, provider.baseUrl, provider.keys[fkIdx]);
    console.log(`${ts()} [STALL-FALLBACK] -> ${visualTag(nextEp.provider, nextEp.model, fkIdx)}`);

    const response = await fetch(url, { method: req.method, headers, body: req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined, signal: controller.signal });
    clearTimeout(initialTimer);

    if (response.status >= 400) {
      let errBody = '';
      try { errBody = await response.text(); } catch { /* ignore */ }
      console.warn(`${ts()} [STALL-FALLBACK] ${response.status} em ${visualTag(nextEp.provider, nextEp.model, fkIdx)}: ${errBody.slice(0, 150)}`);
      applyBackoff(getState(`${nextEp.provider}:${nextEp.model}__${fkIdx}`), response.status, errBody, visualTag(nextEp.provider, nextEp.model, fkIdx), response.headers);
      return false;
    }

    getState(`${nextEp.provider}:${nextEp.model}__${fkIdx}`).backoffIndex = 0;

    const tagState = newTagState();
    const result = await pumpStream(response, res, {}, nextEp, tagState, controller, chunkTimer, clientDisconnectedRef, stallStreamId);
    if (!result.stalled) {
      if (result.finishChunkBuf) await writeSSE(res, result.finishChunkBuf + '\n\n');
      if (!res.__doneSent && result.doneBuf) await writeSSE(res, result.doneBuf + '\n\n');
    }
    return !result.stalled;
  } catch (err) {
    clearTimeout(initialTimer);
    if (err?.name === 'AbortError') {
      console.warn(`${ts()} [STALL-FALLBACK] Timeout em ${visualTag(nextEp.provider, nextEp.model, fkIdx)}.`);
    } else {
      console.error(`${ts()} [STALL-FALLBACK] ${visualTag(nextEp.provider, nextEp.model, fkIdx)}: ${err?.message ?? err}`);
    }
    return false;
  } finally {
    chunkTimer.clear();
  }
}

/**
 * Main HTTP handler. Mutates neither parsedOriginal nor its inner objects.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
export async function handleRequest(req, res) {
  // ----- Admin routes -----
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify(
        {
          status: 'ok',
          uptime: process.uptime(),
          activeRequests: activeCount(),
          blockedModels: blockedEndpoints(),
          rpm: ENV.targetRpm,
          concurrent: ENV.maxConcurrent,
        },
        null,
        2,
      ),
    );
  }
  if (req.url === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify(
        metricsSnapshot({
          uptime: process.uptime(),
          activeRequests: activeCount(),
          blockedModels: blockedEndpoints().length,
        }),
        null,
        2,
      ),
    );
  }

  if (!req.url?.startsWith('/v1')) {
    res.writeHead(404);
    return res.end();
  }

  // ----- URL sanitization -----
  // req.url is always defined for http.createServer, but be defensive. Reject
  // anything that isn't a simple path+query (no \n, \r, or control chars that
  // could confuse the upstream fetch or sneak into logs).
  if (typeof req.url !== 'string' || /[\r\n\x00-\x1f]/.test(req.url)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({ error: { message: 'URL malformada', type: 'proxy_bad_url' } }),
    );
  }

  // ----- Read + parse inbound body -----
  let bodyString = await readBody(req);
  if (isDebug()) debug(`\n=== [OPENCODE -> PROXY] ${new Date().toISOString()} ===\n${bodyString}\n`);

  /** @type {Record<string, any>} */
  let parsedOriginal = {};
  if (req.headers['content-type']?.includes('application/json')) {
    try {
      parsedOriginal = JSON.parse(bodyString);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({ error: { message: `JSON inválido no body: ${err.message}`, type: 'proxy_bad_json' } }),
      );
    }
  }

  // ----- Acquire concurrency slot -----
  const acquired = await acquireSlot(req);
  if (!acquired) return; // client gave up while queued

  /** Boxed ref so inner closures can read/write the latest value. */
  const clientRef = { value: false, controller: /** @type {AbortController|null} */ (null) };
  req.on('close', () => {
    clientRef.value = true;
    clientRef.controller?.abort();
  });

  const requestStartTime = Date.now();
  /** @type {string[]} */
  const attemptsLog = [];

  try {
    let requestComplete = false;
    let abortCascade = false;
    let stalledAfterHeaders = false;
    let stallStreamId = null;
    let stalledEndpoint = null;
    let incompleteAfterHeaders = false;
    let incompleteStreamId = null;
    let incompleteReasoningBuf = '';
    let incompleteEndpoint = null;

    const runCascadeBatch = async (cascade) => {
      for (const endpoint of cascade) {
        const provider = PROVIDERS[endpoint.provider];
        if (!provider || provider.keys.length === 0) continue;

        const kIdx = endpoint.physicalKey;
        const state = getState(`${endpoint.provider}:${endpoint.model}__${kIdx}`);
        if (Date.now() < state.blockedUntil) {
          const rem = Math.ceil((state.blockedUntil - Date.now()) / 1000);
          attemptsLog.push(`SKIP ${visualTag(endpoint.provider, endpoint.model, kIdx)}[${rem}s]`);
          continue;
        }

        if (endpoint !== cascade[0]) {
          console.log(`${ts()} [CASCATA] Roteando para ${visualTag(endpoint.provider, endpoint.model, kIdx)}...`);
        }

        let gotResponseHeaders = false;

        for (let attempt = 1; attempt <= 2 && !requestComplete && !clientRef.value; attempt++) {
          await enforceTimeLimit();

          const controller = new AbortController();
          clientRef.controller = controller;
          const currentConnTimeout = state.connectTimeout;
          const currentStreamTimeout = state.streamTimeout;

          const initialTimer = setTimeout(() => {
            console.warn(`${ts()} [TIMEOUT] ${currentConnTimeout}ms excedido em ${visualTag(endpoint.provider, endpoint.model, kIdx)}. Abortando...`);
            controller.abort();
          }, currentConnTimeout);

          const chunkTimer = makeChunkTimer(currentStreamTimeout, () => {
            console.warn(`${ts()} [STREAM] ${currentStreamTimeout}ms sem dados em ${visualTag(endpoint.provider, endpoint.model, kIdx)}! Abortando...`);
            controller.abort();
          });

          const attemptStart = Date.now();
          try {
            const url = `${provider.baseUrl}${req.url}`;
            const body = prepareBody(parsedOriginal, endpoint);
            const headers = createProxyHeaders(req.headers, provider.baseUrl, provider.keys[kIdx]);
            console.log(`${ts()} [INÍCIO] -> ${visualTag(endpoint.provider, endpoint.model, kIdx)}`);

    const response = await fetch(url, { method: req.method, headers, body: req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined, signal: controller.signal });
            clearTimeout(initialTimer);
            gotResponseHeaders = true;
            console.log(
              `${ts()} [RESPOSTA] Status ${response.status} em ${((Date.now() - attemptStart) / 1000).toFixed(2)}s`,
            );

            if (response.status < 400) {
              const actualTTFT = Date.now() - attemptStart;
              state.connectTimeout = Math.max(30000, Math.min(60000, actualTTFT * 2));
            }

            if (response.status >= 400) {
              chunkTimer.clear();
              let errBody = '';
              try { errBody = await response.text(); } catch { /* ignore */ }
              console.warn(
                `${ts()} [ERRO] ${response.status} em ${visualTag(endpoint.provider, endpoint.model, kIdx)}: ${errBody.slice(0, 150)}`,
              );
              abortCascade = applyBackoff(
                state,
                response.status,
                errBody,
                visualTag(endpoint.provider, endpoint.model, kIdx),
                response.headers,
              );
              attemptsLog.push(`FAIL ${visualTag(endpoint.provider, endpoint.model, kIdx)}`);
              recordRequest(endpoint.model, Date.now() - attemptStart, true);

              if (abortCascade) {
                if (res.headersSent) {
                  requestComplete = true;
                }
              }
              break;
            }

            setLastUsedModel(endpoint.name);
            state.backoffIndex = 0;
            attemptsLog.push(`OK ${visualTag(endpoint.provider, endpoint.model, kIdx)}`);

            /** @type {Record<string, string>} */
            const resHeaders = {};
            response.headers.forEach((v, k) => {
              if (!HOP_BY_HOP.has(k.toLowerCase())) resHeaders[k] = v;
            });

            const tagState = newTagState();

            let streamResult;
            try {
              streamResult = await pumpStream(response, res, resHeaders, endpoint, tagState, controller, chunkTimer, clientRef);
            } catch (streamErr) {
              if (res.headersSent && !clientRef.value) {
                console.warn(`${ts()} [STREAM] Cortado: ${streamErr.message} — re-thrown para encerramento.`);
                throw streamErr;
              }
              console.warn(`${ts()} [STREAM] Cortado: ${streamErr.message}`);
              streamResult = { hadUsefulContent: false, headersSent: false, stalled: false, streamId: null, maxChunkGap: 0, contentBuf: '', reasoningBuf: '', finishReason: null, finishChunkBuf: null, doneBuf: null };
            } finally {
              chunkTimer.clear();
            }

            if (streamResult && !streamResult.headersSent) {
              console.log(`${ts()} [VAZIO] ${visualTag(endpoint.provider, endpoint.model, kIdx)} — stream sem conteúdo útil, tentando próximo.`);
              attemptsLog[attemptsLog.length - 1] = `EMPTY ${visualTag(endpoint.provider, endpoint.model, kIdx)}`;
              recordRequest(endpoint.model, Date.now() - attemptStart, true);
              break;
            }

            if (streamResult && streamResult.stalled && streamResult.headersSent) {
              console.log(`${ts()} [STALL] ${visualTag(endpoint.provider, endpoint.model, kIdx)} — stream estalou, tentando fallback...`);
              attemptsLog[attemptsLog.length - 1] = `STALL ${visualTag(endpoint.provider, endpoint.model, kIdx)}`;
              recordRequest(endpoint.model, Date.now() - attemptStart, true);
              stallStreamId = streamResult.streamId;
              stalledEndpoint = endpoint;
              stalledAfterHeaders = true;
              break;
            }

            if (streamResult && streamResult.headersSent && streamResult.maxChunkGap > 0) {
              state.streamTimeout = Math.max(45000, Math.min(75000, streamResult.maxChunkGap * 3));
            }

            if (streamResult.finishReason !== null) {
              if (!res.writableEnded) {
                if (streamResult.finishChunkBuf) await writeSSE(res, streamResult.finishChunkBuf + '\n\n');
                if (!res.__doneSent && streamResult.doneBuf) await writeSSE(res, streamResult.doneBuf + '\n\n');
                res.end();
              }
              recordRequest(endpoint.model, Date.now() - attemptStart, false);
              requestComplete = true;
            } else {
              console.log(`${ts()} [INCOMPLETO] ${visualTag(endpoint.provider, endpoint.model, kIdx)} — stream terminou sem finish_reason, acionando fallback.`);
              attemptsLog[attemptsLog.length - 1] = `INCOMPLETE ${visualTag(endpoint.provider, endpoint.model, kIdx)}`;
              recordRequest(endpoint.model, Date.now() - attemptStart, true);
              incompleteStreamId = streamResult.streamId;
              incompleteReasoningBuf = streamResult.reasoningBuf;
              incompleteEndpoint = endpoint;
              incompleteAfterHeaders = true;
            }
            break;
          } catch (fetchErr) {
            clearTimeout(initialTimer);
            chunkTimer.clear();
            const isAbort = fetchErr?.name === 'AbortError';
            if (isAbort) {
              if (!clientRef.value) {
                console.warn(`${ts()} [ABORT] Timeout em ${visualTag(endpoint.provider, endpoint.model, kIdx)}.`);
                applyTimeoutCeilingBackoff(
                  state,
                  visualTag(endpoint.provider, endpoint.model, kIdx),
                  gotResponseHeaders,
                );
              }
            } else {
              console.error(`${ts()} [REDE] ${visualTag(endpoint.provider, endpoint.model, kIdx)}: ${fetchErr.message}`);
            }
            attemptsLog.push(`NET ${visualTag(endpoint.provider, endpoint.model, kIdx)}`);
            recordRequest(endpoint.model, Date.now() - attemptStart, true);

            if (res.headersSent && !res.writableEnded && !clientRef.value) {
              console.log(`${ts()} [STREAM-FALHOU] Encerrando stream do cliente após abort.`);
              await sendErrorStream(res, 'chatcmpl-proxy-abort', '\n\n[Stream interrompido por timeout]');
              requestComplete = true;
              break;
            }

            if (isAbort) {
              break;
            }
          }
        }

        if (requestComplete || clientRef.value || abortCascade || stalledAfterHeaders || incompleteAfterHeaders) return;
      }
    };

    const cascade1 = buildDynamicCascade();
    console.log(
      `${ts()} [PLANO] ${cascade1.map((e) => visualTag(e.provider, e.model, e.physicalKey)).join(' -> ')}`,
    );

    await runCascadeBatch(cascade1);

    if (!requestComplete && !res.headersSent && !clientRef.value && !stalledAfterHeaders) {
      const maxKeys = Math.max(...Object.values(PROVIDERS).map((p) => p.keys.length), 1);
      const usedKey = cascade1[0]?.physicalKey ?? 0;
      const otherKey = (usedKey + 1) % maxKeys;
      const cascade2 = buildCascadeForKey(otherKey);
      if (cascade2.length > 0) {
        console.log(
          `${ts()} [PLANO-K2] ${cascade2.map((e) => visualTag(e.provider, e.model, e.physicalKey)).join(' -> ')}`,
        );
        abortCascade = false;
        await runCascadeBatch(cascade2);
      }
    }

    if (!clientRef.value) {
      const total = ((Date.now() - requestStartTime) / 1000).toFixed(2);
      console.log(`${ts()} [RESUMO] ${attemptsLog.join(' -> ')} | ${total}s`);
    }

    if (stalledAfterHeaders && !clientRef.value) {
      const stalledKey = stalledEndpoint.physicalKey;
      const maxKeys = Math.max(...Object.values(PROVIDERS).map((p) => p.keys.length), 1);
      const otherKey = (stalledKey + 1) % maxKeys;
      const sameKey = buildCascadeForKey(stalledKey).filter(
        (ep) => ep.provider !== stalledEndpoint.provider || ep.model !== stalledEndpoint.model || ep.physicalKey !== stalledEndpoint.physicalKey,
      );
      const otherKeyEps = maxKeys > 1
        ? buildCascadeForKey(otherKey)
        : [];
      const remaining = [...sameKey, ...otherKeyEps];

      let fallbackOk = false;
      let triedOtherKey = false;
      for (const nextEp of remaining) {
        if (clientRef.value) break;
        if (!triedOtherKey && nextEp.physicalKey !== stalledKey) {
          console.log(`${ts()} [STALL-FALLBACK-K2] Tentando outra key...`);
          triedOtherKey = true;
        }
        await enforceTimeLimit();
        const fbStart = Date.now();
        const ok = await runStallFallback(req, res, parsedOriginal, nextEp, stallStreamId, clientRef);
        if (ok) {
          attemptsLog.push(`OK ${visualTag(nextEp.provider, nextEp.model, nextEp.physicalKey)}`);
          recordRequest(nextEp.model, Date.now() - fbStart, false);
          fallbackOk = true;
          break;
        } else {
          attemptsLog.push(`FAIL ${visualTag(nextEp.provider, nextEp.model, nextEp.physicalKey)}`);
          recordRequest(nextEp.model, Date.now() - fbStart, true);
        }
      }

      if (fallbackOk) {
        if (!res.writableEnded) {
          if (!res.__doneSent) await writeSSE(res, 'data: [DONE]\n\n');
          res.end();
        }
        requestComplete = true;
      } else if (!clientRef.value) {
        await sendErrorStream(res, stallStreamId || 'chatcmpl-proxy-stall', '\n\n[Stream interrompido — todos os fallbacks falharam]');
        requestComplete = true;
      }
    }

    if (incompleteAfterHeaders && !clientRef.value) {
      const incompleteKey = incompleteEndpoint.physicalKey;
      const maxKeys = Math.max(...Object.values(PROVIDERS).map((p) => p.keys.length), 1);
      const otherKey = (incompleteKey + 1) % maxKeys;
      const sameKey = buildCascadeForKey(incompleteKey).filter(
        (ep) => ep.provider !== incompleteEndpoint.provider || ep.model !== incompleteEndpoint.model || ep.physicalKey !== incompleteEndpoint.physicalKey,
      );
      const otherKeyEps = maxKeys > 1
        ? buildCascadeForKey(otherKey)
        : [];
      const remaining = [...sameKey, ...otherKeyEps];

      const fbParsedOriginal = { ...parsedOriginal, messages: undefined };
      if (Array.isArray(parsedOriginal.messages)) {
        fbParsedOriginal.messages = parsedOriginal.messages.map((m) => ({ ...m }));
        if (incompleteReasoningBuf.trim()) {
          const lastUserIdx = fbParsedOriginal.messages.findLastIndex?.((m) => m.role === 'user') ?? -1;
          if (lastUserIdx >= 0) {
            const suffix =
              '\n\n---\n[Contexto de raciocínio do modelo anterior — use como referência, mas verifique e questione antes de confiar. O pensamento abaixo pode conter erros ou conclusões precipitadas:]\n\n' +
              incompleteReasoningBuf.trim();
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
      }

      let fallbackOk = false;
      let triedOtherKey = false;
      for (const nextEp of remaining) {
        if (clientRef.value) break;
        if (!triedOtherKey && nextEp.physicalKey !== incompleteKey) {
          console.log(`${ts()} [INCOMPLETE-FALLBACK-K2] Tentando outra key...`);
          triedOtherKey = true;
        }
        await enforceTimeLimit();
        const fbStart = Date.now();
        const ok = await runStallFallback(req, res, fbParsedOriginal, nextEp, incompleteStreamId, clientRef);
        if (ok) {
          attemptsLog.push(`OK ${visualTag(nextEp.provider, nextEp.model, nextEp.physicalKey)}`);
          recordRequest(nextEp.model, Date.now() - fbStart, false);
          fallbackOk = true;
          break;
        } else {
          attemptsLog.push(`FAIL ${visualTag(nextEp.provider, nextEp.model, nextEp.physicalKey)}`);
          recordRequest(nextEp.model, Date.now() - fbStart, true);
        }
      }

      if (fallbackOk) {
        if (!res.writableEnded) {
          if (!res.__doneSent) await writeSSE(res, 'data: [DONE]\n\n');
          res.end();
        }
        requestComplete = true;
      } else if (!clientRef.value) {
        await sendErrorStream(res, incompleteStreamId || 'chatcmpl-proxy-incomplete', '\n\n[Resposta incompleta — todos os fallbacks falharam]');
        requestComplete = true;
      }
    }

    // Every endpoint failed without aborting — emit a synthetic SSE stream
    // so the client (opencode) sees a completed response instead of a hard
    // 429/503 JSON error. A hard error makes opencode stop and require the
    // user to type "." to retry; a synthetic stream lets the conversation
    // continue seamlessly.
    if (!requestComplete && !res.headersSent && !clientRef.value) {
      const unblock = earliestUnblockMs();
      const waitSec = Math.ceil((unblock - Date.now()) / 1000);
      const wantsStream = parsedOriginal?.stream !== false;

      if (wantsStream) {
        const msg = waitSec > 0 && waitSec < 30 * 60
          ? `\n[Proxy: todos os modelos indisponíveis — aguarde ${waitSec}s e reenvie]`
          : '\n[Proxy: serviço indisponível — tente novamente]';
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        await sendErrorStream(res, 'chatcmpl-proxy-exhausted', msg);
      } else {
        if (waitSec > 0 && waitSec < 30 * 60) {
          res.writeHead(429, { 'Retry-After': String(waitSec), 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: { message: `Todos os endpoints bloqueados. Tente em ${waitSec}s.`, type: 'proxy_overload' },
            }),
          );
        } else {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Serviço indisponível.', type: 'proxy_unavailable' } }));
        }
      }
    }
  } catch (err) {
    console.error(`${ts()} [CRÍTICO] Erro interno: ${err?.stack ?? err}`);
    if (!res.headersSent && !clientRef.value) {
      const wantsStream = parsedOriginal?.stream !== false;
      if (wantsStream) {
        try {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
          await sendErrorStream(res, 'chatcmpl-proxy-error', '\n[Proxy: erro interno — tente novamente]');
        } catch {
          try { res.destroy(); } catch { /* ignore */ }
        }
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Proxy Error', type: 'proxy_internal' } }));
      }
    }
  } finally {
    clientRef.controller = null;
    releaseSlot();
  }
}

/** Build the HTTP server (no listen — caller decides). */
export function createServer() {
  return http.createServer((req, res) => {
    // Always have a top-level catch so a thrown sync error never crashes the
    // server process. handleRequest already does its own try/catch, this is
    // belt-and-suspenders for readBody / acquireSlot edge cases.
    handleRequest(req, res).catch(async (err) => {
      console.error(`${ts()} [UNCAUGHT] ${err?.stack ?? err}`);
      if (!res.headersSent) {
        try {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
          await sendErrorStream(res, 'chatcmpl-proxy-uncaught', '\n[Proxy: erro interno — tente novamente]');
        } catch {
          try { res.destroy(); } catch { /* ignore */ }
        }
      }
    });
  });
}
