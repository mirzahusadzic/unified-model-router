import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { after, mock, test } from 'node:test';

// Exercise the router's request handler without network access or real credentials.
// Captures go into the env file's directory, the only location Windows allows.
const routerHome = mkdtempSync(join(tmpdir(), 'codex-router-home-'));
const rejectedRequestDir = routerHome;
process.env.CODEX_ROUTER_ENV_FILE = join(routerHome, 'openrouter.env');
// Isolation records from an earlier run: one inside the retention window, one past it.
const dayMs = 24 * 60 * 60 * 1000;
writeFileSync(join(routerHome, 'session-sides.json'), JSON.stringify({
  'isolation-stale': { side: 'openai', at: Date.now() - 25 * dayMs },
  'isolation-expired': { side: 'openai', at: Date.now() - 31 * dayMs },
}));
process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
process.env.CODEX_ROUTER_REJECTED_REQUEST_DIR = rejectedRequestDir;
process.env.CODEX_ROUTER_TOKEN = 'a'.repeat(64);
process.env.CODEX_ROUTER_PORT = '18766';
process.env.CODEX_ROUTER_LOG_LEVEL = 'info';
process.env.CODEX_ROUTER_TRAINING_MODELS = 'vendor/trains';
process.env.CODEX_ROUTER_PROVIDER_ORDER = 'vendor/pinned = google-vertex/us, google-ai-studio; vendor/other=other-endpoint';
const clientHeaders = {
  host: '127.0.0.1:18766',
  'content-type': 'application/json',
  'x-codex-router-token': process.env.CODEX_ROUTER_TOKEN,
  authorization: 'Bearer test-codex-token',
  'chatgpt-account-id': 'test-account',
};
let handleRequest;
const forwarded = [];
const logEntries = [];
mock.method(console, 'log', line => logEntries.push(String(line)));
mock.method(console, 'error', line => logEntries.push(String(line)));
mock.method(http, 'createServer', handler => {
  handleRequest = handler;
  return { on() {}, listen: (_port, _host, ready) => ready() };
});
mock.method(https, 'request', (options, onResponse) => {
  const chunks = [];
  return new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
    final(callback) {
      const rawBody = Buffer.concat(chunks);
      const body = JSON.parse(rawBody.toString('utf8'));
      forwarded.push({ ...options, body, byteLength: rawBody.length });
      // Reproduce the Codex backend's rejection of plaintext reasoning input.
      const invalidIndex = options.hostname === 'chatgpt.com' && Array.isArray(body.input)
        ? body.input.findIndex(item => item?.type === 'reasoning' && item.content?.length > 0)
        : -1;
      const payload = invalidIndex >= 0
        ? { error: { code: 'array_above_max_length', param: `input[${invalidIndex}].content` } }
        : { id: 'resp_test', output: [] };
      const response = Readable.from([JSON.stringify(payload)]);
      response.statusCode = invalidIndex >= 0 ? 400 : 200;
      response.headers = {
        'content-type': 'application/json',
        'x-generation-id': 'gen_test',
        'x-provider-name': 'TestProvider',
        'x-request-id': 'req_test',
        'cf-ray': 'cf_test',
      };
      queueMicrotask(() => onResponse(response));
      callback();
    },
  });
});
const { captureDirectoryAllowed } = await import('../router/unified-router.mjs');
after(() => {
  mock.restoreAll();
  rmSync(routerHome, { recursive: true, force: true });
});

async function exchangeRaw(rawBody, headers = {}, { method = 'POST', url = '/v1/responses' } = {}) {
  const request = new PassThrough();
  Object.assign(request, {
    method,
    url,
    headers: {
      ...clientHeaders,
      'content-length': '1',
      ...headers,
    },
  });
  const response = new PassThrough();
  response.headersSent = false;
  response.responseHeaders = {};
  response.writeHead = (status, responseHeaders = {}) => {
    response.statusCode = status;
    response.responseHeaders = responseHeaders;
    response.headersSent = true;
  };
  const chunks = [];
  response.on('data', chunk => chunks.push(chunk));
  const done = once(response, 'end');
  handleRequest(request, response);
  request.end(rawBody);
  await done;
  return {
    status: response.statusCode,
    headers: response.responseHeaders,
    rawBody: Buffer.concat(chunks).toString('utf8'),
  };
}

async function exchange(rawBody, headers = {}, options) {
  const result = await exchangeRaw(rawBody, headers, options);
  return { ...result, body: JSON.parse(result.rawBody) };
}

async function send(body, headers) {
  const result = await exchange(JSON.stringify(body), headers);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const upstream = forwarded.at(-1);
  assert.equal(Number(upstream.headers['content-length']), upstream.byteLength);
  return upstream;
}

function parsedLogEntries() {
  return logEntries.flatMap(line => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

function parseSse(rawBody) {
  return rawBody.split(/\r?\n/)
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice('data: '.length)));
}

function mockUpstreamSequence(t, responses) {
  let index = 0;
  t.mock.method(https, 'request', (options, onResponse) => {
    const chunks = [];
    return new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
      final(callback) {
        const rawBody = Buffer.concat(chunks);
        // A lookup such as the served-by report's GET sends no body.
        const body = rawBody.length > 0 ? JSON.parse(rawBody.toString('utf8')) : null;
        forwarded.push({ ...options, body, byteLength: rawBody.length });
        const spec = responses[index];
        index += 1;
        if (!spec) {
          callback(new Error(`Unexpected upstream request ${index}`));
          return;
        }
        const response = Readable.from(spec.chunks ?? [spec.body]);
        response.statusCode = spec.status;
        response.headers = {
          'content-type': spec.contentType || 'application/json',
          'x-generation-id': spec.generationId || `gen_reject_${index}`,
          'x-provider-name': '',
          'x-request-id': `req_${index}`,
          'cf-ray': `cf_${index}`,
          ...spec.headers,
        };
        queueMicrotask(() => onResponse(response));
        callback();
      },
    });
  });
}

const nativeReasoning = {
  type: 'reasoning',
  id: 'rs_native',
  summary: [{ type: 'summary_text', text: 'A native reasoning summary.' }],
  encrypted_content: 'test-native-ciphertext',
};
const deepseekReasoning = {
  type: 'reasoning',
  id: 'rs_tmp_example',
  summary: [],
  content: [{ type: 'reasoning_text', text: 'Synthetic provider reasoning.' }],
  encrypted_content: null,
};
const mixedHistory = [
  { role: 'user', content: 'howdy' },
  nativeReasoning,
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Howdy!' }] },
  { role: 'user', content: 'all good?' },
  deepseekReasoning,
  { type: 'message', id: 'msg_tmp_example', role: 'assistant', content: [{ type: 'output_text', text: 'All good.' }] },
  { role: 'user', content: 'not bad ha? this project?' },
];
const recoveryHistory = [
  {
    type: 'message',
    id: 'msg_current_developer',
    role: 'developer',
    content: [{ type: 'input_text', text: 'Current development instructions.' }],
  },
  ...Array.from({ length: 100 }, (_, index) => ({
    type: 'message',
    id: `msg_old_${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: [{ type: index % 2 === 0 ? 'input_text' : 'output_text', text: `Old turn ${index}` }],
  })),
  {
    type: 'message',
    id: 'msg_current_user',
    role: 'user',
    content: [{ type: 'input_text', text: 'Continue the current task.' }],
  },
  {
    type: 'function_call',
    id: 'fc_current',
    call_id: 'call_current',
    name: 'exec_command',
    arguments: '{"cmd":"printf current"}',
  },
  {
    type: 'function_call_output',
    id: 'fco_current',
    call_id: 'call_current',
    output: 'current',
  },
];

test('OpenAI can continue mixed history after a DeepSeek turn', async () => {
  const upstream = await send({ model: 'gpt-6-astra', input: mixedHistory, reasoning: { effort: 'max' } });
  assert.equal(upstream.hostname, 'chatgpt.com');
  assert.equal(upstream.path, '/backend-api/codex/responses');
  assert.deepEqual(upstream.body.input, mixedHistory.filter(item => item !== deepseekReasoning));
  assert.deepEqual(upstream.body.reasoning, { effort: 'max' });
  assert.equal(upstream.headers.authorization, 'Bearer test-codex-token');
  assert.equal(upstream.headers['chatgpt-account-id'], 'test-account');
});

test('DeepSeek structured output stays on DeepSeek as JSON mode with the schema appended last', async () => {
  const schema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
  const format = { type: 'json_schema', name: 'observation', strict: true, schema };
  for (const model of ['deepseek/deepseek-v4.1-flash-1017', 'openrouter/deepseek/deepseek-v4.1-flash-1017',
    'ultra-spark/deepseek-v4.1-flash-1017']) {
    for (const headers of [{}, { 'x-codex-routing-policy': 'preserve-model-v1' }]) {
      const upstream = await send({ model, input: mixedHistory, text: { format, verbosity: 'low' } }, headers);
      assert.equal(upstream.hostname, 'openrouter.ai');
      assert.equal(upstream.body.model, 'deepseek/deepseek-v4.1-flash-1017');
      assert.deepEqual(upstream.body.text, { format: { type: 'json_object' }, verbosity: 'low' });
      // The original history is an unchanged prefix, so cached tokens still apply.
      assert.deepEqual(upstream.body.input.slice(0, mixedHistory.length), mixedHistory);
      const instruction = upstream.body.input.at(-1);
      assert.equal(instruction.role, 'developer');
      // The format's name is no key to wrap the answer in: told of "a JSON object
      // named observation", DeepSeek wrapped 18 of 60 answers in that key.
      assert.doesNotMatch(instruction.content[0].text, /named|observation/);
      assert.match(instruction.content[0].text, /at the top level, not wrapped/);
      assert.ok(instruction.content[0].text.includes(JSON.stringify(schema)));
      const forwardedLog = parsedLogEntries().filter(entry => entry.event === 'request.forwarded').at(-1);
      assert.equal(forwardedLog.structuredOutputAdapted, true);
    }
  }
  const stringInput = await send({ model: 'deepseek/deepseek-v4.1-flash-1017', input: 'Paris?', text: { format } });
  assert.deepEqual(stringInput.body.input[0], { role: 'user', content: 'Paris?' });
});

test('structured output on other OpenRouter models and DeepSeek JSON mode pass through unchanged', async () => {
  const schemaFormat = { type: 'json_schema', name: 'result', schema: { type: 'object' } };
  for (const [model, format] of [
    ['openrouter/vendor/model', schemaFormat],
    ['openrouter/meta/muse-spark-1.3-contributor', schemaFormat],
    ['deepseek/deepseek-v4.1-flash-1017', { type: 'json_object' }],
  ]) {
    for (const headers of [{}, { 'x-codex-routing-policy': 'preserve-model-v1' }]) {
      const upstream = await send({ model, input: 'Synthetic request', text: { format } }, headers);
      assert.equal(upstream.hostname, 'openrouter.ai');
      assert.equal(upstream.body.model, model.replace(/^openrouter\//, ''));
      assert.deepEqual(upstream.body.text.format, format);
      assert.equal(upstream.body.input, 'Synthetic request');
    }
  }
});

test('preserve-model text requests keep OpenRouter model selection without requiring OpenAI login', async () => {
  for (const model of ['deepseek/deepseek-v4.1-flash-1017', 'openrouter/vendor/model']) {
    const upstream = await send({ model, input: 'Synthetic request', text: { format: { type: 'text' } } }, {
      'x-codex-routing-policy': 'preserve-model-v1', authorization: undefined,
    });
    assert.equal(upstream.body.model, model.replace(/^openrouter\//, ''));
    assert.equal(upstream.hostname, 'openrouter.ai');
    assert.equal(upstream.headers['x-codex-routing-policy'], undefined);
    assert.equal(upstream.headers['chatgpt-account-id'], undefined);
  }
});

test('preserve-model policy leaves native structured output on the requested native model', async () => {
  const format = { type: 'json_schema', name: 'result', schema: { type: 'object' } };
  const upstream = await send({ model: 'gpt-6-astra', input: 'Synthetic request', text: { format } },
    { 'x-codex-routing-policy': 'preserve-model-v1' });
  assert.equal(upstream.hostname, 'chatgpt.com');
  assert.equal(upstream.body.model, 'gpt-6-astra');
  assert.deepEqual(upstream.body.text.format, format);
  assert.equal(upstream.headers['x-codex-routing-policy'], undefined);
});

test('routing capabilities and implementation revision are discoverable; unknown policies fail closed', async () => {
  const health = await exchange('', {}, { method: 'GET', url: '/health' });
  assert.deepEqual(health.body.capabilities.routingPolicies, ['preserve-model-v1']);
  assert.equal(health.body.capabilities.openrouterRejectionRecovery, 'completed-diagnostic-v1');
  assert.equal(health.body.capabilities.providerIsolation, 'session-v3');
  assert.match(health.body.revision, /^[a-f0-9]{64}$/);
  assert.equal(health.body.capabilities.revisionPrecondition, true);
  // The verifier matches it against the service's own process.
  assert.equal(health.body.pid, process.pid);
  const count = forwarded.length;
  const result = await exchange(JSON.stringify({ model: 'deepseek/example' }),
    { 'x-codex-routing-policy': 'typo' });
  assert.equal(result.status, 400);
  assert.equal(forwarded.length, count);
});

test('revision preconditions reject stale or malformed revisions before either upstream', async () => {
  const health = await exchange('', {}, { method: 'GET', url: '/health' });
  for (const model of ['gpt-6-astra', 'deepseek/example', 'openrouter/vendor/model']) {
    const count = forwarded.length;
    for (const [revision, status, code] of [
      ['0'.repeat(64), 409, 'router_revision_mismatch'],
      ['invalid', 400, 'invalid_router_revision'],
      ['', 400, 'invalid_router_revision'],
      [['a'.repeat(64), 'b'.repeat(64)], 400, 'invalid_router_revision'],
    ]) {
      const result = await exchange(JSON.stringify({ model }), { 'x-codex-router-revision': revision });
      assert.equal(result.status, status);
      assert.equal(result.body.error.code, code);
      assert.equal(forwarded.length, count);
    }
    const upstream = await send({ model, input: 'Synthetic revision check' }, {
      'x-codex-router-revision': health.body.revision, 'x-codex-routing-policy': 'preserve-model-v1',
    });
    assert.equal(forwarded.length, count + 1);
    assert.equal(upstream.headers['x-codex-router-revision'], undefined);
    assert.equal(upstream.body.model, model.replace(/^openrouter\//, ''));
  }
  assert.equal((await exchange('{}', {
    'x-codex-router-token': undefined, 'x-codex-router-revision': 'invalid',
  })).status, 401);
});

test('native reasoning, messages, tool calls, and tool results survive unchanged', async () => {
  const input = [
    nativeReasoning,
    { ...nativeReasoning, id: 'rs_empty', content: [] },
    { type: 'reasoning', id: 'rs_reference', summary: [] },
    { type: 'reasoning', id: 'rs_summary', summary: [{ type: 'summary_text', text: 'Summary only.' }] },
    { type: 'function_call', call_id: 'call_test', name: 'lookup', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_test', output: 'found' },
    { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Found it.' }] },
    { role: 'user', content: [{ type: 'input_text', text: 'Continue.' }] },
  ];
  const upstream = await send({ model: 'gpt-6-astra', input });
  assert.deepEqual(upstream.body.input, input);
});

test('reasoning with encrypted content retains it while omitting plaintext content', async () => {
  const input = [{ ...nativeReasoning, content: deepseekReasoning.content }];
  const upstream = await send({ model: 'gpt-6-astra', input });
  assert.deepEqual(upstream.body.input, [nativeReasoning]);
});

test('DeepSeek and other OpenRouter routes retain their reasoning history', async () => {
  for (const model of ['deepseek/deepseek-v4.1-flash-1017', 'openrouter/vendor/model']) {
    const upstream = await send({ model, input: mixedHistory, reasoning: { effort: 'xhigh' } });
    assert.equal(upstream.hostname, 'openrouter.ai');
    assert.equal(upstream.path, '/api/v1/responses');
    assert.equal(upstream.body.model, model.replace(/^openrouter\//, ''));
    assert.deepEqual(upstream.body.input, mixedHistory);
    assert.deepEqual(upstream.body.reasoning, { effort: model.startsWith('deepseek/') ? 'max' : 'xhigh' });
    assert.equal(upstream.headers.authorization, 'Bearer test-openrouter-key');
    assert.equal(upstream.headers['chatgpt-account-id'], undefined);
  }
});

test('only DeepSeek reasoning efforts are remapped; other OpenRouter models keep standard efforts', async () => {
  for (const [requested, deepseek] of [
    ['minimal', 'low'], ['low', 'low'], ['medium', 'high'], ['high', 'high'], ['xhigh', 'max'], ['max', 'max'],
    ['none', 'none'],
  ]) {
    for (const model of ['deepseek/deepseek-v4.1-flash-1017', 'openrouter/deepseek/deepseek-v4.1-flash-1017',
    'ultra-spark/deepseek-v4.1-flash-1017']) {
      const upstream = await send({ model, input: 'Hello', reasoning: { effort: requested } });
      assert.deepEqual(upstream.body.reasoning, { effort: deepseek });
    }
    const muse = await send({ model: 'openrouter/meta/muse-spark-1.3-contributor', input: 'Hello', reasoning: { effort: requested } });
    assert.equal(muse.body.model, 'meta/muse-spark-1.3-contributor');
    assert.deepEqual(muse.body.reasoning, { effort: requested });
  }
});

test('Claude requests through OpenRouter get automatic prompt caching; other models do not', async () => {
  for (const model of ['openrouter/anthropic/claude-sonnet-5.5', 'openrouter/anthropic/claude-opus-5.5']) {
    const logsBefore = parsedLogEntries().length;
    const upstream = await send({ model, input: 'Hello', reasoning: { effort: 'xhigh', summary: 'auto' } });
    assert.equal(upstream.hostname, 'openrouter.ai');
    assert.equal(upstream.body.model, model.slice('openrouter/'.length));
    assert.deepEqual(upstream.body.cache_control, { type: 'ephemeral' });
    assert.deepEqual(upstream.body.reasoning, { effort: 'xhigh', summary: 'auto' });
    const forwardedLog = parsedLogEntries().slice(logsBefore).find(entry => entry.event === 'request.forwarded');
    assert.equal(forwardedLog.promptCachingAdded, true);
  }
  // A caller's own cache setting is kept as sent.
  const explicit = await send({ model: 'openrouter/anthropic/claude-sonnet-5.5', input: 'Hello',
    cache_control: { type: 'ephemeral', ttl: '1h' } });
  assert.deepEqual(explicit.body.cache_control, { type: 'ephemeral', ttl: '1h' });
  for (const model of ['deepseek/deepseek-v4.1-flash-1017', 'openrouter/meta/muse-spark-1.3-contributor']) {
    const upstream = await send({ model, input: 'Hello' });
    assert.equal(upstream.body.cache_control, undefined, model);
  }
});

test('configured OpenRouter endpoint preferences apply only to their model', async () => {
  const logsBefore = parsedLogEntries().length;
  const pinned = await send({ model: 'openrouter/vendor/pinned', input: 'Hello' });
  assert.deepEqual(pinned.body.provider, { order: ['google-vertex/us', 'google-ai-studio'] });
  const forwardedLog = parsedLogEntries().slice(logsBefore).find(entry => entry.event === 'request.forwarded');
  assert.deepEqual(forwardedLog.providerOrder, ['google-vertex/us', 'google-ai-studio']);

  const unpinned = await send({ model: 'openrouter/vendor/model', input: 'Hello' });
  assert.equal(unpinned.body.provider, undefined);
  const explicit = await send({ model: 'openrouter/vendor/pinned', input: 'Hello', provider: { only: ['custom'] } });
  assert.deepEqual(explicit.body.provider, { only: ['custom'] });
  const native = await send({ model: 'vendor/pinned', input: 'Hello' });
  assert.equal(native.hostname, 'chatgpt.com');
  assert.equal(native.body.provider, undefined);
});

test('native OpenAI and training-tier models never share a session, including its spawned agents', async () => {
  const inSession = id => ({ 'session-id': id });
  const refused = async (model, id) => {
    const count = forwarded.length;
    const result = await exchange(JSON.stringify({ model, input: 'Hello' }), inSession(id));
    assert.equal(result.status, 409, model);
    assert.equal(result.body.error.code, 'provider_isolation');
    assert.equal(forwarded.length, count);
  };
  await send({ model: 'gpt-6-astra', input: 'Hello' }, inSession('isolation-openai'));
  for (const model of ['openrouter/meta/muse-spark-1.3-contributor', 'ultra-spark/deepseek-v4.1-flash-1017',
    'openrouter/vendor/trains']) {
    await refused(model, 'isolation-openai');
  }
  await send({ model: 'deepseek/deepseek-v4.1-flash-1017', input: 'Hello' }, inSession('isolation-openai'));

  // Ultra Spark and its Muse workers share one session and one side.
  await send({ model: 'ultra-spark/deepseek-v4.1-flash-1017', input: 'Hello' }, inSession('isolation-training'));
  await send({ model: 'openrouter/meta/muse-spark-1.3-contributor', input: 'Hello' }, inSession('isolation-training'));
  await refused('gpt-6-astra', 'isolation-training');

  // Earlier Codex versions sent session_id; it identifies the same session.
  await refused('gpt-6-astra', 'isolation-training');
  const legacy = await exchange(JSON.stringify({ model: 'gpt-6-astra', input: 'Hello' }), { session_id: 'isolation-training' });
  assert.equal(legacy.status, 409);

  // Without a session ID there is nothing to isolate.
  await send({ model: 'gpt-6-astra', input: 'Hello' });
  await send({ model: 'openrouter/meta/muse-spark-1.3-contributor', input: 'Hello' });

  const sidesFile = join(routerHome, 'session-sides.json');
  const sides = JSON.parse(readFileSync(sidesFile, 'utf8'));
  assert.equal(sides['isolation-openai'].side, 'openai');
  assert.equal(sides['isolation-training'].side, 'training');
  assert.doesNotMatch(readFileSync(sidesFile, 'utf8'), /Hello/);
  if (process.platform !== 'win32') assert.equal(statSync(sidesFile).mode & 0o777, 0o600);
});

test('Claude and training-tier models never share a session; Claude may share one with OpenAI and DeepSeek', async () => {
  const inSession = id => ({ 'session-id': id });
  const claude = 'openrouter/anthropic/claude-sonnet-5.5';
  const refused = async (model, id, message) => {
    const count = forwarded.length;
    const result = await exchange(JSON.stringify({ model, input: 'Hello' }), inSession(id));
    assert.equal(result.status, 409, model);
    assert.equal(result.body.error.code, 'provider_isolation');
    assert.match(result.body.error.message, message);
    assert.equal(forwarded.length, count);
  };
  await send({ model: claude, input: 'Hello' }, inSession('isolation-claude'));
  for (const model of ['openrouter/meta/muse-spark-1.3-contributor', 'ultra-spark/deepseek-v4.1-flash-1017',
    'openrouter/vendor/trains']) {
    await refused(model, 'isolation-claude', /already used a Claude model/);
  }
  await send({ model: 'deepseek/deepseek-v4.1-flash-1017', input: 'Hello' }, inSession('isolation-claude'));
  // Muse Spark 1.3 outside the contributor tier is not a training-tier model.
  const museStandard = await send({ model: 'openrouter/meta/muse-spark-1.3', input: 'Hello' }, inSession('isolation-claude'));
  assert.equal(museStandard.body.model, 'meta/muse-spark-1.3');
  assert.equal(museStandard.body.provider.data_collection, 'deny');
  await send({ model: 'gpt-6-astra', input: 'Hello' }, inSession('isolation-claude'));
  await send({ model: 'openrouter/anthropic/claude-opus-5.5', input: 'Hello' }, inSession('isolation-claude'));

  await send({ model: 'openrouter/meta/muse-spark-1.3-contributor', input: 'Hello' }, inSession('isolation-muse'));
  await refused(claude, 'isolation-muse', /Start a new thread to use a Claude model/);

  // A session that began on OpenAI may add Claude and still refuses Muse.
  await send({ model: 'gpt-6-astra', input: 'Hello' }, inSession('isolation-openai-claude'));
  await send({ model: claude, input: 'Hello' }, inSession('isolation-openai-claude'));
  await refused('openrouter/meta/muse-spark-1.3-contributor', 'isolation-openai-claude', /native OpenAI model/);

  const sides = JSON.parse(readFileSync(join(routerHome, 'session-sides.json'), 'utf8'));
  assert.equal(sides['isolation-claude'].side, 'anthropic');
  assert.equal(sides['isolation-openai-claude'].side, 'openai');
});

test('non-training Ultra Spark keeps its whole session off collecting endpoints and away from the training tier', async () => {
  const inSession = id => ({ 'session-id': id });
  const lead = 'ultra-spark-private/deepseek-v4.1-flash-1017';
  // Even without a session ID, the lead reaches only endpoints that do not collect data.
  const bare = await send({ model: lead, input: 'Hello' });
  assert.equal(bare.hostname, 'openrouter.ai');
  assert.equal(bare.body.model, 'deepseek/deepseek-v4.1-flash-1017');
  assert.equal(bare.body.provider.data_collection, 'deny');
  await send({ model: lead, input: 'Hello' }, inSession('private-lead'));
  for (const model of ['openrouter/meta/muse-spark-1.3', 'deepseek/deepseek-v4.1-flash-1017']) {
    const upstream = await send({ model, input: 'Hello' }, inSession('private-lead'));
    assert.equal(upstream.body.provider.data_collection, 'deny', model);
  }
  await send({ model: 'anthropic/claude-sonnet-5-5', input: 'Hello' }, inSession('private-lead'));
  for (const model of ['openrouter/meta/muse-spark-1.3-contributor', 'ultra-spark/deepseek-v4.1-flash-1017']) {
    const count = forwarded.length;
    const result = await exchange(JSON.stringify({ model, input: 'Hello' }), inSession('private-lead'));
    assert.equal(result.status, 409, model);
    assert.match(result.body.error.message, /already used the non-training tier/);
    assert.equal(forwarded.length, count);
  }
  // A training-tier session cannot switch to it either.
  await send({ model: 'ultra-spark/deepseek-v4.1-flash-1017', input: 'Hello' }, inSession('contributor-lead'));
  const refused = await exchange(JSON.stringify({ model: lead, input: 'Hello' }), inSession('contributor-lead'));
  assert.equal(refused.status, 409);
  assert.match(refused.body.error.message, /Start a new thread to use the non-training tier/);
  const sides = JSON.parse(readFileSync(join(routerHome, 'session-sides.json'), 'utf8'));
  assert.equal(sides['private-lead'].side, 'private');
});

test('the deny data policy keeps a request off collecting endpoints and the training tier, with or without a session', async () => {
  const deny = { 'x-codex-router-data-policy': 'deny' };
  // Without a session: the deny, merged with the router's own endpoint order; the header goes nowhere.
  const before = parsedLogEntries().length;
  const pinned = await send({ model: 'openrouter/vendor/pinned', input: 'Hello' }, deny);
  assert.deepEqual(pinned.body.provider, { order: ['google-vertex/us', 'google-ai-studio'], data_collection: 'deny' });
  assert.equal(pinned.headers['x-codex-router-data-policy'], undefined);
  assert.equal(parsedLogEntries().slice(before).find(entry => entry.event === 'request.forwarded').requestDataPolicy, 'deny');
  const claude = await send({ model: 'openrouter/anthropic/claude-sonnet-5.5', input: 'Hello' }, deny);
  assert.equal(claude.body.provider.data_collection, 'deny');
  for (const model of ['openrouter/meta/muse-spark-1.3-contributor', 'ultra-spark/deepseek-v4.1-flash-1017']) {
    const count = forwarded.length;
    const result = await exchange(JSON.stringify({ model, input: 'Hello' }), deny);
    assert.equal(result.status, 409, model);
    assert.equal(result.body.error.code, 'data_policy');
    assert.equal(forwarded.length, count);
  }
  // A session with no side yet becomes non-training, for its later requests too.
  await send({ model: 'deepseek/deepseek-v4.1-flash-1017', input: 'Hello' }, { ...deny, 'session-id': 'deny-policy' });
  const later = await exchange(JSON.stringify({ model: 'openrouter/meta/muse-spark-1.3-contributor', input: 'Hello' }),
    { 'session-id': 'deny-policy' });
  assert.equal(later.status, 409);
  assert.equal(later.body.error.code, 'provider_isolation');
  const health = await exchange('', {}, { method: 'GET', url: '/health' });
  assert.deepEqual(health.body.capabilities.dataPolicies, ['deny']);
  const unknown = await exchange(JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash-1017', input: 'Hello' }),
    { 'x-codex-router-data-policy': 'allow' });
  assert.equal(unknown.status, 400);
  // Without the header nothing changes.
  const plain = await send({ model: 'openrouter/vendor/pinned', input: 'Hello' });
  assert.deepEqual(plain.body.provider, { order: ['google-vertex/us', 'google-ai-studio'] });
});

test('X-Codex-Router-Endpoints pins OpenRouter endpoints in its order, with no fallbacks', async () => {
  const pin = { 'x-codex-router-endpoints': 'deepinfra/fp8, fireworks' };
  const pinned = await send({ model: 'deepseek/deepseek-v4.1-flash-1017', input: 'Hello' }, pin);
  assert.deepEqual(pinned.body.provider, { order: ['deepinfra/fp8', 'fireworks'], allow_fallbacks: false });
  assert.equal(pinned.headers['x-codex-router-endpoints'], undefined);
  // It replaces the router's configured order, and the deny policy joins it.
  const both = await send({ model: 'openrouter/vendor/pinned', input: 'Hello' }, { ...pin, 'x-codex-router-data-policy': 'deny' });
  assert.deepEqual(both.body.provider, { order: ['deepinfra/fp8', 'fireworks'], allow_fallbacks: false, data_collection: 'deny' });
  const tooMany = Array.from({ length: 17 }, (_, index) => `endpoint-${index}`).join(',');
  for (const value of ['', 'fire works', 'deepinfra,,fireworks', '/fireworks', tooMany]) {
    const count = forwarded.length;
    const result = await exchange(JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash-1017', input: 'Hello' }),
      { 'x-codex-router-endpoints': value });
    assert.equal(result.status, 400, value);
    assert.equal(forwarded.length, count);
  }
  const conflict = await exchange(JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash-1017', input: 'Hello',
    provider: { order: ['deepseek'] } }), pin);
  assert.equal(conflict.status, 400);
  // OpenRouter's provider settings, when sent, must be an object.
  for (const provider of ['x', null, ['fireworks']]) {
    const count = forwarded.length;
    const result = await exchange(JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash-1017', input: 'Hello', provider }), pin);
    assert.equal(result.status, 400, JSON.stringify(provider));
    assert.equal(forwarded.length, count);
  }
  const health = await exchange('', {}, { method: 'GET', url: '/health' });
  assert.equal(health.body.capabilities.endpointPins, true);
});

test('a training-tier worker that carries the Ultra Spark lead history is refused before forwarding', async () => {
  // Codex gives the main thread a thread ID equal to the session ID.
  const lead = { 'session-id': 'fork-guard', 'thread-id': 'fork-guard' };
  const worker = threadId => ({ 'session-id': 'fork-guard', 'thread-id': threadId });
  const ultraSpark = 'ultra-spark/deepseek-v4.1-flash-1017';
  const muse = 'openrouter/meta/muse-spark-1.3-contributor';
  const calls = (id, count = 1) => Array.from({ length: count }, (_, index) => [
    { type: 'function_call', call_id: `${id}_${index}`, name: 'shell', arguments: '{}' },
    { type: 'function_call_output', call_id: `${id}_${index}`, output: 'ok' },
  ]).flat();
  const leadHistory = [{ type: 'message', role: 'user', content: 'Review the router' }, ...calls('lead_call')];
  const workerHistory = [{ type: 'message', role: 'user', content: 'Search for TODOs' }, ...calls('worker_call')];
  const refused = async (body, headers) => {
    const forwardedBefore = forwarded.length;
    const result = await exchange(JSON.stringify(body), headers);
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, 'forked_lead_context');
    assert.equal(forwarded.length, forwardedBefore);
  };

  // A forked worker that arrives before the lead's first request after a
  // restart claims nothing: only the main thread's requests are recorded.
  await send({ model: ultraSpark, input: leadHistory }, worker('fork-early-worker'));
  await send({ model: ultraSpark, input: leadHistory }, lead);

  // A worker spawned with fork_context: false has only its own call IDs.
  await send({ model: muse, input: workerHistory }, worker('fork-clean-worker'));

  // A forked worker replays the lead's calls; nothing leaves the machine.
  await refused({ model: muse, input: [...leadHistory, ...workerHistory] }, worker('fork-forked-worker'));
  const logged = parsedLogEntries().findLast(entry => entry.event === 'session.forked_lead_context');
  assert.equal(logged.forkedCallIds, 1);
  assert.equal(JSON.stringify(logged).includes('Review the router'), false);
  await refused({ model: muse, input: leadHistory }, worker('fork-early-worker'));

  // A worker that inherited the Ultra Spark model gains no exemption from its
  // own Ultra Spark requests, and cannot evict the lead's calls by flooding.
  await send({ model: ultraSpark, input: [...leadHistory, ...calls('flood_call', 4097)] }, worker('fork-inherited-worker'));
  await refused({ model: muse, input: leadHistory }, worker('fork-inherited-worker'));
  await send({ model: muse, input: calls('flood_call') }, worker('fork-inherited-worker'));

  // Call IDs longer than 256 characters are not remembered.
  const longCall = calls('x'.repeat(256));
  await send({ model: ultraSpark, input: [...leadHistory, ...longCall] }, lead);
  await send({ model: muse, input: longCall }, worker('fork-long-id-worker'));

  // The lead thread itself may switch to Muse with /model.
  await send({ model: muse, input: leadHistory }, lead);
  // The legacy conversation_id header identifies threads too.
  await refused({ model: muse, input: leadHistory }, { 'session-id': 'fork-guard', conversation_id: 'fork-legacy-worker' });
  // Requests without a session or thread ID are not checked.
  await send({ model: muse, input: leadHistory }, { 'session-id': 'fork-guard' });
  await send({ model: muse, input: leadHistory }, { 'thread-id': 'fork-sessionless-worker' });
});

test('isolation records survive restarts, refresh on use, and expire after 30 idle days', async () => {
  const muse = { model: 'openrouter/meta/muse-spark-1.3-contributor', input: 'Hello' };
  // A record loaded from disk is enforced, and a neutral request refreshes it.
  await send({ model: 'deepseek/deepseek-v4.1-flash-1017', input: 'Hello' }, { 'session-id': 'isolation-stale' });
  const refreshed = JSON.parse(readFileSync(join(routerHome, 'session-sides.json'), 'utf8'))['isolation-stale'];
  assert.equal(refreshed.side, 'openai');
  assert.ok(Date.now() - refreshed.at < 60000);
  const blocked = await exchange(JSON.stringify(muse), { 'session-id': 'isolation-stale' });
  assert.equal(blocked.status, 409);
  // A record past the retention window was dropped when the router started.
  await send(muse, { 'session-id': 'isolation-expired' });
});

test('OpenRouter continuation is stateless without forwarding the native session ID', async () => {
  const upstream = await send({
    model: 'deepseek/deepseek-v4.1-flash-1017',
    input: 'Continue after a tool call',
    previous_response_id: 'resp_upstream_state',
    store: true,
  }, { 'session-id': 'codex-thread-session' });
  assert.equal(upstream.headers['session-id'], undefined);
  assert.equal(upstream.body.previous_response_id, undefined);
  assert.equal(upstream.body.store, false);
  const forwardedLog = parsedLogEntries().filter(entry => entry.event === 'request.forwarded').at(-1);
  assert.equal(forwardedLog.stateReset, true);

  const native = await send({ model: 'gpt-6-astra', input: 'Native continuation', store: true },
    { 'session-id': 'native-session', 'thread-id': 'native-thread', 'x-codex-window-id': 'native-window' });
  assert.equal(native.headers['session-id'], 'native-session');
  assert.equal(native.headers['thread-id'], 'native-thread');
  assert.equal(native.headers['x-codex-window-id'], 'native-window');
  assert.equal(native.body.store, true);
});

test('OpenRouter tool history drops invalid records and keeps one ordered output per call', async () => {
  const firstCall = { type: 'function_call', call_id: 'call_first', name: 'lookup', arguments: '{}' };
  const secondCall = { type: 'function_call', call_id: 'call_second', name: 'lookup', arguments: '{}' };
  const firstOutput = { type: 'function_call_output', call_id: 'call_first', output: 'old result' };
  const latestFirstOutput = { type: 'function_call_output', call_id: 'call_first', output: 'latest result' };
  const secondOutput = { type: 'function_call_output', call_id: 'call_second', output: 'second result' };
  const input = [
    deepseekReasoning,
    firstCall,
    secondCall,
    secondOutput,
    firstOutput,
    firstCall,
    latestFirstOutput,
    { type: 'function_call_output', call_id: 'call_orphan', output: 'orphan result' },
    { type: 'function_call', name: 'lookup', arguments: '{}' },
    { type: 'function_call', call_id: 'call_pending', name: 'lookup', arguments: '{}' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Continue.' }] },
  ];

  const upstream = await send({ model: 'deepseek/deepseek-v4.1-flash-1017', input });
  // The repeated call survives where its latest output answers it.
  assert.deepEqual(upstream.body.input, [
    deepseekReasoning,
    secondCall,
    secondOutput,
    firstCall,
    latestFirstOutput,
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Continue.' }] },
  ]);

  const forwardedLog = parsedLogEntries().filter(entry => entry.event === 'request.forwarded').at(-1);
  assert.deepEqual(forwardedLog.historyRepairs, {
    changed: true,
    droppedInvalidCalls: 1,
    droppedDuplicateCalls: 1,
    droppedUnansweredCalls: 1,
    droppedOrphanOutputs: 1,
    droppedDuplicateOutputs: 1,
    droppedToolDeclarations: 0,
  });
});

test('OpenRouter drops native tool declarations after a switch from a Responses Lite model', async () => {
  const declarations = {
    type: 'additional_tools',
    id: 'at_native',
    role: 'developer',
    tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }],
  };
  const developer = { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Be brief.' }] };
  const user = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue.' }] };
  const tools = [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }];

  const upstream = await send({
    model: 'deepseek/deepseek-v4.1-flash-1017', input: [declarations, developer, user], tools,
  });
  assert.deepEqual(upstream.body.input, [developer, user]);
  assert.deepEqual(upstream.body.tools, tools);
  const repaired = parsedLogEntries().filter(entry => entry.event === 'history.repaired').at(-1);
  assert.equal(repaired.droppedToolDeclarations, 1);

  // Native requests keep them: the Codex backend accepts its own declarations.
  const native = await send({ model: 'gpt-6-sol', input: [declarations, developer, user] });
  assert.deepEqual(native.body.input, [declarations, developer, user]);
});

test('OpenRouter keeps sequential tool rounds separate and orders parallel outputs by call', async () => {
  const firstCall = { type: 'function_call', call_id: 'call_first', name: 'lookup', arguments: '{}' };
  const secondCall = { type: 'function_call', call_id: 'call_second', name: 'lookup', arguments: '{}' };
  const firstOutput = { type: 'function_call_output', call_id: 'call_first', output: 'first' };
  const secondOutput = { type: 'function_call_output', call_id: 'call_second', output: 'second' };

  const sequential = await send({
    model: 'openrouter/vendor/model',
    input: [firstCall, firstOutput, secondCall, secondOutput],
  });
  assert.deepEqual(sequential.body.input, [firstCall, firstOutput, secondCall, secondOutput]);

  const parallel = await send({
    model: 'openrouter/vendor/model',
    input: [firstCall, secondCall, secondOutput, firstOutput],
  });
  assert.deepEqual(parallel.body.input, [firstCall, secondCall, firstOutput, secondOutput]);
});

test('OpenRouter retries one compacted history after a pre-stream 400', async t => {
  mockUpstreamSequence(t, [
    {
      status: 400,
      generationId: 'gen_reject_recovery',
      body: JSON.stringify({
        error: { message: 'invalid request', code: 400, metadata: { provider_name: null } },
      }),
    },
    {
      status: 200,
      contentType: 'text/event-stream',
      generationId: 'gen_recovered',
      body: 'data: {"type":"response.completed","response":{"id":"resp_recovered","end_turn":true}}\n\n',
    },
  ]);
  const before = forwarded.length;
  const logsBefore = parsedLogEntries().length;
  const result = await exchangeRaw(JSON.stringify({
    model: 'deepseek/deepseek-v4.1-flash-1017',
    input: recoveryHistory,
  }), { 'x-codex-routing-policy': 'preserve-model-v1' });

  assert.equal(result.status, 200);
  assert.match(result.rawBody, /resp_recovered/);
  assert.equal(forwarded.length, before + 2);
  const [primary, recovery] = forwarded.slice(before);
  assert.deepEqual(primary.body.input, recoveryHistory);
  assert.ok(recovery.body.input.length < primary.body.input.length);
  const [notice] = recovery.body.input.splice(2, 1);
  assert.deepEqual(recovery.body.input, [
    recoveryHistory[0],
    recoveryHistory[1],
    recoveryHistory[101],
    recoveryHistory[102],
    recoveryHistory[103],
  ]);
  assert.equal(notice.role, 'developer');
  assert.match(notice.content[0].text, /^\[router note\] .*omits earlier conversation items/);

  const entries = parsedLogEntries().slice(logsBefore);
  const rejected = entries.find(entry => entry.event === 'openrouter.request_rejected');
  assert.equal(rejected.status, 400);
  assert.equal(rejected.attempt, 1);
  assert.equal(rejected.inputItems, recoveryHistory.length);
  assert.equal(rejected.generationId, 'gen_reject_recovery');
  assert.match(rejected.payloadSha256, /^[a-f0-9]{64}$/);
  const retry = entries.find(entry => entry.event === 'openrouter.recovery_attempt');
  assert.equal(retry.attempt, 2);
  assert.equal(retry.compactionStrategy, 'latest-user-turn');
  assert.equal(retry.inputItems, 6);
  assert.ok(retry.droppedItems > 0);
  assert.equal(retry.omissionNotice, true);
  assert.match(retry.payloadSha256, /^[a-f0-9]{64}$/);
});

test('DeepSeek structured-output recovery keeps the real developer instructions before the schema', async t => {
  mockUpstreamSequence(t, [
    { status: 400, body: JSON.stringify({ error: { message: 'invalid request', code: 400 } }) },
    {
      status: 200,
      contentType: 'text/event-stream',
      body: 'data: {"type":"response.completed","response":{"id":"resp_structured_recovery","end_turn":true}}\n\n',
    },
  ]);
  const before = forwarded.length;
  const format = { type: 'json_schema', name: 'result', schema: { type: 'object', properties: { value: { type: 'string' } } } };
  const result = await exchangeRaw(JSON.stringify({
    model: 'deepseek/deepseek-v4.1-flash-1017',
    input: recoveryHistory,
    text: { format },
  }));

  assert.equal(result.status, 200);
  assert.equal(forwarded.length, before + 2);
  const recovery = forwarded.at(-1).body.input;
  assert.equal(recovery[0].id, 'msg_current_developer');
  assert.equal(recovery.at(-1).role, 'developer');
  assert.match(recovery.at(-1).content[0].text, /conforms to this JSON schema/);
  assert.equal(recovery.filter(item => item.id === 'msg_current_developer').length, 1);
});

test('OpenRouter recovery keeps a tool call paired with an output selected at the tail boundary', async t => {
  const call = { type: 'function_call', id: 'fc_boundary', call_id: 'call_boundary', name: 'exec_command', arguments: '{}' };
  const output = { type: 'function_call_output', id: 'fco_boundary', call_id: 'call_boundary', output: 'boundary result' };
  // Four pinned items (the opening developer and user messages, the current
  // user message, and room for the omission notice) leave a 76-item tail: the
  // output and 75 newer items, so the tail begins between the call and its output.
  const history = [
    recoveryHistory[0],
    ...recoveryHistory.slice(1, 50),
    recoveryHistory.at(-3),
    call,
    output,
    ...Array.from({ length: 75 }, (_, index) => ({
      type: 'message',
      id: `msg_after_output_${index}`,
      role: 'assistant',
      content: [{ type: 'output_text', text: `After output ${index}` }],
    })),
  ];
  mockUpstreamSequence(t, [
    { status: 400, body: JSON.stringify({ error: { message: 'invalid request', code: 400 } }) },
    {
      status: 200,
      contentType: 'text/event-stream',
      body: 'data: {"type":"response.completed","response":{"id":"resp_boundary","end_turn":true}}\n\n',
    },
  ]);
  const before = forwarded.length;
  const result = await exchangeRaw(JSON.stringify({
    model: 'deepseek/deepseek-v4.1-flash-1017',
    input: history,
  }));

  assert.equal(result.status, 200);
  assert.equal(forwarded.length, before + 2);
  const recovery = forwarded.at(-1).body.input;
  const callIndex = recovery.findIndex(item => item.call_id === 'call_boundary' && item.type === 'function_call');
  const outputIndex = recovery.findIndex(item => item.call_id === 'call_boundary' && item.type === 'function_call_output');
  assert.ok(callIndex >= 0, 'recovery retained the tool call');
  assert.equal(outputIndex, callIndex + 1, 'the tool output immediately follows its call after normalization');
});

test('OpenRouter recovery keeps a bounded recent tail for a long single-turn history', async t => {
  const singleTurnHistory = [
    {
      type: 'message',
      id: 'msg_long_user',
      role: 'user',
      content: [{ type: 'input_text', text: 'Perform a long task.' }],
    },
    ...Array.from({ length: 100 }, (_, index) => ({
      type: 'message',
      id: `msg_long_assistant_${index}`,
      role: 'assistant',
      content: [{ type: 'output_text', text: `Progress ${index}` }],
    })),
  ];
  mockUpstreamSequence(t, [
    {
      status: 400,
      body: JSON.stringify({ error: { message: 'invalid request', code: 400 } }),
    },
    {
      status: 200,
      contentType: 'text/event-stream',
      body: 'data: {"type":"response.completed","response":{"id":"resp_tail","end_turn":true}}\n\n',
    },
  ]);
  const before = forwarded.length;
  const logsBefore = parsedLogEntries().length;
  const result = await exchangeRaw(JSON.stringify({
    model: 'deepseek/deepseek-v4.1-flash-1017',
    input: singleTurnHistory,
  }), { 'x-codex-routing-policy': 'preserve-model-v1' });

  assert.equal(result.status, 200);
  assert.equal(forwarded.length, before + 2);
  const recovery = forwarded.at(-1);
  assert.ok(recovery.body.input.length <= 80);
  assert.equal(recovery.body.input[0].id, 'msg_long_user');
  assert.equal(recovery.body.input.at(-1).id, 'msg_long_assistant_99');
  const retry = parsedLogEntries().slice(logsBefore)
    .find(entry => entry.event === 'openrouter.recovery_attempt');
  assert.equal(retry.compactionStrategy, 'recent-tail');
});

test('OpenRouter recovery bounds a long latest turn that follows earlier turns', async t => {
  const longTurnHistory = [
    recoveryHistory[0],
    { type: 'message', id: 'msg_earlier_user', role: 'user', content: [{ type: 'input_text', text: 'Earlier task.' }] },
    { type: 'message', id: 'msg_earlier_reply', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] },
    { type: 'message', id: 'msg_task', role: 'user', content: [{ type: 'input_text', text: 'Refactor everything.' }] },
    ...Array.from({ length: 120 }, (_, index) => [
      { type: 'function_call', call_id: `call_long_${index}`, name: 'exec_command', arguments: '{}' },
      { type: 'function_call_output', call_id: `call_long_${index}`, output: 'x'.repeat(20000) },
    ]).flat(),
  ];
  mockUpstreamSequence(t, [
    { status: 400, body: JSON.stringify({ error: { message: 'invalid request', code: 400 } }) },
    {
      status: 200,
      contentType: 'text/event-stream',
      body: 'data: {"type":"response.completed","response":{"id":"resp_long_turn","end_turn":true}}\n\n',
    },
  ]);
  const before = forwarded.length;
  const result = await exchangeRaw(JSON.stringify({
    model: 'deepseek/deepseek-v4.1-flash-1017',
    input: longTurnHistory,
  }));

  assert.equal(result.status, 200);
  assert.equal(forwarded.length, before + 2);
  const [primary, recovery] = forwarded.slice(before);
  const input = recovery.body.input;
  assert.ok(recovery.byteLength < primary.byteLength / 2);
  assert.ok(Buffer.byteLength(JSON.stringify(input)) <= 1024 * 1024);
  assert.deepEqual(input.slice(0, 2).map(item => item.id), ['msg_current_developer', 'msg_earlier_user']);
  assert.match(input[2].content[0].text, /^\[router note\]/);
  assert.equal(input[3].id, 'msg_task');
  assert.equal(input.some(item => item.id === 'msg_earlier_reply'), false);
  assert.equal(input.at(-1).call_id, 'call_long_119');
  const callIds = new Set(input.filter(item => item.type === 'function_call').map(item => item.call_id));
  const outputIds = input.filter(item => item.type === 'function_call_output').map(item => item.call_id);
  assert.deepEqual(outputIds, [...callIds]);
});

test('OpenRouter recovery keeps the thread opening, including injected AGENTS.md, and says what it omitted', async t => {
  const message = (id, role, text) => ({
    type: 'message',
    id,
    role,
    content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
  });
  const opening = [
    message('msg_permissions', 'developer', 'Sandbox and approval policy.'),
    message('msg_agents', 'user', '# AGENTS.md instructions\n\nNever start a paid run without the operator\'s go-ahead.'),
    message('msg_environment', 'user', '<environment_context><cwd>/work</cwd></environment_context>'),
    message('msg_first_task', 'user', 'Review the study.'),
  ];
  const history = [
    ...opening,
    ...Array.from({ length: 60 }, (_, index) => message(`msg_early_${index}`, 'assistant', `Early ${index}`)),
    message('msg_mid_developer', 'developer', 'Collaboration mode changed.'),
    ...Array.from({ length: 60 }, (_, index) => message(`msg_late_${index}`, 'assistant', `Late ${index}`)),
  ];
  mockUpstreamSequence(t, [
    { status: 400, body: JSON.stringify({ error: { message: 'invalid request', code: 400 } }) },
    {
      status: 200,
      contentType: 'text/event-stream',
      body: 'data: {"type":"response.completed","response":{"id":"resp_opening","end_turn":true}}\n\n',
    },
  ]);
  const before = forwarded.length;
  const logsBefore = parsedLogEntries().length;
  const result = await exchangeRaw(JSON.stringify({
    model: 'deepseek/deepseek-v4.1-flash-1017',
    input: history,
  }));

  assert.equal(result.status, 200);
  assert.equal(forwarded.length, before + 2);
  const input = forwarded.at(-1).body.input;
  assert.deepEqual(input.slice(0, opening.length), opening);
  assert.equal(input[opening.length].role, 'developer');
  assert.match(input[opening.length].content[0].text, /^\[router note\]/);
  assert.equal(input.filter(item => item.content?.[0]?.text?.startsWith('[router note]')).length, 1);
  assert.ok(input.some(item => item.id === 'msg_mid_developer'));
  assert.equal(input.at(-1).id, 'msg_late_59');
  // A pinned item inside the tail is counted once, so the tail fills the item limit.
  assert.equal(input.length, 80);
  const retry = parsedLogEntries().slice(logsBefore)
    .find(entry => entry.event === 'openrouter.recovery_attempt');
  assert.equal(retry.omissionNotice, true);
  assert.equal(retry.inputItems, 80);
});

test('OpenRouter recovery keeps the context and summary that follow a compacted thread\'s retained user messages', async t => {
  const message = (id, role, text) => ({ type: 'message', id, role, content: [{ type: 'input_text', text }] });
  // After a compaction, Codex lists the retained user messages first, then its
  // context, then the summary; the next turn follows.
  const context = [
    message('msg_permissions', 'developer', 'Sandbox and approval policy.'),
    message('msg_agents', 'user', '# AGENTS.md instructions\n\nNever start a paid run without the operator\'s go-ahead.'),
    message('msg_summary', 'user', 'Summary of the conversation so far.'),
    message('msg_task', 'user', 'Continue the refactor.'),
  ];
  const history = [
    ...Array.from({ length: 30 }, (_, index) => message(`msg_retained_${index}`, 'user', `Earlier request ${index}`)),
    ...context,
    ...Array.from({ length: 60 }, (_, index) => [
      { type: 'function_call', call_id: `call_compacted_${index}`, name: 'exec_command', arguments: '{}' },
      { type: 'function_call_output', call_id: `call_compacted_${index}`, output: 'ok' },
    ]).flat(),
  ];
  mockUpstreamSequence(t, [
    { status: 400, body: JSON.stringify({ error: { message: 'invalid request', code: 400 } }) },
    {
      status: 200,
      contentType: 'text/event-stream',
      body: 'data: {"type":"response.completed","response":{"id":"resp_compacted","end_turn":true}}\n\n',
    },
  ]);
  const before = forwarded.length;
  const result = await exchangeRaw(JSON.stringify({
    model: 'deepseek/deepseek-v4.1-flash-1017',
    input: history,
  }));

  assert.equal(result.status, 200);
  assert.equal(forwarded.length, before + 2);
  const input = forwarded.at(-1).body.input;
  assert.deepEqual(input.slice(0, context.length), context);
  assert.match(input[context.length].content[0].text, /^\[router note\]/);
  assert.equal(input.some(item => item.id?.startsWith('msg_retained_')), false);
  assert.equal(input.at(-1).call_id, 'call_compacted_59');
});

test('the omission notice follows Codex\'s context even when an earlier item is kept', async t => {
  const message = (id, role) => ({
    type: 'message',
    id,
    role,
    content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: id }],
  });
  // The latest user message precedes the developer message, so it is kept
  // ahead of Codex's context.
  const history = [
    message('msg_older_user', 'user'),
    message('msg_latest_user', 'user'),
    message('msg_developer', 'developer'),
    ...Array.from({ length: 100 }, (_, index) => message(`msg_reply_${index}`, 'assistant')),
  ];
  mockUpstreamSequence(t, [
    { status: 400, body: JSON.stringify({ error: { message: 'invalid request', code: 400 } }) },
    {
      status: 200,
      contentType: 'text/event-stream',
      body: 'data: {"type":"response.completed","response":{"id":"resp_notice_position","end_turn":true}}\n\n',
    },
  ]);
  const before = forwarded.length;
  const result = await exchangeRaw(JSON.stringify({
    model: 'deepseek/deepseek-v4.1-flash-1017',
    input: history,
  }));

  assert.equal(result.status, 200);
  assert.equal(forwarded.length, before + 2);
  const input = forwarded.at(-1).body.input;
  assert.deepEqual(input.slice(0, 2).map(item => item.id), ['msg_latest_user', 'msg_developer']);
  assert.match(input[2].content[0].text, /^\[router note\]/);
  assert.equal(input.some(item => item.id === 'msg_older_user'), false);
});

test('OpenRouter recovery pins a bounded opening when a thread has no model output yet', async t => {
  const history = Array.from({ length: 100 }, (_, index) => ({
    type: 'message',
    id: `msg_user_${index}`,
    role: 'user',
    content: [{ type: 'input_text', text: `User note ${index}` }],
  }));
  mockUpstreamSequence(t, [
    { status: 400, body: JSON.stringify({ error: { message: 'invalid request', code: 400 } }) },
    {
      status: 200,
      contentType: 'text/event-stream',
      body: 'data: {"type":"response.completed","response":{"id":"resp_user_only","end_turn":true}}\n\n',
    },
  ]);
  const before = forwarded.length;
  const result = await exchangeRaw(JSON.stringify({
    model: 'deepseek/deepseek-v4.1-flash-1017',
    input: history,
  }));

  assert.equal(result.status, 200);
  assert.equal(forwarded.length, before + 2);
  const input = forwarded.at(-1).body.input;
  assert.ok(input.length <= 80);
  assert.deepEqual(input.slice(0, 16).map(item => item.id), history.slice(0, 16).map(item => item.id));
  assert.match(input[16].content[0].text, /^\[router note\]/);
  assert.equal(input.at(-1).id, 'msg_user_99');
});

test('OpenRouter recovery drops encrypted reasoning from a short history', async t => {
  mockUpstreamSequence(t, [
    { status: 400, body: JSON.stringify({ error: { message: 'invalid request', code: 400 } }) },
    {
      status: 200,
      contentType: 'text/event-stream',
      body: 'data: {"type":"response.completed","response":{"id":"resp_no_reasoning","end_turn":true}}\n\n',
    },
  ]);
  const before = forwarded.length;
  const result = await exchangeRaw(JSON.stringify({
    model: 'deepseek/deepseek-v4.1-flash-1017',
    input: mixedHistory,
  }));

  assert.equal(result.status, 200);
  assert.match(result.rawBody, /resp_no_reasoning/);
  assert.equal(forwarded.length, before + 2);
  assert.deepEqual(forwarded.at(-1).body.input, mixedHistory.filter(item => item !== nativeReasoning));
});

test('an OpenRouter context-window rejection fails the response so Codex can compact', async t => {
  mockUpstreamSequence(t, [{
    status: 400,
    body: JSON.stringify({ error: {
      message: "This endpoint's maximum context length is 163840 tokens. However, you requested about 200000 tokens.",
      code: 400,
    } }),
  }]);
  const before = forwarded.length;
  const logsBefore = parsedLogEntries().length;
  const result = await exchangeRaw(JSON.stringify({
    model: 'deepseek/deepseek-v4.1-flash-1017',
    input: recoveryHistory,
  }));

  assert.equal(result.status, 200);
  assert.equal(result.headers['x-codex-router-diagnostic'], 'openrouter-context-overflow');
  assert.equal(forwarded.length, before + 1);
  const events = parseSse(result.rawBody);
  assert.deepEqual(events.map(event => event.type), ['response.created', 'response.failed']);
  assert.equal(events[1].response.error.code, 'context_length_exceeded');
  assert.doesNotMatch(result.rawBody, /163840/);
  const rejected = parsedLogEntries().slice(logsBefore)
    .find(entry => entry.event === 'openrouter.request_rejected');
  assert.equal(rejected.contextOverflow, true);
});

test('a context overflow reported only through error_type also fails the response', async t => {
  mockUpstreamSequence(t, [{
    status: 400,
    body: JSON.stringify({
      error_type: 'context_length_exceeded',
      error: { code: 'invalid_prompt', message: 'Request rejected' },
    }),
  }]);
  const before = forwarded.length;
  const result = await exchangeRaw(JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash-1017', input: 'Hello' }));
  assert.equal(result.headers['x-codex-router-diagnostic'], 'openrouter-context-overflow');
  assert.equal(parseSse(result.rawBody)[1].response.error.code, 'context_length_exceeded');
  assert.equal(forwarded.length, before + 1);
});

test('OpenRouter rejection capture stops reading an error body at the 256 KiB limit', async t => {
  const body = JSON.stringify({ error: { message: 'x'.repeat(300 * 1024), code: 400 } });
  mockUpstreamSequence(t, [{ status: 400, body }]);
  const before = forwarded.length;
  const logsBefore = parsedLogEntries().length;
  const result = await exchangeRaw(JSON.stringify({ model: 'openrouter/vendor/model', input: 'Hello' }));

  assert.equal(result.status, 200);
  assert.equal(result.headers['x-codex-router-diagnostic'], 'openrouter-request-rejected');
  assert.equal(forwarded.length, before + 1);
  const rejected = parsedLogEntries().slice(logsBefore)
    .find(entry => entry.event === 'openrouter.request_rejected');
  assert.equal(rejected.upstreamErrorBytes, 256 * 1024);
  assert.equal(rejected.upstreamErrorTruncated, true);
});

test('an endless OpenRouter 400 body is closed at the capture limit instead of drained', { timeout: 5000 }, async t => {
  let upstreamResponse;
  t.mock.method(https, 'request', (options, onResponse) => new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
    final(callback) {
      upstreamResponse = new PassThrough();
      upstreamResponse.statusCode = 400;
      upstreamResponse.headers = { 'content-type': 'application/json' };
      queueMicrotask(() => {
        onResponse(upstreamResponse);
        // More than the 256 KiB limit, and the body never ends.
        for (let chunk = 0; chunk < 5; chunk += 1) upstreamResponse.write('x'.repeat(64 * 1024));
      });
      callback();
    },
  }));
  const result = await exchangeRaw(JSON.stringify({ model: 'openrouter/vendor/model', input: 'Hello' }));
  assert.equal(result.status, 200);
  assert.equal(result.headers['x-codex-router-diagnostic'], 'openrouter-request-rejected');
  assert.equal(upstreamResponse.destroyed, true);
});

test('Windows rejection captures are limited to the private router directory itself', () => {
  const routerDir = join(tmpdir(), 'codex-home', 'unified-router');
  assert.equal(captureDirectoryAllowed(routerDir, routerDir, 'win32'), true);
  assert.equal(captureDirectoryAllowed(routerDir.toUpperCase(), routerDir, 'win32'), true);
  assert.equal(captureDirectoryAllowed(join(routerDir, 'rejections'), routerDir, 'win32'), false);
  assert.equal(captureDirectoryAllowed(join(tmpdir(), 'shared'), routerDir, 'win32'), false);
  assert.equal(captureDirectoryAllowed(join(tmpdir(), 'shared'), routerDir, 'darwin'), true);
});

test('an OpenRouter 400 that closes before ending returns 502 instead of hanging', async t => {
  t.mock.method(https, 'request', (options, onResponse) => new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
    final(callback) {
      const response = new PassThrough();
      response.statusCode = 400;
      response.headers = { 'content-type': 'application/json' };
      queueMicrotask(() => {
        onResponse(response);
        response.write('{"error":');
        response.destroy();
      });
      callback();
    },
  }));
  const result = await exchangeRaw(JSON.stringify({ model: 'openrouter/vendor/model', input: 'Hello' }));
  assert.equal(result.status, 502);
});

test('tool-history repair keeps the answered retry, not the unanswered call that shares its ID', async () => {
  const call = args => ({ type: 'function_call', call_id: 'call_retry', name: 'exec_command', arguments: args });
  const output = { type: 'function_call_output', call_id: 'call_retry', output: 'done' };
  const message = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Retrying.' }] };
  const upstream = await send({
    model: 'openrouter/vendor/model',
    input: [{ role: 'user', content: 'go' }, call('{"cmd":"first"}'), message, call('{"cmd":"second"}'), output],
  });
  // The output answers the second call, and the message keeps its place.
  assert.deepEqual(upstream.body.input, [{ role: 'user', content: 'go' }, message, call('{"cmd":"second"}'), output]);
});

test('a repeated OpenRouter 400 completes with a router diagnostic instead of breaking Codex', async t => {
  mockUpstreamSequence(t, [
    {
      status: 400,
      generationId: 'gen_reject_primary',
      body: JSON.stringify({
        error: { message: 'invalid request', code: 400, metadata: { provider_name: null } },
      }),
    },
    {
      status: 400,
      generationId: 'gen_reject_recovery',
      body: JSON.stringify({
        error: { message: 'invalid request', code: 400, metadata: { provider_name: null } },
      }),
    },
  ]);
  const before = forwarded.length;
  const captureBefore = readdirSync(rejectedRequestDir).sort();
  const logsBefore = parsedLogEntries().length;
  const result = await exchangeRaw(JSON.stringify({
    model: 'openrouter/vendor/model',
    input: recoveryHistory,
  }), { 'x-codex-routing-policy': 'preserve-model-v1' });

  assert.equal(result.status, 200);
  assert.equal(result.headers['content-type'], 'text/event-stream');
  assert.equal(result.headers['x-codex-router-diagnostic'], 'openrouter-request-rejected');
  assert.doesNotMatch(result.rawBody, /"error"/);
  const events = parseSse(result.rawBody);
  assert.deepEqual(events.map(event => event.type), [
    'response.created',
    'response.output_item.done',
    'response.completed',
  ]);
  assert.equal(events[1].item.role, 'assistant');
  assert.equal(events[1].item.content[0].text,
    '[router diagnostic] OpenRouter rejected this step. The thread is intact; retry or start a new thread.');
  assert.equal(events[2].response.end_turn, true);
  assert.equal(events[2].response.usage, undefined);
  assert.equal(forwarded.length, before + 2);

  const entries = parsedLogEntries().slice(logsBefore);
  const rejected = entries.filter(entry => entry.event === 'openrouter.request_rejected');
  assert.equal(rejected.length, 2);
  assert.deepEqual(rejected.map(entry => entry.attempt), [1, 2]);
  assert.deepEqual(rejected.map(entry => entry.generationId), [
    'gen_reject_primary',
    'gen_reject_recovery',
  ]);
  for (const entry of rejected) {
    assert.match(entry.payloadSha256, /^[a-f0-9]{64}$/);
    assert.equal(entry.status, 400);
    assert.equal(entry.bytes > 0, true);
    assert.equal(entry.inputItems > 0, true);
    assert.equal(entry.upstreamErrorCode, 400);
    assert.equal(entry.upstreamErrorBytes > 0, true);
  }
  assert.equal(entries.some(entry => entry.event === 'openrouter.fallback_completion'), true);
  const serializedLogs = JSON.stringify(entries);
  assert.doesNotMatch(serializedLogs, /Continue the current task|Old turn 0|printf current/);

  const captureAfter = readdirSync(rejectedRequestDir).sort();
  const created = captureAfter.filter(name => !captureBefore.includes(name));
  assert.equal(created.length, 4);
  for (const name of created) {
    // Windows has no file modes; the router directory's access list protects captures there.
    if (process.platform !== 'win32') assert.equal(statSync(join(rejectedRequestDir, name)).mode & 0o777, 0o600);
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(rejectedRequestDir, name), 'utf8')));
  }
});

test('native OpenAI 400 responses remain errors and are never replaced by router diagnostics', async t => {
  mockUpstreamSequence(t, [{
    status: 400,
    generationId: 'gen_native_reject',
    body: JSON.stringify({ error: { message: 'native rejected this request', code: 400 } }),
  }]);
  const result = await exchangeRaw('{"model":"gpt-6-astra","input":"Hello"}');
  assert.equal(result.status, 400);
  assert.deepEqual(JSON.parse(result.rawBody), {
    error: { message: 'native rejected this request', code: 400 },
  });
});

test('structured router logs correlate requests without recording bodies or credentials', async () => {
  const ready = parsedLogEntries().find(entry => entry.event === 'router.ready');
  assert.match(ready.revision, /^[a-f0-9]{64}$/);
  const before = logEntries.length;
  const sensitiveBody = 'ROUTER_PRIVATE_BODY_VALUE';
  await send({ model: 'openrouter/vendor/model', input: sensitiveBody }, {
    'x-private-header': 'ROUTER_PRIVATE_HEADER_VALUE', 'session-id': 'session-log-test',
  });
  const rejected = await exchange(JSON.stringify({ model: 'openrouter/vendor/model', input: 'Hello' }),
    { 'x-codex-routing-policy': 'unknown-policy' });
  assert.equal(rejected.status, 400);
  await new Promise(resolve => setImmediate(resolve));

  const entries = parsedLogEntries().slice(before);
  const forwarded = entries.filter(entry => entry.event === 'request.forwarded').at(-1);
  assert.match(forwarded.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(forwarded.sessionId, 'session-log-test');
  const started = entries.find(entry => entry.event === 'upstream.response_started'
    && entry.requestId === forwarded.requestId);
  const finished = entries.find(entry => entry.event === 'upstream.response_finished'
    && entry.requestId === forwarded.requestId);
  const completed = entries.find(entry => entry.event === 'request.finished'
    && entry.requestId === forwarded.requestId);
  assert.equal(completed.sessionId, 'session-log-test');
  assert.equal(completed.level, 'info');
  assert.equal(completed.status, 200);
  const rejectedFinished = entries.filter(entry => entry.event === 'request.finished').at(-1);
  assert.equal(rejectedFinished.level, 'error');
  assert.equal(rejectedFinished.status, 400);
  for (const entry of [started, finished]) {
    assert.equal(entry.generationId, 'gen_test');
    assert.equal(entry.providerName, 'TestProvider');
    assert.equal(entry.upstreamRequestId, 'req_test');
    assert.equal(entry.cloudflareRayId, 'cf_test');
  }
  const serialized = JSON.stringify(entries);
  assert.doesNotMatch(serialized, new RegExp(sensitiveBody));
  assert.doesNotMatch(serialized, /ROUTER_PRIVATE_HEADER_VALUE|test-openrouter-key|a{64}/);
});

test('token usage is logged from the final stream event while every byte passes through unchanged', async t => {
  const events = [
    { type: 'response.created', response: { id: 'resp_usage', status: 'in_progress', output: [] } },
    { type: 'response.output_text.delta', delta: 'Grüße PRIVATE_STREAM_TEXT' },
    { type: 'response.completed', response: {
      id: 'resp_usage',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Grüße PRIVATE_STREAM_TEXT' }] }],
      usage: {
        input_tokens: 8208,
        input_tokens_details: { cached_tokens: 8204, cache_write_tokens: 0 },
        output_tokens: 4,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 8212,
        cost: 0.0008684,
        is_byok: false,
        note: 'PRIVATE_USAGE_TEXT',
      },
    } },
  ];
  const stream = Buffer.from(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  // Split inside the multibyte ü and at several other points.
  const split = stream.indexOf(Buffer.from('ü')) + 1;
  const chunks = [stream.subarray(0, split), stream.subarray(split, split + 7), stream.subarray(split + 7, -40),
    stream.subarray(-40)];
  mockUpstreamSequence(t, [{ status: 200, contentType: 'text/event-stream', chunks, generationId: 'gen_usage' }]);
  const logsBefore = parsedLogEntries().length;
  const result = await exchangeRaw(JSON.stringify({ model: 'openrouter/anthropic/claude-sonnet-5.5', input: 'Hello' }),
    { 'session-id': 'usage-session' });
  assert.equal(result.status, 200);
  assert.equal(result.rawBody, stream.toString('utf8'));

  const logs = parsedLogEntries().slice(logsBefore);
  const usage = logs.filter(entry => entry.event === 'upstream.usage');
  assert.equal(usage.length, 1);
  assert.equal(usage[0].sessionId, 'usage-session');
  assert.equal(usage[0].upstreamModel, 'anthropic/claude-sonnet-5.5');
  assert.equal(usage[0].responseStatus, 'completed');
  assert.equal(usage[0].generationId, 'gen_usage');
  assert.deepEqual(usage[0].usage, {
    input_tokens: 8208,
    input_tokens_details: { cached_tokens: 8204, cache_write_tokens: 0 },
    output_tokens: 4,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 8212,
    cost: 0.0008684,
  });
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_STREAM_TEXT|PRIVATE_USAGE_TEXT/);
});

test('usage is found whatever the property order of the final event', async t => {
  // `type` follows a long response object, far past the start of the line.
  const finalEvent = `{"response":{"id":"resp_order","status":"incomplete","output":[{"type":"message","content":[{"type":"output_text","text":"${'x'.repeat(4096)}"}]}],"usage":{"input_tokens":12,"output_tokens":3}},"type":"response.incomplete"}`;
  // A delta that quotes a final event type in its text is not a final event.
  const delta = JSON.stringify({ type: 'response.output_text.delta', delta: '"type":"response.completed"', response: { usage: { input_tokens: 99 } } });
  const body = `data: ${delta}\n\ndata: ${finalEvent}\n\n`;
  mockUpstreamSequence(t, [{ status: 200, contentType: 'text/event-stream', body }]);
  const logsBefore = parsedLogEntries().length;
  const result = await exchangeRaw(JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash-1017', input: 'Hello' }));
  assert.equal(result.rawBody, body);
  const usage = parsedLogEntries().slice(logsBefore).filter(entry => entry.event === 'upstream.usage');
  assert.equal(usage.length, 1);
  assert.equal(usage[0].responseStatus, 'incomplete');
  assert.deepEqual(usage[0].usage, { input_tokens: 12, output_tokens: 3 });
});

test('streams without a final usage event log no usage', async t => {
  const body = 'data: {"type":"response.created","response":{"id":"resp_none"}}\n\ndata: [DONE]\n\n';
  mockUpstreamSequence(t, [{ status: 200, contentType: 'text/event-stream', body }]);
  const logsBefore = parsedLogEntries().length;
  const result = await exchangeRaw(JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash-1017', input: 'Hello' }));
  assert.equal(result.rawBody, body);
  assert.equal(parsedLogEntries().slice(logsBefore).some(entry => entry.event === 'upstream.usage'), false);
});

test('string, empty, and absent inputs still pass through', async () => {
  for (const body of [{ input: 'Hello' }, { input: [] }, {}]) {
    const upstream = await send({ model: 'gpt-6-astra', ...body });
    assert.deepEqual(upstream.body, { model: 'gpt-6-astra', ...body });
  }
});

for (const phase of ['before headers', 'after headers', 'during streaming', 'after completion']) {
  test(`upstream cleanup when the client closes ${phase}`, async t => {
    const upstream = new Writable({
      autoDestroy: false,
      write(_chunk, _encoding, callback) { callback(); },
    });
    const upstreamResponse = new PassThrough();
    upstreamResponse.statusCode = 200;
    upstreamResponse.headers = { 'content-type': 'text/event-stream' };
    let deliverHeaders;
    t.mock.method(https, 'request', (_options, onResponse) => {
      deliverHeaders = () => onResponse(upstreamResponse);
      return upstream;
    });
    t.after(() => {
      upstream.destroy();
      upstreamResponse.destroy();
    });

    const request = new PassThrough();
    Object.assign(request, {
      method: 'POST',
      url: '/v1/responses',
      headers: { ...clientHeaders },
    });
    const response = new PassThrough();
    response.headersSent = false;
    response.writeHead = status => {
      response.statusCode = status;
      response.headersSent = true;
    };
    const received = [];
    response.on('data', chunk => received.push(chunk.toString()));
    t.after(() => response.destroy());
    const sent = once(upstream, 'finish');
    handleRequest(request, response);
    request.end(JSON.stringify({ model: 'gpt-6-astra', input: 'Hello' }));
    await sent;
    assert.equal(upstream.destroyed, false);

    if (phase !== 'before headers') deliverHeaders();
    if (phase === 'during streaming' || phase === 'after completion') {
      upstreamResponse.write('data: first chunk\n\n');
      assert.deepEqual(received, ['data: first chunk\n\n']);
      assert.equal(upstream.destroyed, false);
    }
    const before = logEntries.length;
    const closed = once(response, 'close');
    if (phase === 'after completion') upstreamResponse.end();
    else response.destroy();
    await closed;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(upstream.destroyed, phase !== 'after completion');
    const events = parsedLogEntries().slice(before).map(entry => entry.event);
    assert.equal(events.includes('request.aborted'), phase !== 'after completion');
    assert.equal(events.includes('upstream.error'), false);
  });
}

test('router authentication is required even with a Codex bearer token', async () => {
  const count = forwarded.length;
  for (const token of [undefined, '', 'wrong', 'b'.repeat(64), 'é'.repeat(64)]) {
    for (const model of ['gpt-6-astra', 'deepseek/example']) {
      const result = await exchange(JSON.stringify({ model }), { 'x-codex-router-token': token });
      assert.equal(result.status, 401);
    }
  }
  const models = await exchange('', { 'x-codex-router-token': undefined }, { method: 'GET', url: '/v1/models' });
  assert.equal(models.status, 401);
  const health = await exchange('', { 'x-codex-router-token': undefined }, { method: 'GET', url: '/health' });
  assert.equal(health.status, 200);
  assert.equal(health.body.clientAuth, true);
  assert.equal(forwarded.length, count);
});

test('rejects browser origins, foreign hosts, and non-JSON content before forwarding', async () => {
  const count = forwarded.length;
  for (const headers of [
    { host: 'evil.example:18766' }, { host: undefined }, { host: '127.0.0.1:1234' },
    { origin: 'https://evil.example' }, { origin: 'null' },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-origin' },
  ]) {
    assert.equal((await exchange('{"model":"deepseek/example"}', headers)).status, 403);
  }
  for (const contentType of [undefined, 'text/plain', 'application/jsonp']) {
    assert.equal((await exchange('{"model":"deepseek/example"}', { 'content-type': contentType })).status, 415);
  }
  assert.equal(forwarded.length, count);
});

test('malformed JSON and invalid body shapes return 400 and subsequent requests work', async () => {
  const count = forwarded.length;
  const invalid = [null, [], 1, true, 'hello', {}, { model: 1 }, { model: ' ' },
    { model: 'deepseek/example', input: {} }, { model: 'deepseek/example', reasoning: [] },
    { model: 'deepseek/example', reasoning: { effort: { toString: null } } },
    { model: 'deepseek/example', text: { format: 'json' } }];
  for (const body of ['{broken', ...invalid.map(value => JSON.stringify(value))]) {
    assert.equal((await exchange(body)).status, 400);
  }
  assert.equal(forwarded.length, count);
  await send({ model: 'gpt-6-astra' });
});

test('only provider-specific headers go upstream; local and unrelated credentials stay local', async () => {
  for (const model of ['gpt-6-astra', 'openrouter/vendor/model']) {
    const upstream = await send({ model }, {
      cookie: 'private-cookie', 'proxy-authorization': 'private-proxy-token',
      'x-private-header': 'private-value', 'openai-beta': 'responses=experimental',
      'session-id': 'native-session', 'x-codex-turn-state': 'native-state',
      'content-type': 'application/json; charset=utf-8',
    });
    for (const name of ['cookie', 'proxy-authorization', 'x-private-header', 'x-codex-router-token', 'host']) {
      assert.equal(upstream.headers[name], undefined);
    }
    assert.equal(upstream.headers['session-id'], model.startsWith('gpt') ? 'native-session' : undefined);
    assert.equal(upstream.headers['x-codex-turn-state'], model.startsWith('gpt') ? 'native-state' : undefined);
  }
});

test('synchronous upstream failures return 502 without exposing error details', async t => {
  t.mock.method(https, 'request', () => { throw new Error('private error details'); });
  const result = await exchange('{"model":"gpt-6-astra"}');
  assert.equal(result.status, 502);
  assert.doesNotMatch(JSON.stringify(result.body), /private error details/);
});

for (const failure of ['error', 'premature close']) {
  test(`upstream ${failure} closes the downstream stream`, async t => {
    const upstream = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const upstreamResponse = new PassThrough();
    upstreamResponse.statusCode = 200;
    upstreamResponse.headers = { 'content-type': 'text/event-stream' };
    t.mock.method(https, 'request', (_options, onResponse) => {
      queueMicrotask(() => onResponse(upstreamResponse));
      return upstream;
    });
    const request = new PassThrough();
    Object.assign(request, { method: 'POST', url: '/v1/responses', headers: { ...clientHeaders } });
    const response = new PassThrough();
    response.writeHead = () => { response.headersSent = true; };
    response.resume();
    const closed = new Promise(resolve => response.once('close', resolve));
    t.after(() => { request.destroy(); response.destroy(); upstream.destroy(); upstreamResponse.destroy(); });
    handleRequest(request, response);
    request.end('{"model":"gpt-6-astra"}');
    await new Promise(resolve => setImmediate(resolve));
    const before = logEntries.length;
    upstreamResponse.write('data: first\n\n');
    upstreamResponse.destroy(failure === 'error' ? new Error('upstream reset') : undefined);
    await closed;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(response.destroyed, true);
    assert.equal(upstream.destroyed, true);
    const events = parsedLogEntries().slice(before).map(entry => entry.event);
    assert.deepEqual(events, ['upstream.error']);
  });
}

// OpenRouter would run Codex's hosted web_search on its side and return the
// results only as citations, which later turns do not show the model.
const sse = events => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
const webSearchFirstResponse = (extraCall = null) => {
  const call = { type: 'function_call', id: 'fc_search', call_id: 'call_search', name: 'web_search', arguments: '{"query":"openai codex contributors"}', status: 'completed' };
  const output = [call, ...(extraCall ? [extraCall] : [])];
  return sse([
    { type: 'response.created', response: { id: 'resp_first', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_search', output_index: 0, delta: '{"query":"openai codex contributors"}' },
    { type: 'response.function_call_arguments.done', item_id: 'fc_search', output_index: 0, arguments: call.arguments },
    { type: 'response.output_item.done', output_index: 0, item: call },
    ...(extraCall ? [{ type: 'response.output_item.added', output_index: 1, item: extraCall }, { type: 'response.output_item.done', output_index: 1, item: extraCall }] : []),
    { type: 'response.completed', response: { id: 'resp_first', status: 'completed', output, usage: { input_tokens: 100, output_tokens: 10 } } },
  ]);
};
const webSearchResult = status => ({ status, body: JSON.stringify(status === 200 ? { output: [{ type: 'message', role: 'assistant', content: [{
  type: 'output_text', text: 'OK', annotations: [
    { type: 'url_citation', url: 'https://github.com/openai/codex', title: 'openai/codex', content: 'Lightweight coding agent. 688 contributors.' },
    { type: 'url_citation', url: 'https://github.com/openai/codex', title: 'duplicate', content: 'dropped' }] }] }], usage: { cost: 0.007 } } : { error: { message: 'down' } }) });
const answer = { type: 'message', id: 'msg_answer', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'GitHub lists 688 contributors.', annotations: [] }] };
const continuationResponse = sse([
  { type: 'response.created', response: { id: 'resp_second', status: 'in_progress', output: [] } },
  { type: 'response.output_item.added', output_index: 0, item: { ...answer, status: 'in_progress', content: [] } },
  { type: 'response.output_item.done', output_index: 0, item: answer },
  { type: 'response.completed', response: { id: 'resp_second', status: 'completed', output: [answer], usage: { input_tokens: 300, output_tokens: 20 } } },
]);
const searchRequest = (input = 'How many contributors does openai/codex have?') => JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash-1017', input, stream: true,
  tools: [{ type: 'web_search', external_web_access: false }, { type: 'function', name: 'exec_command', parameters: { type: 'object' } }] });

test('web search for OpenRouter models runs in the router, reaches Codex as a web_search_call, and stays in later turns', async t => {
  // One sequence for both requests: a second mock in the same test would outlive it.
  mockUpstreamSequence(t, [
    { status: 200, contentType: 'text/event-stream', body: webSearchFirstResponse() },
    webSearchResult(200),
    { status: 200, contentType: 'text/event-stream', body: continuationResponse },
    { status: 200, contentType: 'text/event-stream', body: continuationResponse },
    { status: 200, contentType: 'text/event-stream', body: continuationResponse },
  ]);
  const before = forwarded.length;
  const result = await exchangeRaw(searchRequest(), { 'session-id': 'web-search-session' });
  assert.equal(result.status, 200);
  const [first, search, continuation] = forwarded.slice(before);
  // The model is offered a function, never OpenRouter's hosted search.
  assert.deepEqual(first.body.tools.map(tool => `${tool.type}:${tool.name ?? ''}`), ['function:web_search', 'function:exec_command']);
  assert.deepEqual(search.body.plugins, [{ id: 'web', engine: 'exa', max_results: 5 }]);
  assert.equal(search.body.model, 'deepseek/deepseek-v4.1-flash-1017');
  assert.match(JSON.stringify(search.body.input), /openai codex contributors/);
  assert.deepEqual(continuation.body.input.slice(-2).map(item => item.type), ['function_call', 'function_call_output']);
  const output = continuation.body.input.at(-1).output;
  assert.match(output, /^Web search results for "openai codex contributors":/);
  assert.match(output, /https:\/\/github\.com\/openai\/codex\n {3}Lightweight coding agent\. 688 contributors\./);
  assert.doesNotMatch(output, /dropped/);

  // Codex sees one response: a native search item, the answer, and no function call it cannot run.
  const events = parseSse(result.rawBody);
  assert.equal(events.filter(event => event.type === 'response.created').length, 1);
  assert.ok(!events.some(event => event.item?.type === 'function_call' || event.type?.startsWith('response.function_call_arguments')));
  const final = events.at(-1);
  assert.equal(final.type, 'response.completed');
  assert.equal(final.response.id, 'resp_first');
  assert.deepEqual(final.response.output.map(item => item.type), ['web_search_call', 'message']);
  assert.deepEqual(final.response.output[0], { type: 'web_search_call', id: 'call_search', status: 'completed', action: { type: 'search', query: 'openai codex contributors' } });
  assert.deepEqual(final.response.usage, { input_tokens: 400, output_tokens: 30 });
  const searchLog = parsedLogEntries().find(entry => entry.event === 'web_search.executed');
  assert.deepEqual([searchLog.results, searchLog.failed, searchLog.cost], [1, false, 0.007]);
  assert.doesNotMatch(JSON.stringify(searchLog), /openai codex contributors/, 'logs never carry the query');

  // The next request carries the search back as a call with its stored results.
  const laterInput = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Earlier question' }] },
    final.response.output[0], answer, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'reference?' }] }];
  const later = await exchangeRaw(searchRequest(laterInput), { 'session-id': 'web-search-session' });
  assert.equal(later.status, 200);
  const restored = forwarded.at(-1).body.input;
  assert.deepEqual(restored.slice(1, 3).map(item => [item.type, item.call_id]), [['function_call', 'call_search'], ['function_call_output', 'call_search']]);
  assert.equal(restored[2].output, output);
  assert.ok(!restored.some(item => item.type === 'web_search_call'));
  const stored = JSON.parse(readFileSync(join(routerHome, 'web-search-results.json'), 'utf8'));
  assert.equal(stored[JSON.stringify(['web-search-session', 'call_search'])].text, output);

  // Another session with the same call ID never receives these results.
  const other = await exchangeRaw(searchRequest(laterInput), { 'session-id': 'other-session' });
  assert.equal(other.status, 200);
  assert.match(forwarded.at(-1).body.input[2].output, /^The results of this search are not available any more\./);
});

test('the excerpts of one search share 10,000 characters, so a long one keeps the room short ones leave', async t => {
  const searchWith = excerpts => ({ status: 200, body: JSON.stringify({ output: [{ type: 'message', role: 'assistant', content: [{
    type: 'output_text', text: 'OK', annotations: excerpts.map((content, index) => ({
      type: 'url_citation', url: `https://example.com/${index}`, title: `Page ${index}`, content })) }] }] }) });
  const cases = [
    [[300, 9000, 300, 300, 300], [300, 8800, 300, 300, 300]],
    [[9000, 300, 9000, 300, 300], [4550, 300, 4550, 300, 300]],
    [[300, 2000, 300, 300, 300], [300, 2000, 300, 300, 300]],
  ];
  // One sequence for every request: a second mock in the same test would outlive it.
  mockUpstreamSequence(t, cases.flatMap(([sent]) => [
    { status: 200, contentType: 'text/event-stream', body: webSearchFirstResponse() },
    searchWith(sent.map((length, index) => 'abcde'[index].repeat(length))),
    { status: 200, contentType: 'text/event-stream', body: continuationResponse },
  ]));
  for (const [sent, kept] of cases) {
    const before = forwarded.length;
    const result = await exchangeRaw(searchRequest(), { 'session-id': 'web-search-budget-session' });
    assert.equal(result.status, 200);
    const output = forwarded.slice(before)[2].body.input.at(-1).output;
    const excerpts = output.split('\n\n').slice(1).map(block => block.split('\n')[2].trim());
    assert.deepEqual(excerpts.map(excerpt => excerpt.length), kept, `excerpts of ${sent.join(', ')}`);
    excerpts.forEach((excerpt, index) => assert.equal(excerpt.endsWith('…'), kept[index] < sent[index]));
  }
});

test('a web search beside another call ends the response, and a failed search says so', async t => {
  const exec = { type: 'function_call', id: 'fc_exec', call_id: 'call_exec', name: 'exec_command', arguments: '{"cmd":"ls"}', status: 'completed' };
  mockUpstreamSequence(t, [{ status: 200, contentType: 'text/event-stream', body: webSearchFirstResponse(exec) }, webSearchResult(500)]);
  const before = forwarded.length;
  const result = await exchangeRaw(searchRequest(), { 'session-id': 'mixed-session' });
  // Codex runs its own call and comes back with the search in its history, so no continuation is sent.
  assert.equal(forwarded.length - before, 2);
  const final = parseSse(result.rawBody).at(-1);
  assert.deepEqual(final.response.output.map(item => item.type === 'function_call' ? item.name : item.type), ['web_search_call', 'exec_command']);
  const stored = JSON.parse(readFileSync(join(routerHome, 'web-search-results.json'), 'utf8'));
  assert.match(stored[JSON.stringify(['mixed-session', 'call_search'])].text, /^The web search for "openai codex contributors" failed: the search service answered with HTTP 500\./);
  // Without a session there is nothing to scope results to, so nothing is kept.
  assert.ok(!Object.keys(stored).some(key => JSON.parse(key)[0] === ''));
});

test('a refused continuation still ends the response with the searches and a router diagnostic', async t => {
  mockUpstreamSequence(t, [
    { status: 200, contentType: 'text/event-stream', body: webSearchFirstResponse() },
    webSearchResult(200),
    { status: 400, body: JSON.stringify({ error: { message: 'refused' } }) },
  ]);
  const refusedResult = await exchangeRaw(searchRequest());
  assert.equal(refusedResult.status, 200);
  const refused = parseSse(refusedResult.rawBody);
  assert.equal(refused.at(-1).type, 'response.completed');
  assert.deepEqual(refused.at(-1).response.output.map(item => item.type), ['web_search_call', 'message']);
  assert.match(refused.at(-1).response.output[1].content[0].text, /^\[router diagnostic\] The web search ran, but OpenRouter rejected the next step\./);
});

test('a continuation that breaks mid-stream ends the response with a router diagnostic', async t => {
  // The continuation starts streaming, then the connection fails.
  const responses = [
    () => Readable.from([webSearchFirstResponse()]),
    () => Readable.from([webSearchResult(200).body]),
    () => {
      const broken = new PassThrough();
      queueMicrotask(() => {
        broken.write(sse([{ type: 'response.created', response: { id: 'resp_second', status: 'in_progress', output: [] } },
          { type: 'response.output_item.done', output_index: 0, item: answer },
          { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_partial', role: 'assistant', status: 'in_progress', content: [] } },
          { type: 'response.output_text.delta', item_id: 'msg_partial', output_index: 1, delta: 'Half an ' },
          { type: 'response.output_text.delta', item_id: 'msg_partial', output_index: 1, delta: 'answer' }]));
        setImmediate(() => broken.destroy(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })));
      });
      return broken;
    },
  ];
  let index = 0;
  t.mock.method(https, 'request', (_options, onResponse) => new Writable({
    write(_chunk, _encoding, callback) { callback(); },
    final(callback) {
      const response = responses[index]();
      index += 1;
      response.statusCode = 200;
      response.headers = { 'content-type': index === 2 ? 'application/json' : 'text/event-stream' };
      queueMicrotask(() => onResponse(response));
      callback();
    },
  }));
  const before = logEntries.length;
  const broken = await exchangeRaw(searchRequest());
  assert.equal(broken.status, 200);
  const events = parseSse(broken.rawBody);
  assert.equal(events.at(-1).type, 'response.completed');
  const output = events.at(-1).response.output;
  // The finished answer stays, the half-streamed message is closed as incomplete, and the diagnostic follows.
  assert.deepEqual(output.map(item => item.id), ['call_search', 'msg_answer', 'msg_partial', output[3].id]);
  assert.deepEqual([output[2].status, output[2].content[0].text], ['incomplete', 'Half an answer']);
  assert.ok(events.some(event => event.type === 'response.output_item.done' && event.item.id === 'msg_partial'));
  assert.match(output[3].id, /^msg_router_/);
  assert.match(output[3].content[0].text, /the next step was interrupted/);
  assert.ok(parsedLogEntries().slice(before).some(entry => entry.event === 'web_search.continuation_failed' && entry.errorCode === 'ECONNRESET'));
});

test('a continuation that ends without a final event still gets one', async t => {
  mockUpstreamSequence(t, [
    { status: 200, contentType: 'text/event-stream', body: webSearchFirstResponse() },
    webSearchResult(200),
    { status: 200, contentType: 'text/event-stream', body: sse([
      { type: 'response.created', response: { id: 'resp_second', status: 'in_progress', output: [] } },
      { type: 'response.output_item.done', output_index: 0, item: answer }]) },
  ]);
  const before = logEntries.length;
  const result = await exchangeRaw(searchRequest());
  assert.equal(result.status, 200);
  const final = parseSse(result.rawBody).at(-1);
  assert.equal(final.type, 'response.completed');
  // What the continuation finished stays in the response, ahead of the diagnostic.
  assert.deepEqual(final.response.output.slice(0, 2).map(item => item.id), ['call_search', 'msg_answer']);
  assert.match(final.response.output[2].id, /^msg_router_/);
  assert.match(final.response.output[2].content[0].text, /the next step was interrupted/);
  assert.ok(parsedLogEntries().slice(before).some(entry => entry.event === 'web_search.continuation_failed' && entry.errorCode === 'ENDED_WITHOUT_FINAL_EVENT'));
});

test('a continuation over the context window fails the response so Codex compacts', async t => {
  mockUpstreamSequence(t, [
    { status: 200, contentType: 'text/event-stream', body: webSearchFirstResponse() },
    webSearchResult(200),
    { status: 400, body: JSON.stringify({ error: { code: 'context_length_exceeded', message: 'too long' } }) },
  ]);
  const result = await exchangeRaw(searchRequest());
  assert.equal(result.status, 200);
  const final = parseSse(result.rawBody).at(-1);
  assert.equal(final.type, 'response.failed');
  assert.equal(final.response.error.code, 'context_length_exceeded');
});

test('a failed response runs no search, and its search call never reaches Codex', async t => {
  const call = { type: 'function_call', id: 'fc_search', call_id: 'call_search', name: 'web_search', arguments: '{"query":"x"}' };
  mockUpstreamSequence(t, [{ status: 200, contentType: 'text/event-stream', body: sse([
    { type: 'response.created', response: { id: 'resp_failed', status: 'in_progress', output: [] } },
    { type: 'response.output_item.done', output_index: 0, item: call },
    { type: 'response.failed', response: { id: 'resp_failed', status: 'failed', output: [call], error: { code: 'server_error' } } }]) }]);
  const before = forwarded.length;
  const events = parseSse((await exchangeRaw(searchRequest())).rawBody);
  assert.equal(forwarded.length - before, 1, 'no search request');
  assert.equal(events.at(-1).type, 'response.failed');
  assert.deepEqual(events.at(-1).response.output, []);
  assert.ok(!events.some(event => event.item?.type === 'web_search_call' || event.item?.name === 'web_search'));
});

test('a client that disconnects during a search stops the search and any continuation', async t => {
  const requests = [];
  t.mock.method(https, 'request', (_options, onResponse) => {
    const index = requests.length;
    // Like a pending ClientRequest, the mock closes only when it is destroyed.
    const outgoing = new Writable({
      autoDestroy: false,
      write(_chunk, _encoding, callback) { callback(); },
      final(callback) {
        if (index === 0) {
          const first = Readable.from([webSearchFirstResponse()]);
          first.statusCode = 200;
          first.headers = { 'content-type': 'text/event-stream' };
          queueMicrotask(() => onResponse(first));
        }
        // The search never answers; the client leaves while it waits.
        callback();
      },
    });
    requests.push(outgoing);
    return outgoing;
  });
  const request = new PassThrough();
  Object.assign(request, { method: 'POST', url: '/v1/responses', headers: { ...clientHeaders } });
  const response = new PassThrough();
  response.writeHead = () => { response.headersSent = true; };
  response.resume();
  handleRequest(request, response);
  request.end(searchRequest());
  const before = logEntries.length;
  while (requests.length < 2) await new Promise(resolve => setImmediate(resolve));
  response.destroy();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(requests.length, 2, 'no continuation after the client left');
  assert.equal(requests[1].destroyed, true, 'the pending search is cancelled');
  // Cancelling settles the search, so nothing waits on it.
  assert.ok(parsedLogEntries().slice(before).some(entry => entry.event === 'web_search.executed' && entry.failed === true));
});

test('a client that disconnects while the continuation is pending cancels it', async t => {
  const requests = [];
  t.mock.method(https, 'request', (_options, onResponse) => {
    const index = requests.length;
    // Like a pending ClientRequest, the mock closes only when it is destroyed.
    const outgoing = new Writable({
      autoDestroy: false,
      write(_chunk, _encoding, callback) { callback(); },
      final(callback) {
        const body = [webSearchFirstResponse(), webSearchResult(200).body][index];
        if (body) {
          const answer = Readable.from([body]);
          answer.statusCode = 200;
          answer.headers = { 'content-type': index === 0 ? 'text/event-stream' : 'application/json' };
          queueMicrotask(() => onResponse(answer));
        }
        // The continuation never answers.
        callback();
      },
    });
    requests.push(outgoing);
    return outgoing;
  });
  const request = new PassThrough();
  Object.assign(request, { method: 'POST', url: '/v1/responses', headers: { ...clientHeaders, 'session-id': 'pending-continuation' } });
  const response = new PassThrough();
  response.writeHead = () => { response.headersSent = true; };
  response.resume();
  handleRequest(request, response);
  request.end(searchRequest());
  while (requests.length < 3) await new Promise(resolve => setImmediate(resolve));
  response.destroy();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(requests.length, 3);
  assert.equal(requests[2].destroyed, true, 'the pending continuation is cancelled');
});

test('a step runs at most eight searches and ends without a continuation', async t => {
  const calls = Array.from({ length: 9 }, (_, index) => ({ type: 'function_call', id: `fc_${index}`, call_id: `call_${index}`,
    name: 'web_search', arguments: JSON.stringify({ query: `query ${index}` }), status: 'completed' }));
  mockUpstreamSequence(t, [{ status: 200, contentType: 'text/event-stream', body: sse([
    { type: 'response.created', response: { id: 'resp_many', status: 'in_progress', output: [] } },
    ...calls.map((call, index) => ({ type: 'response.output_item.done', output_index: index, item: call })),
    { type: 'response.completed', response: { id: 'resp_many', status: 'completed', output: calls } }]) },
  ...Array.from({ length: 8 }, () => webSearchResult(200))]);
  const before = forwarded.length;
  const logsBefore = logEntries.length;
  const final = parseSse((await exchangeRaw(searchRequest(), { 'session-id': 'many-searches' })).rawBody).at(-1);
  assert.equal(forwarded.length - before, 9, 'the first response and eight searches, no continuation');
  assert.equal(final.response.output.length, 8);
  assert.ok(final.response.output.every(item => item.type === 'web_search_call'));
  assert.ok(parsedLogEntries().slice(logsBefore).some(entry => entry.event === 'web_search.limit_reached' && entry.dropped === 1));
});

test('stored search results expire while the router runs', async t => {
  mockUpstreamSequence(t, [
    { status: 200, contentType: 'text/event-stream', body: webSearchFirstResponse() },
    webSearchResult(200),
    { status: 200, contentType: 'text/event-stream', body: continuationResponse },
    { status: 200, contentType: 'text/event-stream', body: continuationResponse },
  ]);
  await exchangeRaw(searchRequest(), { 'session-id': 'expiring-session' });
  const searched = { type: 'web_search_call', id: 'call_search', status: 'completed', action: { type: 'search', query: 'openai codex contributors' } };
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 31 * 24 * 60 * 60 * 1000 });
  await exchangeRaw(searchRequest([searched, answer]), { 'session-id': 'expiring-session' });
  t.mock.timers.reset();
  assert.match(forwarded.at(-1).body.input[1].output, /^The results of this search are not available any more\./);
  const stored = JSON.parse(readFileSync(join(routerHome, 'web-search-results.json'), 'utf8'));
  assert.equal(stored[JSON.stringify(['expiring-session', 'call_search'])], undefined, 'expired results leave the file too');
});

test('a refused continuation ends the response as the first request would: retried, compacted, or with the provider\'s diagnostic', async t => {
  const error = message => JSON.stringify({ error: { message } });
  mockUpstreamSequence(t, [
    { status: 200, contentType: 'text/event-stream', body: webSearchFirstResponse() }, webSearchResult(200),
    { status: 429, body: error('Rate limit exceeded') },
    { status: 200, contentType: 'text/event-stream', body: webSearchFirstResponse() }, webSearchResult(200),
    { status: 413, body: error('Payload too large') },
    { status: 200, body: JSON.stringify({ id: 'resp_claude', output: [] }) },
    { status: 200, contentType: 'text/event-stream', body: webSearchFirstResponse() }, webSearchResult(200),
    { status: 404, body: error('0 endpoints out of 39 requested are available matching your guardrail restrictions and data policy.') },
  ]);
  const final = async headers => parseSse((await exchangeRaw(searchRequest(), headers)).rawBody).at(-1);
  const limited = await final();
  assert.equal(limited.type, 'response.failed');
  assert.equal(limited.response.error.code, 'rate_limit_exceeded');
  const oversized = await final();
  assert.equal(oversized.response.error.code, 'context_length_exceeded');
  await send({ model: 'openrouter/anthropic/claude-sonnet-5.5', input: 'Hello' }, inClaudeSession('continuation-policy'));
  const policy = await final(inClaudeSession('continuation-policy'));
  assert.equal(policy.type, 'response.completed');
  assert.match(policy.response.output.at(-1).content[0].text, /go only to endpoints that do not collect data/);
});

test('a continuation the upstream fails with an oversized server error ends the response so Codex retries', async t => {
  mockUpstreamSequence(t, [
    { status: 200, contentType: 'text/event-stream', body: webSearchFirstResponse() },
    webSearchResult(200),
    { status: 500, body: 'x'.repeat(512 * 1024) },
  ]);
  const result = await exchangeRaw(searchRequest());
  assert.equal(result.status, 200);
  const final = parseSse(result.rawBody).at(-1);
  assert.equal(final.type, 'response.failed');
  assert.equal(final.response.error.code, 'server_error');
  assert.deepEqual(final.response.output.map(item => item.type), ['web_search_call']);
});

test('restored searches keep a step\'s calls together, ahead of their outputs', async () => {
  const exec = { type: 'function_call', call_id: 'call_exec', name: 'exec_command', arguments: '{}' };
  const reasoning = { type: 'reasoning', id: 'rs_step', summary: [], content: [{ type: 'reasoning_text', text: 'Check both.' }] };
  const search = id => ({ type: 'web_search_call', id, status: 'completed', action: { type: 'search', query: id } });
  const upstream = await send({ model: 'deepseek/deepseek-v4.1-flash-1017', tools: [{ type: 'web_search' }], input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check.' }] }, reasoning, exec, search('ws_one'), search('ws_two'),
    { type: 'function_call_output', call_id: 'call_exec', output: 'ok' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'And?' }] }] });
  assert.deepEqual(upstream.body.input.map(item => item.call_id ? `${item.type}:${item.call_id}` : item.type), [
    'message', 'reasoning', 'function_call:call_exec', 'function_call:ws_one', 'function_call:ws_two',
    'function_call_output:call_exec', 'function_call_output:ws_one', 'function_call_output:ws_two', 'message']);
});

test('a step\'s calls reach OpenRouter as one turn across the reasoning between them, ahead of their outputs', async () => {
  const reasoning = id => ({ type: 'reasoning', id, summary: [], content: [{ type: 'reasoning_text', text: id }] });
  const call = id => ({ type: 'function_call', call_id: id, name: 'exec_command', arguments: '{}' });
  const output = id => ({ type: 'function_call_output', call_id: id, output: id });
  const upstream = await send({ model: 'openrouter/anthropic/claude-sonnet-5.5', input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check.' }] },
    reasoning('rs_one'), call('one'), reasoning('rs_two'), call('two'), output('two'), output('one'),
    // A later step starts after the outputs and stays separate.
    reasoning('rs_three'), call('three'), output('three'), reasoning('rs_four'), call('four'), output('four')] });
  assert.deepEqual(upstream.body.input.map(item => `${item.type}:${item.call_id ?? item.id ?? item.role}`), [
    'message:user', 'reasoning:rs_one', 'function_call:one', 'reasoning:rs_two', 'function_call:two',
    'function_call_output:one', 'function_call_output:two',
    'reasoning:rs_three', 'function_call:three', 'function_call_output:three',
    'reasoning:rs_four', 'function_call:four', 'function_call_output:four']);
});

test('native OpenAI requests keep the hosted web_search tool', async () => {
  const upstream = await send({ model: 'gpt-6-astra', input: 'Hello', tools: [{ type: 'web_search' }] });
  assert.deepEqual(upstream.body.tools, [{ type: 'web_search' }]);
});

test('whole-number floats in OpenRouter tool arguments reach Codex as integers, and nothing else changes', async t => {
  const sent = '{"cmd":"sleep 1","timeout_ms":60000.0,"offset":-3.0,"label":"v1.0 \\"60.0\\"","ratio":0.5,"scale":1.50,"big":2.0e3}';
  const expected = '{"cmd":"sleep 1","timeout_ms":60000,"offset":-3,"label":"v1.0 \\"60.0\\"","ratio":0.5,"scale":1.50,"big":2.0e3}';
  const call = { type: 'function_call', id: 'fc_wait', call_id: 'call_wait', name: 'exec_command', arguments: sent, status: 'completed' };
  mockUpstreamSequence(t, [{ status: 200, contentType: 'text/event-stream', body: sse([
    { type: 'response.created', response: { id: 'resp_float', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_wait', output_index: 0, delta: sent },
    { type: 'response.function_call_arguments.done', item_id: 'fc_wait', output_index: 0, arguments: sent },
    { type: 'response.output_item.done', output_index: 0, item: call },
    { type: 'response.completed', response: { id: 'resp_float', status: 'completed', output: [call] } }]) }]);
  const before = logEntries.length;
  const result = await exchangeRaw(JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash-1017', input: 'Wait.', stream: true }));
  const events = parseSse(result.rawBody);
  // Codex parses the finished copy; the streamed delta stays as sent.
  assert.equal(events.find(event => event.type === 'response.function_call_arguments.delta').delta, sent);
  assert.equal(events.find(event => event.type === 'response.function_call_arguments.done').arguments, expected);
  assert.equal(events.find(event => event.type === 'response.output_item.done').item.arguments, expected);
  assert.equal(events.at(-1).response.output[0].arguments, expected);
  assert.ok(parsedLogEntries().slice(before).some(entry => entry.event === 'tool_arguments.normalized' && entry.name === 'exec_command'));
});

// Claude on Anthropic's API: the router translates Codex's Responses requests
// to Messages requests and Claude's streamed events back. The tests that
// switch a request to OpenRouter come last, because a refusal holds new
// sessions on OpenRouter for an hour.
const anthropicSse = events => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
const claudeThinking = (thinking, signature) => ({ type: 'reasoning', id: `rs_${signature}`, summary: [{ type: 'summary_text', text: thinking }],
  encrypted_content: `codex-router-anthropic-thinking:v1:${Buffer.from(JSON.stringify({ type: 'thinking', thinking, signature })).toString('base64url')}` });
const claudeStream = (blocks, { stopReason = 'end_turn', stopDetails, usage = {} } = {}) => anthropicSse([
  { type: 'message_start', message: { id: 'msg_claude', model: 'claude-sonnet-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 100,
    cache_creation_input_tokens: 20, output_tokens: 1, ...usage } } },
  ...blocks.flatMap((block, index) => [
    { type: 'content_block_start', index, content_block: block.start },
    ...(block.deltas ?? []).map(delta => ({ type: 'content_block_delta', index, delta })),
    { type: 'content_block_stop', index }]),
  { type: 'message_delta', delta: { stop_reason: stopReason, ...(stopDetails ? { stop_details: stopDetails } : {}) }, usage: { output_tokens: 30 } },
  { type: 'message_stop' },
]);
const claudeRequest = (input, extra = {}) => JSON.stringify({ model: 'anthropic/claude-sonnet-5-5', stream: true, input,
  tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }], ...extra });
const inClaudeSession = id => ({ 'session-id': id, 'thread-id': id });

test('Claude slugs run on Anthropic\'s API as Messages requests with the history in Claude\'s turns', async () => {
  const developer = text => ({ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] });
  const user = text => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
  const call = (callId, name, args, namespace) => ({ type: 'function_call', call_id: callId, name, arguments: args, ...(namespace ? { namespace } : {}) });
  const output = (callId, value) => ({ type: 'function_call_output', call_id: callId, output: value });
  const upstream = await send({
    model: 'anthropic/claude-sonnet-5-5',
    reasoning: { effort: 'minimal', summary: 'auto' },
    parallel_tool_calls: true,
    tools: [
      { type: 'function', name: 'exec_command', description: 'Run a command.', strict: false, parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
      { type: 'namespace', name: 'multi_agent_v1', description: 'Agents.', tools: [
        { type: 'function', name: 'spawn_agent', description: 'Spawn.', parameters: { type: 'object', properties: { message: { type: 'string' } } } }] },
      { type: 'web_search', external_web_access: false },
    ],
    input: [
      developer('Base instructions.'), developer('Permissions.'), user('Context.'), user('Spawn a helper and list files.'),
      claudeThinking('Plan both.', 'sig-a'), call('toolu_spawn', 'spawn_agent', '{"message":"help"}', 'multi_agent_v1'),
      claudeThinking('Now list.', 'sig-b'), call('toolu_ls', 'exec_command', '{"cmd":"ls"}'), call('call:lost', 'exec_command', '{}'),
      output('toolu_spawn', 'spawned'), output('toolu_ls', [{ type: 'input_text', text: 'a.txt' },
        { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0K' }]), output('call_ghost', 'orphan'),
      deepseekReasoning,
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done: a.txt.' }] },
      developer('Mode changed.'), user('Thanks.'),
    ],
  }, inClaudeSession('claude-translate'));
  assert.equal(upstream.hostname, 'api.anthropic.com');
  assert.equal(upstream.path, '/v1/messages');
  assert.equal(upstream.headers['x-api-key'], 'test-anthropic-key');
  assert.equal(upstream.headers['anthropic-version'], '2026-10-21');
  assert.equal(upstream.headers['anthropic-beta'], 'thinking-binding-controls-2026-08-01');
  // Codex's ChatGPT credentials never reach Anthropic.
  assert.equal(upstream.headers.authorization, undefined);
  assert.equal(upstream.headers['chatgpt-account-id'], undefined);
  const { body } = upstream;
  assert.equal(body.model, 'claude-sonnet-5-5');
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 64000);
  assert.deepEqual(body.cache_control, { type: 'ephemeral' });
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
  // Claude cannot turn thinking off, so the lowest efforts become low.
  assert.deepEqual(body.output_config, { effort: 'low' });
  assert.deepEqual(body.tool_choice, { type: 'auto' });
  assert.deepEqual(body.tools.map(tool => tool.name), ['exec_command', 'multi_agent_v1__spawn_agent', 'web_search']);
  assert.deepEqual(body.tools[0], { name: 'exec_command', description: 'Run a command.', input_schema: { type: 'object', properties: { cmd: { type: 'string' } } } });
  // Codex's opening developer messages join the system prompt; a later one sits just before Claude's turn.
  assert.deepEqual(body.system, [{ type: 'text', text: 'Base instructions.' }, { type: 'text', text: 'Permissions.' }]);
  assert.deepEqual(body.messages, [
    { role: 'user', content: [{ type: 'text', text: 'Context.' }, { type: 'text', text: 'Spawn a helper and list files.' }] },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 'Plan both.', signature: 'sig-a' },
      { type: 'tool_use', id: 'toolu_spawn', name: 'multi_agent_v1__spawn_agent', input: { message: 'help' } },
      { type: 'thinking', thinking: 'Now list.', signature: 'sig-b' },
      { type: 'tool_use', id: 'toolu_ls', name: 'exec_command', input: { cmd: 'ls' } }] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_spawn', content: 'spawned' },
      { type: 'tool_result', tool_use_id: 'toolu_ls', content: [{ type: 'text', text: 'a.txt' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K' } }] }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Done: a.txt.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Thanks.' }] },
    { role: 'system', content: [{ type: 'text', text: 'Mode changed.' }] },
  ]);
  const routes = JSON.parse(readFileSync(join(routerHome, 'claude-routes.json'), 'utf8'));
  assert.equal(routes['claude-translate'].route, 'anthropic');
});

test('a caller can put Claude\'s cache breakpoint at the end of its instructions, or set none; Codex\'s stays as it was', async () => {
  const request = JSON.parse(claudeRequest('Classify this line.', { instructions: 'Shared rubric.' }));
  const marked = value => JSON.stringify(value).includes('cache_control');
  const codex = await send(request);
  assert.deepEqual(codex.body.cache_control, { type: 'ephemeral' });
  assert.deepEqual(codex.body.system, [{ type: 'text', text: 'Shared rubric.' }]);
  const before = parsedLogEntries().length;
  const shared = await send(request, { 'x-codex-router-prompt-cache': 'instructions' });
  assert.equal(shared.hostname, 'api.anthropic.com');
  assert.equal(shared.body.cache_control, undefined);
  assert.deepEqual(shared.body.system, [{ type: 'text', text: 'Shared rubric.', cache_control: { type: 'ephemeral' } }]);
  assert.ok(!marked(shared.body.messages));
  assert.equal(shared.headers['x-codex-router-prompt-cache'], undefined);
  assert.equal(parsedLogEntries().slice(before).find(entry => entry.event === 'request.forwarded').promptCache, 'instructions');
  // Without instructions there is nothing to mark, and the log says so; "none" marks nothing.
  const bareLogs = parsedLogEntries().length;
  const bare = await send(JSON.parse(claudeRequest('Classify this line.')), { 'x-codex-router-prompt-cache': 'instructions' });
  assert.ok(!marked(bare.body));
  assert.equal(parsedLogEntries().slice(bareLogs).find(entry => entry.event === 'request.forwarded').promptCachingAdded, false);
  // Opening developer messages form the system prompt, so its end gets the breakpoint.
  const opening = await send(JSON.parse(claudeRequest([
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Shared rubric.' }] },
    { role: 'user', content: 'Classify this line.' },
  ])), { 'x-codex-router-prompt-cache': 'instructions' });
  assert.deepEqual(opening.body.system, [{ type: 'text', text: 'Shared rubric.', cache_control: { type: 'ephemeral' } }]);
  assert.ok(!marked((await send(request, { 'x-codex-router-prompt-cache': 'none' })).body));
  // OpenRouter takes only a breakpoint over the whole prompt, so either mode leaves it off
  // there, a breakpoint in the caller's own body included.
  for (const mode of ['instructions', 'none']) {
    const openrouter = await send({ ...request, model: 'openrouter/anthropic/claude-sonnet-5.5',
      cache_control: { type: 'ephemeral', ttl: '1h' } }, { 'x-codex-router-prompt-cache': mode });
    assert.equal(openrouter.hostname, 'openrouter.ai');
    assert.equal(openrouter.body.cache_control, undefined);
    assert.equal(openrouter.headers['x-codex-router-prompt-cache'], undefined);
  }
  const health = await exchange('', {}, { method: 'GET', url: '/health' });
  assert.deepEqual(health.body.capabilities.promptCacheModes, ['instructions', 'none']);
  const count = forwarded.length;
  const unknown = await exchange(JSON.stringify(request), { 'x-codex-router-prompt-cache': 'everything' });
  assert.equal(unknown.status, 400);
  assert.equal(forwarded.length, count);
});

test('a step\'s tool output ends Claude\'s turn, so the next request extends the same prefix', async () => {
  const first = [{ role: 'user', content: 'List files.' }, claudeThinking('List.', 'sig-c'),
    { type: 'function_call', call_id: 'toolu_one', name: 'exec_command', arguments: '{"cmd":"ls"}' },
    { type: 'function_call_output', call_id: 'toolu_one', output: 'a.txt' }];
  const before = (await send(JSON.parse(claudeRequest(first)))).body.messages;
  const after = (await send(JSON.parse(claudeRequest([...first,
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'One file.' }] },
    { role: 'user', content: 'Thanks.' }])))).body.messages;
  assert.deepEqual(after.slice(0, before.length), before);
  assert.deepEqual(after.slice(before.length).map(message => message.role), ['assistant', 'user']);
});

test('Claude\'s stream reaches Codex as Responses events, and its signed thinking comes back unchanged', async t => {
  mockUpstreamSequence(t, [
    { status: 200, contentType: 'text/event-stream', body: claudeStream([
      { start: { type: 'thinking', thinking: '', signature: '' }, deltas: [{ type: 'thinking_delta', thinking: 'Plan ' },
        { type: 'thinking_delta', thinking: 'it.' }, { type: 'signature_delta', signature: 'sig-live' }] },
      { start: { type: 'text', text: '' }, deltas: [{ type: 'text_delta', text: 'On it.' }] },
      { start: { type: 'tool_use', id: 'toolu_live', name: 'multi_agent_v1__spawn_agent', input: {} },
        deltas: [{ type: 'input_json_delta', partial_json: '{"message":' }, { type: 'input_json_delta', partial_json: '"go"}' }] },
    ], { stopReason: 'tool_use' }) },
    { status: 200, contentType: 'application/json', body: '{}' },
    { status: 200, contentType: 'application/json', body: '{}' },
    { status: 200, contentType: 'application/json', body: '{}' },
  ]);
  const tools = [{ type: 'namespace', name: 'multi_agent_v1', tools: [{ type: 'function', name: 'spawn_agent', parameters: { type: 'object' } }] }];
  const result = await exchangeRaw(claudeRequest('Spawn.', { tools }));
  assert.equal(result.status, 200);
  const events = parseSse(result.rawBody);
  assert.equal(events[0].type, 'response.created');
  // Every item is announced before its deltas, which Codex requires.
  const added = events.filter(event => event.type === 'response.output_item.added').map(event => event.item.type);
  assert.deepEqual(added, ['reasoning', 'message', 'function_call']);
  assert.deepEqual(events.filter(event => event.type === 'response.reasoning_summary_text.delta').map(event => event.delta), ['Plan ', 'it.']);
  const done = events.filter(event => event.type === 'response.output_item.done').map(event => event.item);
  assert.deepEqual(done[0].summary, [{ type: 'summary_text', text: 'Plan it.' }]);
  assert.match(done[0].encrypted_content, /^codex-router-anthropic-thinking:v1:/);
  assert.deepEqual(done[1].content, [{ type: 'output_text', text: 'On it.', annotations: [] }]);
  // Codex dispatches a grouped tool by its namespace and name.
  assert.equal(done[2].name, 'spawn_agent');
  assert.equal(done[2].namespace, 'multi_agent_v1');
  assert.equal(done[2].call_id, 'toolu_live');
  assert.equal(done[2].arguments, '{"message":"go"}');
  const completed = events.at(-1);
  assert.equal(completed.type, 'response.completed');
  assert.deepEqual(completed.response.usage, { input_tokens: 130, input_tokens_details: { cached_tokens: 100, cache_write_tokens: 20 },
    output_tokens: 30, total_tokens: 160 });

  // Codex sends the items back; Claude gets its turn back unchanged, and no other upstream sees the thinking.
  const history = [{ role: 'user', content: 'Spawn.' }, ...done, { type: 'function_call_output', call_id: 'toolu_live', output: 'ok' }];
  await exchange(claudeRequest(history, { tools }));
  assert.deepEqual(forwarded.at(-1).body.messages[1].content, [
    { type: 'thinking', thinking: 'Plan it.', signature: 'sig-live' },
    { type: 'text', text: 'On it.' },
    { type: 'tool_use', id: 'toolu_live', name: 'multi_agent_v1__spawn_agent', input: { message: 'go' } },
  ]);
  for (const model of ['gpt-6-astra', 'deepseek/deepseek-v4.1-flash-1017']) {
    await exchange(JSON.stringify({ model, input: history }));
    assert.ok(!forwarded.at(-1).body.input.some(item => item.type === 'reasoning'), model);
  }
});

test('Claude\'s stop reasons and stream errors end the response the way Codex expects', async t => {
  const text = { start: { type: 'text', text: '' }, deltas: [{ type: 'text_delta', text: 'Partial' }] };
  mockUpstreamSequence(t, [
    { status: 200, contentType: 'text/event-stream', body: claudeStream([text], { stopReason: 'max_tokens' }) },
    { status: 200, contentType: 'text/event-stream', body: claudeStream([], { stopReason: 'refusal', stopDetails: { type: 'refusal', category: 'cyber' } }) },
    { status: 200, contentType: 'text/event-stream', body: claudeStream([text], { stopReason: 'model_context_window_exceeded' }) },
    { status: 200, contentType: 'text/event-stream', body: anthropicSse([
      { type: 'message_start', message: { id: 'msg_err', usage: { input_tokens: 5 } } },
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]) },
  ]);
  const final = async () => parseSse((await exchangeRaw(claudeRequest('Go.'))).rawBody).at(-1);
  const incomplete = await final();
  assert.equal(incomplete.type, 'response.incomplete');
  assert.deepEqual(incomplete.response.incomplete_details, { reason: 'max_output_tokens' });
  const refused = await final();
  assert.equal(refused.type, 'response.completed');
  assert.match(refused.response.output.at(-1).content[0].text, /Claude declined to continue this request \(cyber\)/);
  const overflow = await final();
  assert.equal(overflow.type, 'response.failed');
  assert.equal(overflow.response.error.code, 'context_length_exceeded');
  // Codex retries other failures with backoff.
  const failed = await final();
  assert.equal(failed.type, 'response.failed');
  assert.equal(failed.response.error.code, 'server_error');
});

test('Claude\'s rejections: an overflow compacts, another 400 retries once without thinking, and rate limits pass through', async t => {
  const error = (type, message, extra = {}) => JSON.stringify({ type: 'error', error: { type, message, ...extra } });
  mockUpstreamSequence(t, [
    { status: 400, body: error('invalid_request_error', 'prompt is too long: 1000001 tokens > 1000000 maximum') },
    { status: 400, body: error('invalid_request_error', 'messages.1.content.0: Invalid `signature` in `thinking` block') },
    { status: 400, body: error('invalid_request_error', 'still invalid') },
    { status: 429, body: error('rate_limit_error', 'Slow down'), headers: { 'retry-after': '7' } },
  ]);
  const history = [{ role: 'user', content: 'Go.' }, claudeThinking('Think.', 'sig-bad'),
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Went.' }] }, { role: 'user', content: 'Again.' }];
  const overflow = parseSse((await exchangeRaw(claudeRequest(history))).rawBody).at(-1);
  assert.equal(overflow.response.error.code, 'context_length_exceeded');
  const result = await exchangeRaw(claudeRequest(history));
  assert.equal(result.status, 200);
  assert.equal(result.headers['x-codex-router-diagnostic'], 'anthropic-request-rejected');
  assert.match(parseSse(result.rawBody).find(event => event.type === 'response.output_item.done').item.content[0].text, /Anthropic rejected this step/);
  // The retry left out the signed thinking.
  assert.ok(forwarded.at(-2).body.messages[1].content.some(block => block.type === 'thinking'));
  assert.ok(!forwarded.at(-1).body.messages[1].content.some(block => block.type === 'thinking'));
  const limited = await exchangeRaw(claudeRequest('Go.'));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '7');
});

test('a session keeps its Claude route, and Claude stays apart from the training tier', async () => {
  await send({ model: 'openrouter/anthropic/claude-sonnet-5.5', input: 'Hello' }, inClaudeSession('claude-sticky'));
  const continued = await send({ model: 'anthropic/claude-sonnet-5-5', input: 'Hello' }, inClaudeSession('claude-sticky'));
  assert.equal(continued.hostname, 'openrouter.ai');
  assert.equal(continued.body.model, 'anthropic/claude-sonnet-5.5');
  assert.deepEqual(continued.body.cache_control, { type: 'ephemeral' });
  await send({ model: 'anthropic/claude-opus-5-5', input: 'Hello' }, inClaudeSession('claude-isolated'));
  const refusal = await exchange(JSON.stringify({ model: 'openrouter/meta/muse-spark-1.3-contributor', input: 'Hello' }),
    inClaudeSession('claude-isolated'));
  assert.equal(refusal.status, 409);
  assert.match(refusal.body.error.message, /already used a Claude model/);
});

test('web search on Claude\'s direct route runs through OpenRouter and continues on Anthropic\'s API', async t => {
  mockUpstreamSequence(t, [
    { status: 200, contentType: 'text/event-stream', body: claudeStream([{ start: { type: 'tool_use', id: 'toolu_search', name: 'web_search', input: {} },
      deltas: [{ type: 'input_json_delta', partial_json: '{"query":"openai codex contributors"}' }] }], { stopReason: 'tool_use' }) },
    webSearchResult(200),
    { status: 200, contentType: 'text/event-stream', body: claudeStream([{ start: { type: 'text', text: '' },
      deltas: [{ type: 'text_delta', text: 'GitHub lists 688 contributors.' }] }]) },
  ]);
  const result = await exchangeRaw(claudeRequest('How many contributors?', { tools: [{ type: 'web_search' }] }), inClaudeSession('claude-search'));
  const events = parseSse(result.rawBody);
  assert.ok(events.some(event => event.type === 'response.output_item.done' && event.item.type === 'web_search_call'));
  assert.equal(events.at(-1).type, 'response.completed');
  const [first, search, continuation] = forwarded.slice(-3);
  assert.equal(first.hostname, 'api.anthropic.com');
  assert.equal(search.hostname, 'openrouter.ai');
  assert.equal(search.body.model, 'anthropic/claude-sonnet-5.5');
  assert.equal(continuation.hostname, 'api.anthropic.com');
  assert.deepEqual(continuation.body.messages.slice(1).map(message => message.content.map(block => block.type)), [['tool_use'], ['tool_result']]);
  assert.match(continuation.body.messages[2].content[0].content, /688 contributors/);
});

// OpenRouter ends its streams with `[DONE]` after the final event.
const finalEventFor = id => `data: {"type":"response.output_text.delta","delta":"OK"}\n\n`
  + `data: {"type":"response.completed","response":{"id":"${id}","status":"completed"}}\n\ndata: [DONE]\n\n`;
const sseEventsOf = rawBody => rawBody.split(/\r?\n/).filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
  .map(line => JSON.parse(line.slice('data: '.length)));

test('X-Codex-Router-Report: provider marks the final event at once, and the lookup answers later', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  mockUpstreamSequence(t, [
    { status: 200, contentType: 'text/event-stream', body: finalEventFor('gen-1793-served') },
    { status: 429, body: JSON.stringify({ error: { message: 'Rate limited' } }) },
    { status: 200, body: JSON.stringify({ data: { provider_name: 'Fireworks', model: 'deepseek/deepseek-v4.1-flash-20261017' } }) },
  ]);
  const count = forwarded.length;
  const result = await exchangeRaw(JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash-1017', input: 'Hello', stream: true }),
    { 'x-codex-router-report': 'provider', 'x-codex-router-endpoints': 'fireworks' });
  const events = sseEventsOf(result.rawBody);
  assert.equal(events[0].delta, 'OK');
  // OpenRouter names no provider, so the stream says so without waiting; one pinned endpoint is the one that served.
  assert.equal(events.at(-1).response.provider, 'unknown');
  assert.equal(events.at(-1).response.endpoint, 'fireworks');
  assert.match(result.rawBody, /"endpoint":"fireworks"[^\n]*\n\ndata: \[DONE\]\n\n$/);
  assert.equal(forwarded.length, count + 1);
  // The router looks the generation up only when asked, with its own key. Two polls at once
  // share one lookup, and a rate limit leaves the generation pending.
  const lookup = url => exchange('', {}, { method: 'GET', url });
  const pending = { id: 'gen-1793-served', status: 'pending', provider: 'unknown' };
  const polls = await Promise.all([lookup('/v1/generations/gen-1793-served'), lookup('/v1/generations/gen-1793-served')]);
  assert.deepEqual(polls.map(poll => poll.body), [pending, pending]);
  assert.equal(forwarded.length, count + 2);
  const request = forwarded.at(-1);
  assert.equal(request.method, 'GET');
  assert.equal(request.path, '/api/v1/generation?id=gen-1793-served');
  assert.equal(request.headers.authorization, 'Bearer test-openrouter-key');
  // Within a few seconds another poll does not ask OpenRouter again.
  assert.deepEqual((await lookup('/v1/generations/gen-1793-served')).body, pending);
  assert.equal(forwarded.length, count + 2);
  t.mock.timers.tick(6000);
  assert.deepEqual((await lookup('/v1/generations/gen-1793-served')).body,
    { id: 'gen-1793-served', status: 'resolved', provider: 'Fireworks' });
  // A resolved answer is kept, so it costs no further lookup.
  const lookups = forwarded.length;
  t.mock.timers.tick(6000);
  assert.equal((await lookup('/v1/generations/gen-1793-served')).body.provider, 'Fireworks');
  assert.equal(forwarded.length, lookups);
  assert.equal((await lookup('/v1/generations/gen-1793-never')).status, 404);
  assert.equal((await lookup('/v1/generations/%ZZ')).status, 400);
  assert.equal((await exchange('', { 'x-codex-router-token': 'wrong' }, { method: 'GET', url: '/v1/generations/gen-1793-served' })).status, 401);
  const health = await exchange('', {}, { method: 'GET', url: '/health' });
  assert.deepEqual(health.body.capabilities.reports, ['provider']);
  assert.equal(health.body.capabilities.generationLookup, true);
});

test('the served-by report is absent unless asked for, and names Anthropic on its own route at once', async t => {
  mockUpstreamSequence(t, [
    { status: 200, contentType: 'text/event-stream', body: finalEventFor('gen-1793-plain') },
    { status: 200, contentType: 'text/event-stream', body: finalEventFor('gen-1793-two-pins')
      .replace('data: {"type":"response.completed"', 'id: 7\nevent: response.completed\ndata: {"type":"response.completed"') },
    { status: 200, contentType: 'text/event-stream', body: claudeStream([{ start: { type: 'text', text: '' },
      deltas: [{ type: 'text_delta', text: 'OK' }] }]) },
  ]);
  const deepseek = JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash-1017', input: 'Hello', stream: true });
  const plain = sseEventsOf((await exchangeRaw(deepseek)).rawBody);
  assert.equal(Object.hasOwn(plain.at(-1).response, 'provider'), false);
  // With two pinned endpoints either may have served, so no endpoint is named.
  const twoPinsRaw = (await exchangeRaw(deepseek, { 'x-codex-router-report': 'provider',
    'x-codex-router-endpoints': 'deepinfra/fp8,fireworks' })).rawBody;
  // The final event keeps its other lines; only its data changes.
  assert.match(twoPinsRaw, /\nid: 7\nevent: response\.completed\ndata: \{[^\n]*"provider":"unknown"/);
  const twoPins = sseEventsOf(twoPinsRaw);
  assert.equal(twoPins.at(-1).response.provider, 'unknown');
  assert.equal(Object.hasOwn(twoPins.at(-1).response, 'endpoint'), false);
  const count = forwarded.length;
  const claude = parseSse((await exchangeRaw(claudeRequest('Hello'), { 'x-codex-router-report': 'provider' })).rawBody);
  assert.equal(claude.at(-1).response.provider, 'Anthropic');
  assert.equal(forwarded.length, count + 1);
  assert.equal((await exchange(deepseek, { 'x-codex-router-report': 'everything' })).status, 400);
});

test('a reported search follows the answer\'s generation, pins its search, and names no endpoint on a router answer', async t => {
  mockUpstreamSequence(t, [
    { status: 200, contentType: 'text/event-stream', body: webSearchFirstResponse().replaceAll('resp_first', 'gen-first') },
    webSearchResult(200),
    { status: 200, contentType: 'text/event-stream', body: continuationResponse.replaceAll('resp_second', 'gen-second') },
    { status: 200, body: JSON.stringify({ data: { provider_name: 'Fireworks' } }) },
    { status: 200, contentType: 'text/event-stream', body: webSearchFirstResponse().replaceAll('resp_first', 'gen-third') },
    webSearchResult(200),
    { status: 403, body: JSON.stringify({ error: { message: 'Forbidden' } }) },
  ]);
  const headers = { 'x-codex-router-report': 'provider', 'x-codex-router-endpoints': 'fireworks' };
  const result = await exchangeRaw(searchRequest(), headers);
  const final = sseEventsOf(result.rawBody).at(-1);
  assert.equal(final.response.id, 'gen-first');
  assert.equal(final.response.endpoint, 'fireworks');
  // The pin covers the router's own search too.
  const [, search] = forwarded.slice(-3);
  assert.deepEqual(search.body.provider, { order: ['fireworks'], allow_fallbacks: false });
  // Codex sees the first response's id, but the answer came from the continuation's generation.
  const report = await exchange('', {}, { method: 'GET', url: '/v1/generations/gen-first' });
  assert.equal(report.body.provider, 'Fireworks');
  assert.equal(forwarded.at(-1).path, '/api/v1/generation?id=gen-second');
  // A continuation OpenRouter refuses ends in the router's own answer, which no endpoint served.
  const refused = sseEventsOf((await exchangeRaw(searchRequest(), headers)).rawBody).at(-1);
  assert.equal(refused.response.provider, 'unknown');
  assert.equal(Object.hasOwn(refused.response, 'endpoint'), false);
  assert.equal((await exchange('', {}, { method: 'GET', url: '/v1/generations/gen-third' })).status, 404);
});

test('a caller\'s cache breakpoint holds on the step after the router\'s search', async t => {
  mockUpstreamSequence(t, [
    { status: 200, contentType: 'text/event-stream', body: claudeStream([{ start: { type: 'tool_use', id: 'toolu_search', name: 'web_search', input: {} },
      deltas: [{ type: 'input_json_delta', partial_json: '{"query":"openai codex contributors"}' }] }], { stopReason: 'tool_use' }) },
    webSearchResult(200),
    { status: 200, contentType: 'text/event-stream', body: claudeStream([{ start: { type: 'text', text: '' },
      deltas: [{ type: 'text_delta', text: 'GitHub lists 688 contributors.' }] }]) },
  ]);
  const result = await exchangeRaw(claudeRequest('How many contributors?', { instructions: 'Shared rubric.', tools: [{ type: 'web_search' }] }),
    { 'x-codex-router-prompt-cache': 'instructions' });
  assert.equal(parseSse(result.rawBody).at(-1).type, 'response.completed');
  const [first, , continuation] = forwarded.slice(-3);
  for (const step of [first, continuation]) {
    assert.equal(step.hostname, 'api.anthropic.com');
    assert.equal(step.body.cache_control, undefined);
    assert.deepEqual(step.body.system.at(-1).cache_control, { type: 'ephemeral' });
  }
});

test('Claude history survives shapes other models leave: the functions namespace, odd call IDs, other image types, and a closing reply', async () => {
  const history = [
    { role: 'user', content: [{ type: 'input_text', text: 'Look.' }, { type: 'input_image', image_url: 'data:image/tiff;base64,SUkqAA' }] },
    // A native model records top-level calls under the `functions` namespace, which Codex treats as none.
    { type: 'function_call', call_id: 'a:b', name: 'exec_command', namespace: 'functions', arguments: '{"cmd":"ls"}' },
    { type: 'function_call', call_id: 'a/b', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
    { type: 'function_call_output', call_id: 'a:b', output: 'one' },
    { type: 'function_call_output', call_id: 'a/b', output: 'two' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Both ran.' }] },
  ];
  const { body } = await send(JSON.parse(claudeRequest(history)));
  assert.deepEqual(body.messages[0].content[1], { type: 'text', text: '[image omitted: Claude does not read image/tiff]' });
  const calls = body.messages[1].content;
  assert.deepEqual(calls.map(block => block.name), ['exec_command', 'exec_command']);
  // Each ID Claude cannot take becomes its own valid ID, and its result follows it.
  const ids = calls.map(block => block.id);
  assert.notEqual(ids[0], ids[1]);
  for (const id of ids) assert.match(id, /^[a-zA-Z0-9_-]+$/);
  assert.deepEqual(body.messages[2].content.map(block => block.tool_use_id), ids);
  // The same history maps IDs the same way, so the prefix holds.
  assert.deepEqual((await send(JSON.parse(claudeRequest(history)))).body.messages[1].content.map(block => block.id), ids);
  // These models reject a request that ends with Claude's own turn.
  assert.deepEqual(body.messages.at(-1), { role: 'user', content: [{ type: 'text', text: '(Continue.)' }] });
});

test('a Claude tool call whose input arrives in its start event keeps that input', async t => {
  mockUpstreamSequence(t, [{ status: 200, contentType: 'text/event-stream', body: claudeStream([
    { start: { type: 'tool_use', id: 'toolu_start', name: 'exec_command', input: { cmd: 'ls' } } }], { stopReason: 'tool_use' }) }]);
  const events = parseSse((await exchangeRaw(claudeRequest('List.'))).rawBody);
  const call = events.find(event => event.type === 'response.output_item.done').item;
  assert.equal(call.arguments, '{"cmd":"ls"}');
});

test('requests too large to send compact the thread, and OpenRouter refusals end in a diagnostic, never a retried status', async t => {
  // Codex retries a 413 with the same bytes and answers a 401 by refreshing its ChatGPT sign-in.
  const oversized = await exchangeRaw(Buffer.alloc(64 * 1024 * 1024 + 1, ' '));
  assert.equal(oversized.status, 200);
  assert.equal(oversized.headers['x-codex-router-diagnostic'], 'router-request-too-large');
  assert.equal(parseSse(oversized.rawBody).at(-1).response.error.code, 'context_length_exceeded');
  mockUpstreamSequence(t, [
    { status: 413, body: JSON.stringify({ type: 'error', error: { type: 'request_too_large', message: 'Request exceeds the maximum allowed number of bytes.' } }) },
    { status: 400, body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 1000001 tokens > 1000000 maximum' } }) },
    { status: 413, body: JSON.stringify({ error: { message: 'Payload too large' } }) },
    { status: 401, body: JSON.stringify({ error: { code: 401, message: 'User not found.' } }) },
  ]);
  for (const [body, diagnostic] of [[claudeRequest('Go.'), 'anthropic-context-overflow'], [claudeRequest('Go.'), 'anthropic-context-overflow'],
    [JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash-1017', input: 'Go.' }), 'openrouter-context-overflow']]) {
    const result = await exchangeRaw(body);
    assert.equal(result.status, 200);
    assert.equal(result.headers['x-codex-router-diagnostic'], diagnostic);
    const failed = parseSse(result.rawBody).at(-1);
    assert.equal(failed.response.error.code, 'context_length_exceeded');
    assert.doesNotMatch(failed.response.error.message, /OpenRouter/);
  }
  const refused = await exchangeRaw(JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash-1017', input: 'Go.' }));
  assert.equal(refused.status, 200);
  assert.equal(refused.headers['x-codex-router-diagnostic'], 'openrouter-request-refused');
  assert.match(parseSse(refused.rawBody).find(event => event.type === 'response.output_item.done').item.content[0].text,
    /OpenRouter refused this request \(HTTP 401\)/);
});

test('a search a thread keeps replaying keeps its results past 30 days', async t => {
  mockUpstreamSequence(t, [
    { status: 200, contentType: 'text/event-stream', body: webSearchFirstResponse() },
    webSearchResult(200),
    { status: 200, contentType: 'text/event-stream', body: continuationResponse },
    { status: 200, contentType: 'text/event-stream', body: webSearchFirstResponse() }, webSearchResult(200),
    { status: 200, contentType: 'text/event-stream', body: continuationResponse },
    { status: 200, body: JSON.stringify({ id: 'resp_replay', output: [] }) },
    { status: 200, body: JSON.stringify({ id: 'resp_replay', output: [] }) },
  ]);
  const session = inClaudeSession('search-replayed');
  await exchangeRaw(searchRequest(), session);
  const replay = async () => {
    await exchange(JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash-1017', input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'How many?' }] },
      { type: 'web_search_call', id: 'call_search', status: 'completed', action: { type: 'search', query: 'openai codex contributors' } },
      answer, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Thanks.' }] }] }), session);
    return forwarded.at(-1).body.input.find(item => item.type === 'function_call_output').output;
  };
  // Each replay restarts the result's 30 days, so a thread active for two months still sees what it found.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 29 * dayMs });
  // Another session's search saves the results just before the replay.
  await exchangeRaw(searchRequest(), inClaudeSession('search-fresh'));
  assert.match(await replay(), /688 contributors/);
  // The renewal is saved at once, so a restart keeps it.
  const saved = Object.entries(JSON.parse(readFileSync(join(routerHome, 'web-search-results.json'), 'utf8')))
    .find(([key]) => key.includes('search-replayed'))[1];
  assert.equal(saved.at, Date.now());
  t.mock.timers.setTime(Date.now() + 29 * dayMs);
  assert.match(await replay(), /688 contributors/);
});

test('after a native OpenAI or Claude model, OpenRouter requests go only to endpoints that do not collect data', async t => {
  const deepseek = { model: 'deepseek/deepseek-v4.1-flash-1017', input: 'Hello' };
  // A session on DeepSeek alone keeps OpenRouter's normal routing.
  assert.equal((await send(deepseek, inClaudeSession('policy-open'))).body.provider, undefined);
  // After Claude, the same model is asked only of endpoints that do not collect data, so a
  // DeepSeek pinned to such an endpoint runs there, and DeepSeek's own endpoint does not qualify.
  await send({ model: 'openrouter/anthropic/claude-sonnet-5.5', input: 'Hello' }, inClaudeSession('policy-claude'));
  assert.deepEqual((await send(deepseek, inClaudeSession('policy-claude'))).body.provider, { data_collection: 'deny' });
  // A configured endpoint order keeps its place beside the policy.
  const pinned = await send({ model: 'openrouter/vendor/pinned', input: 'Hello' }, inClaudeSession('policy-claude'));
  assert.deepEqual(pinned.body.provider, { order: ['google-vertex/us', 'google-ai-studio'], data_collection: 'deny' });
  await send({ model: 'gpt-6-astra', input: 'Hello' }, inClaudeSession('policy-openai'));
  assert.deepEqual((await send(deepseek, inClaudeSession('policy-openai'))).body.provider, { data_collection: 'deny' });
  const logged = parsedLogEntries().findLast(entry => entry.event === 'request.forwarded');
  assert.equal(logged.dataCollection, 'deny');

  // When every endpoint the account allows collects data, Codex gets a diagnostic, not a retried 404.
  mockUpstreamSequence(t, [
    { status: 404, body: JSON.stringify({ error: { code: 404, message: '0 endpoints out of 39 requested are available matching your guardrail restrictions and data policy.' } }) },
    { status: 200, contentType: 'text/event-stream', body: webSearchFirstResponse() },
    webSearchResult(200),
    { status: 200, contentType: 'text/event-stream', body: continuationResponse },
  ]);
  const refused = await exchangeRaw(JSON.stringify(deepseek), inClaudeSession('policy-claude'));
  assert.equal(refused.status, 200);
  assert.equal(refused.headers['x-codex-router-diagnostic'], 'openrouter-data-policy');
  assert.match(parseSse(refused.rawBody).find(event => event.type === 'response.output_item.done').item.content[0].text,
    /go only to endpoints that do not collect data/);
  // The router's own search, which carries a query from the session, follows the same policy.
  await exchangeRaw(searchRequest(), inClaudeSession('policy-claude'));
  const search = forwarded.find(request => Array.isArray(request.body?.plugins) && request.body.input?.[0]?.content?.[0]?.text?.startsWith('Search the web')
    && forwarded.indexOf(request) >= forwarded.length - 3);
  assert.deepEqual(search.body.provider, { data_collection: 'deny' });
});

test('a protected session\'s data policy holds against a caller\'s own provider settings', async () => {
  await send({ model: 'openrouter/anthropic/claude-sonnet-5.5', input: 'Hello' }, inClaudeSession('policy-caller'));
  const overridden = await send({ model: 'deepseek/deepseek-v4.1-flash-1017', input: 'Hello',
    provider: { order: ['deepseek'], data_collection: 'allow' } }, inClaudeSession('policy-caller'));
  assert.deepEqual(overridden.body.provider, { order: ['deepseek'], data_collection: 'deny' });
  // A stricter policy from the caller is kept in any session.
  const strict = await send({ model: 'deepseek/deepseek-v4.1-flash-1017', input: 'Hello',
    provider: { data_collection: 'deny' } }, inClaudeSession('policy-caller-open'));
  assert.deepEqual(strict.body.provider, { data_collection: 'deny' });
});

test('the router\'s search request follows the model\'s configured endpoint order', async t => {
  mockUpstreamSequence(t, [
    { status: 200, contentType: 'text/event-stream', body: webSearchFirstResponse() },
    webSearchResult(200),
    { status: 200, contentType: 'text/event-stream', body: continuationResponse },
  ]);
  await exchangeRaw(JSON.stringify({ model: 'openrouter/vendor/pinned', input: 'Find it.', stream: true, tools: [{ type: 'web_search' }] }));
  const search = forwarded.at(-2);
  assert.ok(Array.isArray(search.body.plugins));
  assert.deepEqual(search.body.provider, { order: ['google-vertex/us', 'google-ai-studio'] });
});

test('a restored search keeps its step as the model saw it: continued alone, or beside the step\'s other calls', async t => {
  const exec = { type: 'function_call', id: 'fc_exec', call_id: 'call_exec', name: 'exec_command', arguments: '{}', status: 'completed' };
  mockUpstreamSequence(t, [
    // A step with a search and another call: Codex runs the call, nothing continues.
    { status: 200, contentType: 'text/event-stream', body: webSearchFirstResponse(exec) }, webSearchResult(200),
    { status: 200, body: JSON.stringify({ id: 'resp_next', output: [] }) },
    // A step of searches alone continues with their results.
    { status: 200, contentType: 'text/event-stream', body: webSearchFirstResponse() }, webSearchResult(200),
    { status: 200, contentType: 'text/event-stream', body: continuationResponse },
    { status: 200, body: JSON.stringify({ id: 'resp_next', output: [] }) },
  ]);
  const reasoning = id => ({ type: 'reasoning', id, summary: [], content: [{ type: 'reasoning_text', text: id }] });
  const search = { type: 'web_search_call', id: 'call_search', status: 'completed', action: { type: 'search', query: 'q' } };
  const later = (session, items) => send({ model: 'deepseek/deepseek-v4.1-flash-1017', tools: [{ type: 'web_search' }],
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check.' }] }, ...items] }, session);
  const order = upstream => upstream.body.input.slice(1).map(item => `${item.type}:${item.call_id ?? item.id}`);

  const mixed = inClaudeSession('restore-mixed');
  await exchangeRaw(searchRequest(), mixed);
  assert.deepEqual(order(await later(mixed, [reasoning('rs_one'), search, reasoning('rs_two'), exec,
    { type: 'function_call_output', call_id: 'call_exec', output: 'ok' }])), [
    'reasoning:rs_one', 'function_call:call_search', 'reasoning:rs_two', 'function_call:call_exec',
    'function_call_output:call_search', 'function_call_output:call_exec']);

  const alone = inClaudeSession('restore-alone');
  await exchangeRaw(searchRequest(), alone);
  assert.deepEqual(order(await later(alone, [search, reasoning('rs_next'), exec,
    { type: 'function_call_output', call_id: 'call_exec', output: 'ok' }])), [
    'function_call:call_search', 'function_call_output:call_search', 'reasoning:rs_next', 'function_call:call_exec',
    'function_call_output:call_exec']);
});

test('the router\'s search never takes over a caller\'s own tool named web_search', async t => {
  // A caller that declares its own top-level web_search keeps it, declared once.
  const own = { type: 'function', name: 'web_search', description: 'Search the docs.', parameters: { type: 'object' } };
  const upstream = await send({ model: 'deepseek/deepseek-v4.1-flash-1017', input: 'Find it.', tools: [own, { type: 'web_search' }] });
  assert.deepEqual(upstream.body.tools.filter(tool => tool.name === 'web_search'), [own]);
  // A grouped tool named web_search reaches Codex as the caller's call, not as the router's search.
  const grouped = { type: 'function_call', id: 'fc_docs', call_id: 'call_docs', name: 'web_search', namespace: 'docs', arguments: '{"query":"x"}', status: 'completed' };
  mockUpstreamSequence(t, [{ status: 200, contentType: 'text/event-stream', body: sse([
    { type: 'response.created', response: { id: 'resp_docs', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...grouped, arguments: '' } },
    { type: 'response.output_item.done', output_index: 0, item: grouped },
    { type: 'response.completed', response: { id: 'resp_docs', status: 'completed', output: [grouped] } }]) }]);
  const before = forwarded.length;
  const events = parseSse((await exchangeRaw(searchRequest())).rawBody);
  assert.equal(forwarded.length, before + 1);
  assert.deepEqual(events.filter(event => event.type === 'response.output_item.done').map(event => `${event.item.type}:${event.item.namespace}`),
    ['function_call:docs']);
});

test('Claude keeps tool names apart and an earlier tool result as it first saw it', async () => {
  const tool = name => ({ type: 'function', name, parameters: { type: 'object' } });
  const { body } = await send(JSON.parse(claudeRequest('Hello', { tools: [tool('a.b'), tool('a_b')] })));
  const names = body.tools.map(entry => entry.name);
  assert.equal(new Set(names).size, 2);
  assert.ok(names.includes('a_b'));
  const step = [{ role: 'user', content: 'Go.' }, { type: 'function_call', call_id: 'toolu_dup', name: 'exec_command', arguments: '{}' },
    { type: 'function_call_output', call_id: 'toolu_dup', output: 'first result' }];
  const before = (await send(JSON.parse(claudeRequest(step)))).body.messages;
  const after = (await send(JSON.parse(claudeRequest([...step,
    { type: 'function_call_output', call_id: 'toolu_dup', output: 'replacement result' }])))).body.messages;
  assert.deepEqual(after.slice(0, before.length), before);
});

// Work counts, not times: characters searched while a request runs.
async function scannedWhile(run) {
  let scanned = 0;
  const split = String.prototype.split;
  const test = RegExp.prototype.test;
  const indexOf = String.prototype.indexOf;
  String.prototype.split = function counted(...args) { scanned += this.length; return split.apply(this, args); };
  RegExp.prototype.test = function counted(text) { scanned += String(text).length; return test.call(this, text); };
  String.prototype.indexOf = function counted(...args) { scanned += this.length; return indexOf.apply(this, args); };
  try {
    await run();
  } finally {
    String.prototype.split = split;
    RegExp.prototype.test = test;
    String.prototype.indexOf = indexOf;
  }
  return scanned;
}

test('a large streamed event that arrives in many chunks is scanned once, on either stream', async t => {
  const chunked = (text, size = 1024) => Array.from({ length: Math.ceil(text.length / size) }, (_, index) => text.slice(index * size, (index + 1) * size));
  const openrouterEvent = bytes => sse([{ type: 'response.output_text.delta', item_id: 'msg_big', output_index: 0, delta: 'x'.repeat(bytes) }]);
  const claudeEvent = bytes => anthropicSse([{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x'.repeat(bytes) } }]);
  const measure = async (bytes, claude) => {
    mockUpstreamSequence(t, [{ status: 200, contentType: 'text/event-stream', chunks: chunked(claude ? claudeEvent(bytes) : openrouterEvent(bytes)) }]);
    return scannedWhile(() => exchangeRaw(claude ? claudeRequest('Go.') : JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash-1017', input: 'Go.' })));
  };
  for (const claude of [false, true]) {
    const small = await measure(128 * 1024, claude);
    const large = await measure(256 * 1024, claude);
    assert.ok(large < small * 3, `${claude ? 'Claude' : 'OpenRouter'}: doubling the event took ${small} to ${large} scanned characters`);
  }
});

test('a refusal no retry can fix moves the request and its session to OpenRouter, and new sessions follow for an hour', async t => {
  mockUpstreamSequence(t, [
    { status: 400, body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error',
      message: 'Your credit balance is too low to access the Anthropic API.' } }) },
    { status: 200, body: JSON.stringify({ id: 'resp_fallback', output: [] }) },
    { status: 200, body: JSON.stringify({ id: 'resp_next', output: [] }) },
  ]);
  const history = [{ role: 'user', content: 'Go.' }, claudeThinking('Think.', 'sig-x'),
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Went.' }] }, { role: 'user', content: 'Again.' }];
  const before = parsedLogEntries().length;
  const result = await exchange(claudeRequest(history), inClaudeSession('claude-fallback'));
  assert.equal(result.status, 200);
  const [refused, fallback] = forwarded.slice(-2);
  assert.equal(refused.hostname, 'api.anthropic.com');
  assert.equal(fallback.hostname, 'openrouter.ai');
  assert.equal(fallback.body.model, 'anthropic/claude-sonnet-5.5');
  assert.equal(fallback.headers.authorization, 'Bearer test-openrouter-key');
  assert.deepEqual(fallback.body.cache_control, { type: 'ephemeral' });
  assert.ok(!fallback.body.input.some(item => item.type === 'reasoning'));
  const log = parsedLogEntries().slice(before).find(entry => entry.event === 'anthropic.refused');
  assert.equal(log.reason, 'billing');
  assert.equal(log.fallback, true);
  const routes = JSON.parse(readFileSync(join(routerHome, 'claude-routes.json'), 'utf8'));
  assert.equal(routes['claude-fallback'].route, 'openrouter');
  const next = await exchange(claudeRequest('Hello'), inClaudeSession('claude-after-refusal'));
  assert.equal(next.status, 200);
  assert.equal(forwarded.at(-1).hostname, 'openrouter.ai');
});

test('an Anthropic refusal on the step after a search moves the thread to OpenRouter and fails the response so Codex retries there', async t => {
  // The test before this one held new sessions on OpenRouter for an hour.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 2 * 60 * 60 * 1000 });
  mockUpstreamSequence(t, [
    { status: 200, contentType: 'text/event-stream', body: claudeStream([{ start: { type: 'tool_use', id: 'toolu_find', name: 'web_search', input: {} },
      deltas: [{ type: 'input_json_delta', partial_json: '{"query":"openai codex contributors"}' }] }], { stopReason: 'tool_use' }) },
    webSearchResult(200),
    { status: 401, body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) },
    { status: 200, body: JSON.stringify({ id: 'resp_retry', output: [] }) },
  ]);
  const before = parsedLogEntries().length;
  const result = await exchangeRaw(claudeRequest('How many contributors?', { tools: [{ type: 'web_search' }] }), inClaudeSession('continuation-refused'));
  const final = parseSse(result.rawBody).at(-1);
  assert.equal(final.type, 'response.failed');
  assert.equal(final.response.error.code, 'server_error');
  assert.match(final.response.error.message, /continues on OpenRouter/);
  const log = parsedLogEntries().slice(before).find(entry => entry.event === 'anthropic.refused');
  assert.equal(log.continuation, true);
  assert.equal(JSON.parse(readFileSync(join(routerHome, 'claude-routes.json'), 'utf8'))['continuation-refused'].route, 'openrouter');
  // Codex's retry of the step goes to OpenRouter.
  await exchange(claudeRequest('How many contributors?'), inClaudeSession('continuation-refused'));
  assert.equal(forwarded.at(-1).hostname, 'openrouter.ai');
});

test('a caller\'s cache breakpoint choice holds when a refusal moves the request to OpenRouter', async t => {
  // The tests before this one held new sessions on OpenRouter for an hour.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 4 * 60 * 60 * 1000 });
  mockUpstreamSequence(t, [
    { status: 400, body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error',
      message: 'Your credit balance is too low to access the Anthropic API.' } }) },
    { status: 200, body: JSON.stringify({ id: 'resp_fallback', output: [] }) },
  ]);
  const result = await exchange(claudeRequest('Go.', { instructions: 'Shared rubric.' }),
    { ...inClaudeSession('cache-mode-fallback'), 'x-codex-router-prompt-cache': 'instructions' });
  assert.equal(result.status, 200);
  const [refused, fallback] = forwarded.slice(-2);
  assert.equal(refused.hostname, 'api.anthropic.com');
  assert.deepEqual(refused.body.system.at(-1).cache_control, { type: 'ephemeral' });
  assert.equal(fallback.hostname, 'openrouter.ai');
  assert.equal(fallback.body.cache_control, undefined);
});
