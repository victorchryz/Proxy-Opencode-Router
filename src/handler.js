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
} from './state.js';
import { buildDynamicCascade, setLastUsedModel } from './cascade.js';
import {
  normalizeSSEEvent,
  injectModelTag,
  newTagState,
} from './normalize.js';
import { createProxyHeaders, buildFetchOptions, prepareBody } from './prepare.js';
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
    res.__poisoned = true;
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

/** Send a small synthetic chunk (used for fallback notices / final errors). */
async function sendSyntheticChunk(res, streamId, content, model = 'proxy') {
  await writeSSE(
    res,
    'data: ' +
      JSON.stringify({
        id: streamId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ delta: { content }, index: 0, finish_reason: null }],
      }) +
      '\n\n',
  );
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
 * Check whether a parsed delta has any useful content (content, tool_calls,
 * or reasoning_content — anything the client can actually use).
 * @param {Record<string,any>} delta
 * @returns {boolean}
 */
function deltaHasUsefulContent(delta) {
  if (!delta) return false;
  if (typeof delta.content === 'string' && delta.content.trim() !== '') return true;
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.trim() !== '') return true;
  return false;
}

/**
 * Stream one upstream response into the client, applying normalization & tags.
 *
 * Buffers chunks internally until the first useful content delta arrives.
 * Only then does it call res.writeHead() and flush the buffer — so if the
 * stream stalls or aborts before producing any useful content, the caller can
 * silently fall back to the next cascade endpoint without the client noticing.
 *
 * @param {import('http').ServerResponse} res
 * @param {Record<string,string>} resHeaders — upstream response headers (already
 *   filtered of hop-by-hop). Only used if we actually writeHead.
 * @returns {Promise<{ hadUsefulContent: boolean, headersSent: boolean }>}
 */
async function pumpStream(response, res, resHeaders, endpoint, tagState, controller, chunkTimer, clientDisconnectedRef) {
  let sseBuffer = '';
  let headersSent = false;
  let hadUsefulContent = false;
  /** @type {string[]} */
  const pendingChunks = [];
  chunkTimer.reset();

  for await (let chunk of response.body) {
    if (clientDisconnectedRef.value) break;
    chunkTimer.reset();

    if (chunk instanceof Uint8Array) chunk = Buffer.from(chunk);
    sseBuffer += chunk.toString('utf-8');

    const events = sseBuffer.split('\n\n');
    sseBuffer = events.pop() ?? '';

    for (let eventStr of events) {
      if (!eventStr.trim()) continue;

      eventStr = normalizeSSEEvent(eventStr);
      debug(`[NVIDIA -> PROXY] ${eventStr}`);

      if (!headersSent) {
        let parsed;
        try { parsed = JSON.parse(eventStr.substring(6).trim()); } catch { parsed = null; }
        const delta = parsed?.choices?.[0]?.delta;
        if (deltaHasUsefulContent(delta)) {
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

      const { eventStr: taggedStr } = injectModelTag(eventStr, endpoint.model, tagState);

      if (headersSent) {
        const alive = await writeSSE(res, taggedStr + '\n\n');
        if (!alive) { clientDisconnectedRef.value = true; break; }
      } else {
        pendingChunks.push(taggedStr + '\n\n');
      }
    }
  }

  if (sseBuffer.trim() && !clientDisconnectedRef.value) {
    const trimmed = sseBuffer.trim();
    if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
      try {
        JSON.parse(trimmed.substring(6).trim());
      } catch {
        console.warn(`${ts()} [STREAM] Frame parcial (JSON inválido) — enviando mesmo assim.`);
      }
      sseBuffer = normalizeSSEEvent(sseBuffer);
      debug(`[NVIDIA -> PROXY] ${sseBuffer}`);

      if (!headersSent) {
        let parsed;
        try { parsed = JSON.parse(sseBuffer.substring(6).trim()); } catch { parsed = null; }
        const delta = parsed?.choices?.[0]?.delta;
        if (deltaHasUsefulContent(delta)) {
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

      const { eventStr: taggedStr } = injectModelTag(sseBuffer, endpoint.model, tagState);

      if (headersSent) {
        await writeSSE(res, taggedStr + '\n\n');
      } else {
        pendingChunks.push(taggedStr + '\n\n');
      }
    }
  }

  return { hadUsefulContent, headersSent };
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
    const cascade = buildDynamicCascade(PROVIDERS.nvidia);
    console.log(
      `${ts()} [PLANO] ${cascade.map((e) => visualTag(e.provider, e.model, e.physicalKey)).join(' -> ')}`,
    );

    let requestComplete = false;
    let abortCascade = false;

    cascadeLoop: for (const endpoint of cascade) {
      const provider = PROVIDERS[endpoint.provider];
      if (!provider || provider.keys.length === 0) continue cascadeLoop;

      const kIdx = endpoint.physicalKey;
      const state = getState(`${endpoint.provider}:${endpoint.model}__${kIdx}`);
      if (Date.now() < state.blockedUntil) {
        const rem = Math.ceil((state.blockedUntil - Date.now()) / 1000);
        attemptsLog.push(`SKIP ${visualTag(endpoint.provider, endpoint.model, kIdx)}[${rem}s]`);
        continue cascadeLoop;
      }

      if (endpoint !== cascade[0]) {
        console.log(`${ts()} [CASCATA] Roteando para ${visualTag(endpoint.provider, endpoint.model, kIdx)}...`);
      }

      // Per-endpoint retry budget. We only retry on NETWORK errors that happen
      // BEFORE we get any upstream response (e.g. DNS failure, connection
      // refused). Once we've received headers — even a 200 that later stalls
      // mid-stream — we do NOT retry the same endpoint: that would loop for
      // 2×stream_timeout on every hung connection and multiply the failure
      // latency. Instead we abort and move to the next endpoint in the cascade.
      let gotResponseHeaders = false;

      for (let attempt = 1; attempt <= 2 && !requestComplete && !clientRef.value; attempt++) {
        await enforceTimeLimit();

        const controller = new AbortController();
        clientRef.controller = controller;
        // connTimeoutMs: tempo desde o disparo de fetch() até receber os
        // HEADERS HTTP da NVIDIA (status + headers). Limpo por
        // clearTimeout(initialTimer) logo após fetch() resolver. NÃO mede
        // stream, NÃO mede "pensamento" pós-headers — só o handshake inicial
        // (TCP+TLS+processamento upstream até o primeiro byte de resposta).
        const initialTimer = setTimeout(() => {
          console.warn(`${ts()} [TIMEOUT] ${ENV.connTimeoutMs}ms excedido em ${visualTag(endpoint.provider, endpoint.model, kIdx)}. Abortando...`);
          controller.abort();
        }, ENV.connTimeoutMs);

        // streamTimeoutMs: tempo máximo de SILÊNCIO (idle) entre chunks do
        // stream SSE. Reseta a cada chunk recebido via chunkTimer.reset().
        // NÃO mede duração total do stream — só aborta se ficar 90s sem
        // receber NENHUM byte. Stream lento mas contínuo NUNCA aborta.
        const chunkTimer = makeChunkTimer(ENV.streamTimeoutMs, () => {
          console.warn(`${ts()} [STREAM] ${ENV.streamTimeoutMs}ms sem dados! Abortando...`);
          controller.abort();
        });

        const attemptStart = Date.now();
        try {
          const url = `${provider.baseUrl}${req.url}`;
          const body = prepareBody(parsedOriginal, endpoint);
          const headers = createProxyHeaders(req.headers, provider.baseUrl, provider.keys[kIdx]);
          console.log(`${ts()} [INÍCIO] -> ${visualTag(endpoint.provider, endpoint.model, kIdx)}`);

          const response = await fetch(url, buildFetchOptions(req.method, headers, body, controller.signal));
          clearTimeout(initialTimer);
          gotResponseHeaders = true; // we got *some* response — don't retry this endpoint on stream errors
          console.log(
            `${ts()} [RESPOSTA] Status ${response.status} em ${((Date.now() - attemptStart) / 1000).toFixed(2)}s`,
          );

          // ----- Upstream error -----
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
            recordRequest(endpoint.model, Date.now() - attemptStart, false, true);

            if (abortCascade) {
              if (!res.headersSent) {
                const wantsStream = parsedOriginal?.stream !== false;
                if (wantsStream) {
                  const abortStreamId = 'chatcmpl-proxy-abort';
                  res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                  });
                  const abortMsg = `\n[Proxy: erro ${response.status} — requisição inválida, não retriable]`;
                  await sendSyntheticChunk(res, abortStreamId, abortMsg);
                  await writeSSE(res, 'data: ' + JSON.stringify({
                    id: abortStreamId, object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000), model: 'proxy',
                    choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
                  }) + '\n\n');
                  if (!res.__doneSent) await writeSSE(res, 'data: [DONE]\n\n');
                  res.end();
                } else {
                  res.writeHead(response.status, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: { message: errBody, type: 'proxy_abort_error' } }));
                }
              }
              requestComplete = true;
            }
            // Either way, this endpoint is done — try the next one (or break).
            break; // exit attempt loop, continue cascadeLoop
          }

          // ----- Success: stream the response -----
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
          } finally {
            chunkTimer.clear();
          }

          // If the stream produced no useful content AND we never sent headers,
          // the client hasn't seen anything — fall through to the next cascade
          // endpoint transparently.
          if (streamResult && !streamResult.headersSent) {
            console.log(`${ts()} [VAZIO] ${visualTag(endpoint.provider, endpoint.model, kIdx)} — stream sem conteúdo útil, tentando próximo.`);
            attemptsLog[attemptsLog.length - 1] = `EMPTY ${visualTag(endpoint.provider, endpoint.model, kIdx)}`;
            recordRequest(endpoint.model, Date.now() - attemptStart, false, true);
            break; // exit attempt loop, continue cascadeLoop
          }

          // ----- Finalize -----
          if (!res.writableEnded) {
            if (!res.__doneSent) await writeSSE(res, 'data: [DONE]\n\n');
            res.end();
          }
          recordRequest(endpoint.model, Date.now() - attemptStart, false, false);
          requestComplete = true;
          break; // exit attempt loop
        } catch (fetchErr) {
          clearTimeout(initialTimer);
          chunkTimer.clear();
          const isAbort = fetchErr?.name === 'AbortError';
          if (isAbort) {
            if (!clientRef.value) {
              console.warn(`${ts()} [ABORT] Timeout em ${visualTag(endpoint.provider, endpoint.model, kIdx)}.`);
            }
          } else {
            console.error(`${ts()} [REDE] ${visualTag(endpoint.provider, endpoint.model, kIdx)}: ${fetchErr.message}`);
          }
          attemptsLog.push(`NET ${visualTag(endpoint.provider, endpoint.model, kIdx)}`);
          recordRequest(endpoint.model, Date.now() - attemptStart, false, true);

          // CRITICAL: if we already started streaming to the client (headers
          // sent), we cannot retry the same endpoint NOR silently move to the
          // next cascade endpoint — the client is waiting for stream closure.
          // We must emit an error chunk + finish_reason + [DONE] + end() so
          // the client (opencode) sees the stream terminate. Otherwise the
          // client hangs forever waiting for a response that never completes.
          //
          // If headers were NOT sent yet (buffering mode), the client hasn't
          // seen anything — fall through to the next cascade endpoint silently.
          if (res.headersSent && !res.writableEnded && !clientRef.value) {
            console.log(`${ts()} [STREAM-FALHOU] Encerrando stream do cliente após abort.`);
            const errStreamId = 'chatcmpl-proxy-abort';
            try {
              await writeSSE(res, 'data: ' + JSON.stringify({
                id: errStreamId, object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000), model: 'proxy',
                choices: [{ delta: { content: '\n\n[Stream interrompido por timeout]' }, index: 0, finish_reason: null }],
              }) + '\n\n');
              await writeSSE(res, 'data: ' + JSON.stringify({
                id: errStreamId, object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000), model: 'proxy',
                choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
              }) + '\n\n');
              if (!res.__doneSent) await writeSSE(res, 'data: [DONE]\n\n');
              res.end();
            } catch (e) {
              console.warn(`${ts()} [STREAM-FALHOU] Erro ao encerrar: ${e.message}`);
              try { res.destroy(); } catch { /* ignore */ }
            }
            requestComplete = true;
            break; // exit attempt loop, will break cascadeLoop below
          }

          // Timeouts (AbortError) are NOT retried — a stream stall or connection
          // timeout usually means the upstream is unhealthy; retrying the same
          // endpoint just doubles the latency before we move to the next cascade
          // candidate. Only fast network errors (ECONNREFUSED, DNS, etc.) get
          // the retry budget. This prevents the "loop" where every hung endpoint
          // burns 2 × stream_timeout before falling through.
          if (isAbort) {
            break; // exit attempt loop, continue cascadeLoop
          }
          // Non-abort network error: retry if attempts remain (loop continues).
        }
      } // attempt loop

      if (requestComplete || clientRef.value || abortCascade) break cascadeLoop;
    } // cascadeLoop

    if (!clientRef.value) {
      const total = ((Date.now() - requestStartTime) / 1000).toFixed(2);
      console.log(`${ts()} [RESUMO] ${attemptsLog.join(' -> ')} | ${total}s`);
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
        const errStreamId = 'chatcmpl-proxy-exhausted';
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        await sendSyntheticChunk(res, errStreamId, msg);
        await writeSSE(res, 'data: ' + JSON.stringify({
          id: errStreamId, object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000), model: 'proxy',
          choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
        }) + '\n\n');
        if (!res.__doneSent) await writeSSE(res, 'data: [DONE]\n\n');
        res.end();
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
        const errStreamId = 'chatcmpl-proxy-error';
        try {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
          await sendSyntheticChunk(res, errStreamId, '\n[Proxy: erro interno — tente novamente]');
          await writeSSE(res, 'data: ' + JSON.stringify({
            id: errStreamId, object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000), model: 'proxy',
            choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
          }) + '\n\n');
          if (!res.__doneSent) await writeSSE(res, 'data: [DONE]\n\n');
          res.end();
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
          await writeSSE(res, 'data: ' + JSON.stringify({
            id: 'chatcmpl-proxy-uncaught',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: 'proxy',
            choices: [{ delta: { content: '\n[Proxy: erro interno — tente novamente]' }, index: 0, finish_reason: null }],
          }) + '\n\n');
          await writeSSE(res, 'data: ' + JSON.stringify({
            id: 'chatcmpl-proxy-uncaught',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: 'proxy',
            choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
          }) + '\n\n');
          await writeSSE(res, 'data: [DONE]\n\n');
          res.end();
        } catch {
          try { res.destroy(); } catch { /* ignore */ }
        }
      }
    });
  });
}
