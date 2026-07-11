// index.js
// Entrypoint for the NVIDIA <-> OpenCode proxy.
// Boots config, providers, debug toggle, and the HTTP server.

import { ENV, MIN_INTERVAL_MS } from './src/config.js';
import { assertProvidersConfigured, PROVIDERS } from './src/providers.js';
import { installDebugToggler } from './src/logger.js';
import { loadModelConfigs, watchModelConfigs } from './src/config.js';
import { createServer } from './src/handler.js';

// Fail fast if no NVIDIA keys are configured.
assertProvidersConfigured();

// Initial load of opencode.jsonc model options + start hot-reload watcher.
loadModelConfigs();
watchModelConfigs();

// Allow toggling debug logging with the 'd' key when attached to a TTY.
installDebugToggler();

const server = createServer();

server.listen(ENV.port, ENV.host, () => {
  console.log(`\n\x1b[36m🚀 nvidia-opencode-proxy v3.4.3 ativo!\x1b[0m`);
  console.log(`🛡  Host:Port      : ${ENV.host}:${ENV.port}`);
  console.log(`🛡  RPM alvo       : ${ENV.targetRpm} (intervalo ${MIN_INTERVAL_MS}ms)`);
  console.log(`🛡  Concorrência   : ${ENV.maxConcurrent}`);
  console.log(`🛡  Timers         : ${ENV.connTimeoutMs}ms conexão | ${ENV.streamTimeoutMs}ms stream idle`);
  console.log(`🔌 Chaves físicas : ${PROVIDERS.nvidia.keys.length}`);
  console.log(`📊 Endpoints      : GET /health · GET /metrics`);
  console.log(`🔄 Cascata        : alterna K1/K2 a cada request, sem repetir modelo`);
  console.log(`🐛 Debug          : pressione [D] no terminal para ligar/desligar\n`);
});

// Graceful shutdown — drain in-flight requests up to 10s.
function shutdown(sig) {
  console.log(`\n[${sig}] Encerrando proxy...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// Ignore SIGHUP so the proxy survives the parent shell exiting (e.g. when
// launched from a non-interactive command runner that closes after spawn).
process.on('SIGHUP', () => console.log('[SIGHUP] ignorado (proxy continua ativo)'));

// Diagnostic: log unexpected exits so we can tell crash vs signal apart.
process.on('exit', (code) => console.log(`[exit] code=${code}`));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err?.stack ?? err));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err?.stack ?? err));
