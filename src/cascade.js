// src/cascade.js
// Dynamic cascade builder: alternates NVIDIA keys and uses a fixed model
// priority (GLM → KIMI → MM → DS → INKLING) with per-key "sticky" model
// selection.
//
// Anti-repetition rules (two distinct triggers, not one blanket rule):
//   1. BLOCKED trigger: if a key's current sticky model just got blocked,
//      it falls through to the next available model in priority order,
//      WITHOUT caring what the other key is currently using.
//   2. COLLISION trigger: if a key's current sticky model is still free,
//      but now equals what the OTHER key is currently using, this key
//      switches to the highest-priority model available to it that isn't
//      the other key's model — unless nothing else is free, in which case
//      it keeps repeating.

import { getState } from './state.js';

export const MODEL_MAP = {
  'glm-5.2': { provider: 'nvidia', model: 'z-ai/glm-5.2' },
  'kimi-k2.6': { provider: 'nvidia', model: 'moonshotai/kimi-k2.6' },
  'minimax-m3': { provider: 'nvidia', model: 'minimaxai/minimax-m3' },
  'deepseek-v4-pro': { provider: 'nvidia', model: 'deepseek-ai/deepseek-v4-pro' },
  'inkling': { provider: 'nvidia', model: 'thinkingmachines/inkling' },
};

const DEFAULT_ORDER = Object.keys(MODEL_MAP);

let _globalKeyToggle = 1;
const _stickyModel = new Map();

export function setLastUsedModel(v, keyIdx) {
  _stickyModel.set(keyIdx, v);
}

function getModelDef(name) {
  const base = MODEL_MAP[name];
  return base ? { ...base, name } : null;
}

function collect(keyIdx, otherKeyIdx, now) {
  const avail = DEFAULT_ORDER
    .map(getModelDef)
    .filter(Boolean)
    .filter((m) => now >= getState(`${m.provider}:${m.model}__${keyIdx}`).blockedUntil);

  if (avail.length === 0) return [];

  const curModel = _stickyModel.get(keyIdx) ?? null;
  const otherModel = _stickyModel.get(otherKeyIdx) ?? null;

  const wasBlocked = curModel !== null && !avail.some((m) => m.name === curModel);

  let chosenName;
  if (wasBlocked) {
    chosenName = avail[0].name;
  } else {
    const alt = avail.find((m) => m.name !== otherModel);
    chosenName = alt ? alt.name : avail[0].name;
  }

  const chosen = avail.find((m) => m.name === chosenName);
  const rest = avail.filter((m) => m.name !== chosenName);
  return [chosen, ...rest].map((m) => ({ ...m, physicalKey: keyIdx }));
}

export function buildDynamicCascade(provider) {
  _globalKeyToggle = (_globalKeyToggle + 1) % provider.keys.length;
  const startKey = _globalKeyToggle;
  const otherKey = (startKey + 1) % provider.keys.length;
  const now = Date.now();

  let cascade = collect(startKey, otherKey, now);

  if (cascade.length === 0 && provider.keys.length > 1) {
    cascade = collect(otherKey, startKey, now);
  }

  if (cascade.length === 0) {
    const fallback = getModelDef(DEFAULT_ORDER[0]);
    cascade = [{ ...fallback, physicalKey: startKey % provider.keys.length }];
  }

  return cascade;
}
