import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catalogFiles } from '../scripts/catalog-files.mjs';

// Codex decides what every request carries: tool definitions, instructions,
// and context. A release can add tools or prompt text without notice, as the
// ChatGPT apps connector tools did at about 237,000 characters per request,
// and OpenRouter bills those tokens on every uncached request. These tests run
// the installed Codex with the installer's own configuration against a local
// fake upstream, so nothing leaves the machine, and fail when the tools, the
// size of a fresh thread's request, or the features Codex turns on change.
// They need the tested Codex version and skip otherwise. After a Codex
// upgrade, review what changed before updating the expectations below.

const root = fileURLToPath(new URL('../', import.meta.url));
const windows = process.platform === 'win32';
const testedVersion = readFileSync(join(root, 'install.mjs'), 'utf8').match(/const testedCodexVersion = '([^']+)'/)[1];
const installedVersion = spawnSync('codex', ['--version'], { encoding: 'utf8', shell: windows, timeout: 30000 })
  .stdout?.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
const versionSkip = !installedVersion ? 'the Codex CLI is not installed'
  : installedVersion !== testedVersion ? `Codex ${installedVersion} is installed; the expectations are for ${testedVersion}` : false;

// Reviewed on macOS with Codex 0.167.0. Feature defaults and tools can differ
// by platform, so other platforms skip until their expectations are added.
const reviewed = {
  darwin: {
    // A fresh thread's tools, as `name` or `namespace.name`; hosted tools by type.
    tools: [
      'create_goal', 'exec_command', 'get_goal', 'multi_agent_v1.close_agent', 'multi_agent_v1.resume_agent',
      'multi_agent_v1.send_input', 'multi_agent_v1.spawn_agent', 'multi_agent_v1.wait_agent', 'request_user_input',
      'update_goal', 'view_image', 'web_search', 'write_stdin',
    ],
    // Upper bounds for a fresh thread's request, about 10% above the measured
    // 27,826, 27,832, 27,836, 27,844, and 30,311 request bytes and 17,319 tool bytes.
    budgets: {
      'anthropic/claude-fable-5-2': { requestBytes: 30600, toolBytes: 19000 },
      'anthropic/claude-opus-5-5': { requestBytes: 30600, toolBytes: 19000 },
      'anthropic/claude-sonnet-5-5': { requestBytes: 30600, toolBytes: 19000 },
      'deepseek/deepseek-v4.1-flash-1017': { requestBytes: 30600, toolBytes: 19000 },
      'openrouter/anthropic/claude-opus-5.5': { requestBytes: 30600, toolBytes: 19000 },
      'openrouter/anthropic/claude-sonnet-5.5': { requestBytes: 30600, toolBytes: 19000 },
      'openrouter/meta/muse-spark-1.3': { requestBytes: 30600, toolBytes: 19000 },
      'openrouter/openai/gpt-6.1-sol': { requestBytes: 30600, toolBytes: 19000 },
      'openrouter/meta/muse-spark-1.3-contributor': { requestBytes: 30600, toolBytes: 19000 },
      'ultra-spark-private/deepseek-v4.1-flash-1017': { requestBytes: 33400, toolBytes: 19000 },
      'ultra-spark/deepseek-v4.1-flash-1017': { requestBytes: 33400, toolBytes: 19000 },
    },
    // Features Codex turns on under the installer's configuration.
    features: [
      'api_key_cyber_access_programs', 'api_key_model_discovery', 'auth_elicitation', 'bedrock_setup_wizard',
      'browser_annotation_api', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'cli_daybreak',
      'code_mode_host', 'code_mode_interrupt', 'collaboration_modes', 'compaction_image_budget', 'computer_use',
      'content_item_kinds', 'daemon_auto_start', 'deferred_tool_world_state', 'enable_request_compression', 'fast_mode', 'goals',
      'guardian_reuse_parent_compaction', 'hooks', 'image_generation', 'in_app_browser', 'in_app_chat',
      'in_app_dictation', 'in_app_local_automation', 'in_app_updates', 'in_app_voice', 'incremental_tools',
      'instant_interrupt', 'item_ids', 'mcp_oauth_refresh_coordination', 'mentions_v2', 'multi_agent',
      'plugin_discovery_prefetch', 'plugin_sharing', 'plugins', 'prediction_preserve_parent_tools', 'realtime_conversation',
      'reasoning_effort_override', 'remote_plugin', 'resize_all_images', 'shell_snapshot',
      'shell_tool', 'skill_mcp_dependency_install', 'skill_search', 'sleep_tool', 'sqlite', 'steer',
      'system_proxy_fallback', 'terminal_resize_reflow', 'tool_call_mcp_elicitation',
      'tool_search_always_defer_mcp_tools', 'tool_suggest', 'tui_app_server', 'ultrafast_mode',
      'unbounded_connection_retries', 'unified_exec', 'unified_exec_tty', 'view_image', 'workspace_dependencies',
      'worktrees', 'write_stdin_approval',
    ],
  },
};
const expected = reviewed[process.platform];
const requestSkip = versionSkip || (!expected && `no reviewed expectations for ${process.platform}`);

const routerModels = catalogFiles(join(root, 'catalog'))
  .map(name => JSON.parse(readFileSync(join(root, 'catalog', name), 'utf8')).slug).sort();
const token = 'a'.repeat(64);

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: windows && command === 'codex', stdio: ['ignore', 'pipe', 'pipe'] });
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

// A scratch Codex home with the installer's catalog and merged configuration.
async function installerHome(t) {
  const directory = mkdtempSync(join(tmpdir(), 'router-prompt-budget-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, 'codex-home');
  const work = join(directory, 'work');
  mkdirSync(home);
  mkdirSync(work);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('CODEX_')));
  env.CODEX_HOME = home;
  const bundled = await run('codex', ['debug', 'models', '--bundled'], { env, cwd: work });
  assert.equal(bundled.status, 0, bundled.stderr);
  writeFileSync(join(directory, 'bundled.json'), bundled.stdout);
  const catalog = spawnSync(process.execPath, [join(root, 'scripts', 'build-catalog.mjs'),
    '--bundled', join(directory, 'bundled.json'), '--catalog-dir', join(root, 'catalog'), '--output', join(home, 'models.json'),
    '--instructions', join(root, 'prompts', 'openrouter-instructions.md'),
    '--persistent', join(root, 'prompts', 'openrouter-persistent.md')], { encoding: 'utf8', env });
  assert.equal(catalog.status, 0, catalog.stderr);
  writeFileSync(join(directory, 'router.env'), `CODEX_ROUTER_TOKEN=${token}\n`);
  const merged = spawnSync(process.execPath, [join(root, 'scripts', 'merge-config.mjs'), '', home,
    join(home, 'config.toml'), join(directory, 'router.env')], { encoding: 'utf8', env });
  assert.equal(merged.status, 0, merged.stderr);
  return { env, work };
}

test('Codex sends router models the reviewed tools and request size', { skip: requestSkip }, async t => {
  const { env, work } = await installerHome(t);
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({ path: request.url, token: request.headers['x-codex-router-token'], bytes: body.length, body: JSON.parse(body) });
      const id = `resp_${requests.length}`;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [
        { type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } },
        { type: 'response.output_item.done', item: { type: 'message', id: `msg_${requests.length}`, role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } },
        { type: 'response.completed', response: { id, object: 'response', status: 'completed', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

  const measured = {};
  for (const model of routerModels) {
    const before = requests.length;
    const result = await run('codex', ['exec', '--ephemeral', '--skip-git-repo-check',
      '-c', `model_providers.unified.base_url=${baseUrl}`, '-m', model, 'ok'], { env, cwd: work });
    assert.equal(result.status, 0, `${model}: ${result.stderr}`);
    assert.equal(requests.length, before + 1, `${model} sent ${requests.length - before} requests`);
    const { path, token: sentToken, bytes, body } = requests.at(-1);
    assert.equal(path, '/v1/responses');
    assert.equal(sentToken, token, 'the managed provider headers must reach the router');
    const tools = (body.tools ?? []).flatMap(tool => (tool.type === 'namespace'
      ? tool.tools.map(member => `${tool.name}.${member.name}`) : [tool.name ?? tool.type])).sort();
    measured[model] = { tools, requestBytes: bytes, toolBytes: JSON.stringify(body.tools ?? []).length };
  }
  const report = JSON.stringify(measured, null, 2);
  for (const model of routerModels) {
    const { tools, requestBytes, toolBytes } = measured[model];
    const budget = expected.budgets[model];
    assert.deepEqual(tools, expected.tools, `${model} sends a different tool list; review it, then update the tools.\n${report}`);
    assert.ok(budget, `${model} has no budget.\n${report}`);
    assert.ok(toolBytes <= budget.toolBytes, `${model} tool definitions grew to ${toolBytes} bytes.\n${report}`);
    assert.ok(requestBytes <= budget.requestBytes, `${model} request grew to ${requestBytes} bytes.\n${report}`);
  }
});

test('the installer keeps Codex apps and guardian off and leaves the reviewed features on', { skip: versionSkip }, async t => {
  const { env, work } = await installerHome(t);
  const result = await run('codex', ['features', 'list'], { env, cwd: work });
  assert.equal(result.status, 0, result.stderr);
  const features = new Map(result.stdout.split(/\r?\n/).map(line => line.trim().split(/\s{2,}/))
    .filter(columns => columns.length >= 3).map(columns => [columns[0], columns.at(-1)]));
  // A renamed key would leave the managed setting without effect.
  assert.equal(features.get('apps'), 'false');
  assert.equal(features.get('guardian_approval'), 'false');
  const enabled = [...features].filter(([, state]) => state === 'true').map(([name]) => name).sort();
  if (!expected) {
    t.diagnostic(`No reviewed features for ${process.platform}: ${JSON.stringify(enabled)}`);
    return;
  }
  assert.deepEqual(enabled, expected.features,
    `Codex turns on different features; review them, then update the features.\n${JSON.stringify(enabled)}`);
});
