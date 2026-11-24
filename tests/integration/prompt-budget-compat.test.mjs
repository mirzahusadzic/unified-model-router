// Fast prompt-budget compatibility probe for macOS CI with the tested CLI.
//
// This mirrors one model of the reviewed expectations in
// tests/prompt-budget.test.mjs, which stays authoritative: if this probe
// fails, run that full suite and review what Codex changed before updating
// either file. It skips anywhere else, so other platforms and CI jobs without
// the tested Codex CLI stay green.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import {
  buildScratchHome,
  captureFreshThread,
  installedCodexVersion,
  startCaptureServer,
  testedCodexVersion,
  toolNames,
} from './codex-capture.mjs';

const windows = process.platform === 'win32';
const tested = testedCodexVersion();
const installed = installedCodexVersion();
const versionSkip = !installed ? 'the Codex CLI is not installed'
  : installed !== tested ? `Codex ${installed} is installed; the probe expects ${tested}` : false;
// Keep in sync with the darwin review in tests/prompt-budget.test.mjs.
const probeModel = 'deepseek/deepseek-v4.1-flash-1017';
const expectedTools = [
  'create_goal', 'exec_command', 'get_goal', 'multi_agent_v1.close_agent', 'multi_agent_v1.resume_agent',
  'multi_agent_v1.send_input', 'multi_agent_v1.spawn_agent', 'multi_agent_v1.wait_agent', 'request_user_input',
  'update_goal', 'view_image', 'web_search', 'write_stdin',
];
const expectedBudget = { requestBytes: 33000, toolBytes: 21300 };
const compatSkip = versionSkip || (process.platform === 'darwin' ? false : `no reviewed probe expectations for ${process.platform}`);

function runCodex(args, { env, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, { env, cwd, shell: windows, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 120000);
    child.once('error', reject);
    child.once('close', status => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test('the tested CLI sends the probe model the reviewed tools within budget', { skip: compatSkip }, async t => {
  const cleanups = [];
  t.after(async () => {
    for (const fn of cleanups.reverse()) {
      try { await fn(); } catch {}
    }
  });
  const cleanup = fn => cleanups.push(fn);
  const { env, work, token, directory } = await buildScratchHome(cleanup);
  void directory;
  const { url, requests } = await startCaptureServer(cleanup, token);
  await captureFreshThread({ env, work, baseUrl: url, model: probeModel, prompt: 'ok' });
  assert.equal(requests.length, 1);
  const [record] = requests;
  const tools = toolNames(record.body ?? {});
  assert.deepEqual(tools, expectedTools, `${probeModel} sends a different tool list; run tests/prompt-budget.test.mjs and review.`);
  const toolBytes = JSON.stringify(record.body?.tools ?? []).length;
  assert.ok(toolBytes <= expectedBudget.toolBytes, `tool definitions grew to ${toolBytes} bytes; review before updating.`);
  assert.ok(record.bytes <= expectedBudget.requestBytes, `request grew to ${record.bytes} bytes; review before updating.`);
});

test('the installer keeps apps and guardian off for the probe home', { skip: versionSkip }, async t => {
  const cleanups = [];
  t.after(async () => {
    for (const fn of cleanups.reverse()) {
      try { await fn(); } catch {}
    }
  });
  const cleanup = fn => cleanups.push(fn);
  const { env, work } = await buildScratchHome(cleanup);
  const result = await runCodex(['features', 'list'], { env, cwd: work });
  assert.equal(result.status, 0, result.stderr);
  const features = new Map(result.stdout.split(/\r?\n/).map(line => line.trim().split(/\s{2,}/))
    .filter(columns => columns.length >= 3).map(columns => [columns[0], columns.at(-1)]));
  assert.equal(features.get('apps'), 'false', 'a renamed apps key would leave the managed setting without effect');
  assert.equal(features.get('guardian_approval'), 'false', 'a renamed guardian key would leave the managed setting without effect');
});
