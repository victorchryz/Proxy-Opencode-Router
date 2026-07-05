// src/cascade.js
// Dynamic cascade builder: alternates NVIDIA keys and uses a fixed model
// priority (GLM → DS → MM) with anti-repetition (lastUsedModel).

import { getState } from './state.js';

/** @typedef {{ provider: string, model: string, name: string, physicalKey: number }} CascadeEndpoint */

/**
 * Short slug  ->  { provider, model }.
 * Fixed priority order: GLM > DS > MM.
 */
export const MODEL_MAP = {
  'glm-5.2': { provider: 'nvidia', model: 'z-ai/glm-5.2' },
  'deepseek-v4-pro': { provider: 'nvidia', model: 'deepseek-ai/deepseek-v4-pro' },
  'minimax-m3': { provider: 'nvidia', model: 'minimaxai/minimax-m3' },
};

const DEFAULT_ORDER = Object.keys(MODEL_MAP);

// Alternates the starting physical key (0 / 1) per request.
let _globalKeyToggle = 1;
export function getGlobalKeyToggle() { return _globalKeyToggle; }

// Tracks the last model that responded successfully (anti-repetition).
// Rotaciona o primeiro disponível para o fim se for igual ao lastUsed.
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

/**
 * Coleta endpoints disponíveis para uma key específica, filtrando bloqueados.
 * Anti-repetição: se o primeiro disponível é o lastUsed e há >1, rotaciona
 * (move pro fim). A rotação acontece depois de filtrar bloqueados, então
 * modelos fallback entram naturalmente na alternância quando prioritários faltam.
 * @param {string[]} keys
 * @param {number} keyIdx
 * @returns {CascadeEndpoint[]}
 */
export function buildCascadeForKey(keys, keyIdx) {
  const now = Date.now();
  const available = DEFAULT_ORDER
    .map(getModelDef)
    .filter(Boolean)
    .filter((m) => {
      const s = getState(`${m.provider}:${m.model}__${keyIdx}`);
      return now >= s.blockedUntil;
    });

  if (available.length > 1 && _lastUsedModel && available[0].name === _lastUsedModel) {
    const [first, ...rest] = available;
    return [...rest, first].map((m) => ({ ...m, physicalKey: keyIdx }));
  }
  return available.map((m) => ({ ...m, physicalKey: keyIdx }));
}

/**
 * Build the cascade for the next request.
 *
 * - Alternates K1↔K2 via globalKeyToggle.
 * - Filtra modelos bloqueados na key atual (respeitando prioridade DEFAULT_ORDER).
 * - Anti-repetição: se o primeiro disponível é o lastUsed e há >1, rotaciona.
 * - Se nada disponível na key inicial, tenta a outra key (mesma lógica).
 * - Se nada disponível em nenhuma key, absolute fallback: GLM na key inicial
 *   ignorando blocks.
 *
 * @param {{ keys: string[] }} provider
 * @returns {CascadeEndpoint[]}
 */
export function buildDynamicCascade(provider) {
  _globalKeyToggle = (_globalKeyToggle + 1) % provider.keys.length;
  const startKey = _globalKeyToggle;
  const otherKey = (startKey + 1) % provider.keys.length;

  let cascade = buildCascadeForKey(provider.keys, startKey);

  if (cascade.length === 0 && provider.keys.length > 1) {
    cascade = buildCascadeForKey(provider.keys, otherKey);
  }

  if (cascade.length === 0) {
    const fallback = getModelDef(DEFAULT_ORDER[0]);
    cascade = [{ ...fallback, physicalKey: startKey % provider.keys.length }];
  }

  return cascade;
}
