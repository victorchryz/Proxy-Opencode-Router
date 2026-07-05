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
// Rebaixa-para-segundo: lastUsedModel desce para a 2ª posição da ordem fixa.
// GLM usado → [DS, GLM, MM] | DS usado → [GLM, DS, MM] | MM usado → [GLM, MM, DS]
// Se o 2º falhar, tenta o último usado de novo (se não bloqueado).
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

/** Reordena DEFAULT_ORDER rebaixando lastUsedModel para a 2ª posição. */
function reorderForAntiRepetition() {
  if (!_lastUsedModel || DEFAULT_ORDER.length <= 2) return DEFAULT_ORDER;
  const idx = DEFAULT_ORDER.indexOf(_lastUsedModel);
  if (idx === -1) return DEFAULT_ORDER;
  const others = DEFAULT_ORDER.filter((n) => n !== _lastUsedModel);
  return [others[0], _lastUsedModel, ...others.slice(1)];
}

/**
 * Coleta endpoints disponíveis para uma key específica, filtrando bloqueados.
 * @param {string[]} keys
 * @param {number} keyIdx
 * @returns {CascadeEndpoint[]}
 */
export function buildCascadeForKey(keys, keyIdx) {
  const now = Date.now();
  const order = reorderForAntiRepetition();
  return order
    .map(getModelDef)
    .filter(Boolean)
    .filter((m) => {
      const s = getState(`${m.provider}:${m.model}__${keyIdx}`);
      return now >= s.blockedUntil;
    })
    .map((m) => ({ ...m, physicalKey: keyIdx }));
}

/**
 * Build the cascade for the next request.
 *
 * - Alternates K1↔K2 via globalKeyToggle.
 * - Rebaixa lastUsedModel para a 2ª posição da ordem fixa (GLM→DS→MM):
 *     GLM usado → [DS, GLM, MM]
 *     DS usado  → [GLM, DS, MM]
 *     MM usado  → [GLM, MM, DS]
 * - Filtra modelos bloqueados na key atual.
 * - Se nada disponível na key inicial, tenta a outra key (mesma ordem).
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
