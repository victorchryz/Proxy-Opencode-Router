// src/metrics.js
// Lightweight in-memory counters for /metrics. Single-process, no persistence.

const metrics = {
  requestsTotal: 0,
  requestsByModel: /** @type {Record<string, number>} */ ({}),
  fallbacksTotal: 0,
  errorsTotal: 0,
  totalResponseTimeMs: 0,
};

/** Record one upstream call (success or failure, primary or fallback). */
export function recordRequest(model, durationMs, isFallback, isError) {
  metrics.requestsTotal++;
  metrics.requestsByModel[model] = (metrics.requestsByModel[model] || 0) + 1;
  if (isFallback) metrics.fallbacksTotal++;
  if (isError) metrics.errorsTotal++;
  metrics.totalResponseTimeMs += durationMs;
}

export function snapshot(extra = {}) {
  return {
    ...metrics,
    avgResponseTimeMs: metrics.requestsTotal
      ? Math.round(metrics.totalResponseTimeMs / metrics.requestsTotal)
      : 0,
    ...extra,
  };
}
