// src/constants.js
// Shared constants used across multiple modules.
// Centralizing these prevents drift (e.g. prepare.js and handler.js removing
// different sets of hop-by-hop headers).

/**
 * Hop-by-hop / unsafe headers that must NEVER be forwarded between client ↔
 * proxy ↔ upstream. Used both when building the upstream request (prepare.js)
 * and when copying the upstream response back to the client (handler.js).
 *
 * - content-encoding: Node's fetch auto-decompresses; forwarding would corrupt.
 * - content-length:   we modify the body (model swap, tag injection), so the
 *                      original length is wrong.
 * - transfer-encoding: we manage chunking ourselves via res.write().
 * - connection / keep-alive / te / trailer / upgrade / proxy-*: per RFC 7230
 *                      these are hop-by-hop and must not traverse a proxy.
 */
export const HOP_BY_HOP = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
]);

/**
 * Regex matching all proxy-injected tags: `[Pensamento: ...]`, `[Resposta: ...]`,
 * `[Fallback: ...]`. Used to strip stale tags from message content before
 * re-sending upstream (so the model doesn't see tags from a previous model).
 */
export const TAG_RE = /\[Pensamento: [^\]]+\]|\[Resposta: [^\]]+\]|\[Fallback: [^\]]+\]/g;

/**
 * Allowlist of opencode.jsonc option keys that are safe to forward to the
 * upstream NVIDIA API. Anything outside this list is silently dropped to
 * prevent a malformed config from breaking the entire cascade with a 400.
 */
export const SAFE_MODEL_OPTION_KEYS = new Set([
  'stream',
  'temperature',
  'top_p',
  'top_k',
  'max_tokens',
  'max_completion_tokens',
  'stop',
  'presence_penalty',
  'frequency_penalty',
  'seed',
  'n',
  'logprobs',
  'top_logprobs',
  'user',
  'chat_template_kwargs',
  'reasoning_effort',
  'reasoning_budget',
  'stream_options',
  'response_format',
  'tools',
  'tool_choice',
]);
