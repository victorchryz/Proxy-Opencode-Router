// src/cascade.js
// Dynamic cascade builder: alternates NVIDIA keys and uses a fixed model
// priority (GLM → DS → KIMI → MM) with anti-repetition (lastUsedModel).

import { getState } from './state.js';

/** @typedef {{ provider: string, model: string, name: string, physicalKey: number }} CascadeEndpoint */

/**
 * Short slug  ->  { provider, model }.
 * Fixed priority order: GLM > DS > KIMI > MM.
 */
export const MODEL_MAP = {
  'glm-5.2': { provider: 'nvidia', model: 'z-ai/glm-5.2' },
  'deepseek-v4-pro': { provider: 'nvidia', model: 'deepseek-ai/deepseek-v4-pro' },
  'kimi-k2.6': { provider: 'nvidia', model: 'moonshotai/kimi-k2.6' },
  'minimax-m3': { provider: 'nvidia', model: 'minimaxai/minimax-m3' },
};

const DEFAULT_ORDER = Object.keys(MODEL_MAP);

// Alternates the starting physical key (0 / 1) per request.
let _globalKeyToggle = 1;
export function getGlobalKeyToggle() { return _globalKeyToggle; }

// Tracks the last model that responded successfully (anti-repetition).
let _lastUsedModel = null;
export function getLastUsedModel() { return _lastUsedModel; }
export function setLastUsedModel(v) { _lastUsedModel = v; }

/** Look up a model definition by short slug. */
function getModelDef(name) {
  const base = MODEL_MAP[name];
  return base ? { ...base, name } : null;
}

/**
 * Build the cascade for the next request.
 *
 * - Alternates K1↔K2 via globalKeyToggle.
 * - Walks DEFAULT_ORDER (GLM → DS → KIMI → MM) skipping:
 *     1. lastUsedModel (anti-repetition)
 *     2. models blocked on the start key
 * - If nothing available on start key, tries the other key (same priority).
 * - If nothing available on either key, absolute fallback: GLM on start key
 *   ignoring blocks.
 *
 * @param {{ keys: string[] }} provider
 * @returns {CascadeEndpoint[]}
 */
export function buildDynamicCascade(provider) {
  _globalKeyToggle = (_globalKeyToggle + 1) % provider.keys.length;
  const startKey = _globalKeyToggle;
  const otherKey = (startKey + 1) % provider.keys.length;
  const now = Date.now();

  const collect = (keyIdx) =>
    DEFAULT_ORDER
      .map(getModelDef)
      .filter(Boolean)
      .filter((m) => m.name !== _lastUsedModel)
      .filter((m) => {
        const s = getState(`${m.provider}:${m.model}__${keyIdx}`);
        return now >= s.blockedUntil;
      })
      .map((m) => ({ ...m, physicalKey: keyIdx }));

  let cascade = collect(startKey);

  if (cascade.length === 0 && provider.keys.length > 1) {
    cascade = collect(otherKey);
  }

  if (cascade.length === 0) {
    const fallback = getModelDef(DEFAULT_ORDER[0]);
    cascade = [{ ...fallback, physicalKey: startKey % provider.keys.length }];
  }

  return cascade;
}
