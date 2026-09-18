'use strict';
/**
 * Local OpenAI-compatible HTTP server (no dependencies, node:http only).
 *
 * Endpoints:
 *   GET  /health               -> { ok, model, models: n }
 *   GET  /v1/models            -> OpenAI models list
 *   POST /v1/chat/completions  -> OpenAI chat completion (stream or not)
 *   GET  /v1/models/:id        -> single model object
 *
 * Security: binds to 127.0.0.1 only; CORS allows browser apps on any origin
 * but the server is unreachable from other machines. Auth: any bearer token
 * (or none) — the bridge is a local convenience; the real upstream auth is
 * the user's own Freebuff token found at startup.
 */

const http = require('http');
const { listModels, resolveModel, defaultModel, isKnownModel } = require('./models');
const sdkRunChat = require('./sdk-bridge').runChat;
const { runChat: cliRunChat, findCliBinary } = require('./cli-bridge');
const { messagesToPrompt } = require('./sdk-bridge');

const OPENAI_BRIDGE_VERSION = 'freebuff-api/1.1.0';

/**
 * Backend selection:
 *   FREEBUFF_API_BACKEND=cli  → official CLI only (free mode, 0 credits)
 *   FREEBUFF_API_BACKEND=sdk  → @codebuff/sdk only (bills credits, 402 without)
 *   default (auto)            → CLI when installed, SDK fallback per request
 */
function pickBackend() {
  const forced = (process.env.FREEBUFF_API_BACKEND || 'auto').toLowerCase();
  if (forced === 'cli') return { primary: 'cli', fallback: null };
  if (forced === 'sdk') return { primary: 'sdk', fallback: null };
  return { primary: findCliBinary() ? 'cli' : 'sdk', fallback: 'sdk' };
}

/** Run one chat request on the chosen backend; auto mode falls back to the
 *  SDK when the CLI path fails (timeouts, TUI races, missing binary).
 *  deps allows tests to stub either backend: { cliRunChat, sdkRunChat }. */
async function routeRunChat(opts, backend, deps = {}) {
  const cli = deps.cliRunChat || cliRunChat;
  const sdk = deps.sdkRunChat || sdkRunChat;
  const useCli = backend.primary === 'cli' || backend.fallback === 'cli';
  if (useCli) {
    try {
      const system = (opts.messages || []).filter((m) => m && m.role === 'system' && typeof m.content === 'string').map((m) => m.content).join('\n').trim();
      const prompt = messagesToPrompt(opts.messages || []);
      if (!prompt) {
        const err = new Error('No usable prompt: messages must contain at least one non-system message with string content.');
        err.status = 400;
        throw err;
      }
      const out = await cli({ model: opts.model, prompt: system ? system + '\n\n---\n\n' + prompt : prompt, timeoutMs: opts.cliTimeoutMs, signal: opts.signal });
      return { ...out, backend: 'cli' };
    } catch (err) {
      if (err.status === 400) throw err; // caller error, not a backend failure
      if (backend.primary === 'cli' && !backend.fallback) throw err; // forced
      if (process.env.FREEBUFF_API_DEBUG) {
        console.warn('  [cli-bridge failed, falling back to SDK]', err.message);
      }
      try {
        const out = await sdk(opts);
        return { ...out, backend: 'sdk', cliFallbackReason: err.message };
      } catch (sdkErr) {
        // Daily free quota exhausted AND the paid-credit fallback also 402'd:
        // surface both facts so the user knows what actually happened.
        if (sdkErr.status === 402 && /Freebucks/i.test(err.message)) {
          sdkErr.hint = 'Daily free quota (Freebucks) is exhausted — it refills at midnight Pacific. '
            + 'The paid-credits fallback also returned 402: ' + (sdkErr.hint || sdkErr.message);
        }
        throw sdkErr;
      }
    }
  }
  const out = await sdk(opts);
  return { ...out, backend: 'sdk' };
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'access-control-allow-origin': '*',
  });
  res.end(payload);
}

function openAiError(res, status, message, hint) {
  json(res, status, {
    error: {
      message,
      type: status === 401 ? 'authentication_error'
        : status === 402 ? 'insufficient_credits'
        : status === 404 ? 'not_found_error'
        : status === 429 ? 'rate_limit_error'
        : 'api_error',
      code: status,
      ...(hint ? { hint } : {}),
    },
  });
}

function modelObject(m) {
  return {
    id: m.id,
    object: 'model',
    created: 1700000000,
    owned_by: 'freebuff',
    freebuff: {
      displayName: m.displayName,
      ...(m.freebucksPerHour != null ? { freebucksPerHour: m.freebucksPerHour } : {}),
      ...(m.recommended ? { recommended: true } : {}),
    },
  };
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sseInit(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
    'x-accel-buffering': 'no',
  });
}

function sseChunk(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function sseDone(res) {
  res.write('data: [DONE]\n\n');
  res.end();
}

function completionId() {
  return 'chatcmpl-freebuff-' + Math.random().toString(36).slice(2, 10);
}

/**
 * Create the server.
 * @param {object} opts
 * @param {string} opts.token          Freebuff/Codebuff token
 * @param {object} [opts.deps]         { runChat } injection for tests
 * @returns {http.Server}
 */
function createServer(opts) {
  const token = opts.token;
  const backend = (opts.deps && opts.deps.backend) || pickBackend();
  const bridgeRun = (opts.deps && opts.deps.runChat) || ((o) => routeRunChat(o, backend));

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'authorization, content-type',
        });
        return res.end();
      }

      if (req.method === 'GET' && (path === '/health' || path === '/')) {
        return json(res, 200, {
          ok: true,
          service: OPENAI_BRIDGE_VERSION,
          endpoint: '/v1',
          backend,
          defaultModel: defaultModel(),
          models: listModels().length,
        });
      }

      if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
        const data = listModels().map(modelObject);
        return json(res, 200, { object: 'list', data });
      }

      let mm = path.match(/^\/(?:v1\/)?models\/([^/]+)$/);
      if (req.method === 'GET' && mm) {
        const id = decodeURIComponent(mm[1]);
        const m = listModels().find((x) => x.id === id);
        if (!m) return openAiError(res, 404, `Model '${id}' not found`);
        return json(res, 200, modelObject(m));
      }

      mm = path.match(/^\/(?:v1\/)?chat\/completions$/);
      if (req.method === 'POST' && mm) {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw || '{}'); } catch {
          return openAiError(res, 400, 'Invalid JSON body');
        }

        const model = resolveModel(body.model);
        const messages = Array.isArray(body.messages) ? body.messages : null;
        if (!messages) return openAiError(res, 400, "'messages' must be an array");
        if (!messages.length) return openAiError(res, 400, "'messages' must not be empty");

        const wantStream = !!body.stream;
        const id = completionId();
        const created = Math.floor(Date.now() / 1000);

        const makeChunk = (delta, finish) => ({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }],
        });

        if (wantStream) {
          // Abort upstream if the client socket dies (real disconnect, not
          // Node's 'close'-on-request-end semantics).
          const abort = new AbortController();
          res.on('close', () => { if (!res.writableEnded) abort.abort(); });

          sseInit(res);
          sseChunk(res, makeChunk({ role: 'assistant' }));
          let streamedAny = false;
          const streamedText = { v: '' };
          try {
            const out = await bridgeRun({
              token,
              model,
              messages,
              maxTokens: body.max_tokens,
              temperature: body.temperature,
              signal: abort.signal,
              onDelta: (t) => {
                streamedAny = true;
                streamedText.v += t;
                sseChunk(res, makeChunk({ content: t }));
              },
            });
            // If the SDK emitted no usable deltas but produced final text,
            // emit it as one chunk so clients always get content.
            if (!streamedAny && out && out.text) {
              sseChunk(res, makeChunk({ content: out.text }));
              streamedText.v = out.text;
              streamedAny = true;
            } else if (out && out.text && out.text !== streamedText.v) {
              // Deltas were streamed but final text diverged: send the tail
              // so nothing is lost.
              if (out.text.startsWith(streamedText.v)) {
                const tail = out.text.slice(streamedText.v.length);
                if (tail) sseChunk(res, makeChunk({ content: tail }));
              } else if (out.text.length > streamedText.v.length) {
                sseChunk(res, makeChunk({ content: out.text }));
              }
              streamedText.v = out.text.length >= streamedText.v.length ? out.text : streamedText.v;
            }
            sseChunk(res, makeChunk({}, 'stop'));
            sseDone(res);
          } catch (err) {
            const status = err.status || 502;
            // If nothing was streamed yet we can still send a proper SSE
            // error event followed by DONE (some clients want that).
            sseChunk(res, { error: { message: err.message, code: status, ...(err.hint ? { hint: err.hint } : {}) } });
            sseChunk(res, makeChunk({}, 'stop'));
            sseDone(res);
          }
          return;
        }

        // Non-streaming.
        try {
          const out = await bridgeRun({
            token,
            model,
            messages,
            maxTokens: body.max_tokens,
            temperature: body.temperature,
          });
          return json(res, 200, {
            id,
            object: 'chat.completion',
            created,
            model,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: out.text },
              finish_reason: 'stop',
            }],
            usage: out.usage || { prompt_tokens: null, completion_tokens: null, total_tokens: null },            freebuff: {
              ...(out.backend ? { backend: out.backend } : {}),
              ...(out.costModes ? { costModes: out.costModes } : {}),
              ...(out.cliFallbackReason ? { cliFallbackReason: out.cliFallbackReason } : {}),
            },
          });
        } catch (err) {
          return openAiError(res, err.status || 502, err.message, err.hint);
        }
      }

      return openAiError(res, 404, `No route for ${req.method} ${path}`);
    } catch (err) {
      return openAiError(res, err.status || 500, err.message || 'Internal error');
    }
  });
}

module.exports = { createServer, modelObject, openAiError, pickBackend, routeRunChat };
