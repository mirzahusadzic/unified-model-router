// Repeatable Codex-version request capture and comparison.
//
// Captures what the Codex CLI sends for a fresh router-model thread through a
// loopback fake upstream: no credentials, no model traffic. The single-version
// capture always runs when the CLI is present; baseline and cross-version
// comparisons only run when their inputs are provided, and skip otherwise.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildScratchHome,
  captureFreshThread,
  capturePersistentThread,
  defaultProbeModel,
  installedCodexVersion,
  normalizeCapture,
  probeCrossProviderResume,
  resolveCodexRunner,
  sanitizeModel,
  sessionIdFromOutput,
  offlineEnv,
  stableStringify,
  startCaptureServer,
  summarizeCaptureDiff,
} from './codex-capture.mjs';

const hasCodex = Boolean(installedCodexVersion());
const codexSkip = hasCodex ? false : 'the Codex CLI is not installed';
const probeModel = process.env.CODEX_CAPTURE_MODEL || defaultProbeModel();
const probePrompt = process.env.CODEX_CAPTURE_PROMPT || 'ok';

function cleanups(t) {
  const fns = [];
  t.after(async () => {
    for (const fn of fns.reverse()) {
      try { await fn(); } catch {}
    }
  });
  return fn => fns.push(fn);
}

test('a fresh router-model thread is captured on loopback without credentials', { skip: codexSkip }, async t => {
  const cleanup = cleanups(t);
  const { env, work, token, directory } = await buildScratchHome(cleanup);
  for (const name of Object.keys(env)) {
    assert.ok(!/API_KEY|TOKEN|SECRET/.test(name), `${name} must not reach the capture environment`);
  }
  const { url, requests } = await startCaptureServer(cleanup, token);
  assert.ok(new URL(url).hostname === '127.0.0.1', 'the capture server must stay on loopback');
  await captureFreshThread({ env, work, baseUrl: url, model: probeModel, prompt: probePrompt });
  assert.equal(requests.length, 1, `expected one captured request, saw ${requests.length}`);
  const [record] = requests;
  assert.equal(record.method, 'POST');
  assert.equal(record.path, '/v1/responses');
  assert.ok(record.tokenOk, 'the managed provider token must reach the fake upstream');
  assert.equal(record.body?.model, probeModel);
  assert.ok(Array.isArray(record.body?.tools) && record.body.tools.length > 0, 'the capture must include Codex tools');
  const first = normalizeCapture(record, directory);
  assert.deepEqual(normalizeCapture(record, directory), first, 'normalization must be stable for the same capture');
  const out = process.env.CODEX_CAPTURE_OUT;
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `${sanitizeModel(probeModel)}.normalized.json`), `${JSON.stringify(first, null, 2)}\n`);
    t.diagnostic(`Wrote capture baseline candidate for ${probeModel} to ${out}`);
  }
});

test('a same-provider resume stays append-only and a provider switch is still refused', { skip: codexSkip }, async t => {
  const cleanup = cleanups(t);
  const { env, work, token, directory } = await buildScratchHome(cleanup);
  const { url, requests } = await startCaptureServer(cleanup, token);
  const { sessionId } = await capturePersistentThread({
    env, work, baseUrl: url, model: probeModel, prompt: probePrompt,
  });
  assert.match(sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(requests.length, 2, `expected a resumed request, saw ${requests.length}`);
  const [first, second] = requests.map(record => normalizeCapture(record, directory));
  assert.deepEqual(second.body.input.slice(0, first.body.input.length), first.body.input,
    'the resumed request must extend the first request byte for byte');
  assert.ok(second.body.input.length > first.body.input.length);

  const refused = await probeCrossProviderResume({ env, work, sessionId, model: 'gpt-6-astra' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Cannot change this thread's model provider from `unified` to `openai` on resume/);
  assert.equal(requests.length, 2, 'the refused provider switch must not reach an upstream');
});

test('a capture matches its baseline when one is provided', async t => {
  const baselineDir = process.env.CODEX_CAPTURE_BASELINE;
  if (!baselineDir) {
    t.skip('set CODEX_CAPTURE_BASELINE to a directory of normalized captures to compare against');
    return;
  }
  if (!hasCodex) {
    t.skip('the Codex CLI is not installed');
    return;
  }
  const file = join(baselineDir, `${sanitizeModel(probeModel)}.normalized.json`);
  if (!existsSync(file)) {
    t.skip(`no baseline for ${probeModel} in ${baselineDir}`);
    return;
  }
  const baseline = JSON.parse(readFileSync(file, 'utf8'));
  const cleanup = cleanups(t);
  const { env, work, token, directory } = await buildScratchHome(cleanup);
  const { url, requests } = await startCaptureServer(cleanup, token);
  await captureFreshThread({ env, work, baseUrl: url, model: baseline.model ?? probeModel, prompt: probePrompt });
  const current = normalizeCapture(requests.at(-1), directory);
  const diff = summarizeCaptureDiff(baseline, current);
  assert.deepEqual(current.tools, baseline.tools ?? current.tools,
    `tool list drifted; review the diff, then update the baseline.\n${diff.join('\n')}\n${stableStringify(current).slice(0, 2000)}`);
  assert.deepEqual(diff, [], `capture differs from baseline; review it before updating.\n${diff.join('\n')}`);
});

test('two public Codex versions are comparable through the same capture', async t => {
  const versions = (process.env.CODEX_CAPTURE_VERSIONS ?? '').split(',').map(entry => entry.trim()).filter(Boolean);
  if (versions.length < 2) {
    t.skip('set CODEX_CAPTURE_VERSIONS to two versions, for example "0.171.0,0.172.0", to compare their requests');
    return;
  }
  const runners = versions.slice(0, 2).map(resolveCodexRunner);
  for (const [index, runner] of runners.entries()) {
    if (runner.skip) {
      t.skip(`Codex ${versions[index]}: ${runner.skip}`);
      return;
    }
  }
  const strict = process.env.CODEX_CAPTURE_STRICT === '1';
  const captures = [];
  for (const runner of runners) {
    const cleanup = cleanups(t);
    const { env, work, token, directory } = await buildScratchHome(cleanup);
    const { url, requests } = await startCaptureServer(cleanup, token);
    await captureFreshThread({
      env, work, baseUrl: url, model: probeModel, prompt: probePrompt,
      command: runner.command, prefixArgs: runner.prefixArgs,
    });
    captures.push({ version: runner.version, normalized: normalizeCapture(requests.at(-1), directory) });
  }
  const [older, newer] = captures;
  const diff = summarizeCaptureDiff(older.normalized, newer.normalized);
  const out = process.env.CODEX_CAPTURE_OUT;
  if (out) {
    mkdirSync(out, { recursive: true });
    for (const { version, normalized } of captures) {
      writeFileSync(join(out, `${version}-${sanitizeModel(probeModel)}.normalized.json`), `${JSON.stringify(normalized, null, 2)}\n`);
    }
    writeFileSync(join(out, 'version-diff.txt'), diff.length > 0 ? `${diff.join('\n')}\n` : 'identical\n');
  }
  if (diff.length > 0 && !strict) {
    t.diagnostic(`Codex ${older.version} -> ${newer.version} request differences to review:\n  ${diff.join('\n  ')}`);
    return;
  }
  assert.deepEqual(diff, [], `Codex ${older.version} -> ${newer.version} changed its requests; review the upgrade steps.\n${diff.join('\n')}`);
});

test('the capture environment strips credentials and the diff is readable', () => {
  const env = offlineEnv('/tmp/scratch-home');
  for (const name of Object.keys(env)) {
    assert.ok(!/API_KEY|TOKEN|SECRET/.test(name), `${name} must not reach the capture environment`);
  }
  assert.equal(env.CODEX_HOME, '/tmp/scratch-home');
  const base = { model: 'm', tokenOk: true, tools: ['a'], requestBytes: 10, toolBytes: 4, body: { model: 'm', x: 1 } };
  assert.deepEqual(summarizeCaptureDiff(base, base), []);
  const diff = summarizeCaptureDiff(base, { ...base, tools: ['b'], requestBytes: 12 });
  assert.ok(diff.some(line => line.includes('added tool: b')), diff.join('\n'));
  assert.ok(diff.some(line => line.includes('removed tool: a')), diff.join('\n'));
  assert.ok(diff.some(line => line.includes('request bytes')), diff.join('\n'));
});

test('session IDs use structured Codex output with a human fallback', () => {
  assert.equal(sessionIdFromOutput({
    status: 0,
    stdout: '{"type":"thread.started","thread_id":"structured-id"}\n',
    stderr: '',
  }), 'structured-id');
  assert.equal(sessionIdFromOutput({ status: 0, stdout: '', stderr: 'session id: legacy-id\n' }), 'legacy-id');
  assert.throws(() => sessionIdFromOutput({ status: 1, stdout: '', stderr: 'boom' }),
    /status 1[\s\S]*boom/);
});
