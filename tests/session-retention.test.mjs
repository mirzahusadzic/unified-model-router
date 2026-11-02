import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { after, mock, test } from 'node:test';

// Session records expire 30 days after their last request, also while the
// router keeps running: a clock moved forward after startup must see them gone.
const day = 24 * 60 * 60 * 1000;
let now = Date.parse('2026-01-01T00:00:00Z');
mock.method(Date, 'now', () => now);

const home = mkdtempSync(join(tmpdir(), 'session-retention-'));
writeFileSync(join(home, 'session-sides.json'), JSON.stringify({
  'idle-side': { side: 'openai', at: now },
  // A non-training Ultra Spark side survives startup however old it is.
  'idle-private': { side: 'private', at: now - 400 * day },
}));
writeFileSync(join(home, 'claude-routes.json'), JSON.stringify({ 'idle-route': { route: 'openrouter', at: now } }));
Object.assign(process.env, {
  CODEX_ROUTER_ENV_FILE: join(home, 'openrouter.env'),
  CODEX_ROUTER_TOKEN: 'a'.repeat(64),
  CODEX_ROUTER_LOG_LEVEL: 'error',
  OPENROUTER_API_KEY: 'test-openrouter-key',
  ANTHROPIC_API_KEY: 'test-anthropic-key',
});
delete process.env.CODEX_ROUTER_PROVIDER_ORDER;
delete process.env.CODEX_ROUTER_TRAINING_MODELS;

let handleRequest;
const forwarded = [];
mock.method(console, 'error', () => {});
mock.method(http, 'createServer', handler => {
  handleRequest = handler;
  return { on() {}, listen: (_port, _host, ready) => ready() };
});
mock.method(https, 'request', (options, onResponse) => {
  const chunks = [];
  return new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
    final(callback) {
      forwarded.push({ hostname: options.hostname, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      const response = Readable.from([JSON.stringify({ id: 'resp_test', output: [] })]);
      response.statusCode = 200;
      response.headers = { 'content-type': 'application/json' };
      queueMicrotask(() => onResponse(response));
      callback();
    },
  });
});
await import('../router/unified-router.mjs');
after(() => {
  mock.restoreAll();
  for (const name of readdirSync(home)) rmSync(join(home, name));
  rmdirSync(home);
});

async function post(model, sessionId) {
  const request = new PassThrough();
  Object.assign(request, {
    method: 'POST',
    url: '/v1/responses',
    headers: {
      host: '127.0.0.1:18766',
      'content-type': 'application/json',
      'x-codex-router-token': 'a'.repeat(64),
      'session-id': sessionId,
      'thread-id': sessionId,
    },
  });
  const response = new PassThrough();
  response.writeHead = status => { response.statusCode = status; };
  response.resume();
  const ended = once(response, 'end');
  handleRequest(request, response);
  request.end(JSON.stringify({ model, input: 'Hello', stream: true }));
  await ended;
  return response.statusCode;
}

test('a session side older than 30 days no longer refuses the other side', async () => {
  now += 31 * day;
  assert.equal(await post('openrouter/meta/muse-spark-1.3-contributor', 'idle-side'), 200);
});

test('a non-training Ultra Spark side never expires: its session keeps deny and refuses the training tier', async () => {
  now += 31 * day;
  assert.equal(await post('deepseek/deepseek-v4.1-flash-1017', 'idle-private'), 200);
  assert.equal(forwarded.at(-1).body.provider.data_collection, 'deny');
  const count = forwarded.length;
  assert.equal(await post('openrouter/meta/muse-spark-1.3-contributor', 'idle-private'), 409);
  assert.equal(forwarded.length, count);
  // Recording another session prunes expired records, but not this one.
  await post('openrouter/meta/muse-spark-1.3-contributor', 'fresh-training');
  const stored = JSON.parse(readFileSync(join(home, 'session-sides.json'), 'utf8'));
  assert.equal(stored['idle-private'].side, 'private');
  assert.equal(stored['fresh-training'].side, 'training');
});

test('a Claude route older than 30 days no longer pins the session to OpenRouter', async () => {
  now += 31 * day;
  await post('anthropic/claude-sonnet-5-5', 'idle-route');
  assert.equal(forwarded.at(-1).hostname, 'api.anthropic.com');
});
