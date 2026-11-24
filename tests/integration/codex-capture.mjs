// Shared harness for Codex-version request capture and comparison.
//
// Captures what an installed Codex CLI sends for a fresh router-model thread
// through a loopback fake upstream, so two CLI versions can be compared
// without credentials or model traffic. Everything stays on 127.0.0.1 with a
// scratch CODEX_HOME; a version comparison only needs the public
// @openai/codex packages from the npm registry, never a model endpoint.
//
// Run directly to capture without the test runner:
//   node tests/integration/codex-capture.mjs --models deepseek/deepseek-v4.1-flash-1017 --prompt ok --out /tmp/captures
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogFiles } from '../../scripts/catalog-files.mjs';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const windows = process.platform === 'win32';

export function testedCodexVersion() {
  return readFileSync(join(repoRoot, 'install.mjs'), 'utf8')
    .match(/const testedCodexVersion = '([^']+)'/)[1];
}

export function installedCodexVersion(command = 'codex') {
  const run = spawnSync(command, ['--version'], { encoding: 'utf8', shell: windows, timeout: 30000 });
  if (run.status !== 0) return null;
  return run.stdout?.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null;
}

export function routerModelSlugs() {
  return catalogFiles(join(repoRoot, 'catalog'))
    .map(name => JSON.parse(readFileSync(join(repoRoot, 'catalog', name), 'utf8')).slug).sort();
}

export function defaultProbeModel() {
  const slugs = routerModelSlugs();
  return slugs.includes('deepseek/deepseek-v4.1-flash-1017') ? 'deepseek/deepseek-v4.1-flash-1017' : slugs[0];
}

// Environment for an offline capture: no router state, no stored keys, and no
// model traffic, since every provider URL the test sets points at loopback.
export function offlineEnv(home) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('CODEX_') || /API_KEY|TOKEN|SECRET/.test(name)) delete env[name];
  }
  env.CODEX_HOME = home;
  return env;
}

function runTracked(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
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

// A scratch Codex home built with the installer's own scripts, so the capture
// uses the same catalog and merged configuration Codex gets on install.
export async function buildScratchHome(cleanup) {
  const directory = join(tmpdir(), `router-capture-${Date.now()}-${process.pid}`);
  mkdirSync(directory, { recursive: true });
  cleanup(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, 'codex-home');
  const work = join(directory, 'work');
  mkdirSync(home);
  mkdirSync(work);
  const env = offlineEnv(home);
  const bundled = await runTracked('codex', ['debug', 'models', '--bundled'],
    { env, cwd: work, shell: windows });
  if (bundled.status !== 0) throw new Error(`codex debug models --bundled failed: ${bundled.stderr}`);
  writeFileSync(join(directory, 'bundled.json'), bundled.stdout);
  const token = randomBytes(32).toString('hex');
  const catalog = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'build-catalog.mjs'),
    '--bundled', join(directory, 'bundled.json'), '--catalog-dir', join(repoRoot, 'catalog'),
    '--output', join(home, 'models.json'),
    '--instructions', join(repoRoot, 'prompts', 'openrouter-instructions.md'),
    '--persistent', join(repoRoot, 'prompts', 'openrouter-persistent.md')],
  { encoding: 'utf8', env });
  if (catalog.status !== 0) throw new Error(`build-catalog failed: ${catalog.stderr}`);
  writeFileSync(join(directory, 'router.env'), `CODEX_ROUTER_TOKEN=${token}\n`);
  const merged = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'merge-config.mjs'), '',
    home, join(home, 'config.toml'), join(directory, 'router.env')], { encoding: 'utf8', env });
  if (merged.status !== 0) throw new Error(`merge-config failed: ${merged.stderr}`);
  return { env, work, home, token, directory };
}

// Loopback fake upstream. Records the request path, byte length, parsed body,
// and whether the managed provider token arrived; header values and bodies
// are never written anywhere except the returned in-memory records.
export async function startCaptureServer(cleanup, token) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks);
      let body = null;
      try { body = JSON.parse(raw.toString('utf8')); } catch {}
      requests.push({
        method: request.method,
        path: request.url,
        bytes: raw.length,
        tokenOk: request.headers['x-codex-router-token'] === token,
        body,
      });
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
  cleanup(() => server.close());
  return { server, url: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

// One fresh-thread turn for a model against the capture server. The provider
// override keeps the request on loopback; nothing reaches a model endpoint.
export async function captureFreshThread({ env, work, baseUrl, model, prompt, command = 'codex', prefixArgs = [] }) {
  if (!new URL(baseUrl).hostname.endsWith('127.0.0.1')) throw new Error('Capture base URL must stay on loopback');
  const before = (await runTracked(command,
    [...prefixArgs, 'exec', '--ephemeral', '--skip-git-repo-check',
      '-c', `model_providers.unified.base_url=${baseUrl}`, '-m', model, prompt],
    { env, cwd: work, shell: windows && command === 'codex' }));
  if (before.status !== 0) throw new Error(`${model}: codex exec failed: ${before.stderr.slice(-2000)}`);
  return before;
}

export function sessionIdFromOutput(result) {
  for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === 'thread.started' && typeof event.thread_id === 'string') return event.thread_id;
    } catch {}
  }
  const fallback = result.stderr?.match(/^session id: (\S+)$/m)?.[1];
  if (fallback) return fallback;
  throw new Error(`Codex did not report the session ID for the capture (status ${result.status ?? 'unknown'})`
    + `\nstdout: ${String(result.stdout ?? '').slice(-1000)}\nstderr: ${String(result.stderr ?? '').slice(-1000)}`);
}

// A persisted router thread proves the request history stays append-only. The
// resumed turn must use the explicit session ID: `resume --last` can select a
// different provider's thread and Codex refuses a provider change on resume.
export async function capturePersistentThread({ env, work, baseUrl, model, prompt, command = 'codex', prefixArgs = [] }) {
  if (!new URL(baseUrl).hostname.endsWith('127.0.0.1')) throw new Error('Capture base URL must stay on loopback');
  const common = ['--skip-git-repo-check', '-c', `model_providers.unified.base_url=${baseUrl}`, '-m', model];
  const first = await runTracked(command,
    [...prefixArgs, 'exec', '--json', ...common, prompt],
    { env, cwd: work, shell: windows && command === 'codex' });
  if (first.status !== 0) throw new Error(`${model}: first codex exec failed: ${first.stderr.slice(-2000)}`);
  const sessionId = sessionIdFromOutput(first);
  const second = await runTracked(command,
    [...prefixArgs, 'exec', 'resume', ...common, sessionId, 'Continue.'],
    { env, cwd: work, shell: windows && command === 'codex' });
  if (second.status !== 0) throw new Error(`${model}: resumed codex exec failed: ${second.stderr.slice(-2000)}`);
  return { sessionId, first, second };
}

// Codex 0.166+ refuses to continue a thread under another provider. Keeping
// that refusal in the harness distinguishes it from a request-shape change.
export async function probeCrossProviderResume({ env, work, sessionId, model = 'gpt-6-astra', command = 'codex', prefixArgs = [] }) {
  return runTracked(command,
    [...prefixArgs, 'exec', 'resume', '--skip-git-repo-check', '-c', 'model_provider=openai', '-m', model, sessionId, 'Continue.'],
    { env, cwd: work, shell: windows && command === 'codex' });
}

export function toolNames(body) {
  return (body.tools ?? []).flatMap(tool => (tool.type === 'namespace'
    ? tool.tools.map(member => `${tool.name}.${member.name}`) : [tool.name ?? tool.type])).sort();
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const volatilePatterns = [
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/\b(resp|msg|rs|sess)_[A-Za-z0-9_-]+/g, '<$1-id>'],
  [/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, '<timestamp>'],
  // Embedded turn metadata is a JSON-encoded string, so its epoch timestamp
  // needs a string-level rule; other numeric fields stay exact.
  [/("[A-Za-z0-9_]*_at_unix_ms":)\d+/g, '$1"<timestamp>"'],
];

export function redactVolatile(value, scratchRoot, key = '') {
  if (typeof value === 'number' && /_at_unix_ms$/i.test(key)) return '<timestamp>';
  if (typeof value === 'string') {
    let text = value;
    if (scratchRoot) text = text.split(scratchRoot).join('<tmp>');
    for (const [pattern, replacement] of volatilePatterns) text = text.replace(pattern, replacement);
    return text;
  }
  if (Array.isArray(value)) return value.map(entry => redactVolatile(entry, scratchRoot));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([child, entry]) => [child, redactVolatile(entry, scratchRoot, child)]));
  }
  return value;
}

// Stable comparison form: sorted tool names, byte counts, and the request
// body with run-specific identifiers replaced and keys in canonical order, so
// two captures of the same request compare equal.
export function normalizeCapture(record, scratchRoot) {
  return {
    method: record.method,
    path: record.path,
    model: record.body?.model,
    tokenOk: record.tokenOk,
    tools: toolNames(record.body ?? {}),
    toolBytes: JSON.stringify(record.body?.tools ?? []).length,
    requestBytes: record.bytes,
    body: JSON.parse(stableStringify(redactVolatile(record.body, scratchRoot))),
  };
}

export function summarizeCaptureDiff(baseline, current) {
  const lines = [];
  if (baseline.model !== current.model) lines.push(`model: ${baseline.model} -> ${current.model}`);
  for (const tool of current.tools.filter(tool => !baseline.tools.includes(tool))) lines.push(`added tool: ${tool}`);
  for (const tool of baseline.tools.filter(tool => !current.tools.includes(tool))) lines.push(`removed tool: ${tool}`);
  if (baseline.requestBytes !== current.requestBytes) {
    lines.push(`request bytes: ${baseline.requestBytes} -> ${current.requestBytes}`);
  }
  if (baseline.toolBytes !== current.toolBytes) lines.push(`tool bytes: ${baseline.toolBytes} -> ${current.toolBytes}`);
  if (baseline.tokenOk !== current.tokenOk) lines.push('managed provider token stopped arriving');
  const baseBody = baseline.body ?? {};
  const nextBody = current.body ?? {};
  for (const key of [...new Set([...Object.keys(baseBody), ...Object.keys(nextBody)])].sort()) {
    if (stableStringify(baseBody[key]) !== stableStringify(nextBody[key])) lines.push(`changed request field: ${key}`);
  }
  return lines;
}

// Resolve how to run a Codex version: the installed CLI, or a public npm
// package via npx (registry download only; captures still stay on loopback).
// Returns { command, prefixArgs, version } or { skip } when unavailable.
export function resolveCodexRunner(wanted) {
  const installed = installedCodexVersion();
  if (!wanted || wanted === installed) {
    if (!installed) return { skip: 'the Codex CLI is not installed' };
    return { command: 'codex', prefixArgs: [], version: installed };
  }
  if (installed === wanted) return { command: 'codex', prefixArgs: [], version: installed };
  const npx = spawnSync('npx', ['--version'], { encoding: 'utf8', shell: windows, timeout: 30000 });
  if (npx.status !== 0) return { skip: 'npx is not available to fetch the comparison Codex version' };
  const probe = spawnSync('npx', ['-y', `@openai/codex@${wanted}`, '--version'],
    { encoding: 'utf8', shell: windows, timeout: 120000 });
  const fetched = probe.stdout?.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
  if (probe.status !== 0 || fetched !== wanted) {
    return { skip: `could not fetch @openai/codex@${wanted} from the npm registry (offline?); no comparison ran` };
  }
  return { command: 'npx', prefixArgs: ['-y', `@openai/codex@${wanted}`], version: wanted };
}

export function sanitizeModel(model) {
  return model.replace(/[^a-zA-Z0-9]+/g, '-');
}

function parseArgs(values) {
  const options = { models: null, prompt: 'ok', out: null, codexVersion: null, baseline: null, strict: false };
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (arg === '--models') options.models = values[++index];
    else if (arg === '--prompt') options.prompt = values[++index];
    else if (arg === '--out') options.out = values[++index];
    else if (arg === '--codex-version') options.codexVersion = values[++index];
    else if (arg === '--baseline') options.baseline = values[++index];
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--help') { options.help = true; }
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.out) {
    console.log('Capture fresh-thread Codex requests on loopback, without credentials or model traffic.\n\n'
      + 'Usage:\n  node tests/integration/codex-capture.mjs --out <dir> [--models a,b] [--prompt text]\n'
      + '    [--codex-version x.y.z] [--baseline <dir>] [--strict]\n\n'
      + 'Defaults capture one probe model with the installed Codex CLI. --codex-version\n'
      + 'fetches that public @openai/codex release via npx for comparison. --baseline\n'
      + 'diffs each capture against a previous --out directory.');
    process.exit(options.help ? 0 : 2);
  }
  const runner = resolveCodexRunner(options.codexVersion);
  if (runner.skip) throw new Error(runner.skip);
  const models = options.models ? options.models.split(',').map(entry => entry.trim()).filter(Boolean) : [defaultProbeModel()];
  mkdirSync(options.out, { recursive: true });
  const cleanups = [];
  const cleanup = fn => cleanups.push(fn);
  try {
    const { env, work, home, token, directory } = await buildScratchHome(cleanup);
    const { url, requests } = await startCaptureServer(cleanup, token);
    let failed = false;
    for (const model of models) {
      await captureFreshThread({ env, work, baseUrl: url, model, prompt: options.prompt, command: runner.command, prefixArgs: runner.prefixArgs });
      const normalized = normalizeCapture(requests.at(-1), directory);
      void home;
      writeFileSync(join(options.out, `${sanitizeModel(model)}.normalized.json`), `${JSON.stringify(normalized, null, 2)}\n`);
      if (options.baseline) {
        const file = join(options.baseline, `${sanitizeModel(model)}.normalized.json`);
        if (!existsSync(file)) {
          console.error(`No baseline for ${model}; wrote the capture as a new baseline candidate.`);
          failed = options.strict;
          continue;
        }
        const diff = summarizeCaptureDiff(JSON.parse(readFileSync(file, 'utf8')), normalized);
        if (diff.length > 0) {
          console.error(`${model} differs from baseline:\n  ${diff.join('\n  ')}`);
          failed = options.strict;
        } else console.log(`${model}: matches baseline.`);
      } else console.log(`${model}: captured ${normalized.requestBytes} bytes, ${normalized.tools.length} tools.`);
    }
    process.exit(failed ? 1 : 0);
  } finally {
    for (const fn of cleanups.reverse()) {
      try { await fn(); } catch {}
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
