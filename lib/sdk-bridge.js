'use strict';
/**
 * SDK bridge: turns an OpenAI chat request into a @codebuff/sdk run with a
 * minimal inline chat agent pinned to the requested model.
 *
 * The SDK is the supported, documented way to talk to Codebuff/Freebuff
 * programmatically. We deliberately do NOT forge CLI headers or replicate the
 * desktop client's free-mode admission protocol: the backend explicitly
 * rejects that ("free_mode_cli_required") and warns about account bans.
 * Through the SDK each request runs as the user's own account and bills
 * against its credits; without credits the backend answers 402 and we pass a
 * clear, honest error back to the caller.
 */

const { CodebuffClient } = require('@codebuff/sdk');

/** Extract text from a stream chunk: the SDK passes a plain string, or an
 *  object like { type: 'reasoning_chunk'|'subagent_chunk', chunk: string }. */
function chunkText(chunk) {
  if (typeof chunk === 'string') return chunk;
  if (chunk && typeof chunk.chunk === 'string' && chunk.type !== 'reasoning_chunk') {
    return chunk.chunk;
  }
  return '';
}

function normalizeErrorStatus(err) {
  const status = err && (err.statusCode || err.status);
  if (typeof status === 'number' && status >= 400) return status;
  const msg = String((err && err.message) || '');
  const m = msg.match(/\b(40[0-9]|429|5\d\d)\b/);
  return m ? Number(m[1]) : 502;
}

function friendlyHint(status) {
  switch (status) {
    case 401:
      return 'Your token was rejected. Re-login in Freebuff Desktop (or set CODEBUFF_API_KEY) and restart the bridge.';
    case 402:
      return 'Model calls through this bridge bill against your Codebuff/Freebuff credits. Top up at https://www.codebuff.com — or use the model inside the official Freebuff app, where free mode applies.';
    case 403:
      return 'The backend refused this call. Free-mode inference is restricted to official clients; through the SDK your account needs credits.';
    case 404:
      return 'Unknown model id. Call GET /v1/models to see the list this bridge knows.';
    case 429:
      return 'Rate limited by the backend. Wait a bit and retry.';
    default:
      return 'Upstream error. See message for details.';
  }
}

function messagesToPrompt(messages) {
  // The inline agent is a plain chat agent: concatenate the conversation in
  // order. System prompt goes into the agent definition; user/assistant
  // history is flattened so multi-turn context survives.
  if (!Array.isArray(messages)) return '';
  return messages
    .filter((m) => m && typeof m.content === 'string' && m.role !== 'system')
    .map((m) => (m.role === 'assistant' ? 'Assistant said: ' : '') + m.content)
    .join('\n\n')
    .trim();
}

function systemFromMessages(messages) {
  if (!Array.isArray(messages)) return '';
  return messages
    .filter((m) => m && m.role === 'system' && typeof m.content === 'string')
    .map((m) => m.content)
    .join('\n')
    .trim();
}

/**
 * @param {object} opts
 * @param {string} opts.token            auth token
 * @param {string} opts.model            resolved model id (e.g. z-ai/glm-5.3-flash)
 * @param {Array}  opts.messages         OpenAI-style messages
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.temperature]
 * @param {(chunk: string) => void} [opts.onDelta]   streaming text deltas
 * @param {object} [opts.deps]           dependency injection for tests
 * @param {Function} [opts.deps.Client]  CodebuffClient constructor
 * @returns {Promise<{ text: string, model: string, usage: object | null }>}
 */
async function runChat(opts) {
  const { token, model, messages, onDelta } = opts;
  const deps = opts.deps || {};
  const Client = deps.Client || CodebuffClient;

  const system = systemFromMessages(messages);
  const prompt = messagesToPrompt(messages);
  if (!prompt) {
    const err = new Error('No usable prompt: messages must contain at least one non-system message with string content.');
    err.status = 400;
    throw err;
  }

  const client = new Client({ apiKey: token });

  // Minimal inline agent definition pinned to the requested model
  // (validated against the SDK's own validator). System prompt from OpenAI
  // messages maps onto instructionsPrompt; the run-level prompt carries the
  // conversation.
  const agent = {
    id: 'freebuff-api-bridge',
    displayName: 'Freebuff API Bridge',
    model,
    outputMode: 'last_message',
    ...(system ? { instructionsPrompt: system } : {}),
  };

  const acc = { text: '', sawDelta: false };
  let result;
  try {
    result = await client.run({
      agent,
      prompt,
      ...(opts.signal ? { signal: opts.signal } : {}),
      handleStreamChunk: (chunk) => {
        const t = chunkText(chunk);
        if (t) {
          acc.sawDelta = true;
          acc.text += t;
          if (onDelta) {
            try { onDelta(t); } catch { /* listener error must not kill the stream */ }
          }
        }
      },
    });
  } catch (err) {
    const status = normalizeErrorStatus(err);
    const wrapped = new Error(
      (err && err.message) || 'SDK request failed'
    );
    wrapped.status = status;
    wrapped.hint = friendlyHint(status);
    wrapped.upstream = status;
    throw wrapped;
  }

  // RunState.output is a discriminated union per SDK types:
  //   { type: 'lastMessage', value: parts[] }
  // | { type: 'structuredOutput', value } 
  // | { type: 'error', message, statusCode? }
  let text = '';
  const output = result && result.output;
  if (output && output.type === 'error') {
    const status = output.statusCode || normalizeErrorStatus({ message: output.message });
    const wrapped = new Error(output.message || 'Upstream model error');
    wrapped.status = status;
    wrapped.hint = friendlyHint(status);
    throw wrapped;
  }
  const parts =
    output && output.type === 'lastMessage' && Array.isArray(output.value)
      ? output.value
      : Array.isArray(output) ? output : [];
  text = parts
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');

  if (acc.sawDelta && text && text !== acc.text && !text.startsWith(acc.text)) {
    // Stream deltas were authoritative but final text diverged; prefer the
    // longer of the two so no tail is lost.
    text = text.length >= acc.text.length ? text : acc.text;
  } else if (acc.sawDelta && !text) {
    text = acc.text;
  }

  return { text, model, usage: null };
}

/** Lazily created per-token client cache (kept tiny; CLI owns the lifecycle). */
const clients = new Map();
function getClient(token) {
  if (!clients.has(token)) {
    clients.set(token, new CodebuffClient({ apiKey: token }));
  }
  return clients.get(token);
}

module.exports = { runChat, getClient, friendlyHint, normalizeErrorStatus, messagesToPrompt, systemFromMessages, chunkText };
