// src/providers.js
// Provider definitions. Each provider has a base URL and one or more API keys.
// The proxy transparently rotates keys per cascade cycle.

/** @typedef {{ baseUrl: string, keys: string[] }} Provider */

const NVIDIA_KEYS = [
  process.env.NVIDIA_KEY_1 || '',
  process.env.NVIDIA_KEY_2 || '',
].filter(Boolean);

const AIHUBMIX_KEYS = [
  process.env.AIHUBMIX_KEY_1 || '',
  process.env.AIHUBMIX_KEY_2 || '',
].filter(Boolean);

const NVIDIA_BASE_URL = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com';
const AIHUBMIX_BASE_URL = process.env.AIHUBMIX_BASE_URL || 'https://aihubmix.com';

const TEST_MODE = process.env.PROXY_TEST_MODE === '1';
const NVD_KEYS = NVIDIA_KEYS.length
  ? NVIDIA_KEYS
  : (TEST_MODE ? ['mock-nv-key-1', 'mock-nv-key-2'] : []);
const AHM_KEYS = AIHUBMIX_KEYS.length
  ? AIHUBMIX_KEYS
  : (TEST_MODE ? ['mock-ahm-key-1', 'mock-ahm-key-2'] : []);

/** @type {Record<string, Provider>} */
export const PROVIDERS = {
  nvidia: {
    baseUrl: NVIDIA_BASE_URL,
    keys: NVD_KEYS,
  },
  aihubmix: {
    baseUrl: AIHUBMIX_BASE_URL,
    keys: AHM_KEYS,
  },
};

/** Quick guard so the process fails fast with a clear message. */
export function assertProvidersConfigured() {
  const total = totalKeyCount();
  if (!total) {
    console.error('[CRÍTICO] Nenhuma NVIDIA_KEY_* ou AIHUBMIX_KEY_* configurada. Abortando.');
    process.exit(1);
  }
}

/** Total number of physical keys across all providers (for logging). */
export function totalKeyCount() {
  return Object.values(PROVIDERS).reduce((sum, p) => sum + p.keys.length, 0);
}
