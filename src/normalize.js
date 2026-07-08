// src/normalize.js
// SSE event normalization and model-tag injection.
//
// - normalizeSSEEvent: drops stray `reasoning` field, merges fragmented
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

export function newTagState() {
  return { reasoningTaggedModel: null, contentTaggedModel: null };
}

/**
 * Inject `[Pensamento: ...]` / `[Resposta: ...]` tags on the first reasoning
 * and/or content chunk. Returns the (possibly rewritten) event string plus the
 * list of tag kinds that were applied this call.
 *
 * @param {string} eventStr
 * @param {string} model
 * @param {TagState} tagState
 * @returns {string}
 */
export function injectModelTag(eventStr, model, tagState) {
  if (!eventStr.startsWith('data: ') || eventStr.trim() === 'data: [DONE]') {
    return eventStr;
  }
  let parsed;
  try {
    parsed = JSON.parse(eventStr.substring(6).trim());
  } catch {
    return eventStr;
  }

  const delta = parsed?.choices?.[0]?.delta;
  if (!delta) return eventStr;

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
    }
  }

  if (typeof delta.content === 'string' && delta.content.trim() !== '') {
    delta.content = stripOldTags(delta.content);
    if (tagState.contentTaggedModel !== model) {
      tagState.contentTaggedModel = model;
      delta.content = `\n\n${delta.content}`;
      modified = true;
    }
  }

  if (!modified) return eventStr;
  return 'data: ' + JSON.stringify(parsed);
}

/**
 * Normalize one SSE event (a single `data: {...}` frame, no trailing blank line).
 * @param {string} eventStr
 * @returns {string}
 */
export function normalizeSSEEvent(eventStr) {
  let nvidiaUsage = null;

  if (eventStr.includes('\n')) {
    const lines = eventStr.split('\n');
    const dataLines = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith(':')) {
        try {
          const c = JSON.parse(trimmed.substring(1).trim());
          if (c.input_tokens != null && c.output_tokens != null) {
            nvidiaUsage = {
              prompt_tokens: c.input_tokens,
              completion_tokens: c.output_tokens,
              total_tokens: c.input_tokens + c.output_tokens,
            };
          }
        } catch {}
      } else if (trimmed.startsWith('data:')) {
        dataLines.push(line);
      }
    }
    if (dataLines.length > 0) eventStr = dataLines.join('\n');
  }

  if (!eventStr.startsWith('data: ') || eventStr.trim() === 'data: [DONE]') {
    return eventStr;
  }

  const needsWork = nvidiaUsage ||
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

  if (nvidiaUsage && (!parsed.usage || parsed.usage === null)) {
    parsed.usage = nvidiaUsage;
  }

  const delta = parsed?.choices?.[0]?.delta;
  if (delta) {
    // Some models emit a stray `reasoning` field alongside the standard
    // `reasoning_content`. We always strip it — the canonical field is
    // `reasoning_content`, which we normalize below.
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

    // CJK leak strip — OPT-IN via PROXY_STRIP_CJK=1.
    if (STRIP_CJK && delta.content) delta.content = delta.content.replace(CJK_RE, '');
    if (STRIP_CJK && delta.reasoning_content) delta.reasoning_content = delta.reasoning_content.replace(CJK_RE, '');
  }

  return 'data: ' + JSON.stringify(parsed);
}
