// src/cascade.js
// Dynamic cascade builder: alternates keys per provider and uses a fixed
// model priority with anti-repetition (lastUsedModel). Multi-provider flat
// cascade — all models from all providers in a single priority list.

import { getState } from './state.js';
import { PROVIDERS } from './providers.js';

/** @typedef {{ provider: string, model: string, name: string, physicalKey: number }} CascadeEndpoint */

/**
 * Short slug  ->  { provider, model }.
 * Fixed priority order across both providers.
 */
export const MODEL_MAP = {
  'gpt-5.5-free': { provider: 'aihubmix', model: 'gpt-5.5-free' },
  'glm-5.2': { provider: 'nvidia', model: 'z-ai/glm-5.2' },
  'coding-glm-5.2-free': { provider: 'aihubmix', model: 'coding-glm-5.2-free' },
  'xiaomi-mimo-v2.5-pro-free': { provider: 'aihubmix', model: 'xiaomi-mimo-v2.5-pro-free' },
  'deepseek-v4-pro': { provider: 'nvidia', model: 'deepseek-ai/deepseek-v4-pro' },
  'coding-minimax-m3-free': { provider: 'aihubmix', model: 'coding-minimax-m3-free' },
  'minimax-m3': { provider: 'nvidia', model: 'minimaxai/minimax-m3' },
};

const DEFAULT_ORDER = Object.keys(MODEL_MAP);

let _globalKeyToggle = 1;
export function getGlobalKeyToggle() { return _globalKeyToggle; }

let _lastUsedModel = null;
export function getLastUsedModel() { return _lastUsedModel; }
export function setLastUsedModel(name) {
  _lastUsedModel = name;
}

/** Look up a model definition by short slug. */
function getModelDef(name) {
  const base = MODEL_MAP[name];
  return base ? { ...base, name } : null;
}

function maxKeyCount() {
  return Math.max(...Object.values(PROVIDERS).map((p) => p.keys.length), 1);
}

function physKeyFor(provider, keyIdx) {
  const keys = PROVIDERS[provider]?.keys || [];
  return keys.length ? keyIdx % keys.length : 0;
}

function providerHasKeys(provider) {
  return (PROVIDERS[provider]?.keys.length || 0) > 0;
}

/**
 * Coleta endpoints disponíveis para uma key index, filtrando bloqueados.
 * Cada modelo usa keyIdx % seuProvider.keys.length como physical key.
 * Anti-repetição: se o primeiro disponível é o lastUsed e há >1, rotaciona.
 * @param {number} keyIdx
 * @returns {CascadeEndpoint[]}
 */
export function buildCascadeForKey(keyIdx) {
  const now = Date.now();
  const available = DEFAULT_ORDER
    .map(getModelDef)
    .filter(Boolean)
    .filter((m) => providerHasKeys(m.provider))
    .filter((m) => {
      const pk = physKeyFor(m.provider, keyIdx);
      const s = getState(`${m.provider}:${m.model}__${pk}`);
      return now >= s.blockedUntil;
    })
    .map((m) => ({ ...m, physicalKey: physKeyFor(m.provider, keyIdx) }));

  if (available.length > 1 && _lastUsedModel && available[0].name === _lastUsedModel) {
    const [first, ...rest] = available;
    return [...rest, first];
  }
  return available;
}

/**
 * Build the cascade for the next request.
 *
 * - Alternates K1↔K2 via globalKeyToggle (applies a todos os providers).
 * - Filtra modelos bloqueados na key atual (respeitando prioridade).
 * - Anti-repetição: se o primeiro disponível é o lastUsed e há >1, rotaciona.
 * - Se nada disponível na key inicial, tenta a outra key.
 * - Se nada disponível em nenhuma key, absolute fallback: primeiro modelo
 *   na key inicial ignorando blocks.
 *
 * @returns {CascadeEndpoint[]}
 */
export function buildDynamicCascade() {
  const maxKeys = maxKeyCount();
  _globalKeyToggle = (_globalKeyToggle + 1) % maxKeys;
  const startKey = _globalKeyToggle;
  const otherKey = (startKey + 1) % maxKeys;

  let cascade = buildCascadeForKey(startKey);

  if (cascade.length === 0 && maxKeys > 1) {
    cascade = buildCascadeForKey(otherKey);
  }

  if (cascade.length === 0) {
    const fallback = getModelDef(DEFAULT_ORDER.find((n) => providerHasKeys(MODEL_MAP[n].provider)));
    if (fallback) {
      cascade = [{ ...fallback, physicalKey: physKeyFor(fallback.provider, startKey) }];
    }
  }

  return cascade;
}
