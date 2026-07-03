// src/normalize.js
// SSE event normalization and model-tag injection.
//
// - normalizeSSEEvent: drops Kimi's stray `reasoning` field, merges fragmented
//   tool_calls chunks, strips empty content, and removes CJK characters that
//   some models leak into the stream.
// - injectModelTag: prepends `[Pensamento: <model>]` / `[Resposta: <model>]`
//   tags the first time reasoning/content is emitted, so the user can tell
//   which model actually answered (especially after a fallback).

import { TAG_RE } from './constants.js';

const CJK_RE = /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g;
const CJK_TEST = /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/;

// CJK stripping is OFF by default — all configured models are Chinese and
// emit CJK legitimately. Enable with PROXY_STRIP_CJK=1 for the legacy
// behavior (strips CJK from content + reasoning_content).
const STRIP_CJK = process.env.PROXY_STRIP_CJK === '1';

/** @typedef {{ reasoningTaggedModel: string|null, contentTaggedModel: string|null }} TagState */

/** @typedef {{ kimiEmittedAnswer: boolean, kimiReasoningBuf: string, kimiStreamId: string|null, kimiFinishChunkBuf: string|null, kimiDoneBuf: string|null, kimiNeedsFallback: boolean }} KimiState */

export function newTagState() {
  return { reasoningTaggedModel: null, contentTaggedModel: null };
}

export function newKimiState() {
  return {
    kimiEmittedAnswer: false,
    kimiReasoningBuf: '',
    kimiStreamId: null,
    kimiFinishChunkBuf: null,
    kimiDoneBuf: null,
    kimiNeedsFallback: false,
  };
}

/**
 * Inject `[Pensamento: ...]` / `[Resposta: ...]` tags on the first reasoning
 * and/or content chunk. Returns the (possibly rewritten) event string plus the
 * list of tag kinds that were applied this call.
 *
 * @param {string} eventStr
 * @param {string} model
 * @param {TagState} tagState
 * @returns {{ eventStr: string, tags: string[] }}
 */
export function injectModelTag(eventStr, model, tagState) {
  if (!eventStr.startsWith('data: ') || eventStr.trim() === 'data: [DONE]') {
    return { eventStr, tags: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(eventStr.substring(6).trim());
  } catch {
    return { eventStr, tags: [] };
  }

  const delta = parsed?.choices?.[0]?.delta;
  if (!delta) return { eventStr, tags: [] };

  const tags = [];
  let modified = false;
  const stripOldTags = (s) => {
    if (typeof s !== 'string') return s;
    const stripped = s.replace(TAG_RE, '');
    if (stripped !== s) modified = true;
    return stripped;
  };

  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.trim() !== '') {
    delta.reasoning_content = stripOldTags(delta.reasoning_content);
    if (tagState.reasoningTaggedModel !== model) {
      tagState.reasoningTaggedModel = model;
      delta.reasoning_content = `[Pensamento: ${model}]\n\n${delta.reasoning_content}`;
      modified = true;
      tags.push('reasoning');
    }
  }

  if (typeof delta.content === 'string' && delta.content.trim() !== '') {
    delta.content = stripOldTags(delta.content);
    if (tagState.contentTaggedModel !== model) {
      tagState.contentTaggedModel = model;
      delta.content = `[Resposta: ${model}]\n\n${delta.content}`;
      modified = true;
      tags.push('content');
    }
  }

  // Only re-serialize if we actually changed something. Previously, when a
  // stale tag was stripped but no NEW tag was injected (model already tagged),
  // we returned the original eventStr and the stale tag leaked through.
  if (!modified) return { eventStr, tags };
  return { eventStr: 'data: ' + JSON.stringify(parsed), tags };
}

/**
 * Normalize one SSE event (a single `data: {...}` frame, no trailing blank line).
 * @param {string} eventStr
 * @param {boolean} isKimi
 * @param {KimiState|null} kimiState
 * @returns {string}
 */
export function normalizeSSEEvent(eventStr, isKimi, kimiState) {
  if (!eventStr.startsWith('data: ') || eventStr.trim() === 'data: [DONE]') {
    return eventStr;
  }

  // Fast path: skip JSON parsing when there's nothing we'd touch.
  // We check for 'reasoning' too because some models emit a stray `reasoning`
  // field (in addition to `reasoning_content`) that we need to strip.
  const needsWork =
    isKimi ||
    eventStr.includes('"tool_calls"') ||
    eventStr.includes('"content"') ||
    eventStr.includes('"reasoning"') ||
    CJK_TEST.test(eventStr);
  if (!needsWork) return eventStr;

  let parsed;
  try {
    parsed = JSON.parse(eventStr.substring(6).trim());
  } catch {
    return eventStr;
  }

  const delta = parsed?.choices?.[0]?.delta;
  if (delta) {
    // Some models (Kimi, step-3.7-flash, etc.) emit a stray `reasoning` field
    // alongside the standard `reasoning_content`. The `reasoning` field often
    // contains raw CJK characters that leak through. We always strip it — the
    // canonical field is `reasoning_content`, which we normalize below.
    if (delta.reasoning !== undefined) delete delta.reasoning;

    if (Array.isArray(delta.tool_calls)) {
      if (delta.tool_calls.length === 0) {
        delete delta.tool_calls;
      } else {
        // Merge tool_calls fragments by index (some providers split args).
        const merged = {};
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!merged[idx]) merged[idx] = { index: idx };
          if (tc.id) merged[idx].id = tc.id;
          if (tc.type) merged[idx].type = tc.type;
          if (tc.function) {
            if (!merged[idx].function) merged[idx].function = {};
            if (tc.function.name) merged[idx].function.name = tc.function.name;
            if (tc.function.arguments) {
              merged[idx].function.arguments =
                (merged[idx].function.arguments || '') + tc.function.arguments;
            }
          }
        }
        delta.tool_calls = Object.values(merged);
      }
    }

    if (delta.content === null || delta.content === '' || delta.content === ' ') {
      delete delta.content;
    }

    // CJK leak strip — OPT-IN via PROXY_STRIP_CJK=1. Off by default because
    // all configured models are Chinese and legitimately emit CJK in both
    // reasoning and content. The original intent was to strip CJK that
    // *leaks* into a non-CJK response, but a blunt regex corrupts legitimate
    // Chinese/Japanese/Korean answers. When enabled, only strip from `content`
    // (never `reasoning_content`) to preserve the model's thinking.
    if (STRIP_CJK && delta.content) delta.content = delta.content.replace(CJK_RE, '');
    if (STRIP_CJK && delta.reasoning_content) delta.reasoning_content = delta.reasoning_content.replace(CJK_RE, '');

    if (kimiState) {
      if (delta.content && delta.content.trim() !== '') kimiState.kimiEmittedAnswer = true;
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        kimiState.kimiEmittedAnswer = true;
      }
      if (delta.reasoning_content) kimiState.kimiReasoningBuf += delta.reasoning_content;
    }
  }

  return 'data: ' + JSON.stringify(parsed);
}
