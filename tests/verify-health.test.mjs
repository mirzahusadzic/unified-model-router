import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { routerRevision } from '../router/common.mjs';

const source = fileURLToPath(new URL('../router/unified-router.mjs', import.meta.url));
const verifier = fileURLToPath(new URL('../scripts/verify-health.mjs', import.meta.url));
const health = {
  ok: true, openai: true, openrouter: true, clientAuth: true,
  revision: routerRevision(source),
  capabilities: {
    routingPolicies: ['preserve-model-v1'],
    openrouterRejectionRecovery: 'completed-diagnostic-v1',
    providerIsolation: 'session-v3',
    revisionPrecondition: true,
    promptCacheModes: ['instructions', 'none'],
    dataPolicies: ['deny'],
    reports: ['provider'],
    generationLookup: true,
    endpointPins: true,
    fallbackPolicies: ['none'],
    thinkingBudgets: true,
    thinkingOff: { effort: 'none', models: ['anthropic/claude-sonnet-5-5'] },
    trainingDeclarations: ['declared-training', 'endpoint', 'provider-terms', 'unknown'],
    modelTraining: 'training-v1',
  },
};

test('health verifier requires current source identity and capabilities, not just old booleans', () => {
  // The revision covers the router's modules, not only its entry file.
  const entryOnly = createHash('sha256').update(readFileSync(source)).digest('hex');
  for (const value of [health, { ...health, revision: '0'.repeat(64) }, { ...health, revision: entryOnly },
    { ...health, capabilities: undefined }, { ...health, capabilities: { routingPolicies: ['preserve-model-v1'] } },
    { ...health, capabilities: { routingPolicies: 'preserve-model-v1', revisionPrecondition: true } },
    { ...health, capabilities: { ...health.capabilities, openrouterRejectionRecovery: undefined } },
    // session-v3 adds the data-collection filter for sessions that used OpenAI or Claude.
    { ...health, capabilities: { ...health.capabilities, providerIsolation: undefined } },
    { ...health, capabilities: { ...health.capabilities, providerIsolation: 'session-v2' } },
    { ...health, clientAuth: false }, { ...health, openrouter: false }, null]) {
    const result = spawnSync(process.execPath, [verifier, source], { input: JSON.stringify(value), encoding: 'utf8' });
    assert.equal(result.status === 0, value === health, result.stderr);
  }
});

test('health verifier requires the complete caller-advertised capability contract', () => {
  const run = value => spawnSync(process.execPath, [verifier, source],
    { input: JSON.stringify(value), encoding: 'utf8' });
  assert.equal(run(health).status, 0, run(health).stderr);
  const extended = {
    ...health,
    capabilities: {
      ...health.capabilities,
      promptCacheModes: ['future', 'none', 'instructions'],
      dataPolicies: ['future', 'deny'],
      reports: ['future', 'provider'],
      fallbackPolicies: ['future', 'none'],
      thinkingOff: { effort: 'none', models: ['future', 'anthropic/claude-sonnet-5-5'] },
      trainingDeclarations: ['future', 'declared-training', 'endpoint', 'provider-terms', 'unknown'],
    },
  };
  assert.equal(run(extended).status, 0, run(extended).stderr);
  const cases = [
    ['routingPolicies', { ...health.capabilities, routingPolicies: ['other-policy-v1'] }],
    ['routingPolicies', { ...health.capabilities, routingPolicies: [] }],
    ['openrouterRejectionRecovery', { ...health.capabilities, openrouterRejectionRecovery: 'retry-v1' }],
    ['providerIsolation', { ...health.capabilities, providerIsolation: 'session-v2' }],
    ['revisionPrecondition', { ...health.capabilities, revisionPrecondition: false }],
    ['promptCacheModes', { ...health.capabilities, promptCacheModes: ['instructions'] }],
    ['promptCacheModes', { ...health.capabilities, promptCacheModes: 'instructions,none' }],
    ['dataPolicies', { ...health.capabilities, dataPolicies: [] }],
    ['dataPolicies', { ...health.capabilities, dataPolicies: ['allow'] }],
    ['reports', { ...health.capabilities, reports: [] }],
    ['reports', { ...health.capabilities, reports: ['other'] }],
    ['generationLookup', { ...health.capabilities, generationLookup: false }],
    ['generationLookup', { ...health.capabilities, generationLookup: undefined }],
    ['endpointPins', { ...health.capabilities, endpointPins: false }],
    ['endpointPins', { ...health.capabilities, endpointPins: undefined }],
    ['fallbackPolicies', { ...health.capabilities, fallbackPolicies: [] }],
    ['fallbackPolicies', { ...health.capabilities, fallbackPolicies: ['openrouter'] }],
    ['thinkingBudgets', { ...health.capabilities, thinkingBudgets: false }],
    ['thinkingBudgets', { ...health.capabilities, thinkingBudgets: undefined }],
    ['thinkingOff', { ...health.capabilities, thinkingOff: { effort: 'none', models: [] } }],
    ['thinkingOff', { ...health.capabilities, thinkingOff: { effort: 'low', models: ['anthropic/claude-sonnet-5-5'] } }],
    ['thinkingOff', { ...health.capabilities, thinkingOff: undefined }],
    ['trainingDeclarations', { ...health.capabilities, trainingDeclarations: ['endpoint'] }],
    ['trainingDeclarations', { ...health.capabilities, trainingDeclarations: ['declared-training', 'endpoint', 'provider-terms'] }],
    ['modelTraining', { ...health.capabilities, modelTraining: 'training-v0' }],
    ['modelTraining', { ...health.capabilities, modelTraining: undefined }],
    ['ok', null],
    ['openai', null],
  ];
  for (const [key, capabilities] of cases) {
    let value;
    if (key === 'ok') value = { ...health, ok: false };
    else if (key === 'openai') value = { ...health, openai: false };
    else value = { ...health, capabilities };
    const result = run(value);
    assert.notEqual(result.status, 0, key);
    assert.match(result.stderr, /required capabilities|do not match/, key);
  }
  // Every boolean the verifier checks must hold, not only two of them.
  for (const key of ['ok', 'openai', 'openrouter', 'clientAuth']) {
    const result = run({ ...health, [key]: false });
    assert.notEqual(result.status, 0, key);
  }
});

test('health verifier accepts only the router process the service runs', () => {
  const run = (value, option) => spawnSync(process.execPath, [verifier, source, option],
    { input: JSON.stringify(value), encoding: 'utf8' });
  const answering = { ...health, pid: 4242 };
  assert.equal(run(answering, '--service-pid=4242').status, 0);
  // A stray copy of the same code holds the port while the service's process restarts.
  const stray = run(answering, '--service-pid=5151');
  assert.notEqual(stray.status, 0);
  assert.match(stray.stderr, /Router process 4242 answers instead of the service's process 5151/);
  // The service runs no process at all, yet something answers on its port.
  const none = run(answering, '--service-pid=');
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /no running process, yet router process 4242 answers/);
  assert.notEqual(run(health, '--service-pid=4242').status, 0);
  // Zero also means the service runs none.
  const zero = run(answering, '--service-pid=0');
  assert.notEqual(zero.status, 0);
  assert.match(zero.stderr, /no running process/);
  // A PID beyond the safe integer range never matches, so nothing passes as the service.
  const huge = run(answering, '--service-pid=9007199254740993');
  assert.notEqual(huge.status, 0);
  assert.match(huge.stderr, /no running process/);
  // Without a PID the verifier names the answerer unknown.
  const unknown = run(health, '--service-pid=');
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /yet router process unknown answers/);
});

test('health verifier refuses PID options it cannot read exactly', () => {
  const run = args => spawnSync(process.execPath, [verifier, source, ...args],
    { input: JSON.stringify({ ...health, pid: 4242 }), encoding: 'utf8' });
  assert.equal(run(['--service-pid=4242']).status, 0);
  // Each of these once compared equal to 4242, or let a second PID go unchecked.
  for (const args of [['--service-pid=+4242'], ['--service-pid=4242.0'], ['--service-pid=0x1092'],
    ['--service-pid=4.242e3'], ['--service-pid=04242'], ['--service-pid=4242', '--service-pid=5151'],
    ['--service-pid', '4242'], ['--service-pids=4242']]) {
    const result = run(args);
    assert.notEqual(result.status, 0, args.join(' '));
    assert.match(result.stderr, /Usage: verify-health\.mjs/, args.join(' '));
  }
});

test('health verifier refuses argument shapes that could skip a check', () => {
  const good = JSON.stringify({ ...health, pid: 4242 });
  const missing = spawnSync(process.execPath, [verifier], { input: good, encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Usage: verify-health\.mjs/);
  const extra = spawnSync(process.execPath, [verifier, source, 'http://127.0.0.1:1/health', 'spare'],
    { input: good, encoding: 'utf8' });
  assert.notEqual(extra.status, 0);
  assert.match(extra.stderr, /Usage: verify-health\.mjs/);
});

test('health verifier accepts a process the service started, such as node under a shim', () => {
  const run = option => spawnSync(process.execPath, [verifier, source, option],
    { input: JSON.stringify({ ...health, pid: 4243 }), encoding: 'utf8' });
  assert.equal(run('--service-pid=4242,4243').status, 0);
  assert.match(run('--service-pid=4242,5151').stderr, /Router process 4243 answers instead of the service's process 4242, 5151/);
  for (const option of ['--service-pid=4242,', '--service-pid=,4243', '--service-pid=4242,,4243']) {
    assert.match(run(option).stderr, /Usage: verify-health\.mjs/, option);
  }
});

test('shared readiness probe rejects redirects without contacting their target', async t => {
  let targetContacts = 0;
  let redirect = null;
  const server = http.createServer((request, response) => {
    if (request.url === '/target') targetContacts++;
    if (redirect !== null) {
      response.writeHead(redirect, { location: `http://127.0.0.1:${server.address().port}/target` });
      response.end();
    } else {
      response.end(JSON.stringify(health));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const code of [null, 301, 302, 303, 307, 308]) {
    redirect = code;
    const child = spawn(process.execPath, [verifier, source, `http://127.0.0.1:${server.address().port}/health`], { stdio: 'ignore' });
    const [status] = await once(child, 'exit');
    assert.equal(status === 0, code === null);
  }
  assert.equal(targetContacts, 0);
});

test('health verifier only contacts a local 127.0.0.1 health endpoint', async t => {
  const server = http.createServer((request, response) => response.end(JSON.stringify(health)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const bad = [
    `https://127.0.0.1:${port}/health`,
    `http://localhost:${port}/health`,
    `http://127.0.0.2:${port}/health`,
    `http://user@127.0.0.1:${port}/health`,
    `http://:pass@127.0.0.1:${port}/health`,
    `http://user:pass@127.0.0.1:${port}/health`,
    `http://127.0.0.1:${port}/health?next=1`,
    `http://127.0.0.1:${port}/health#top`,
    `http://127.0.0.1:${port}/`,
    `http://127.0.0.1:${port}/v1/models`,
    `http://127.0.0.1:${port}/health/`,
    '::not-a-url::',
  ];
  const runEndpoint = endpoint => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [verifier, source, endpoint], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stderr }));
  });
  for (const endpoint of bad) {
    const result = await runEndpoint(endpoint);
    assert.notEqual(result.status, 0, endpoint);
    assert.match(result.stderr, /local 127\.0\.0\.1|Invalid URL/, endpoint);
  }
  // The versioned path serves the same health; the probe tested it above through stdin.
  const v1 = await runEndpoint(`http://127.0.0.1:${port}/v1/health`);
  assert.equal(v1.status, 0, v1.stderr);
});

test('health verifier fails closed on transport errors, oversized bodies, and timeouts', async t => {
  // A closed port refuses the lookup.
  const closed = http.createServer();
  closed.listen(0, '127.0.0.1');
  await once(closed, 'listening');
  const port = closed.address().port;
  await new Promise(resolve => closed.close(resolve));
  const refused = spawnSync(process.execPath, [verifier, source, `http://127.0.0.1:${port}/health`],
    { encoding: 'utf8' });
  assert.notEqual(refused.status, 0);

  const runLive = endpoint => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [verifier, source, endpoint], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stderr }));
  });
  // A body larger than 16 KiB never parses.
  const big = http.createServer((request, response) => {
    response.end(JSON.stringify({ ...health, note: 'x'.repeat(17000) }));
  });
  big.listen(0, '127.0.0.1');
  await once(big, 'listening');
  t.after(() => new Promise(resolve => big.close(resolve)));
  const oversized = await runLive(`http://127.0.0.1:${big.address().port}/health`);
  assert.notEqual(oversized.status, 0);
  assert.match(oversized.stderr, /exceeds 16 KiB/);

  // A hanging endpoint trips the 2s lookup timeout.
  const hanging = http.createServer(() => {});
  hanging.listen(0, '127.0.0.1');
  await once(hanging, 'listening');
  t.after(() => new Promise(resolve => hanging.close(resolve)));
  const timedOut = await runLive(`http://127.0.0.1:${hanging.address().port}/health`);
  assert.notEqual(timedOut.status, 0);
  assert.match(timedOut.stderr, /timed out/);
});
