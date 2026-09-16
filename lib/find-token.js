'use strict';
/**
 * Locate the local Freebuff Desktop / Codebuff auth token.
 *
 * Search order:
 *  1. CODEBUFF_API_KEY env var (explicit override)
 *  2. FREEBUFF_DESKTOP_STATE_PATH env var -> JSON file,
 *     authSessions["https://www.codebuff.com"].token
 *  3. ~/.config/freebuff-desktop/state.json  (Freebuff Desktop on all OSes;
 *     Electron stores its config here, and app updates do NOT touch it)
 *  4. ~/.codebuff/credentials.json           (Codebuff CLI, legacy "authToken")
 *
 * Re-run on every start: if the user re-logs-in, the fresh token is picked up
 * automatically. Nothing is ever written or sent anywhere except to
 * api.codebuff.com as a normal Authorization header.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CODEBUFF_AUTH_URL = 'https://www.codebuff.com';

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function extractDesktopToken(state) {
  if (!state || typeof state !== 'object') return null;
  const sessions = state.authSessions;
  if (sessions && typeof sessions === 'object') {
    const direct = sessions[CODEBUFF_AUTH_URL];
    if (direct && typeof direct.token === 'string' && direct.token.trim()) {
      return direct.token.trim();
    }
    // Fallback: first session entry that carries a token.
    for (const value of Object.values(sessions)) {
      if (value && typeof value.token === 'string' && value.token.trim()) {
        return value.token.trim();
      }
    }
  }
  // Legacy flat field.
  if (typeof state.authToken === 'string' && state.authToken.trim()) {
    return state.authToken.trim();
  }
  return null;
}

function extractDesktopUser(state) {
  try {
    const session = state && state.authSessions && state.authSessions[CODEBUFF_AUTH_URL];
    if (session && session.user && session.user.email) return session.user;
  } catch {}
  return null;
}

/**
 * @returns {{ token: string, source: string, user: object | null } | null}
 */
function findToken() {
  // 1. Explicit env override.
  const envKey = process.env.CODEBUFF_API_KEY;
  if (envKey && envKey.trim()) {
    return { token: envKey.trim(), source: 'CODEBUFF_API_KEY env var', user: null };
  }

  // 2. Custom state path.
  const customPath = process.env.FREEBUFF_DESKTOP_STATE_PATH;
  if (customPath && customPath.trim()) {
    const state = readJsonIfExists(customPath.trim());
    const token = extractDesktopToken(state);
    if (token) {
      return {
        token,
        source: customPath.trim(),
        user: extractDesktopUser(state),
      };
    }
  }

  // 3. Freebuff Desktop default location (same on Windows/macOS/Linux).
  const desktopState = path.join(os.homedir(), '.config', 'freebuff-desktop', 'state.json');
  const state = readJsonIfExists(desktopState);
  const token = extractDesktopToken(state);
  if (token) {
    return { token, source: desktopState, user: extractDesktopUser(state) };
  }

  // 4. Legacy Codebuff CLI credentials.
  const cliCreds = path.join(os.homedir(), '.codebuff', 'credentials.json');
  const creds = readJsonIfExists(cliCreds);
  if (creds && typeof creds.authToken === 'string' && creds.authToken.trim()) {
    return { token: creds.authToken.trim(), source: cliCreds, user: null };
  }

  return null;
}

function maskToken(token) {
  if (token.length <= 10) return '*'.repeat(token.length);
  return token.slice(0, 6) + '*'.repeat(Math.max(4, token.length - 10)) + token.slice(-4);
}

function printFound(found) {
  console.log('');
  console.log('  Token : ' + maskToken(found.token));
  console.log('  Source: ' + found.source);
  if (found.user && found.user.email) {
    console.log('  User  : ' + found.user.email + (found.user.name ? ' (' + found.user.name + ')' : ''));
  }
  console.log('');
}

module.exports = { findToken, maskToken, printFound };
