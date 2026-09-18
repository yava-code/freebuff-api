'use strict';
/**
 * CLI bridge: runs each chat request through the OFFICIAL Freebuff CLI
 * (`npm install -g freebuff` → binary managed in ~/.config/manicode/), i.e.
 * the genuine client the backend grants free-mode inference to.
 *
 * No protocol forging, no header spoofing — the CLI is simply driven like a
 * user would drive it:
 *   1. Spawn the real binary with a piped stdin in a scratch cwd.
 *   2. Preselect the model by writing `freebuffModel` into the CLI's own
 *      settings.json (restored afterwards), so the picker opens with the
 *      requested model highlighted; a single Enter confirms it.
 *   3. Prompt text + Enter submits; admission grants a 1-hour session.
 *   4. The CLI persists its own transcript to
 *      ~/.config/manicode/projects/<cwd-basename>/chats/<ts>/chat-messages.json
 *      — we watch that file and take the assistant's reply from it.
 *   5. Ctrl+C twice, kill, scratch dir removed.
 *
 * Requests are serialized through a queue: one TUI at a time, otherwise
 * keystrokes from concurrent calls would interleave. The transcript is
 * streamed by the CLI while the model writes, so the answer is only accepted
 * once it stopped growing (two identical consecutive reads).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CONFIG_DIR = path.join(os.homedir(), '.config', 'manicode');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const ENTER_DELAY_MS = 7000;      // TUI boot → model picker visible
const SUBMIT_DELAY_MS = 15000;    // admission ("… · 1h left") → editor ready
const WATCH_INTERVAL_MS = 400;

/** Known install locations of the official CLI binary (first hit wins). */
function findCliBinary() {
  const candidates = [
    process.env.FREEBUFF_CLI_BIN,
    path.join(CONFIG_DIR, 'freebuff.exe'), // Windows (npm-managed binary lives here)
    path.join(CONFIG_DIR, 'freebuff'),     // macOS/Linux
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}/**
 * Model ids the CLI picker actually offers (4 in the current build). Requests
 * for other catalog models fall back to the picker default.
 */
const CLI_MODELS = [
  'z-ai/glm-5.3-flash',
  'crof/kimi-k3-eco',
  'mimo/mimo-v2.5',
  'deepseek/deepseek-v4-flash',
];

/** Bridge model id → the value the CLI expects in settings.freebuffModel. */
function pickerModel(modelId) {
  return CLI_MODELS.includes(modelId) ? modelId : CLI_MODELS[0];
}

/** Write the requested model into the CLI's settings.json, returning a
 *  restore() thunk. settings.json is the CLI's own user preference file —
 *  same thing a user edits when picking a model in the TUI. */
function withPickerModel(modelId) {
  const wanted = pickerModel(modelId);
  let original = null;
  try { original = fs.readFileSync(SETTINGS_FILE, 'utf8'); } catch {}
  let json = {};
  try { json = JSON.parse(original || '{}'); } catch { json = {}; }
  const already = json.freebuffModel === wanted;
  if (!already) {
    try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...json, freebuffModel: wanted }, null, 2)); } catch {}
  }
  return {
    restore() {
      if (already) return;
      try {
        if (original === null) fs.unlinkSync(SETTINGS_FILE);
        else fs.writeFileSync(SETTINGS_FILE, original);
      } catch {}
    },
  };
}

function messageText(msg) {
  if (!msg || typeof msg !== 'object') return '';
  if (typeof msg.content === 'string' && msg.content) return msg.content;
  if (typeof msg.text === 'string' && msg.text) return msg.text;
  const parts = Array.isArray(msg.content) ? msg.content : Array.isArray(msg.blocks) ? msg.blocks : Array.isArray(msg.parts) ? msg.parts : [];
  // Transcript blocks carry { type:'text', content, textType:'reasoning'|'text' }.
  // Reasoning (model's thinking) must not leak into the answer.
  return parts
    .filter((p) => p && (typeof p.content === 'string' || typeof p.text === 'string') && (!p.textType || p.textType === 'text'))
    .map((p) => (typeof p.content === 'string' ? p.content : p.text))
    .join('');
}

function looksLikeAssistant(msg) {
  if (!msg || typeof msg !== 'object') return false;
  // CLI transcript marks assistant messages with variant:'ai'; keep role
  // checks for forward/backward compatibility.
  if (msg.variant === 'ai') return true;
  const role = msg.role || msg.type;
  return role === 'assistant' || role === 'ASSISTANT';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ---------------------------------------------------------------- queue -- */

let chain = Promise.resolve();
function enqueue(job) {
  const run = chain.then(job, job);
  chain = run.catch(() => {}); // keep the queue alive after failures
  return run;
}

/* ------------------------------------------------------------ one TUI run */

/**
 * @param {object} opts
 * @param {string} opts.model        bridge model id
 * @param {string} opts.prompt       flattened user prompt (no system text)
 * @param {number} [opts.timeoutMs]  overall budget (default 120000)
 * @param {object} [opts.deps]       test injection: { spawnFn, sleepFn, nowFn }
 * @returns {Promise<{ text: string, via: 'cli' }>}
 */
async function runOnce(opts) {
  const { model, prompt } = opts;
  const deps = opts.deps || {};
  const spawnFn = deps.spawnFn || spawn;
  const sleepFn = deps.sleepFn || sleep;
  const timeoutMs = opts.timeoutMs || Number(process.env.FREEBUFF_API_CLI_TIMEOUT_MS) || 120000;
  const signal = opts.signal;
  const findBin = deps.findBinFn || findCliBinary;
  const configDir = deps.configDir || CONFIG_DIR;
  const debug = !!process.env.FREEBUFF_API_DEBUG;
  const debugLog = path.join(os.tmpdir(), 'freebuff-api-cli-debug.log');
  const debugWrite = (s) => { if (debug) { try { fs.appendFileSync(debugLog, s); } catch {} } };

  const bin = findBin();
  if (!bin) {
    const err = new Error('Official Freebuff CLI not found (install: npm install -g freebuff)');
    err.status = 503;
    err.hint = 'Install the CLI once, or force the SDK backend with FREEBUFF_API_BACKEND=sdk.';
    throw err;
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-api-cli-'));
  const chatsDir = path.join(configDir, 'projects', path.basename(scratch), 'chats');
  const picker = withPickerModel(model);
  const t0 = Date.now();

  const child = spawnFn(bin, [], { cwd: scratch, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderrTail = '';
  let stdoutTail = '';
  if (child.stderr) child.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-2000); debugWrite('[stderr] ' + d); });
  if (child.stdout) child.stdout.on('data', (d) => { stdoutTail = (stdoutTail + d.toString('utf8')).slice(-4000); debugWrite('[stdout] ' + d.toString('utf8')); });

  let onAbort = null;

  const send = (s) => { try { child.stdin.write(s); } catch {} };
  const closeTui = () => {
    send('\x03');
    setTimeout(() => send('\x03'), 300);
    setTimeout(() => { try { child.kill(); } catch {} }, 900);
  };

  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      let chatDir = null;

      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearInterval(watch);
        clearTimeout(timer);
        fn(arg);
      };

      child.on('error', (e) => {
        finish(reject, Object.assign(new Error('CLI spawn failed: ' + e.message), { status: 502 }));
      });
      child.on('close', (code) => {
        if (!settled) {
          const e = new Error('CLI exited before answering (code ' + code + ')' + (stderrTail ? ': ' + stderrTail.trim().slice(-300) : ''));
          e.status = 502;
          finish(reject, e);
        }
      });

      // Abort support: a disconnected HTTP client must tear the TUI down.
      onAbort = () => {
        const e = new Error('Request aborted');
        e.status = 499;
        finish(reject, e);
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }

      // Watch the CLI's own transcript for the assistant's answer. The CLI
      // rewrites the file while streaming, so accept the text only after two
      // identical consecutive reads (answer finished growing).
      let lastText = '';
      const plainTail = () => stdoutTail.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
      const watch = setInterval(() => {
        // Fail fast when the daily Freebucks quota is exhausted — the TUI
        // blocks admission ("Not enough Freebucks … Enter opens plans") and
        // no transcript would ever appear.
        if (/not enough freebucks/i.test(plainTail())) {
          const e = new Error('Freebuff CLI: daily Freebucks exhausted — the session was not admitted.');
          e.status = 402;
          e.hint = 'The free quota refills daily (midnight Pacific). Alternatively set FREEBUFF_API_BACKEND=sdk to bill paid credits.';
          finish(reject, e);
          return;
        }
        try {
          if (!chatDir) {
            if (!fs.existsSync(chatsDir)) return;
            const dirs = fs.readdirSync(chatsDir)
              .map((d) => path.join(chatsDir, d))
              .filter((p) => { try { return fs.statSync(p).mtimeMs > t0 - 2000; } catch { return false; } })
              .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
            chatDir = dirs[0] || null;
            if (!chatDir) return;
          }
          const f = path.join(chatDir, 'chat-messages.json');
          if (!fs.existsSync(f)) return;
          let arr;
          try { arr = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return; } // mid-write; retry
          if (!Array.isArray(arr) || arr.length < 2) return; // divider + user echo + answer
          const last = [...arr].reverse().find(looksLikeAssistant);
          const text = last ? messageText(last).trim() : '';
          if (text && text === lastText) finish(resolve, { text, via: 'cli' });
          lastText = text;
        } catch { /* transient fs races are fine */ }
      }, WATCH_INTERVAL_MS);

      const timer = setTimeout(() => {
        const plain = stdoutTail.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/[^\x20-\x7E\n]/g, ' ').replace(/\s+/g, ' ').trim();
        const e = new Error('CLI timed out after ' + Math.round(timeoutMs / 1000) + 's' + (plain ? '. TUI tail: ' + plain.slice(-400) : stderrTail ? ': ' + stderrTail.trim().slice(-300) : ''));
        e.status = 504;
        finish(reject, e);
      }, timeoutMs);

      // Drive the TUI: the picker opens with the requested model preselected
      // (via settings.freebuffModel), one Enter confirms it. Keystrokes go in
      // separate batches with pauses (one big write races the editor).
      (async () => {
        await sleepFn(ENTER_DELAY_MS);
        send('\r');                                   // confirm model picker
        await sleepFn(SUBMIT_DELAY_MS);               // admission → editor ready
        send(prompt);
        await sleepFn(800);
        send('\r');                                   // submit
      })().catch((e) => {
        finish(reject, Object.assign(new Error('CLI automation failed: ' + (e && e.message)), { status: 502 }));
      });
    });
  } finally {
    if (signal && onAbort) {
      try { signal.removeEventListener('abort', onAbort); } catch {}
    }
    closeTui();
    picker.restore();
    setTimeout(() => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {} }, 1500);
  }
}

/** Serialized entry point. */
function runChat(opts) {
  return enqueue(() => runOnce(opts));
}

module.exports = { runChat, findCliBinary, pickerModel, CLI_MODELS, messageText, looksLikeAssistant };
