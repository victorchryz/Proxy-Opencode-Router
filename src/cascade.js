// src/cascade.js
// Dynamic cascade builder: alternates NVIDIA keys and uses a fixed model
// priority (GLM → DS → MM) with anti-repetition per-key (lastUsedModel+Key).

import { getState } from './state.js';

/** @typedef {{ provider: string, model: string, name: string, physicalKey: number }} CascadeEndpoint */

/**
 * Short slug  ->  { provider, model }.
 * Fixed priority order: GLM > DS > MM.
 */
export const MODEL_MAP = {
  'glm-5.2': { provider: 'nvidia', model: 'z-ai/glm-5.2' },
  'minimax-m3': { provider: 'nvidia', model: 'minimaxai/minimax-m3' },
  'deepseek-v4-pro': { provider: 'nvidia', model: 'deepseek-ai/deepseek-v4-pro' },
};

const DEFAULT_ORDER = Object.keys(MODEL_MAP);

// Alternates the starting physical key (0 / 1) per request.
let _globalKeyToggle = 1;

let _lastUsedModel = null;
let _lastUsedKey = null;
export function setLastUsedModel(v, keyIdx) { _lastUsedModel = v; _lastUsedKey = keyIdx; }

/** Look up a model definition by short slug. */
function getModelDef(name) {
  const base = MODEL_MAP[name];
  return base ? { ...base, name } : null;
}

/**
 * Build the cascade for the next request.
 *
 * - Alternates K1↔K2 via globalKeyToggle.
 * - Walks DEFAULT_ORDER (GLM → DS → MM) skipping:
 *     1. lastUsedModel on the SAME key (anti-repetition per-key)
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
      .filter((m) => !(m.name === _lastUsedModel && keyIdx === _lastUsedKey))
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
