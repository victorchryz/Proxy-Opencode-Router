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
  applyTimeoutCeilingBackoff,
  blockedEndpoints,
  earliestUnblockMs,
  activeCount,
} from './state.js';
import { buildDynamicCascade, setLastUsedModel } from './cascade.js';
import {
  normalizeSSEEvent,
  injectModelTag,
  newTagState,
  newStreamState,
} from './normalize.js';
import { createProxyHeaders, buildFetchOptions, prepareBody } from './prepare.js';
import { recordRequest, snapshot as metricsSnapshot } from './metrics.js';
import { ts, visualTag, debug, isDebug } from './logger.js';
import { HOP_BY_HOP, CONTEXT_OVERFLOW_RE } from './constants.js';

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

/** Emit a synthetic SSE error stream: writeHead (if needed) + content chunk +
 *  finish_reason:stop + [DONE] + end. Used by all error/abort paths. */
async function emitErrorStream(res, id, msg) {
  if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  await sendSyntheticChunk(res, id, msg);
  await writeSSE(res, 'data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'proxy', choices: [{ delta: {}, index: 0, finish_reason: 'stop' }] }) + '\n\n');
  if (!res.__doneSent) await writeSSE(res, 'data: [DONE]\n\n');
  if (!res.writableEnded) res.end();
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

async function* sseEvents(response, chunkTimer, clientRef) {
  let sseBuffer = '';
  chunkTimer.reset();
  for await (let chunk of response.body) {
    if (clientRef.value) return;
    chunkTimer.reset();
    if (chunk instanceof Uint8Array) chunk = Buffer.from(chunk);
    sseBuffer += chunk.toString('utf-8');
    const events = sseBuffer.split('\n\n');
    sseBuffer = events.pop() ?? '';
    for (const eventStr of events) {
      const dataLine = eventStr.split('\n').find(l => l.startsWith('data: '));
      if (dataLine) yield dataLine;
    }
  }
  if (sseBuffer.trim() && !clientRef.value) {
    const dataLine = sseBuffer.split('\n').find(l => l.startsWith('data: '));
    if (dataLine && dataLine.trim() !== 'data: [DONE]') {
      try { JSON.parse(dataLine.substring(6).trim()); yield dataLine; }
      catch { /* partial frame — discard */ }
    }
  }
}

async function pumpStream(response, res, endpoint, tagState, streamState, chunkTimer, clientRef) {
  const pendingChunks = [];
  const resHeaders = {};
  response.headers.forEach((v, k) => {
    if (!HOP_BY_HOP.has(k.toLowerCase())) resHeaders[k] = v;
  });

  for await (let eventStr of sseEvents(response, chunkTimer, clientRef)) {
    if (!streamState.streamId) {
      const idMatch = eventStr.match(/"id"\s*:\s*"([^"]+)"/);
      if (idMatch) streamState.streamId = idMatch[1];
    }

    const contentLenBefore = streamState.contentBuf.length;
    const reasoningLenBefore = streamState.reasoningBuf.length;
    eventStr = normalizeSSEEvent(eventStr, streamState);
    const hadUsefulContent =
      streamState.contentBuf.length > contentLenBefore ||
      streamState.reasoningBuf.length > reasoningLenBefore ||
      streamState.emittedAnswer;

    debug(`[NVIDIA -> PROXY] ${eventStr}`);
    const { eventStr: taggedStr } = injectModelTag(eventStr, endpoint.model, tagState);

    const isFinish = /"finish_reason"\s*:\s*"(?:stop|length|tool_calls)"/.test(eventStr);
    const isDone = eventStr.trim() === 'data: [DONE]';
    if (isFinish) {
      streamState.finishChunkBuf = taggedStr;
    } else if (isDone) {
      streamState.doneBuf = taggedStr;
    } else {
      if (hadUsefulContent && !streamState.headersSent) {
        res.writeHead(response.status, resHeaders);
        streamState.headersSent = true;
        for (const pending of pendingChunks) {
          const alive = await writeSSE(res, pending + '\n\n');
          if (!alive) { clientRef.value = true; break; }
        }
        pendingChunks.length = 0;
      }
      if (clientRef.value) break;
      if (streamState.headersSent) {
        const alive = await writeSSE(res, taggedStr + '\n\n');
        if (!alive) { clientRef.value = true; break; }
      } else {
        pendingChunks.push(taggedStr);
      }
    }
  }
}

/**
 * Run a single fallback attempt against `nextEp` and stream it to the client.
 * @returns {Promise<boolean>} `true` if the fallback streamed successfully.
 */
async function runFallback(req, res, parsedOriginal, nextEp, fallbackStreamId, tagState, fallbackStreamState, clientDisconnectedRef) {
  const provider = PROVIDERS[nextEp.provider];
  const fkIdx = nextEp.physicalKey;
  const url = `${provider.baseUrl}${req.url}`;

  const controller = new AbortController();
  // connTimeoutMs: tempo desde fetch() até receber os HEADERS HTTP da NVIDIA.
  // Limpo por clearTimeout(initialTimer) logo após fetch() resolver. NÃO
  // mede stream nem "pensamento" pós-headers.
  const initialTimer = setTimeout(
    () => controller.abort(),
    ENV.connTimeoutMs,
  );
  // streamTimeoutMs: tempo máximo de SILÊNCIO (idle) entre chunks. Reseta a
  // cada chunk recebido. NÃO mede duração total — só aborta se ficar 90s
  // sem receber NENHUM byte.
  const chunkTimer = makeChunkTimer(ENV.streamTimeoutMs, () => {
    console.warn(`${ts()} [STREAM] ${ENV.streamTimeoutMs}ms sem dados (fallback). Abortando...`);
    controller.abort();
  });

  try {
    const body = prepareBody(parsedOriginal, nextEp);
    const headers = createProxyHeaders(req.headers, provider.baseUrl, provider.keys[fkIdx]);
    console.log(`${ts()} [FALLBACK] -> ${visualTag(nextEp.provider, nextEp.model, fkIdx)}`);

    const response = await fetch(url, buildFetchOptions(req.method, headers, body, controller.signal));
    clearTimeout(initialTimer);

    if (response.status >= 400) {
      let errBody = '';
      try { errBody = await response.text(); } catch { /* ignore */ }
      console.warn(`${ts()} [FALLBACK] ${response.status} em ${visualTag(nextEp.provider, nextEp.model, fkIdx)}: ${errBody.slice(0, 150)}`);
      applyBackoff(
        getState(`${nextEp.provider}:${nextEp.model}__${fkIdx}`),
        response.status,
        errBody,
        visualTag(nextEp.provider, nextEp.model, fkIdx),
        response.headers,
      );
      return false;
    }

    getState(`${nextEp.provider}:${nextEp.model}__${fkIdx}`).backoffIndex = 0;

    for await (let eventStr of sseEvents(response, chunkTimer, clientDisconnectedRef)) {
      eventStr = normalizeSSEEvent(eventStr, fallbackStreamState);
      debug(`[FALLBACK -> PROXY] ${eventStr}`);
      const { eventStr: taggedStr } = injectModelTag(eventStr, nextEp.model, tagState);
      const out = fallbackStreamState.streamId
        ? taggedStr.replace(/"id"\s*:\s*"[^"]*"/, `"id":"${fallbackStreamId}"`)
        : taggedStr;
      const alive = await writeSSE(res, out + '\n\n');
      if (!alive) { clientDisconnectedRef.value = true; break; }
    }

    return true;
  } catch (err) {
    clearTimeout(initialTimer);
    if (err?.name === 'AbortError') {
      console.warn(`${ts()} [FALLBACK ABORT] Timeout em ${visualTag(nextEp.provider, nextEp.model, fkIdx)}.`);
    } else {
      console.error(`${ts()} [FALLBACK FETCH] ${visualTag(nextEp.provider, nextEp.model, fkIdx)}: ${err?.message ?? err}`);
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
          console.warn(`${ts()} [TIMEOUT] ${state.connectTimeout}ms excedido em ${visualTag(endpoint.provider, endpoint.model, kIdx)}. Abortando...`);
          controller.abort();
        }, state.connectTimeout);

        // streamTimeoutMs: tempo máximo de SILÊNCIO (idle) entre chunks do
        // stream SSE. Reseta a cada chunk recebido via chunkTimer.reset().
        // NÃO mede duração total do stream — só aborta se ficar 90s sem
        // receber NENHUM byte. Stream lento mas contínuo NUNCA aborta.
        const chunkTimer = makeChunkTimer(state.streamTimeout, () => {
          console.warn(`${ts()} [STREAM] ${state.streamTimeout}ms sem dados em ${visualTag(endpoint.provider, endpoint.model, kIdx)}! Abortando...`);
          controller.abort();
        });

        const attemptStart = Date.now();
        let gotResponseHeaders = false;
        try {
          const url = `${provider.baseUrl}${req.url}`;
          const body = prepareBody(parsedOriginal, endpoint);
          const headers = createProxyHeaders(req.headers, provider.baseUrl, provider.keys[kIdx]);
          console.log(`${ts()} [INÍCIO] -> ${visualTag(endpoint.provider, endpoint.model, kIdx)}`);

          const response = await fetch(url, buildFetchOptions(req.method, headers, body, controller.signal));
          clearTimeout(initialTimer);
          gotResponseHeaders = true;
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
                if (response.status === 400 && CONTEXT_OVERFLOW_RE.test(errBody)) {
                  res.writeHead(400, { 'Content-Type': 'application/json' });
                  res.end(errBody);
                } else if (parsedOriginal?.stream !== false) {
                  await emitErrorStream(res, 'chatcmpl-proxy-abort', `\n[Proxy: erro ${response.status} — requisição inválida, não retriable]`);
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
          setLastUsedModel(endpoint.name, kIdx);
          state.backoffIndex = 0;
          attemptsLog.push(`OK ${visualTag(endpoint.provider, endpoint.model, kIdx)}`);

          const tagState = newTagState();
          const streamState = newStreamState();

          let streamAborted = false;
          try {
            await pumpStream(response, res, endpoint, tagState, streamState, chunkTimer, clientRef);
          } catch (streamErr) {
            streamAborted = true;
            console.warn(`${ts()} [STREAM] Cortado: ${streamErr.message}`);
            if (streamErr?.name === 'AbortError' && !clientRef.value) {
              applyTimeoutCeilingBackoff(state, visualTag(endpoint.provider, endpoint.model, kIdx), true);
            }
          } finally {
            chunkTimer.clear();
            if (streamState.headersSent) {
              const hasContent = streamState.contentBuf.trim().length > 0;
              const hasReasoning = streamState.reasoningBuf.trim().length > 0;
              const hasFinish = !!streamState.finishChunkBuf;
              console.log(`${ts()} [STREAM-FIM] contentLen=${streamState.contentBuf.length} reasoningLen=${streamState.reasoningBuf.length} toolCalls=${streamState.emittedAnswer} finish=${hasFinish} clientGone=${clientRef.value}`);
              if (!clientRef.value) {
                if (hasReasoning && !hasContent) {
                  streamState.needsFallback = true;
                  console.log(`${ts()} [${endpoint.name}] Só reasoning sem content — acionando fallback.`);
                } else if (streamAborted && !hasFinish) {
                  streamState.needsFallback = true;
                  console.log(`${ts()} [${endpoint.name}] Stream abortado sem finish_reason (contentLen=${streamState.contentBuf.length}) — acionando fallback.`);
                } else {
                  console.log(`${ts()} [${endpoint.name}] Resposta considerada completa (sem fallback).`);
                }
              } else {
                console.log(`${ts()} [${endpoint.name}] Cliente desconectado — fallback não acionado.`);
              }
            }
          }

          const hasAnyOutput = streamState.emittedAnswer || streamState.contentBuf.length > 0 || streamState.reasoningBuf.length > 0;
          if (!streamState.headersSent && !hasAnyOutput && !clientRef.value) {
            attemptsLog[attemptsLog.length - 1] = `VAZIO ${visualTag(endpoint.provider, endpoint.model, kIdx)}`;
            console.log(`${ts()} [${endpoint.name}] Sem conteúdo útil (emittedAnswer=${streamState.emittedAnswer} contentLen=${streamState.contentBuf.length} reasoningLen=${streamState.reasoningBuf.length}) — pulando para próximo modelo.`);
            recordRequest(endpoint.model, Date.now() - attemptStart, false, true);
            break;
          }

          let fallbackOk = false;
          if (streamState.needsFallback && !clientRef.value) {
            const fallbackStreamId = streamState.streamId || 'chatcmpl-fallback';
            streamState.finishChunkBuf = null;

            await sendSyntheticChunk(res, fallbackStreamId, '\n', 'proxy-fallback');

            const fallbackTagState = newTagState();
            const fallbackStreamState = newStreamState();
            fallbackStreamState.streamId = streamState.streamId;

            const fbParsedOriginal = { ...parsedOriginal, messages: undefined };
            if (Array.isArray(parsedOriginal.messages)) {
              fbParsedOriginal.messages = parsedOriginal.messages.map((m) => ({ ...m }));
            }

            if (streamState.reasoningBuf.trim() && Array.isArray(fbParsedOriginal.messages)) {
              const lastUserIdx = fbParsedOriginal.messages.findLastIndex?.((m) => m.role === 'user') ?? -1;
              if (lastUserIdx >= 0) {
                const suffix =
                  '\n\n---\nEu mandei essa mesma mensagem pra outra IA e ela me devolveu isso aqui mas não confie cegamente antes de testar:\n\n' +
                  streamState.reasoningBuf.trim();
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

            const candidates = cascade.filter(
              (ep) =>
                ep.name !== endpoint.name &&
                Date.now() >= getState(`${ep.provider}:${ep.model}__${ep.physicalKey}`).blockedUntil,
            );

            for (const nextEp of candidates) {
              if (clientRef.value) break;
              const fbStart = Date.now();
              const ok = await runFallback(
                req,
                res,
                fbParsedOriginal,
                nextEp,
                fallbackStreamId,
                fallbackTagState,
                fallbackStreamState,
                clientRef,
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
              await writeSSE(
                res,
                'data: ' +
                  JSON.stringify({
                    id: fallbackStreamId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: 'proxy',
                    choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
                  }) +
                  '\n\n',
              );
            }
          } else if (streamState.finishChunkBuf) {
            if (!streamState.headersSent) {
              res.writeHead(response.status, resHeaders);
              streamState.headersSent = true;
              for (const pending of pendingChunks) {
                const alive = await writeSSE(res, pending + '\n\n');
                if (!alive) { clientRef.value = true; break; }
              }
              pendingChunks.length = 0;
            }
            await writeSSE(res, streamState.finishChunkBuf + '\n\n');
            if (streamState.doneBuf) await writeSSE(res, streamState.doneBuf + '\n\n');
          } else if (streamState.doneBuf) {
            if (!streamState.headersSent) {
              res.writeHead(response.status, resHeaders);
              streamState.headersSent = true;
            }
            await writeSSE(res, streamState.doneBuf + '\n\n');
          }

          if (!res.writableEnded) {
            if (!res.__doneSent) await writeSSE(res, 'data: [DONE]\n\n');
            res.end();
          }
          if (streamState.needsFallback && fallbackOk) {
            recordRequest(endpoint.model, Date.now() - attemptStart, false, true);
          } else {
            recordRequest(endpoint.model, Date.now() - attemptStart, false, false);
          }
          requestComplete = true;
          break; // exit attempt loop
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
          recordRequest(endpoint.model, Date.now() - attemptStart, false, true);

          // CRITICAL: if we already started streaming to the client (headers
          // sent), we cannot retry the same endpoint NOR silently move to the
          // next cascade endpoint — the client is waiting for stream closure.
          // We must emit an error chunk + finish_reason + [DONE] + end() so
          // the client (opencode) sees the stream terminate. Otherwise the
          // client hangs forever waiting for a response that never completes.
          if (res.headersSent && !res.writableEnded && !clientRef.value) {
            console.log(`${ts()} [STREAM-FALHOU] Encerrando stream do cliente após abort.`);
            try {
              await emitErrorStream(res, 'chatcmpl-proxy-abort', '\n\n[Stream interrompido por timeout]');
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

    // Every endpoint failed without aborting — return HTTP 429 (with
    // Retry-After) or 503 so OpenCode sees a retryable error and auto-retries
    // with its own backoff, instead of masking as synthetic SSE 200 which
    // forced the user to manually re-send.
    if (!requestComplete && !res.headersSent && !clientRef.value) {
      const unblock = earliestUnblockMs();
      const waitSec = Math.ceil((unblock - Date.now()) / 1000);

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
  } catch (err) {
    console.error(`${ts()} [CRÍTICO] Erro interno: ${err?.stack ?? err}`);
    if (!res.headersSent && !clientRef.value) {
      if (parsedOriginal?.stream !== false) {
        try {
          await emitErrorStream(res, 'chatcmpl-proxy-error', '\n[Proxy: erro interno — tente novamente]');
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
          await emitErrorStream(res, 'chatcmpl-proxy-uncaught', '\n[Proxy: erro interno — tente novamente]');
        } catch {
          try { res.destroy(); } catch { /* ignore */ }
        }
      }
    });
  });
}
