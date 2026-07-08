// src/metrics.js
// Lightweight in-memory counters for /metrics. Single-process, no persistence.

const metrics = {
  requestsTotal: 0,
  requestsByModel: /** @type {Record<string, number>} */ ({}),
  errorsTotal: 0,
  totalResponseTimeMs: 0,
};

export function recordRequest(model, durationMs, isError) {
  metrics.requestsTotal++;
  metrics.requestsByModel[model] = (metrics.requestsByModel[model] || 0) + 1;
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
