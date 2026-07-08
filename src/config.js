// src/config.js
// Loads runtime config from environment variables and parses opencode.jsonc
// (with hot-reload via debounced fs.watch).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Minimal .env loader (no external deps). Bun loads .env natively; Node does
// not, so we do it ourselves. Only sets vars that aren't already defined.
// ---------------------------------------------------------------------------
function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  let raw;
  try {
    raw = fs.readFileSync(envPath, 'utf8');
  } catch {
    return; // no .env file — fine, env may come from the shell
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes if present.
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv();

/** @typedef {Record<string, Record<string, unknown>>} ModelOptionsMap */

const parseIntSafe = (v, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
};

/** All runtime configuration sourced from env (with sensible defaults).
 *  - connTimeoutMs: tempo máximo para receber a PRIMEIRA resposta (headers) do
 *    upstream. Se a NVIDIA não responder em 60s, aborta. (Default: 60000)
 *  - streamTimeoutMs: tempo máximo sem receber NENHUM chunk (idle). Se o modelo
 *    está enviando chunks (mesmo lentos), o timer reseta a cada chunk e NUNCA
 *    aborta — pode ficar 2h pensando sem problema. Só aborta se o stream
 *    trava completamente sem enviar nada por 90s. (Default: 90000)
 *  - targetRpm: limite de RPM global do proxy (não por modelo). NVIDIA tem 40
 *    RPM POR MODELO, mas o proxy rotaciona modelos então o RPM agregado pode
 *    ser maior. (Default: 40)
 */
export const ENV = {
  targetRpm: parseIntSafe(process.env.PROXY_TARGET_RPM, 40),
  connTimeoutMs: parseIntSafe(process.env.PROXY_CONN_TIMEOUT_MS, 30000),
  streamTimeoutMs: parseIntSafe(process.env.PROXY_STREAM_TIMEOUT_MS, 60000),
  maxConcurrent: parseIntSafe(process.env.PROXY_MAX_CONCURRENT, 1),
  port: parseIntSafe(process.env.PROXY_PORT, 9999),
  host: process.env.PROXY_HOST || '127.0.0.1',
};

/** Minimum interval (ms) between two upstream requests to honor RPM. */
export const MIN_INTERVAL_MS = Math.ceil(60000 / ENV.targetRpm);

/** Path to opencode.jsonc (~/.config/opencode/opencode.jsonc). */
export const OPENCODE_CONFIG_PATH = path.join(
  process.env.HOME || os.homedir(),
  '.config',
  'opencode',
  'opencode.jsonc',
);

/** @type {ModelOptionsMap} */
export const modelConfigs = {};

/**
 * Strip JSONC comments + trailing commas safely (preserves http:// in URLs).
 * @param {string} raw
 * @returns {string}
 */
function stripJsonc(raw) {
  return raw
    .replace(/^\uFEFF/, '')
    .replace(/\r/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/(^|[^\\:])\/\/.*$/gm, '$1') // line comments (keeps http://)
    .replace(/,\s*([}\]])/g, '$1'); // trailing commas
}

/** (Re)load model options from opencode.jsonc. Safe to call repeatedly. */
export function loadModelConfigs() {
  try {
    const raw = fs.readFileSync(OPENCODE_CONFIG_PATH, 'utf8');
    const config = JSON.parse(stripJsonc(raw));
    /** @type {ModelOptionsMap} */
    const next = {};
    for (const providerName of Object.keys(config?.provider || {})) {
      const models = config?.provider?.[providerName]?.models || {};
      for (const name of Object.keys(models)) {
        next[name] = { ...(models[name].options || {}) };
      }
    }
    for (const k of Object.keys(modelConfigs)) delete modelConfigs[k];
    Object.assign(modelConfigs, next);
    console.log(`[config] opencode.jsonc carregado — ${Object.keys(next).length} modelo(s).`);
  } catch (err) {
    console.warn(`[config] Falha ao ler opencode.jsonc: ${err.message}`);
  }
}

/**
 * Start a debounced, self-healing watcher on opencode.jsonc.
 *
 * - 1s debounce absorbs editors that fire multiple events per save.
 * - If the file is deleted/moved (common with atomic-save editors like vim),
 *   the watcher dies — we detect this and retry every 5s until the file
 *   reappears, then re-arm the watcher.
 */
export function watchModelConfigs() {
  let timer = null;
  let watcher = null;

  const arm = () => {
    try {
      watcher = fs.watch(OPENCODE_CONFIG_PATH, () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          console.log('[config] opencode.jsonc alterado, recarregando...');
          loadModelConfigs();
        }, 1000);
      });
      watcher.on('error', (err) => {
        console.warn(`[config] Watch error: ${err.message}`);
        // File was likely deleted/renamed (atomic save). Re-arm after a delay.
        watcher?.close();
        watcher = null;
        setTimeout(arm, 5000);
      });
    } catch (err) {
      // File doesn't exist yet — retry in 5s.
      console.warn(`[config] Não foi possível observar opencode.jsonc: ${err.message}`);
      setTimeout(arm, 5000);
    }
  };

  arm();
}
