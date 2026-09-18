'use strict';
/**
 * Honest tests with dependency injection: no network, no faked HTTP — the
 * fake client only stands in for @codebuff/sdk at the boundary where the
 * bridge consumes it. Run: npm test
 */

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../lib/server');
const { resolveModel, DEFAULT_MODEL } = require('../lib/models');
const { messagesToPrompt, systemFromMessages, normalizeErrorStatus, friendlyHint } = require('../lib/sdk-bridge');
const { findToken, maskToken } = require('../lib/find-token');
const { runChat: cliRunChat, messageText, looksLikeAssistant, pickerModel, CLI_MODELS } = require('../lib/cli-bridge');
const { pickBackend, routeRunChat } = require('../lib/server');

let portCounter = 18800;
function nextPort() { return ++portCounter; }

/** Per-test agent: Node's global keep-alive agent would hold sockets to a
 *  closed server and RESET the next one sharing the port. */
function freshAgent() {
  return new http.Agent({ keepAlive: false, maxSockets: 1 });
}

function post(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request('http://127.0.0.1:' + port + pathname, {
      method: 'POST',
      agent: freshAgent(),
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:' + port + pathname, { agent: freshAgent() }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    }).on('error', reject);
  });
}

/** Fake SDK client mirroring the real handleStreamChunk contract:
 *  chunks arrive as plain strings (or {type:'reasoning_chunk', chunk}). */
function makeFakeClient(script) {
  return function FakeClient(opts) {
    this.opts = opts;
    this.run = async (runOpts) => {
      script.calls.push(runOpts);
      const emit = (text) => {
        if (runOpts.handleStreamChunk) runOpts.handleStreamChunk(text);
      };
      if (script.mode === 'deltas') {
        for (const t of script.deltas) emit(t);
        return { output: { type: 'lastMessage', value: [{ type: 'text', text: script.finalText }] } };
      }
      if (script.mode === 'deltas_with_tail') {
        // Real SDK quirk: deltas stream first, final text includes extra tail.
        for (const t of script.deltas) emit(t);
        return { output: { type: 'lastMessage', value: [{ type: 'text', text: script.finalText }] } };
      }
      if (script.mode === 'final_only') {
        return { output: { type: 'lastMessage', value: [{ type: 'text', text: script.finalText }] } };
      }
      if (script.mode === 'reasoning_noise') {
        // Reasoning chunks must not pollute the output stream.
        if (runOpts.handleStreamChunk) {
          runOpts.handleStreamChunk({ type: 'reasoning_chunk', agentId: 'x', ancestorRunIds: [], chunk: 'internal thoughts' });
        }
        for (const t of script.deltas) emit(t);
        return { output: { type: 'lastMessage', value: [{ type: 'text', text: script.finalText }] } };
      }
      if (script.mode === 'upstream_error') {
        return { output: { type: 'error', message: 'Out of credits. Please add credits at https://www.codebuff.com/usage.', statusCode: 402 } };
      }
      if (script.mode === 'throw') {
        const e = new Error(script.errorMessage || 'boom');
        e.statusCode = script.errorStatus || 500;
        throw e;
      }
      throw new Error('unknown script mode');
    };
  };
}

async function withServer(deps, fn) {
  const port = nextPort();
  const server = createServer({ token: 'test-token', deps });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    await fn(port);
  } finally {
    // Destroy lingering keep-alive sockets so the next test cannot receive a
    // RESET from a server that no longer exists.
    server.closeAllConnections && server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// ---------- model resolution ----------
test('resolveModel: empty -> default', () => {
  assert.strictEqual(resolveModel(''), DEFAULT_MODEL);
  assert.strictEqual(resolveModel(undefined), DEFAULT_MODEL);
});
test('resolveModel: known id passthrough', () => {
  assert.strictEqual(resolveModel('openai/gpt-5.6-luna'), 'openai/gpt-5.6-luna');
});
test('resolveModel: bare alias gets provider prefix', () => {
  assert.strictEqual(resolveModel('gpt-5.6-luna'), 'openai/gpt-5.6-luna');
});

// ---------- prompt building ----------
test('messagesToPrompt: flattens history, skips system', () => {
  const p = messagesToPrompt([
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'bye' },
  ]);
  assert.strictEqual(p, 'hi\n\nAssistant said: hello\n\nbye');
});
test('systemFromMessages: joins system blocks', () => {
  assert.strictEqual(systemFromMessages([
    { role: 'system', content: 'a' },
    { role: 'user', content: 'x' },
    { role: 'system', content: 'b' },
  ]), 'a\nb');
});

// ---------- error mapping ----------
test('normalizeErrorStatus: statusCode wins', () => {
  assert.strictEqual(normalizeErrorStatus({ statusCode: 402 }), 402);
  assert.strictEqual(normalizeErrorStatus({ message: 'HTTP 429 too many' }), 429);
  assert.strictEqual(normalizeErrorStatus({}), 502);
});
test('friendlyHint: 402 mentions credits', () => {
  assert.ok(/credits/i.test(friendlyHint(402)));
});

// ---------- stream chunk normalization ----------
test('chunkText: plain string chunks pass through; reasoning chunks ignored', () => {
  const { chunkText } = require('../lib/sdk-bridge');
  assert.strictEqual(chunkText('hello'), 'hello');
  assert.strictEqual(chunkText({ type: 'subagent_chunk', chunk: 'sub' }), 'sub');
  assert.strictEqual(chunkText({ type: 'reasoning_chunk', chunk: 'thinking...' }), '');
  assert.strictEqual(chunkText(null), '');
});

// ---------- HTTP surface ----------
test('GET /health', async () => {
  await withServer({}, async (port) => {
    const r = await get(port, '/health');
    assert.strictEqual(r.status, 200);
    const b = JSON.parse(r.body);
    assert.strictEqual(b.ok, true);
    assert.ok(b.models >= 10);
  });
});

test('GET /v1/models returns OpenAI list with freebuff metadata', async () => {
  await withServer({}, async (port) => {
    const r = await get(port, '/v1/models');
    assert.strictEqual(r.status, 200);
    const b = JSON.parse(r.body);
    assert.strictEqual(b.object, 'list');
    assert.ok(b.data.length >= 10);
    const glm = b.data.find((m) => m.id === DEFAULT_MODEL);
    assert.ok(glm, 'default model present');
    assert.strictEqual(glm.owned_by, 'freebuff');
    assert.strictEqual(glm.freebuff.displayName, 'GLM 5.3 Flash');
  });
});

test('GET /v1/models/:id -> 404 for unknown', async () => {
  await withServer({}, async (port) => {
    const r = await get(port, '/v1/models/nope/nope');
    assert.strictEqual(r.status, 404);
  });
});

test('POST /v1/chat/completions non-stream happy path', async () => {
  const script = { calls: [], mode: 'deltas', deltas: ['Hello', ' world'], finalText: 'Hello world' };
  await withServer({ runChat: async (o) => (await require('../lib/sdk-bridge').runChat({ ...o, deps: { Client: makeFakeClient(script) } })) }, async (port) => {
    const r = await post(port, '/v1/chat/completions', { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }] });
    assert.strictEqual(r.status, 200);
    const b = JSON.parse(r.body);
    assert.strictEqual(b.object, 'chat.completion');
    assert.strictEqual(b.choices[0].message.content, 'Hello world');
    assert.strictEqual(script.calls.length, 1);
    assert.strictEqual(script.calls[0].agent.model, DEFAULT_MODEL);
  });
});

test('POST stream: deltas forwarded in SSE order with [DONE]', async () => {
  const script = { calls: [], mode: 'deltas', deltas: ['A', 'B', 'C'], finalText: 'ABC' };
  await withServer({ runChat: async (o) => (await require('../lib/sdk-bridge').runChat({ ...o, deps: { Client: makeFakeClient(script) } })) }, async (port) => {
    const r = await post(port, '/v1/chat/completions', { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true });
    assert.strictEqual(r.status, 200);
    assert.ok(r.headers['content-type'].includes('text/event-stream'));
    const events = r.body.split('\n\n').filter((e) => e.startsWith('data: '));
    const contents = events
      .filter((e) => e.slice(6) !== '[DONE]')
      .map((e) => JSON.parse(e.slice(6)))
      .filter((o) => o && o.choices && o.choices[0].delta && typeof o.choices[0].delta.content === 'string')
      .map((o) => o.choices[0].delta.content);
    assert.deepStrictEqual(contents, ['A', 'B', 'C']);
    assert.ok(r.body.endsWith('data: [DONE]\n\n'));
  });
});

test('POST stream: tail after deltas is not lost', async () => {
  const script = { calls: [], mode: 'deltas_with_tail', deltas: ['Hello', ' world'], finalText: 'Hello world from fake' };
  await withServer({ runChat: async (o) => (await require('../lib/sdk-bridge').runChat({ ...o, deps: { Client: makeFakeClient(script) } })) }, async (port) => {
    const r = await post(port, '/v1/chat/completions', { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true });
    const contents = r.body.split('\n\n')
      .filter((e) => e.startsWith('data: '))
      .map((e) => { try { return JSON.parse(e.slice(6)); } catch { return null; } })
      .filter((o) => o && o.choices && o.choices[0].delta && typeof o.choices[0].delta.content === 'string')
      .map((o) => o.choices[0].delta.content);
    assert.strictEqual(contents.join(''), 'Hello world from fake');
  });
});

test('POST stream: final-only output still streams one chunk', async () => {
  const script = { calls: [], mode: 'final_only', finalText: 'final text here' };
  await withServer({ runChat: async (o) => (await require('../lib/sdk-bridge').runChat({ ...o, deps: { Client: makeFakeClient(script) } })) }, async (port) => {
    const r = await post(port, '/v1/chat/completions', { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true });
    const contents = r.body.split('\n\n')
      .filter((e) => e.startsWith('data: '))
      .map((e) => { try { return JSON.parse(e.slice(6)); } catch { return null; } })
      .filter((o) => o && o.choices && o.choices[0].delta && typeof o.choices[0].delta.content === 'string')
      .map((o) => o.choices[0].delta.content);
    assert.deepStrictEqual(contents, ['final text here']);
  });
});

test('POST stream: reasoning chunks are filtered out', async () => {
  const script = { calls: [], mode: 'reasoning_noise', deltas: ['Answer'], finalText: 'Answer' };
  await withServer({ runChat: async (o) => (await require('../lib/sdk-bridge').runChat({ ...o, deps: { Client: makeFakeClient(script) } })) }, async (port) => {
    const r = await post(port, '/v1/chat/completions', { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true });
    const contents = r.body.split('\n\n')
      .filter((e) => e.startsWith('data: '))
      .map((e) => { try { return JSON.parse(e.slice(6)); } catch { return null; } })
      .filter((o) => o && o.choices && o.choices[0].delta && typeof o.choices[0].delta.content === 'string')
      .map((o) => o.choices[0].delta.content);
    assert.deepStrictEqual(contents, ['Answer']);
    assert.ok(!r.body.includes('internal thoughts'));
  });
});

test('POST non-stream: upstream 402 -> honest error with hint', async () => {
  const script = { calls: [], mode: 'upstream_error' };
  await withServer({ runChat: async (o) => (await require('../lib/sdk-bridge').runChat({ ...o, deps: { Client: makeFakeClient(script) } })) }, async (port) => {
    const r = await post(port, '/v1/chat/completions', { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }] });
    assert.strictEqual(r.status, 402);
    const b = JSON.parse(r.body);
    assert.strictEqual(b.error.type, 'insufficient_credits');
    assert.ok(/credits/i.test(b.error.hint));
  });
});

test('POST stream: upstream error arrives as SSE error event, then DONE', async () => {
  const script = { calls: [], mode: 'upstream_error' };
  await withServer({ runChat: async (o) => (await require('../lib/sdk-bridge').runChat({ ...o, deps: { Client: makeFakeClient(script) } })) }, async (port) => {
    const r = await post(port, '/v1/chat/completions', { model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true });
    assert.strictEqual(r.status, 200); // SSE headers already sent
    assert.ok(r.body.includes('"error"'));
    assert.ok(r.body.includes('402'));
    assert.ok(r.body.endsWith('data: [DONE]\n\n'));
  });
});

test('POST: bad JSON -> 400', async () => {
  await withServer({}, async (port) => {
    const r = await new Promise((resolve, reject) => {
      const req = http.request('http://127.0.0.1:' + port + '/v1/chat/completions', { method: 'POST', agent: freshAgent(), headers: { 'content-type': 'application/json' } }, (res) => {
        let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      req.on('error', reject); req.end('{oops');
    });
    assert.strictEqual(r.status, 400);
  });
});

test('POST: empty messages -> 400', async () => {
  await withServer({}, async (port) => {
    const r = await post(port, '/v1/chat/completions', { messages: [] });
    assert.strictEqual(r.status, 400);
  });
});

test('findToken: env override wins; maskToken keeps ends', () => {
  const prev = process.env.CODEBUFF_API_KEY;
  process.env.CODEBUFF_API_KEY = 'test-key-1234567890';
  try {
    const found = findToken();
    assert.strictEqual(found.token, 'test-key-1234567890');
    assert.strictEqual(found.source, 'CODEBUFF_API_KEY env var');
  } finally {
    if (prev === undefined) delete process.env.CODEBUFF_API_KEY; else process.env.CODEBUFF_API_KEY = prev;
  }
  const masked = maskToken('test-key-1234567890');
  assert.ok(masked.startsWith('test-k'));
  assert.ok(masked.endsWith('7890'));
  assert.ok(!masked.includes('123456789'));
});

/* ---------------------------------------------- cli-bridge unit tests -- */

test('cli-bridge: messageText extracts content/blocks/reasoning-filter', () => {
  assert.strictEqual(messageText({ variant: 'ai', content: 'hi' }), 'hi');
  assert.strictEqual(messageText({ variant: 'ai', content: [{ type: 'text', text: 'a' }] }), 'a');
  assert.strictEqual(
    messageText({ variant: 'ai', blocks: [
      { type: 'text', content: 'thinking...', textType: 'reasoning' },
      { type: 'text', content: 'answer', textType: 'text' },
    ] }),
    'answer',
  );
  assert.strictEqual(messageText({ variant: 'ai', parts: [{ type: 'text', content: 'x' }] }), 'x');
  assert.strictEqual(messageText(null), '');
});

test('cli-bridge: looksLikeAssistant accepts variant:ai and role forms', () => {
  assert.ok(looksLikeAssistant({ variant: 'ai' }));
  assert.ok(looksLikeAssistant({ role: 'assistant' }));
  assert.ok(looksLikeAssistant({ type: 'ASSISTANT' }));
  assert.ok(!looksLikeAssistant({ variant: 'user' }));
  assert.ok(!looksLikeAssistant(null));
});

test('cli-bridge: pickerModel maps known ids, defaults unknown to GLM flash', () => {
  assert.strictEqual(pickerModel('z-ai/glm-5.3-flash'), 'z-ai/glm-5.3-flash');
  assert.strictEqual(pickerModel('deepseek/deepseek-v4-flash'), 'deepseek/deepseek-v4-flash');
  assert.strictEqual(pickerModel('no/such-model'), 'z-ai/glm-5.3-flash');
  assert.ok(CLI_MODELS.length >= 4);
});

test('cli-bridge: happy path via fake TUI (transcript file is read)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbcli-test-'));
  const calls = [];
  const { EventEmitter } = require('events');
  // The fake CLI mirrors the real one: transcript under
  // <configDir>/projects/<basename(cwd)>/chats/<ts>/chat-messages.json.
  const fakeSpawn = (bin, args, opts) => {
    const chatsDir = path.join(dir, 'config', 'projects', path.basename(opts.cwd), 'chats');
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.write = (s) => calls.push(s);
    child.stderr = new EventEmitter();
    setTimeout(() => {
      fs.mkdirSync(chatsDir, { recursive: true });
      const chatDir = path.join(chatsDir, '2026-01-01_00-00-00');
      fs.mkdirSync(chatDir, { recursive: true });
      fs.writeFileSync(path.join(chatDir, 'chat-messages.json'), JSON.stringify([
        { id: 'divider-1', variant: 'ai', content: '', blocks: [{ type: 'mode-divider', mode: 'LITE' }] },
        { id: 'user-1', variant: 'user', content: 'hi' },
        { id: 'ai-1', variant: 'ai', content: '', blocks: [
          { type: 'text', content: 'hidden thoughts', textType: 'reasoning' },
          { type: 'text', content: 'PONG', textType: 'text' },
        ] },
      ]));
    }, 100);
    return child;
  };
  const fastSleep = (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20)));
  const out = await cliRunChat({
    model: 'z-ai/glm-5.3-flash',
    prompt: 'hi',
    timeoutMs: 15000,
    deps: {
      spawnFn: fakeSpawn,
      sleepFn: fastSleep,
      findBinFn: () => 'fake-freebuff.exe',
      configDir: path.join(dir, 'config'),
    },
  });
  assert.strictEqual(out.text, 'PONG');
  assert.strictEqual(out.via, 'cli');
  // TUI was driven: Enter, submit...
  assert.ok(calls.includes('\r'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cli-bridge: missing binary -> 503 with install hint', async () => {
  const err = await cliRunChat({
    model: 'z-ai/glm-5.3-flash',
    prompt: 'hi',
    deps: { findBinFn: () => null },
  }).catch((e) => e);
  assert.strictEqual(err.status, 503);
  assert.ok(err.hint.includes('FREEBUFF_API_BACKEND'));
});

test('cli-bridge: timeout -> 504 and TUI teardown keystrokes sent', async () => {
  const calls = [];
  const { EventEmitter } = require('events');
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.write = (s) => calls.push(s);
  child.stderr = new EventEmitter();
  const err = await cliRunChat({
    model: 'z-ai/glm-5.3-flash',
    prompt: 'hi',
    timeoutMs: 300,
    deps: {
      spawnFn: () => child,
      sleepFn: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
      findBinFn: () => 'fake-freebuff.exe',
      configDir: path.join(os.tmpdir(), 'fbcli-nowhere-' + Date.now()),
    },
  }).catch((e) => e);
  assert.strictEqual(err.status, 504);
  assert.ok(calls.includes('\x03'), 'Ctrl+C teardown');
});

/* --------------------------------------------------- backend routing -- */

test('routing: system prompt prepended to CLI prompt', async () => {
  let seen = null;
  const out = await routeRunChat(
    { messages: [{ role: 'system', content: 'Be terse.' }, { role: 'user', content: 'hi' }], model: 'm' },
    { primary: 'cli', fallback: 'sdk' },
    { cliRunChat: async (o) => { seen = o; return { text: 'ok', via: 'cli' }; }, sdkRunChat: async () => { throw new Error('SDK must not run'); } },
  );
  assert.strictEqual(out.backend, 'cli');
  assert.ok(seen.prompt.startsWith('Be terse.\n\n---\n\nhi'));
});

test('routing: CLI failure in auto mode falls back to SDK with reason', async () => {
  let sdkOpts = null;
  const out = await routeRunChat(
    { messages: [{ role: 'user', content: 'hi' }], model: 'm' },
    { primary: 'cli', fallback: 'sdk' },
    {
      cliRunChat: async () => { throw Object.assign(new Error('CLI timed out'), { status: 504 }); },
      sdkRunChat: async (o) => { sdkOpts = o; return { text: 'sdk-ok' }; },
    },
  );
  assert.strictEqual(out.backend, 'sdk');
  assert.strictEqual(out.cliFallbackReason, 'CLI timed out');
  assert.strictEqual(sdkOpts.model, 'm');
});

test('routing: forced CLI (no fallback) rethrows backend error', async () => {
  const err = await routeRunChat(
    { messages: [{ role: 'user', content: 'hi' }], model: 'm' },
    { primary: 'cli', fallback: null },
    { cliRunChat: async () => { throw Object.assign(new Error('boom'), { status: 504 }); }, sdkRunChat: async () => { throw new Error('SDK must not run'); } },
  ).catch((e) => e);
  assert.strictEqual(err.message, 'boom');
});

test('routing: empty prompt -> 400 before any backend', async () => {
  const err = await routeRunChat(
    { messages: [{ role: 'system', content: 'only system' }], model: 'm' },
    { primary: 'cli', fallback: 'sdk' },
    { cliRunChat: async () => { throw new Error('CLI must not run'); }, sdkRunChat: async () => { throw new Error('SDK must not run'); } },
  ).catch((e) => e);
  assert.strictEqual(err.status, 400);
});

test('routing: pickBackend honors FREEBUFF_API_BACKEND', () => {
  const prev = process.env.FREEBUFF_API_BACKEND;
  try {
    process.env.FREEBUFF_API_BACKEND = 'sdk';
    assert.deepStrictEqual(pickBackend(), { primary: 'sdk', fallback: null });
    process.env.FREEBUFF_API_BACKEND = 'cli';
    assert.deepStrictEqual(pickBackend(), { primary: 'cli', fallback: null });
    process.env.FREEBUFF_API_BACKEND = 'auto';
    const auto = pickBackend();
    assert.ok(auto.primary === 'cli' || auto.primary === 'sdk');
    assert.strictEqual(auto.fallback, 'sdk');
  } finally {
    if (prev === undefined) delete process.env.FREEBUFF_API_BACKEND; else process.env.FREEBUFF_API_BACKEND = prev;
  }
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('  ✓ ' + name);
    } catch (err) {
      failed++;
      console.log('  ✗ ' + name);
      console.log('      ' + (err && err.message));
    }
  }
  console.log('');
  console.log(failed === 0 ? `All ${tests.length} tests passed.` : failed + ' test(s) FAILED.');
  process.exit(failed === 0 ? 0 : 1);
})();
