// src/cascade.js
// Dynamic cascade builder: rotates NVIDIA keys and orders models so the most
// recently used sinks to the back of its tier (no immediate repeats cross-key).

import { getState } from './state.js';

/** @typedef {{ provider: string, model: string, name: string, physicalKey: number }} CascadeEndpoint */

/**
 * Short slug  ->  { provider, model }.
 * Order is the initial cascade preference (most preferred first).
 * First 2 are "efetivos" (priority), last 2 are "estagiários" (fallback).
 */
export const MODEL_MAP = {
  'glm-5.2': { provider: 'nvidia', model: 'z-ai/glm-5.2' },
  'deepseek-v4-pro': { provider: 'nvidia', model: 'deepseek-ai/deepseek-v4-pro' },
  'kimi-k2.6': { provider: 'nvidia', model: 'moonshotai/kimi-k2.6' },
  'minimax-m3': { provider: 'nvidia', model: 'minimaxai/minimax-m3' },
};

const DEFAULT_ORDER = Object.keys(MODEL_MAP);

// Tier boundaries: index 0-1 = efetivos, index 2-3 = estagiários.
// sinkModel inserts within the same tier so efetivos always stay before estagiários.
const TIER_BOUNDARY = 2;

// Mutable runtime order. After a model succeeds it sinks to the back of its tier.
let modelOrder = [...DEFAULT_ORDER];

// Alternates the starting physical key (0 / 1) per request.
let _globalKeyToggle = 1;
export function getGlobalKeyToggle() { return _globalKeyToggle; }

// Tracks the last model that responded successfully (cross-key anti-repetition).
let _lastUsedModel = null;
export function getLastUsedModel() { return _lastUsedModel; }
export function setLastUsedModel(v) { _lastUsedModel = v; }

// Tracks which keys have already been the "starter" since last reset — once
// every key has had its turn, we restore the default model order.
const _keysUsedSinceReset = new Set();
export function getKeysUsedSinceReset() { return _keysUsedSinceReset; }

/** Look up a model definition by short slug. */
function getModelDef(name) {
  const base = MODEL_MAP[name];
  return base ? { ...base, name } : null;
}

/** Current ordered list of model definitions. */
function currentModelList() {
  return modelOrder.map(getModelDef).filter(Boolean);
}

/**
 * Move a model to the back of its tier (called after success).
 * Efetivos stay before estagiários; within each tier, the used model goes last.
 */
export function sinkModel(name) {
  const idx = modelOrder.indexOf(name);
  if (idx < 0) return;

  modelOrder.splice(idx, 1);

  // Find insertion point: end of the model's tier.
  const tierIdx = DEFAULT_ORDER.indexOf(name);
  const isEfetivo = tierIdx < TIER_BOUNDARY;

  let insertAt = modelOrder.length;
  for (let i = 0; i < modelOrder.length; i++) {
    const t = DEFAULT_ORDER.indexOf(modelOrder[i]);
    if (isEfetivo && t >= TIER_BOUNDARY) { insertAt = i; break; }
    if (!isEfetivo && t < TIER_BOUNDARY) continue;
  }

  modelOrder.splice(insertAt, 0, name);
}

/** Restore default order and clear tracking (called after full key cycle). */
export function resetModelOrder() {
  modelOrder = [...DEFAULT_ORDER];
}

/**
 * Build the cascade for the next request: alternates the starting key, filters
 * out endpoints that are currently blocked, and falls back to the alternate
 * key if every endpoint is blocked on the preferred key.
 *
 * Anti-repetition: if the first model in the order is the same as lastUsedModel,
 * it gets moved to the back so the next request picks a different model.
 *
 * @param {{ keys: string[] }} provider
 * @returns {CascadeEndpoint[]}
 */
export function buildDynamicCascade(provider) {
  _globalKeyToggle = (_globalKeyToggle + 1) % provider.keys.length;
  const startKey = _globalKeyToggle;

  // Anti-repetition cross-key: if the first model is what was just used,
  // move it to the back so the next request picks something different.
  if (_lastUsedModel && modelOrder[0] === _lastUsedModel) {
    modelOrder.push(modelOrder.shift());
  }

  const ordered = currentModelList();
  const now = Date.now();

  const collect = (keyIdx) =>
    ordered
      .filter((m) => {
        const s = getState(`${m.provider}:${m.model}__${keyIdx}`);
        return now >= s.blockedUntil;
      })
      .map((m) => ({ ...m, physicalKey: keyIdx }));

  let cascade = collect(startKey);

  // All blocked on preferred key? Try the other one.
  if (cascade.length === 0 && provider.keys.length > 1) {
    const otherKey = (startKey + 1) % provider.keys.length;
    cascade = collect(otherKey);
  }

  // Absolute fallback: ignore blocks and try the first model on the start key.
  if (cascade.length === 0) {
    cascade = [{ ...ordered[0], physicalKey: startKey % provider.keys.length }];
  }

  return cascade;
}
