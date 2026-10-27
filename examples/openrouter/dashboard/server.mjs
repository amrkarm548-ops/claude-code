#!/usr/bin/env node
// OpenRouter × Claude Code — status dashboard and playground.
//
// Zero dependencies. Reads the live Claude Code config, reports whether the
// OpenRouter credential actually works from this machine, lists the free model
// catalog, and can send a test message through the same endpoint Claude Code
// uses (https://openrouter.ai/api/v1/messages).
//
//   node examples/openrouter/dashboard/server.mjs
//   PORT=4173 HOST=0.0.0.0 node ...        # defaults
//
// The API key never reaches the browser: every request is proxied here, and
// the key is only ever reported masked.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const SNAPSHOT = path.join(HERE, 'free-models.snapshot.json');

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';

const CONF_DIR = process.env.XDG_CONFIG_HOME
  ? path.join(process.env.XDG_CONFIG_HOME, 'openrouter')
  : path.join(process.env.HOME || '.', '.config', 'openrouter');
const KEY_FILE = process.env.OPENROUTER_KEY_FILE || path.join(CONF_DIR, 'api_key');
const META_FILE = process.env.OPENROUTER_META_FILE || path.join(CONF_DIR, 'key_meta.json');
const SETTINGS_FILE = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '.', '.claude'), 'settings.json');

const OPENROUTER = 'https://openrouter.ai/api';

// ---------- config reading -------------------------------------------------
function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

function readJson(file) {
  const text = readText(file);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readSettings() {
  const cfg = readJson(SETTINGS_FILE) || {};
  return { path: SETTINGS_FILE, exists: fs.existsSync(SETTINGS_FILE), env: cfg.env || {} };
}

function readKey() {
  const fromEnv = process.env.ANTHROPIC_AUTH_TOKEN || process.env.OPENROUTER_API_KEY || '';
  if (fromEnv.startsWith('sk-or-')) return { key: fromEnv, source: 'environment' };
  const fromFile = readText(KEY_FILE);
  if (fromFile.startsWith('sk-or-')) return { key: fromFile, source: KEY_FILE };
  const settingsKey = readSettings().env.ANTHROPIC_AUTH_TOKEN;
  if (typeof settingsKey === 'string' && settingsKey.startsWith('sk-or-')) {
    return { key: settingsKey, source: SETTINGS_FILE };
  }
  return { key: '', source: null };
}

function mask(key) {
  if (!key) return null;
  if (key.length <= 16) return `${key.slice(0, 6)}…`;
  return `${key.slice(0, 12)}…${key.slice(-4)}`;
}

// Claude Code's own notation: a trailing [1m] declares a 1M context window and a
// leading ~ marks a gateway alias. Neither is part of the id OpenRouter takes.
const bareModel = (id) => String(id || '').replace(/\[1m\]$/i, '').replace(/^~/, '');

// ---------- outbound calls -------------------------------------------------
async function callOpenRouter(pathname, { method = 'GET', body, key, timeout = 25000 } = {}) {
  const started = Date.now();
  const headers = { 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/anthropics/claude-code', 'X-Title': 'Claude Code dashboard' };
  if (key) headers.Authorization = `Bearer ${key}`;
  try {
    const res = await fetch(OPENROUTER + pathname, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON error page */
    }
    return { ok: res.ok, status: res.status, json, text, ms: Date.now() - started };
  } catch (err) {
    const cause = err?.cause?.code || err?.cause?.message || err?.name || 'unknown';
    return {
      ok: false,
      status: 0,
      json: null,
      text: String(err?.message || err),
      ms: Date.now() - started,
      network: true,
      cause,
    };
  }
}

// ---------- free catalog (live, cached; snapshot as fallback) --------------
let catalog = { at: 0, models: null, source: null, error: null };
const CATALOG_TTL_MS = 5 * 60 * 1000;

function normalizeFree(payload) {
  return (payload?.data || [])
    .filter((m) => String(m.pricing?.prompt) === '0' && (m.architecture?.output_modalities || ['text']).includes('text'))
    .map((m) => {
      const params = m.supported_parameters || [];
      return {
        id: m.id,
        name: m.name,
        context: m.context_length,
        tools: params.includes('tools'),
        tool_choice: params.includes('tool_choice'),
        vision: (m.architecture?.input_modalities || []).some((x) => x === 'image' || x === 'video'),
        expires: m.expiration_date || null,
      };
    })
    .sort((a, b) => Number(b.tools) - Number(a.tools) || b.context - a.context);
}

async function getFreeModels({ force = false } = {}) {
  if (!force && catalog.models && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog;
  const { key } = readKey();
  const res = await callOpenRouter('/v1/models?max_price=0', { key, timeout: 12000 });
  if (res.ok && res.json?.data) {
    catalog = { at: Date.now(), models: normalizeFree(res.json), source: 'live', error: null };
    return catalog;
  }
  const snapshot = readJson(SNAPSHOT) || [];
  catalog = {
    at: Date.now(),
    models: snapshot,
    source: 'snapshot',
    error: res.network
      ? `no network egress to openrouter.ai (${res.cause})`
      : `HTTP ${res.status}: ${(res.json?.error?.message || res.text || '').slice(0, 200)}`,
  };
  return catalog;
}

// ---------- routes ---------------------------------------------------------
function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function apiStatus() {
  const settings = readSettings();
  const { key, source } = readKey();
  const meta = readJson(META_FILE) || {};
  const env = settings.env;
  const models = {
    opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL || null,
    sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL || null,
    haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || null,
    fable: env.ANTHROPIC_DEFAULT_FABLE_MODEL || null,
    subagent: env.CLAUDE_CODE_SUBAGENT_MODEL || null,
  };
  const all = Object.values(models).filter(Boolean).map(bareModel);
  const freeOnly = all.length > 0 && all.every((m) => /:free$|^openrouter\/free$/.test(m));

  const checks = [
    { id: 'base_url', label: 'ANTHROPIC_BASE_URL', value: env.ANTHROPIC_BASE_URL || null, ok: env.ANTHROPIC_BASE_URL === OPENROUTER },
    { id: 'auth_token', label: 'ANTHROPIC_AUTH_TOKEN', value: mask(env.ANTHROPIC_AUTH_TOKEN), ok: typeof env.ANTHROPIC_AUTH_TOKEN === 'string' && env.ANTHROPIC_AUTH_TOKEN.startsWith('sk-or-') },
    { id: 'api_key_empty', label: 'ANTHROPIC_API_KEY', value: env.ANTHROPIC_API_KEY === '' ? '"" (empty, as required)' : (env.ANTHROPIC_API_KEY ?? 'missing'), ok: env.ANTHROPIC_API_KEY === '' },
    { id: 'free_only', label: 'model classes', value: freeOnly ? 'all :free' : `${all.filter((m) => !/:free$|^openrouter\/free$/.test(m)).length} paid`, ok: freeOnly },
    { id: 'discovery', label: 'model discovery', value: env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY ?? 'unset', ok: freeOnly ? env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === '0' : env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === '1' },
    { id: 'background', label: 'nonessential traffic', value: env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === '1' ? 'disabled (saves free quota)' : 'enabled', ok: true },
  ];

  const now = Math.floor(Date.now() / 1000);
  const expiry = meta.expires_at
    ? { at: meta.expires_at, iso: new Date(meta.expires_at * 1000).toISOString(), left: meta.expires_at - now, expired: meta.expires_at <= now, mode: meta.mode || null }
    : null;

  return {
    baseUrl: env.ANTHROPIC_BASE_URL || null,
    key: { present: Boolean(key), masked: mask(key), source },
    settings: { path: settings.path, exists: settings.exists },
    models,
    freeOnly,
    checks,
    expiry,
    ready: checks.filter((c) => ['base_url', 'auth_token', 'api_key_empty'].includes(c.id)).every((c) => c.ok),
  };
}

async function apiTest({ model } = {}) {
  const { key } = readKey();
  if (!key) return { ok: false, stage: 'config', error: 'no OpenRouter key found (run setup.sh)' };
  const target = bareModel(model || readSettings().env.ANTHROPIC_DEFAULT_HAIKU_MODEL || 'nvidia/nemotron-3.5-lightning:free');

  const res = await callOpenRouter('/v1/messages', {
    method: 'POST',
    key,
    body: {
      model: target,
      max_tokens: 64,
      tools: [
        {
          name: 'get_weather',
          description: 'Get the weather for a city',
          input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      ],
      messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
    },
  });

  if (res.network) {
    return {
      ok: false,
      stage: 'network',
      model: target,
      ms: res.ms,
      error: `cannot reach openrouter.ai from this machine (${res.cause})`,
      detail: 'The sandbox that serves this preview has no egress to openrouter.ai. Run the dashboard on your own machine to test for real.',
    };
  }
  if (!res.ok) {
    const message = res.json?.error?.message || res.text.slice(0, 300);
    const fixed = {
      401: 'key rejected — rotate it at openrouter.ai/settings/keys',
      402: 'insufficient credits on the account',
      404: 'model id not available — check the free catalog',
      429: 'rate limited (20 req/min, 50 or 1000 req/day) — wait for Retry-After',
      502: 'upstream provider failed — retry or switch model',
      503: 'no provider currently serving this model',
    }[res.status];
    return { ok: false, stage: 'http', status: res.status, model: target, ms: res.ms, error: message, detail: String(message).slice(0, 400) };
  }

  const text = (res.json?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return {
    ok: true,
    stage: 'done',
    model: res.json?.model || target,
    ms: res.ms,
    text,
    usage: res.json?.usage || null,
    servedBy: res.json?.provider || null,
  };
}

async function apiChat({ model, message }) {
  const { key } = readKey();
  if (!key) return { ok: false, error: 'no OpenRouter key found (run setup.sh)' };
  if (!message || !message.trim()) return { ok: false, error: 'empty message' };
  const target = bareModel(model || readSettings().env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'thinkingmachines/inkling-small:free');
  const res = await callOpenRouter('/v1/messages', {
    method: 'POST',
    key,
    timeout: 60000,
    body: { model: target, max_tokens: 512, messages: [{ role: 'user', content: message.slice(0, 4000) }] },
  });
  if (res.network) return { ok: false, model: target, error: `cannot reach openrouter.ai (${res.cause})`, detail: 'no egress from this sandbox' };
  if (!res.ok) return { ok: false, model: target, status: res.status, error: res.json?.error?.message || res.text.slice(0, 300) };
  const text = (res.json?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return { ok: true, model: res.json?.model || target, text, usage: res.json?.usage || null, ms: res.ms };
}

// Cheap reachability probe: lists models (no inference, does not consume the
// free requests/day allowance).
async function apiReach() {
  const { key } = readKey();
  const res = await callOpenRouter('/v1/models', { key, timeout: 8000 });
  return {
    ok: res.ok && Boolean(res.json?.data),
    status: res.status,
    ms: res.ms,
    network: Boolean(res.network),
    error: res.network ? `no egress to openrouter.ai (${res.cause})` : res.ok ? null : `HTTP ${res.status}`,
  };
}

async function apiCredits() {
  const { key } = readKey();
  if (!key) return { ok: false, error: 'no key' };
  const res = await callOpenRouter('/v1/credits', { key, timeout: 12000 });
  if (res.network) return { ok: false, network: true, error: `cannot reach openrouter.ai (${res.cause})` };
  if (!res.ok) return { ok: false, status: res.status, error: res.json?.error?.message || res.text.slice(0, 200) };
  const d = res.json?.data || {};
  return { ok: true, total: d.total_credits, used: d.total_usage, left: (d.total_credits || 0) - (d.total_usage || 0) };
}

// ---------- static files ---------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

// ---------- server ---------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname;

  try {
    if (route === '/api/status' && req.method === 'GET') return json(res, 200, await apiStatus());

    if (route === '/api/free-models' && req.method === 'GET') {
      const data = await getFreeModels({ force: url.searchParams.get('refresh') === '1' });
      return json(res, 200, { source: data.source, fetchedAt: data.at, error: data.error, models: data.models });
    }

    if (route === '/api/reach' && req.method === 'GET') return json(res, 200, await apiReach());

    if (route === '/api/credits' && req.method === 'GET') return json(res, 200, await apiCredits());

    if (route === '/api/test' && req.method === 'POST') return json(res, 200, await apiTest(await readBody(req)));

    if (route === '/api/chat' && req.method === 'POST') return json(res, 200, await apiChat(await readBody(req)));

    if (route === '/api/health') return json(res, 200, { ok: true, uptime: process.uptime() });

    if (route.startsWith('/api/')) return json(res, 404, { error: 'unknown endpoint' });

    return serveStatic(res, route);
  } catch (err) {
    return json(res, 500, { error: String(err?.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  const { key } = readKey();
  console.log(`OpenRouter dashboard on http://${HOST}:${PORT}`);
  console.log(`  settings : ${SETTINGS_FILE} ${fs.existsSync(SETTINGS_FILE) ? '' : '(missing)'}`);
  console.log(`  key      : ${key ? mask(key) : 'none found'}`);
});
