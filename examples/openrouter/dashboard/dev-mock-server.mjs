#!/usr/bin/env node
// A tiny local stand-in for OpenRouter's Anthropic-compatible endpoint.
//
// It exists for one purpose: prove that the Claude Code wiring (settings →
// model resolution → /v1/messages → streaming response → printed answer) works
// on a machine that cannot reach openrouter.ai. It always answers with a fixed
// text — it is NOT a model.
//
//   node examples/openrouter/dashboard/dev-mock-server.mjs          # :8787
//   CLAUDE_CONFIG_DIR=/tmp/demo claude -p "hi"                      # point Claude Code here
//
// Never use this for real work.

import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8787);
const HOST = process.env.MOCK_HOST || '127.0.0.1';
const REPLY = process.env.MOCK_REPLY || 'pong — this reply comes from a local stand-in server, not from a model.';

const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

function body(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (path === '/__log') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ served: requests }, null, 2));
    return;
  }

  if (path.startsWith('/v1/messages/count_tokens')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ input_tokens: 42 }));
    return;
  }

  if (path === '/v1/messages' && req.method === 'POST') {
    const payload = await body(req);
    requests.push({ at: new Date().toISOString(), model: payload.model, stream: Boolean(payload.stream), tools: (payload.tools || []).length, auth: req.headers.authorization ? 'present' : 'missing' });
    console.log(`▶ ${payload.model} (stream=${Boolean(payload.stream)}, tools=${(payload.tools || []).length}, auth=${req.headers.authorization ? 'yes' : 'no'})`);

    const id = `msg_mock_${Date.now()}`;
    const usage = { input_tokens: 42, output_tokens: 24, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

    if (!payload.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: payload.model, content: [{ type: 'text', text: REPLY }], stop_reason: 'end_turn', stop_sequence: null, usage }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    sse(res, 'message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: payload.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    for (const chunk of REPLY.match(/.{1,24}/gs) || []) {
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } });
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
    sse(res, 'message_stop', { type: 'message_stop' });
    res.end();
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `no mock route for ${req.method} ${path}` } }));
});

const requests = [];

server.listen(PORT, HOST, () => {
  console.log(`mock Anthropic endpoint on http://${HOST}:${PORT}  (fixed reply, not a model)`);
  console.log(`  use it with: ANTHROPIC_BASE_URL=http://${HOST}:${PORT} ANTHROPIC_AUTH_TOKEN=mock ANTHROPIC_API_KEY= claude -p "hi"`);
  console.log(`  request log: curl http://${HOST}:${PORT}/__log`);
});
