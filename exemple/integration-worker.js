const readline = require('readline');

function writeDiagnostic(method, args) {
  const serialized = args.map((value) => {
    if (typeof value === 'string') return value;

    try {
      return JSON.stringify(value);
    } catch (_) {
      return String(value);
    }
  }).join(' ');

  process.stderr.write(`${serialized}\n`);
}

console.log = (...args) => writeDiagnostic('log', args);
console.info = (...args) => writeDiagnostic('info', args);
console.warn = (...args) => writeDiagnostic('warn', args);
console.error = (...args) => writeDiagnostic('error', args);

let authProvider = null;
let spotfireProvider = null;
let deslocamentoRepository = null;

function ensureAuthProvider() {
  if (!authProvider) {
    const PuppeteerAuthProvider = require('../../modules/auth/PuppeteerAuthProvider');
    authProvider = new PuppeteerAuthProvider();
  }
  return authProvider;
}

function ensureSpotfireRepository() {
  if (!spotfireProvider) {
    const SpotfireProvider = require('../../modules/deslocamentos/SpotfireProvider');
    spotfireProvider = new SpotfireProvider();
  }
  if (!deslocamentoRepository) {
    const DeslocamentoRepository = require('../../modules/deslocamentos/DeslocamentoRepository');
    deslocamentoRepository = new DeslocamentoRepository(spotfireProvider);
  }
  return { spotfireProvider, deslocamentoRepository };
}

async function shutdownAll() {
  await Promise.all([
    authProvider ? authProvider.shutdown().catch(() => {}) : Promise.resolve(),
    spotfireProvider ? spotfireProvider.shutdown().catch(() => {}) : Promise.resolve(),
  ]);

  authProvider = null;
  spotfireProvider = null;
  deslocamentoRepository = null;
}

async function handle(type, payload) {
  switch (type) {
    case 'auth.initialize':
      return ensureAuthProvider().initialize();
    case 'auth.getToken':
      return authProvider ? authProvider.getToken() : null;
    case 'auth.isAuthenticated':
      return authProvider ? authProvider.isAuthenticated() : false;
    case 'auth.reAuthenticate':
      return ensureAuthProvider().reAuthenticate();
    case 'auth.shutdown':
      if (authProvider) await authProvider.shutdown();
      authProvider = null;
      return true;

    case 'spotfire.initialize':
      await ensureSpotfireRepository().spotfireProvider.initialize();
      return true;
    case 'spotfire.shutdown':
      if (spotfireProvider) await spotfireProvider.shutdown();
      spotfireProvider = null;
      deslocamentoRepository = null;
      return true;
    case 'spotfire.resetSession':
      await ensureSpotfireRepository().spotfireProvider.resetSession();
      return true;

    case 'deslocamento.findByPolo': {
      const runtime = ensureSpotfireRepository();
      await runtime.spotfireProvider.initialize();
      return runtime.deslocamentoRepository.findByPolo(payload.polo);
    }

    case 'deslocamento.findAll': {
      const runtime = ensureSpotfireRepository();
      await runtime.spotfireProvider.initialize();
      return runtime.deslocamentoRepository.findAll();
    }

    case 'runtime.shutdown':
      await shutdownAll();
      return true;

    default:
      throw new Error(`Unknown integration worker command: ${type}`);
  }
}

function sendMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handleMessage(message) {
  if (!message || !message.id || !message.type) return;

  try {
    const result = await handle(message.type, message.payload || {});
    sendMessage({ id: message.id, ok: true, result });
  } catch (error) {
    sendMessage({
      id: message.id,
      ok: false,
      error: { message: error.message, stack: error.stack },
    });
  }
}

const reader = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

reader.on('line', async (line) => {
  if (!line) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    sendMessage({
      id: null,
      ok: false,
      error: { message: `Invalid JSON message: ${line}` },
    });
    return;
  }

  await handleMessage(message);
});

process.stdin.on('end', async () => {
  await shutdownAll();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await shutdownAll();
  process.exit(0);
});