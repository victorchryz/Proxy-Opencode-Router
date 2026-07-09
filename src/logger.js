// src/logger.js
// Console logger with colored model tags, timestamps, and optional debug dump.

import fs from 'node:fs';
import path from 'node:path';

const __dirname = import.meta.dirname;
const DEBUG_LOG_PATH = path.join(__dirname, '..', 'debug.log');

let DEBUG_MODE = false;
let debugFh = null;

const RESET = '\x1b[0m';
const DIM = '\x1b[90m';

/** Provider short labels for visual tags. */
const PROVIDER_LABEL = { nvidia: 'NVDA', aihubmix: 'AHM' };

const MODEL_COLORS = {
  'glm-5.2': '\x1b[36m',
  'deepseek-v4-pro': '\x1b[34m',
  'minimax-m3': '\x1b[31m',
  'gpt-5.5': '\x1b[32m',
  'mimo': '\x1b[33m',
};

/** Build the colored tag shown on every log line, e.g. `glm-5.2 [NVDA K1]`. */
export function visualTag(provider, model, keyIdx) {
  const slug = model.includes('/') ? model.split('/').pop() : model;
  const ptag = PROVIDER_LABEL[provider] || provider.toUpperCase();
  const color = Object.entries(MODEL_COLORS).find(([k]) => model.includes(k))?.[1];
  return `${color ? `${color}${slug}${RESET}` : slug} [${ptag} K${keyIdx + 1}]`;
}

/** Console timestamp `[HH:MM:SS]` (dimmed). */
export function ts() {
  const t = new Date().toTimeString().split(' ')[0];
  return `${DIM}[${t}]${RESET}`;
}

/** Toggle debug logging on/off. When on, dumps raw request/response bodies. */
function setDebug(on) {
  DEBUG_MODE = on;
  if (on && !debugFh) {
    debugFh = fs.createWriteStream(DEBUG_LOG_PATH, { flags: 'w' });
    // Without an error listener, a write error (disk full, file deleted, etc.)
    // would crash the process with an unhandled 'error' event.
    debugFh.on('error', (err) => {
      console.warn(`${ts()} [debug] write error: ${err.message}`);
      debugFh = null;
      DEBUG_MODE = false;
    });
    debugFh.write(`--- DEBUG INICIADO ${new Date().toISOString()} ---\n`);
    console.log(`${ts()} [debug] LIGADO — gravando em ${DEBUG_LOG_PATH}`);
  } else if (!on && debugFh) {
    debugFh.end();
    debugFh = null;
    console.log(`${ts()} [debug] DESLIGADO`);
  }
}

export function isDebug() {
  return DEBUG_MODE;
}

/** Append a line to the debug log (no-op when debug is off). */
export function debug(text) {
  if (DEBUG_MODE && debugFh) debugFh.write(text + '\n');
}

// Allow toggling debug from the controlling TTY by pressing 'd'.
export function installDebugToggler() {
  if (!process.stdin.isTTY) return;
  try {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (key) => {
      const k = key.toString();
      if (k === '\x03' || k === '\x04') {
        console.log('\nEncerrando proxy...');
        process.exit(0);
      }
      if (k.toLowerCase() === 'd') setDebug(!DEBUG_MODE);
    });
  } catch {
    /* non-TTY: ignore */
  }
}
