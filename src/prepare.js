// src/prepare.js
// Build the upstream request: deep-cloned body with model swap, tag cleanup,
// and merged opencode.jsonc model options.

import { modelConfigs } from './config.js';
import { HOP_BY_HOP, TAG_RE, SAFE_MODEL_OPTION_KEYS } from './constants.js';

/** Strip proxy-injected tags from any string content. */
function cleanTags(s) {
  return typeof s === 'string' ? s.replace(TAG_RE, '') : s;
}

/**
 * Build the final upstream JSON body for a given endpoint.
 * Deep-clones the original parsed body so cascade retries are isolated.
 *
 * @param {Record<string, any>} parsedOriginal
 * @param {{ model: string, name: string }} endpoint
 * @returns {string} JSON string ready to be sent upstream.
 */
export function prepareBody(parsedOriginal, endpoint) {
  /** @type {Record<string, any>} */
  const body = { ...parsedOriginal };
  body.model = endpoint.model;

  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((msg) => ({ ...msg }));

    for (const msg of body.messages) {
      if (typeof msg.content === 'string') {
        msg.content = cleanTags(msg.content);
      } else if (Array.isArray(msg.content)) {
        msg.content = msg.content.map((part) => ({ ...part }));
        for (const part of msg.content) {
          if (part.type === 'text' && typeof part.text === 'string') {
            part.text = cleanTags(part.text);
          }
        }
      }
      if (typeof msg.reasoning_content === 'string') {
        msg.reasoning_content = cleanTags(msg.reasoning_content);
      }
      if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length === 0) {
        delete msg.tool_calls;
      }
    }
  }

  // When the cascade swapped the model, drop the original model-specific options
  // (chat_template_kwargs / reasoning_*) so they don't leak into a different model.
  if (parsedOriginal.model && parsedOriginal.model !== endpoint.model) {
    delete body.chat_template_kwargs;
    delete body.reasoning_effort;
    delete body.reasoning_budget;
  }

  // Apply opencode.jsonc model options — but only allow known-safe keys so a
  // stray field in the config can't break the upstream request with a 400.
  const opts = modelConfigs[endpoint.model];
  if (opts) {
    for (const k of Object.keys(opts)) {
      if (SAFE_MODEL_OPTION_KEYS.has(k)) body[k] = opts[k];
    }
  }

  return JSON.stringify(body);
}

/**
 * Build upstream headers: copies inbound headers (minus hop-by-hop), sets Host
 * to the upstream host, and injects the NVIDIA bearer token.
 *
 * @param {import('http').IncomingHttpHeaders} reqHeaders
 * @param {string} providerBaseUrl
 * @param {string} key
 * @returns {Record<string, string>}
 */
export function createProxyHeaders(reqHeaders, providerBaseUrl, key) {
  /** @type {Record<string, string>} */
  const headers = {};
  for (const [k, v] of Object.entries(reqHeaders)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
  }
  headers['host'] = new URL(providerBaseUrl).host;
  headers['authorization'] = `Bearer ${key}`;
  return headers;
}

