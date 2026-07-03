// src/providers.js
// Provider definitions. Each provider has a base URL and one or more API keys.
// The proxy transparently rotates keys per cascade cycle.

/** @typedef {{ baseUrl: string, keys: string[] }} Provider */

const NVIDIA_KEYS = [
  process.env.NVIDIA_KEY_1 || '',
  process.env.NVIDIA_KEY_2 || '',
].filter(Boolean);

// Allow overriding the NVIDIA base URL via env (used by the test harness to
// point the proxy at a mock server that captures upstream requests).
const NVIDIA_BASE_URL = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com';

// Only use mock keys when explicitly in test mode (PROXY_TEST_MODE=1). Without
// this gate, a user who forgets to set NVIDIA_KEY_* gets a proxy that boots
// "successfully" and then 401s every request — the assertProvidersConfigured
// guard never fires because the array is non-empty.
const TEST_MODE = process.env.PROXY_TEST_MODE === '1';
const KEYS = NVIDIA_KEYS.length
  ? NVIDIA_KEYS
  : (TEST_MODE ? ['mock-key-1', 'mock-key-2'] : []);

/** @type {Record<string, Provider>} */
export const PROVIDERS = {
  nvidia: {
    baseUrl: NVIDIA_BASE_URL,
    keys: KEYS,
  },
};

/** Quick guard so the process fails fast with a clear message. */
export function assertProvidersConfigured() {
  if (!PROVIDERS.nvidia.keys.length) {
    console.error('[CRÍTICO] Nenhuma NVIDIA_KEY_* configurada. Abortando.');
    process.exit(1);
  }
}

/** Total number of physical keys across all providers (for logging). */
export function totalKeyCount() {
  return Object.values(PROVIDERS).reduce((sum, p) => sum + p.keys.length, 0);
}
