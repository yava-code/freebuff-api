#!/usr/bin/env node
'use strict';
/**
 * freebuff-api — one command OpenAI-compatible bridge for Freebuff Desktop.
 *
 *   npx github:yava-code/freebuff-api
 *
 * Finds your local Freebuff login token, prints it + the local endpoint, and
 * serves an OpenAI-compatible API on 127.0.0.1:
 *
 *   GET  /health
 *   GET  /v1/models
 *   POST /v1/chat/completions     (stream: true supported)
 *
 * Re-run any time: the token is re-read at every start, so Freebuff Desktop
 * updates and re-logins never break it. Nothing is installed into the app
 * folder — this script lives anywhere you like and only READS your token.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { findToken, printFound } = require('./lib/find-token');
const { defaultModel } = require('./lib/models');
const { createServer } = require('./lib/server');

const DEFAULT_PORT = Number(process.env.FREEBUFF_API_PORT || 8787);

function printBanner() {
  console.log('');
  console.log('  freebuff-api — OpenAI-compatible bridge for Freebuff Desktop');
  console.log('  -------------------------------------------------------------');
}

function printUsage(endpoint, apiKeyMasked) {
  console.log('');
  console.log('  OpenAI endpoint : ' + endpoint);
  console.log('  API key         : ' + apiKeyMasked + '   (any string works locally; use the real token elsewhere)');
  console.log('');
  console.log('  Quick test:');
  console.log('    curl ' + endpoint + '/models');
  console.log('');
  console.log('  Chat (non-stream):');
  console.log('    curl ' + endpoint + '/chat/completions \\');
  console.log('      -H "Content-Type: application/json" \\');
  console.log("      -d '{\"model\":\"" + defaultModel() + "\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}'");
  console.log('');
  console.log('  Use in any OpenAI client: base_url = ' + endpoint + ' , api_key = the token above.');
  console.log('  Stop: Ctrl+C');
  console.log('');
}

async function main() {
  printBanner();

  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    console.log('Usage: freebuff-api [--port N]');
    console.log('  --port N   port to listen on (default ' + DEFAULT_PORT + ', env FREEBUFF_API_PORT)');
    console.log('');
    console.log('  Backends (env FREEBUFF_API_BACKEND):');
    console.log('    auto (default)  official Freebuff CLI if installed (free mode), else SDK');
    console.log('    cli             official CLI only — free mode, 0 credits, needs `npm i -g freebuff`');
    console.log('    sdk             @codebuff/sdk only — bills account credits (402 without them)');
    process.exit(0);
  }

  const found = findToken();
  if (!found) {
    console.error('');
    console.error('  ✗ No Freebuff/Codebuff token found.');
    console.error('');
    console.error('  Looked in:');
    console.error('    - CODEBUFF_API_KEY env var');
    console.error('    - FREEBUFF_DESKTOP_STATE_PATH env var');
    console.error('    - ' + path.join(os.homedir(), '.config', 'freebuff-desktop', 'state.json'));
    console.error('    - ' + path.join(os.homedir(), '.codebuff', 'credentials.json'));
    console.error('');
    console.error('  Install Freebuff Desktop and log in once, then re-run this command.');
    process.exit(1);
  }

  printFound(found);

  const backend = require('./lib/server').pickBackend();
  console.log('');
  console.log('  Backend: ' + backend.primary + (backend.fallback ? ' (fallback: ' + backend.fallback + ')' : ''));
  if (backend.primary === 'sdk' && backend.fallback !== 'cli') {
    console.log('           Official CLI not detected — requests bill against credits (402 without).');
    console.log('           Install it once for free mode:  npm install -g freebuff');
  }

  const port = DEFAULT_PORT;
  const server = createServer({ token: found.token });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const endpoint = 'http://127.0.0.1:' + port + '/v1';
  printUsage(endpoint, found.token.slice(0, 6) + '…' + found.token.slice(-4));

  // Persist the last endpoint for tooling (harmless best-effort).
  try {
    fs.writeFileSync(
      path.join(os.tmpdir(), 'freebuff-api-endpoint.txt'),
      endpoint + '\n',
      'utf8'
    );
  } catch {}

  const shutdown = () => {
    console.log('\n  Shutting down…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('  ✗ Port ' + (err.port || DEFAULT_PORT) + ' is busy. Re-run with: --port 8788');
  } else {
    console.error('  ✗ ' + (err && err.stack ? err.stack : err));
  }
  process.exit(1);
});
