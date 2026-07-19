// src/cascade.js
// Dynamic cascade builder: alternates NVIDIA keys and uses a fixed model
// priority (GLM → KIMI → MM → DS → INKLING). Two modes via PROXY_ANTI_REPEAT:
//   - 1 (default): sticky per-key anti-repetition (K1≠K2 models).
//   - 0: legacy — both keys hit the top available model in lockstep.
//
// Anti-repetition rules (when PROXY_ANTI_REPEAT=1, two distinct triggers):
//   1. BLOCKED trigger: if a key's current sticky model just got blocked,
//      it falls through to the next available model in priority order,
//      WITHOUT caring what the other key is currently using.
//   2. COLLISION trigger: if a key's current sticky model is still free,
//      but now equals what the OTHER key is currently using, this key
//      switches to the highest-priority model available to it that isn't
//      the other key's model — unless nothing else is free, in which case
//      it keeps repeating.

import { getState } from './state.js';
import { ENV } from './config.js';
import { fileURLToPath } from 'node:url';

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
  if (ENV.antiRepeat) _stickyModel.set(keyIdx, v);
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

function collectSimple(keyIdx, _otherKeyIdx, now) {
  return DEFAULT_ORDER
    .map(getModelDef)
    .filter(Boolean)
    .filter((m) => now >= getState(`${m.provider}:${m.model}__${keyIdx}`).blockedUntil)
    .map((m) => ({ ...m, physicalKey: keyIdx }));
}

export function buildDynamicCascade(provider) {
  _globalKeyToggle = (_globalKeyToggle + 1) % provider.keys.length;
  const startKey = _globalKeyToggle;
  const otherKey = (startKey + 1) % provider.keys.length;
  const now = Date.now();

  const fn = ENV.antiRepeat ? collect : collectSimple;
  let cascade = fn(startKey, otherKey, now);
  if (cascade.length === 0 && provider.keys.length > 1) cascade = fn(otherKey, startKey, now);

  if (cascade.length === 0) {
    const fallback = getModelDef(DEFAULT_ORDER[0]);
    cascade = [{ ...fallback, physicalKey: startKey % provider.keys.length }];
  }

  return cascade;
}

// Self-check: run `node src/cascade.js` to verify cascade logic. No framework.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  ENV.antiRepeat = true;
  const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } };
  const provider = { keys: ['k1', 'k2'] };
  const reset = () => {
    _globalKeyToggle = 1;
    _stickyModel.clear();
    for (const { provider, model } of Object.values(MODEL_MAP)) {
      getState(`${provider}:${model}__0`).blockedUntil = 0;
      getState(`${provider}:${model}__1`).blockedUntil = 0;
    }
  };
  const block = (id) => { const s = getState(id); s.blockedUntil = Date.now() + 60000; };
  // 1. Cold start diverge (K1->GLM, then sticky, K2->KIMI)
  reset(); let r = buildDynamicCascade(provider); assert(r[0].name === 'glm-5.2' && r[0].physicalKey === 0, '1 cold K1->GLM');
  setLastUsedModel('glm-5.2', 0); r = buildDynamicCascade(provider); assert(r[0].name === 'kimi-k2.6' && r[0].physicalKey === 1, '1 cold K2->KIMI');
  // 2. Climb-back-up: sticky=DS, free -> GLM
  reset(); setLastUsedModel('deepseek-v4-pro', 0); r = buildDynamicCascade(provider); assert(r[0].name === 'glm-5.2' && r[0].physicalKey === 0, '2 climb DS->GLM');
  // 3. BLOCKED ignores other: sticky=KIMI blocked on K0, K2 sticky=KIMI -> K1 picks GLM
  reset(); setLastUsedModel('kimi-k2.6', 0); setLastUsedModel('kimi-k2.6', 1); block('nvidia:moonshotai/kimi-k2.6__0'); r = buildDynamicCascade(provider); assert(r[0].name === 'glm-5.2' && r[0].physicalKey === 0, '3 BLOCKED->GLM');
  // 4. Collision: both sticky=GLM -> diverge to KIMI
  reset(); setLastUsedModel('glm-5.2', 0); setLastUsedModel('glm-5.2', 1); r = buildDynamicCascade(provider); assert(r[0].name === 'kimi-k2.6' && r[0].physicalKey === 0, '4 collision->KIMI');
  // 5. All blocked -> absolute fallback GLM@startKey
  reset(); ['nvidia:z-ai/glm-5.2','nvidia:moonshotai/kimi-k2.6','nvidia:minimaxai/minimax-m3','nvidia:deepseek-ai/deepseek-v4-pro','nvidia:thinkingmachines/inkling'].forEach(m => { block(m + '__0'); block(m + '__1'); }); r = buildDynamicCascade(provider); assert(r[0].name === 'glm-5.2' && r[0].physicalKey === 0, '5 all-blocked->GLM@0');
  // 6. Legacy mode (antiRepeat=false): collectSimple returns priority order, sticky is no-op
  ENV.antiRepeat = false; reset(); setLastUsedModel('glm-5.2', 0); r = buildDynamicCascade(provider); assert(r[0].name === 'glm-5.2' && r[0].physicalKey === 0 && _stickyModel.size === 0, '6 legacy -> GLM, sticky no-op');
  console.log('cascade self-check: 6/6 OK');
}
