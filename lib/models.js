'use strict';
/**
 * Model catalog for the bridge.
 *
 * These are the models Freebuff Desktop currently exposes in its picker
 * (kept in one place so updating the bridge after an app update is a
 * one-file change). `freebucksPerHour` is the in-app session price —
 * shown for information only; the bridge bills via @codebuff/sdk credits.
 */

const DEFAULT_MODEL = 'z-ai/glm-5.3-flash';

const MODELS = [
  { id: 'z-ai/glm-5.3-flash',       displayName: 'GLM 5.3 Flash',            freebucksPerHour: 5,  recommended: true },
  { id: 'crof/kimi-k3-eco',         displayName: 'Kimi K3 Eco',              freebucksPerHour: 5  },
  { id: 'mimo/mimo-v2.5',           displayName: 'MiMo v2.5',                freebucksPerHour: 10 },
  { id: 'deepseek/deepseek-v4-flash', displayName: 'DeepSeek V4 Flash',      freebucksPerHour: 15 },
  { id: 'openai/gpt-5.6-luna',      displayName: 'GPT-5.6 Luna',             freebucksPerHour: 20 },
  { id: 'openai/gpt-5.6-luna-es',   displayName: 'GPT-5.6 Luna ES',          freebucksPerHour: 20 },
  { id: 'meta/muse-spark-1.3-contributor', displayName: 'Muse Spark 1.3',     freebucksPerHour: 15 },
  { id: 'minimax/minimax-m3',       displayName: 'MiniMax M3',               freebucksPerHour: 15 },
  { id: 'z-ai/glm-5.2',             displayName: 'GLM 5.2',                  freebucksPerHour: null },
  { id: 'deepseek/deepseek-v4-pro', displayName: 'DeepSeek V4 Pro',          freebucksPerHour: null },
  { id: 'google/gemini-3.8-flash',  displayName: 'Gemini 3.8 Flash',         freebucksPerHour: 50 },
  { id: 'google/gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro',      freebucksPerHour: null },
  { id: 'anthropic/claude-fable-5', displayName: 'Claude Fable 5',           freebucksPerHour: null },
];

function listModels() {
  return MODELS;
}

function isKnownModel(id) {
  return MODELS.some((m) => m.id === id);
}

function resolveModel(requested) {
  if (!requested || typeof requested !== 'string' || !requested.trim()) {
    return DEFAULT_MODEL;
  }
  const id = requested.trim();
  if (isKnownModel(id)) return id;
  // Tolerate common aliases: "gpt-5.6-luna" -> "openai/gpt-5.6-luna".
  const stripped = id.includes('/') ? id : MODELS.find((m) => m.id.endsWith('/' + id))?.id;
  return stripped || id;
}

function defaultModel() {
  return DEFAULT_MODEL;
}

module.exports = { MODELS, DEFAULT_MODEL, listModels, isKnownModel, resolveModel, defaultModel };
