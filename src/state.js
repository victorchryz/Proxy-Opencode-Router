// src/state.js
// Per-endpoint backoff state, RPM limiter and concurrency slots.
// Designed for a single-process Node HTTP server (no shared state across machines).

import { ENV, MIN_INTERVAL_MS } from './config.js';
import { ts } from './logger.js';

/** @typedef {{ blockedUntil: number, backoffIndex: number, connectTimeout: number, streamTimeout: number }} EndpointState */

/** Backoff schedule (minutes) for retryable upstream errors.
 *  Starts at 2 min and grows to 1h. */
const BACKOFF_MINUTES = [2, 5, 10, 15, 20, 30, 60];

/** @type {Record<string, EndpointState>} */
const endpointState = {};

/** Get (or create) the state slot for a given endpoint id. */
export function getState(id) {
  if (!endpointState[id]) endpointState[id] = { blockedUntil: 0, backoffIndex: 0, connectTimeout: ENV.connTimeoutMs, streamTimeout: ENV.streamTimeoutMs };
  return endpointState[id];
}

/** Snapshot all currently-blocked endpoints (for /health). */
export function blockedEndpoints() {
  const now = Date.now();
  return Object.entries(endpointState)
    .filter(([, s]) => s.blockedUntil > now)
    .map(([id, s]) => ({ id, blockedSeconds: Math.ceil((s.blockedUntil - now) / 1000) }));
}

/** Earliest unblock time across all endpoints (ms since epoch), or 0 if none blocked. */
export function earliestUnblockMs() {
  const now = Date.now();
  let min = Infinity;
  for (const id in endpointState) {
    if (endpointState[id].blockedUntil > now && endpointState[id].blockedUntil < min) {
      min = endpointState[id].blockedUntil;
    }
  }
  return min === Infinity ? 0 : min;
}

/**
 * Apply backoff based on an upstream error response.
 * @returns {boolean} `true` when the cascade MUST be aborted (4xx that won't recover),
 *   `false` when the proxy may try the next endpoint.
 */
export function applyBackoff(state, status, errBody, tag, headers) {
  // 400 w/ DEGRADED is a soft failure (try next model, short backoff).
  const isDegraded = status === 400 && typeof errBody === 'string' && errBody.includes('DEGRADED');

  // Hard 4xx (auth/bad-request) → no point in cascading.
  if ((status === 400 && !isDegraded) || status === 401 || status === 403) {
    console.log(`${ts()} [CRÍTICO] Erro ${status} em ${tag}. Abortando cascata.`);
    return true;
  }

  // Honor upstream Retry-After / x-ratelimit-reset-requests when present.
  let apiRetryAfterMs = 0;
  if (headers) {
    const retryAfter = headers.get('retry-after') || headers.get('x-ratelimit-reset-requests');
    if (retryAfter) {
      const asNum = Number(retryAfter);
      if (!Number.isNaN(asNum)) apiRetryAfterMs = asNum * 1000;
      else {
        const d = Date.parse(retryAfter);
        if (!Number.isNaN(d)) apiRetryAfterMs = d - Date.now();
      }
    }
  }

  if (status === 429 && apiRetryAfterMs > 0) {
    state.blockedUntil = Date.now() + apiRetryAfterMs;
    state.backoffIndex = 0;
    console.log(
      `${ts()} [BLOQUEIO] API pediu Retry-After. ${tag} bloqueado por ${Math.ceil(apiRetryAfterMs / 1000)}s.`,
    );
    return false;
  }

  // 429 without Retry-After header (NVIDIA's behavior — they don't send one).
  // NVIDIA's "40 RPM" limit behaves like a sliding window that can stay blocked
  // for 20+ minutes after esgotar — much longer than the 60s you'd expect. New
  // requests while blocked may also renew the window, so we want to stay away
  // long enough for it to fully reset.
  //
  // Escalating ensures we don't waste cascade budget by
  // retrying too early and getting another 429 that just renews the window.
  if (status === 429) {
    const waitMin = BACKOFF_MINUTES[state.backoffIndex] ?? 60;
    state.blockedUntil = Date.now() + waitMin * 60 * 1000;
    state.backoffIndex = Math.min(state.backoffIndex + 1, BACKOFF_MINUTES.length - 1);
    console.log(
      `${ts()} [RATE-LIMIT] 429 sem Retry-After. ${tag} bloqueado por ${waitMin} min (backoff ${state.backoffIndex}).`,
    );
    return false;
  }

  if (isDegraded) {
    state.blockedUntil = Date.now() + 2 * 60 * 1000;
    state.backoffIndex = 0;
    console.log(`${ts()} [DEGRADADO] ${tag} — bloqueado por 2 min, tentando próximo.`);
    return false;
  }

  // Generic retryable error (5xx / network / unknown) → exponential backoff.
  const waitMin = BACKOFF_MINUTES[state.backoffIndex] ?? 30;
  state.blockedUntil = Date.now() + waitMin * 60 * 1000;
  state.backoffIndex = Math.min(state.backoffIndex + 1, BACKOFF_MINUTES.length - 1);
  console.log(`${ts()} [BLOQUEIO] Erro ${status}. ${tag} bloqueado por ${waitMin} min.`);
  return false;
}

const CONNECT_CEILING = 150000;
const STREAM_CEILING = 150000;

export function applyTimeoutCeilingBackoff(state, tag, gotResponseHeaders) {
  const ceiling = gotResponseHeaders ? STREAM_CEILING : CONNECT_CEILING;
  const current = gotResponseHeaders ? state.streamTimeout : state.connectTimeout;
  const expanded = Math.min(ceiling, Math.round(current * 1.3));

  if (expanded === current) {
    const waitMin = BACKOFF_MINUTES[state.backoffIndex] ?? 60;
    state.blockedUntil = Date.now() + waitMin * 60 * 1000;
    state.backoffIndex = Math.min(state.backoffIndex + 1, BACKOFF_MINUTES.length - 1);
    console.warn(
      `${ts()} [ADAPTATIVO→BLOQUEIO] ${tag} atingiu teto ${gotResponseHeaders ? 'STREAM' : 'CONEXÃO'} (${current}ms). Bloqueado por ${waitMin} min (backoff ${state.backoffIndex}).`,
    );
    return true;
  }

  if (gotResponseHeaders) state.streamTimeout = expanded;
  else state.connectTimeout = expanded;
  console.warn(
    `${ts()} [ADAPTATIVO] Janela ${gotResponseHeaders ? 'STREAM' : 'CONEXÃO'} de ${tag} expandida para ${expanded}ms.`,
  );
  return false;
}

// ---------------------------------------------------------------------------
// Concurrency slots
// ---------------------------------------------------------------------------
let activeRequests = 0;
/** @type {Array<() => void>} */
const waitQueue = [];

/**
 * Acquire a concurrency slot. Resolves `true` once acquired, `false` if the
 * client disconnects while still queued.
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<boolean>}
 */
export function acquireSlot(req) {
  return new Promise((resolve) => {
    if (activeRequests < ENV.maxConcurrent) {
      activeRequests++;
      return resolve(true);
    }
    // Queue this request. Track the queued callback so we can remove it on close.
    let queued;
    const onClose = () => {
      const idx = waitQueue.indexOf(queued);
      if (idx !== -1) waitQueue.splice(idx, 1);
      resolve(false);
    };
    queued = () => {
      req.off('close', onClose);
      if (req.destroyed) return resolve(false);
      activeRequests++;
      resolve(true);
    };
    req.once('close', onClose);
    waitQueue.push(queued);
  });
}

/** Release a slot and wake the next waiter. */
export function releaseSlot() {
  activeRequests = Math.max(0, activeRequests - 1);
  const next = waitQueue.shift();
  if (next) next();
}

export function activeCount() {
  return activeRequests;
}

// ---------------------------------------------------------------------------
// RPM limiter
// ---------------------------------------------------------------------------
// Use performance.now() (monotonic, immune to NTP clock skew) for the RPM
// limiter. Date.now() can jump backward on NTP correction, which would make
// the interval calculation wrong and either over-throttle or under-throttle.
let lastGlobalRequestMono = 0;

/** Ensure upstream requests are spaced at least MIN_INTERVAL_MS apart. */
export async function enforceTimeLimit() {
  const now = performance.now();
  const wait = MIN_INTERVAL_MS - (now - lastGlobalRequestMono);
  if (wait > 0) {
    lastGlobalRequestMono = now + wait;
    console.log(`${ts()} [LIMITE] Segurando por ${Math.round(wait)}ms (${ENV.targetRpm} RPM)`);
    await new Promise((r) => setTimeout(r, wait));
  } else {
    lastGlobalRequestMono = now;
  }
}
