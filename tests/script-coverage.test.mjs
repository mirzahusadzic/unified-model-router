import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { catalogFiles, compareCatalogFiles } from '../scripts/catalog-files.mjs';
import { repositoryRoot } from '../scripts/repository-root.mjs';
import { logicalLines, hasManagedKeysMarker } from '../scripts/toml-lines.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const windowsHost = process.platform === 'win32';

function baseEnv(extra = {}) {
  return {
    ...process.env,
    OPENROUTER_API_KEY: '',
    CODEX_ROUTER_TOKEN: '',
    CODEX_ROUTER_DISABLE_APPS: '1',
    CODEX_ROUTER_DISABLE_ANALYTICS: '1',
    CODEX_ROUTER_AGENT_THREADS: '10',
    CODEX_ROUTER_DISABLE_GUARDIAN: '0',
    CODEX_ROUTER_SANDBOX_NETWORK: '0',
    CODEX_ROUTER_PIN_DAEMON: '',
    CODEX_ROUTER_RESTART_DAEMON: '',
    CODEX_ROUTER_REPO_ROOT: '',
    CODEX_ROUTER_PLATFORM: '',
    CODEX_ROUTER_SOURCE_DIR: '',
    ...extra,
  };
}
function run(script, args = [], opts = {}) {
  const { env = {}, input, timeout = 30000, unset = [] } = opts;
  const childEnv = baseEnv(env);
  for (const name of unset) delete childEnv[name];
  return spawnSync(process.execPath, [join(root, script), ...args], {
    encoding: 'utf8', input, timeout, env: childEnv,
  });
}
function writeWin32Preload(directory) {
  const file = join(directory, 'win32-platform.cjs');
  writeFileSync(file, "Object.defineProperty(process, 'platform', { value: 'win32' });\n");
  return file;
}
function runWin32(script, args = [], opts = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'router-win32-'));
  const preload = writeWin32Preload(directory);
  try {
    const { env = {}, input, timeout = 30000 } = opts;
    return spawnSync(process.execPath, ['--require', preload, join(root, script), ...args], {
      encoding: 'utf8', input, timeout, env: baseEnv(env),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
function runWithPreload(script, args = [], preloadBody, opts = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'router-preload-'));
  const preload = join(directory, 'preload.cjs');
  writeFileSync(preload, preloadBody);
  try {
    const { env = {}, input, timeout = 30000 } = opts;
    return spawnSync(process.execPath, ['--require', preload, join(root, script), ...args], {
      encoding: 'utf8', input, timeout, env: baseEnv(env),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
function succeeds(result, message) {
  assert.equal(result.status, 0, `${message ?? ''}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
}
function fails(result, message) {
  assert.notEqual(result.status, 0, message ?? 'expected failure');
}

// ---------- renderer in a temp root ----------

test('renderer renders single and array entries in a temp root without touching the checkout', t => {
  const repo = mkdtempSync(join(tmpdir(), 'router-render-root-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, 'prompts'), { recursive: true });
  mkdirSync(join(repo, 'catalog', 'vendor-a'), { recursive: true });
  mkdirSync(join(repo, 'catalog', 'vendor-b'), { recursive: true });
  writeFileSync(join(repo, 'prompts', 'openrouter-instructions.md'), 'synthetic instructions');
  writeFileSync(join(repo, 'prompts', 'openrouter-persistent.md'), 'synthetic persistent');
  writeFileSync(join(repo, 'prompts', 'extra.md'), 'synthetic suffix');
  writeFileSync(join(repo, 'catalog', 'vendor-a', 'single.json'),
    JSON.stringify({ slug: 'openrouter/vendor-a/model', display_name: 'A' }));
  writeFileSync(join(repo, 'catalog', 'vendor-b', 'array.json'), JSON.stringify([
    { slug: 'openrouter/vendor-b/model', display_name: 'B', router_instructions_suffix: 'extra.md' },
    { slug: 'native-model', display_name: 'Native stays plain' },
  ]));
  writeFileSync(join(repo, 'catalog', 'vendor-b', 'plain.json'),
    JSON.stringify({ slug: 'custom/plain', display_name: 'Plain' }));
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'render-openrouter-entries.mjs')], {
    encoding: 'utf8', env: { ...process.env, CODEX_ROUTER_REPO_ROOT: repo },
  });
  succeeds(result);
  assert.equal(result.stdout, '');
  const single = JSON.parse(readFileSync(join(repo, 'catalog', 'vendor-a', 'single.json'), 'utf8'));
  assert.equal(single.base_instructions, 'synthetic instructions');
  assert.equal(single.model_messages.instructions_template, 'synthetic instructions');
  assert.equal(single.model_messages.persistent_instructions, 'synthetic persistent');
  const array = JSON.parse(readFileSync(join(repo, 'catalog', 'vendor-b', 'array.json'), 'utf8'));
  assert.equal(array.length, 2);
  assert.equal(array[0].base_instructions, 'synthetic instructions\nsynthetic suffix');
  assert.equal(array[0].model_messages.persistent_instructions, 'synthetic persistent');
  assert.equal(array[0].router_instructions_suffix, 'extra.md');
  assert.deepEqual(array[1], { slug: 'native-model', display_name: 'Native stays plain' });
  const plain = JSON.parse(readFileSync(join(repo, 'catalog', 'vendor-b', 'plain.json'), 'utf8'));
  assert.deepEqual(plain, { slug: 'custom/plain', display_name: 'Plain' });
  // The copied script resolves its default root to the temporary repository,
  // never the checkout other test files are reading concurrently.
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  for (const file of ['render-openrouter-entries.mjs', 'catalog-files.mjs', 'openrouter-prompts.mjs', 'repository-root.mjs']) {
    copyFileSync(join(root, 'scripts', file), join(repo, 'scripts', file));
  }
  const def = spawnSync(process.execPath, [join(repo, 'scripts', 'render-openrouter-entries.mjs')], {
    encoding: 'utf8', env: baseEnv(),
  });
  succeeds(def);
});

test('catalog files skip non-JSON entries and compare names without their extension', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-catalog-files-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'nested'));
  writeFileSync(join(directory, 'plain.json'), '{}');
  writeFileSync(join(directory, 'notes.txt'), '{}');
  writeFileSync(join(directory, 'nested', 'model.json'), '{}');
  writeFileSync(join(directory, 'nested', 'README.md'), '{}');
  assert.deepEqual(catalogFiles(directory), ['nested/model.json', 'plain.json']);
  assert.equal(compareCatalogFiles('a.json', 'b.json'), -1);
  assert.equal(compareCatalogFiles('b.json', 'a.json'), 1);
  assert.equal(compareCatalogFiles('same.json', 'same.json'), 0);
});

test('repository root uses the test override or this checkout', () => {
  assert.equal(repositoryRoot({ CODEX_ROUTER_REPO_ROOT: '/tmp/synthetic-root' }), '/tmp/synthetic-root');
  assert.equal(repositoryRoot({}), fileURLToPath(new URL('../', import.meta.url)));
});

test('merge-config usage failures and missing router token', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-merge-usage-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const existing = join(directory, 'config.toml');
  const home = join(directory, 'codex-home');
  const output = join(directory, 'merged.toml');
  const envFile = join(directory, 'openrouter.env');
  writeFileSync(existing, '');
  writeFileSync(envFile, 'OPENROUTER_API_KEY=synthetic-key\n');
  const merge = (...args) => run('scripts/merge-config.mjs', args);
  for (const args of [[], [existing], [existing, home], [existing, home, output],
    [existing, home, output, envFile, '', '--unknown']]) {
    const result = merge(...args);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /Usage: merge-config\.mjs/);
  }
  const missing = merge(existing, home, output, envFile);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Prepare router credentials before merging/);
  assert.equal(existsSync(output), false);

  writeFileSync(envFile, `CODEX_ROUTER_TOKEN=${'a'.repeat(64)}\n`);
  const defaults = run('scripts/merge-config.mjs', [existing, home, output, envFile], {
    unset: ['CODEX_ROUTER_DISABLE_APPS', 'CODEX_ROUTER_DISABLE_GUARDIAN', 'CODEX_ROUTER_DISABLE_ANALYTICS',
      'CODEX_ROUTER_AGENT_THREADS', 'CODEX_ROUTER_SANDBOX_NETWORK'],
  });
  succeeds(defaults);
  const merged = readFileSync(output, 'utf8');
  assert.match(merged, /apps = false/);
  assert.match(merged, /guardian_approval = false/);
});

// ---------- config-managed ----------

test('config-managed usage and marker states', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-config-managed-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const usage = run('scripts/config-managed.mjs', []);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /Usage: config-managed\.mjs/);
  const missing = join(directory, 'missing.toml');
  assert.equal(run('scripts/config-managed.mjs', [missing]).status, 1);
  const plain = join(directory, 'plain.toml');
  writeFileSync(plain, 'model = "x"\n');
  assert.equal(run('scripts/config-managed.mjs', [plain]).status, 1);
  const managed = join(directory, 'managed.toml');
  writeFileSync(managed, '# BEGIN codex-unified-router managed keys\nmodel = "x"\n# END codex-unified-router managed keys\n');
  assert.equal(run('scripts/config-managed.mjs', [managed]).status, 0);
  const indented = join(directory, 'indented.toml');
  writeFileSync(indented, '  # BEGIN codex-unified-router managed keys  \nmodel = "x"\n');
  // No END marker is fine for the keys-marker check: only the BEGIN line matters.
  assert.equal(run('scripts/config-managed.mjs', [indented]).status, 0);
  const inString = join(directory, 'string.toml');
  writeFileSync(inString, 'note = "# BEGIN codex-unified-router managed keys"\n');
  assert.equal(run('scripts/config-managed.mjs', [inString]).status, 1);
  const inComment = join(directory, 'comment.toml');
  writeFileSync(inComment, '# see "# BEGIN codex-unified-router managed keys" docs\n');
  assert.equal(run('scripts/config-managed.mjs', [inComment]).status, 1);
  const inMultiline = join(directory, 'multiline.toml');
  writeFileSync(inMultiline, 'text = """\n# BEGIN codex-unified-router managed keys\n"""\n');
  assert.equal(run('scripts/config-managed.mjs', [inMultiline]).status, 1);
  assert.equal(hasManagedKeysMarker('# BEGIN codex-unified-router managed keys\n'), true);
});

// ---------- chatgpt-plan ----------

test('chatgpt-plan usage, malformed tokens, and unknown plans', t => {
  const usage = run('scripts/chatgpt-plan.mjs', []);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /Usage: chatgpt-plan\.mjs/);
  const home = mkdtempSync(join(tmpdir(), 'router-plan-edge-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const idToken = claims => ['{"alg":"none"}', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'signature'].join('.');
  const status = (auth, extraEnv) => {
    if (auth === undefined) rmSync(join(home, 'auth.json'), { force: true });
    else writeFileSync(join(home, 'auth.json'), typeof auth === 'string' ? auth : JSON.stringify(auth));
    const result = run('scripts/chatgpt-plan.mjs', [home], extraEnv ? { env: extraEnv } : {});
    succeeds(result);
    assert.doesNotMatch(result.stdout, /signature|eyJ/);
    return result.stdout.trim();
  };
  assert.equal(status(undefined), 'inactive');
  assert.equal(status('not json'), 'unknown');
  assert.equal(status({}), 'inactive');
  assert.equal(status({ tokens: null }), 'inactive');
  assert.equal(status({ tokens: { id_token: 123 } }), 'inactive');
  assert.equal(status({ tokens: { id_token: 'nonsense-without-dots' } }), 'unknown');
  assert.equal(status({ tokens: { id_token: 'a.b' } }), 'unknown');
  assert.equal(status({ tokens: { id_token: 'a.!!!.c' } }), 'unknown');
  assert.equal(status({ tokens: { id_token: idToken(null) } }), 'unknown');
  assert.equal(status({ tokens: { id_token: idToken('just-a-string') } }), 'unknown');
  assert.equal(status({ tokens: { id_token: idToken({ sub: 'user' }) } }), 'unknown');
  const future = new Date(Date.now() + 86400000).toISOString();
  const past = new Date(Date.now() - 86400000).toISOString();
  const plan = until => ({ 'https://api.openai.com/auth': { chatgpt_subscription_active_until: until } });
  assert.equal(status({ tokens: { id_token: idToken(plan(future)) } }), 'active');
  assert.equal(status({ tokens: { id_token: idToken(plan(past)) } }), 'inactive');
  assert.equal(status({ tokens: { id_token: idToken(plan('not-a-date')) } }), 'unknown');
  assert.equal(status({ tokens: { id_token: idToken({ 'https://api.openai.com/auth': null }) } }), 'unknown');
});

// ---------- codex-daemon ----------

function fakeDaemonCodex(directory) {
  const bin = join(directory, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(directory, 'calls.log');
  writeFileSync(join(bin, 'fake-codex.mjs'), `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2).join(' ');
try { appendFileSync(process.env.FAKE_CODEX_LOG ?? ${JSON.stringify(log)}, args + '\\n'); } catch {}
if (args === 'app-server daemon version') {
  if (process.env.FAKE_DAEMON !== 'running') process.exit(1);
  const managed = process.env.FAKE_MANAGED_VERSION || '0.172.0';
  console.log(JSON.stringify({ status: 'running', managedCodexVersion: managed, appServerVersion: managed, cliVersion: '0.172.0' }));
} else if (args === 'app-server daemon update --from-cli --yes') {
  process.exit(Number(process.env.FAKE_PIN_STATUS || 0));
} else if (args === 'app-server daemon restart') {
  process.exit(Number(process.env.FAKE_RESTART_STATUS || 0));
} else { process.exit(1); }
`);
  const isWin = process.platform === 'win32';
  writeFileSync(join(bin, isWin ? 'codex.cmd' : 'codex'), isWin
    ? '@node "%~dp0fake-codex.mjs" %*\r\n'
    : '#!/bin/sh\nexec node "$(dirname "$0")/fake-codex.mjs" "$@"\n', { mode: 0o700 });
  return { bin, log };
}

test('codex-daemon usage and setting validation', () => {
  for (const args of [[], ['--verify'], ['--verify', 'home', '--codex-runs-installer'], ['home', '--unknown'], ['a', 'b', 'c']]) {
    const result = run('scripts/codex-daemon.mjs', args);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /Usage: codex-daemon\.mjs/);
  }
  const home = mkdtempSync(join(tmpdir(), 'router-daemon-usage-'));
  try {
    for (const env of [{ CODEX_ROUTER_PIN_DAEMON: 'yes' }, { CODEX_ROUTER_RESTART_DAEMON: 'maybe' }, { CODEX_ROUTER_PIN_DAEMON: '2' }]) {
      const result = run('scripts/codex-daemon.mjs', [home], { env });
      assert.equal(result.status, 2, JSON.stringify(env));
      assert.match(result.stderr, /must be 0 or 1/);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex-daemon verify branches', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-daemon-verify-edge-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { bin, log } = fakeDaemonCodex(directory);
  const pathEnv = bin + (windowsHost ? ';' : ':') + process.env.PATH;
  const check = (home, env = {}) => run('scripts/codex-daemon.mjs', ['--verify', home], {
    env: { PATH: pathEnv, FAKE_CODEX_LOG: log, FAKE_DAEMON: '', CODEX_ROUTER_PIN_DAEMON: '', ...env },
  });
  const home = join(directory, 'home');
  mkdirSync(home, { recursive: true });
  assert.equal(check(home, { CODEX_ROUTER_PIN_DAEMON: '0' }).status, 0);
  const missing = check(home);
  assert.equal(missing.status, 0);
  assert.match(missing.stderr, /No Codex app-server daemon is installed/);
  const packageRoot = join(home, 'packages', 'app-server-daemon');
  mkdirSync(join(packageRoot, 'current'), { recursive: true });
  rmSync(log, { force: true });
  assert.equal(check(home).status, 0);
  writeFileSync(join(packageRoot, 'auto-update-version'), '0.172.0');
  const unpinned = check(home, { FAKE_DAEMON: 'running' });
  assert.equal(unpinned.status, 1);
  assert.match(unpinned.stderr, /updates itself instead of following/);
  rmSync(join(packageRoot, 'auto-update-version'));
  const drifted = check(home, { FAKE_DAEMON: 'running', FAKE_MANAGED_VERSION: '0.173.0' });
  assert.equal(drifted.status, 1);
  assert.match(drifted.stderr, /runs Codex 0\.173\.0, but the CLI is 0\.172\.0/);
  const ok = check(home, { FAKE_DAEMON: 'running' });
  assert.equal(ok.status, 0, ok.stderr);
  const stoppedOk = check(home, { FAKE_DAEMON: '' });
  assert.equal(stoppedOk.status, 0, stoppedOk.stderr);
});

test('codex-daemon restart and pin branches, including failures', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-daemon-restart-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { bin, log } = fakeDaemonCodex(directory);
  const pathEnv = bin + (windowsHost ? ';' : ':') + process.env.PATH;
  const daemon = (home, flags = [], env = {}) => run('scripts/codex-daemon.mjs', [home, ...flags], {
    env: { PATH: pathEnv, FAKE_CODEX_LOG: log, FAKE_DAEMON: '', CODEX_ROUTER_PIN_DAEMON: '', CODEX_ROUTER_RESTART_DAEMON: '', ...env },
  });
  const freshHome = name => {
    const home = join(directory, name);
    mkdirSync(home, { recursive: true });
    rmSync(log, { force: true });
    return home;
  };
  let home = freshHome('missing-pin-off');
  let result = daemon(home, [], { CODEX_ROUTER_PIN_DAEMON: '0' });
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stderr, /No Codex app-server daemon/);
  home = freshHome('missing-pin-on');
  result = daemon(home, []);
  assert.equal(result.status, 0);
  assert.match(result.stderr, /No Codex app-server daemon is installed/);
  home = freshHome('runs-installer-off');
  mkdirSync(join(home, 'packages', 'app-server-daemon', 'current'), { recursive: true });
  result = daemon(home, ['--codex-runs-installer'], { FAKE_DAEMON: 'running', CODEX_ROUTER_PIN_DAEMON: '0' });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /was not restarted\. Afterwards run: codex app-server daemon restart/);
  assert.doesNotMatch(result.stderr, /or pinned/);
  home = freshHome('runs-installer-on');
  mkdirSync(join(home, 'packages', 'app-server-daemon', 'current'), { recursive: true });
  result = daemon(home, ['--codex-runs-installer'], { FAKE_DAEMON: 'running' });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /was not restarted or pinned/);
  home = freshHome('no-restart-off');
  mkdirSync(join(home, 'packages', 'app-server-daemon', 'current'), { recursive: true });
  result = daemon(home, [], { FAKE_DAEMON: 'running', CODEX_ROUTER_RESTART_DAEMON: '0', CODEX_ROUTER_PIN_DAEMON: '0' });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  home = freshHome('no-restart-on');
  mkdirSync(join(home, 'packages', 'app-server-daemon', 'current'), { recursive: true });
  result = daemon(home, [], { FAKE_DAEMON: 'running', CODEX_ROUTER_RESTART_DAEMON: '0' });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /was not pinned, because CODEX_ROUTER_RESTART_DAEMON=0/);
  home = freshHome('pin-fail-restart-ok');
  mkdirSync(join(home, 'packages', 'app-server-daemon', 'current'), { recursive: true });
  result = daemon(home, [], { FAKE_DAEMON: 'running', FAKE_PIN_STATUS: '1' });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /Could not pin/);
  assert.match(result.stdout, /Restarted the Codex app-server daemon/);
  home = freshHome('pin-fail-restart-fail');
  mkdirSync(join(home, 'packages', 'app-server-daemon', 'current'), { recursive: true });
  result = daemon(home, [], { FAKE_DAEMON: 'running', FAKE_PIN_STATUS: '1', FAKE_RESTART_STATUS: '1' });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /Could not pin/);
  assert.match(result.stderr, /Could not restart/);
  home = freshHome('restart-fail-only');
  mkdirSync(join(home, 'packages', 'app-server-daemon', 'current'), { recursive: true });
  result = daemon(home, [], { FAKE_DAEMON: 'running', CODEX_ROUTER_PIN_DAEMON: '0', FAKE_RESTART_STATUS: '1' });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /Could not restart/);
  home = freshHome('stopped-pin-off');
  mkdirSync(join(home, 'packages', 'app-server-daemon', 'current'), { recursive: true });
  result = daemon(home, [], { CODEX_ROUTER_PIN_DAEMON: '0' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  home = freshHome('stopped-pin-fail');
  mkdirSync(join(home, 'packages', 'app-server-daemon', 'current'), { recursive: true });
  result = daemon(home, [], { FAKE_PIN_STATUS: '1' });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /Could not pin/);
  assert.equal(result.stdout, '');
});

test('codex-daemon covers the Windows spawn branch via platform spoofing', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-daemon-win32-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { bin } = fakeDaemonCodex(directory);
  const home = join(directory, 'home');
  mkdirSync(join(home, 'packages', 'app-server-daemon', 'current'), { recursive: true });
  const pathEnv = bin + (windowsHost ? ';' : ':') + process.env.PATH;
  const result = runWin32('scripts/codex-daemon.mjs', ['--verify', home], {
    env: { PATH: pathEnv, FAKE_DAEMON: '', CODEX_ROUTER_PIN_DAEMON: '0' },
  });
  assert.equal(result.status, 0, result.stderr);
});

// ---------- verify-catalog ----------

test('verify-catalog usage and malformed catalog states', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-verify-catalog-edge-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.equal(run('scripts/verify-catalog.mjs', []).status, 2);
  assert.equal(run('scripts/verify-catalog.mjs', ['--report']).status, 2);
  assert.equal(run('scripts/verify-catalog.mjs', ['a', 'b']).status, 2);
  assert.equal(run('scripts/verify-catalog.mjs', ['--report', 'a', 'b']).status, 2);
  assert.equal(run('scripts/verify-catalog.mjs', ['--report', 'a', 'b', 'c']).status, 2);
  const missing = join(directory, 'missing.json');
  let result = run('scripts/verify-catalog.mjs', [missing]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot read the model catalog/);
  const notJson = join(directory, 'not-json.json');
  writeFileSync(notJson, 'not json');
  result = run('scripts/verify-catalog.mjs', [notJson]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot read the model catalog/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
  for (const body of ['{}', '{"models":"x"}', '{"models":null}', '{"models":{}}']) {
    const file = join(directory, 'no-list.json');
    writeFileSync(file, body);
    result = run('scripts/verify-catalog.mjs', [file]);
    assert.equal(result.status, 1, body);
    assert.match(result.stderr, /has no models list/, body);
  }
  const reportBad = join(directory, 'report-bad.json');
  writeFileSync(reportBad, 'not json');
  result = run('scripts/verify-catalog.mjs', ['--report', reportBad]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot read the model catalog/);
});

test('verify-catalog report with no hidden router models and prompt edge mismatches', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-verify-catalog-report-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bundled = join(directory, 'bundled.json');
  const catalogFile = join(directory, 'models.json');
  writeFileSync(bundled, JSON.stringify({ models: [{ slug: 'gpt-6-astra', visibility: 'list' }] }));
  const build = () => succeeds(run('scripts/build-catalog.mjs', ['--bundled', bundled,
    '--catalog-dir', join(root, 'catalog'),
    '--instructions', join(root, 'prompts', 'openrouter-instructions.md'),
    '--persistent', join(root, 'prompts', 'openrouter-persistent.md'),
    '--output', catalogFile]));
  const verify = (...args) => run('scripts/verify-catalog.mjs', [...args]);
  build();
  let catalog = JSON.parse(readFileSync(catalogFile, 'utf8'));
  catalog.models = catalog.models.filter(model => model.visibility !== 'hide');
  writeFileSync(catalogFile, JSON.stringify(catalog));
  let report = verify('--report', catalogFile);
  assert.equal(report.status, 0, report.stderr);
  assert.doesNotMatch(report.stdout, /usable by name/);
  assert.match(report.stdout, /Native OpenAI models: 1 in \/model/);
  catalog.models = catalog.models.filter(model => model.slug === 'gpt-6-astra');
  writeFileSync(catalogFile, JSON.stringify(catalog));
  report = verify('--report', catalogFile);
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /^Router models: *$/m);
  assert.match(report.stdout, /Native OpenAI models: 1 in \/model/);
  build();
  catalog = JSON.parse(readFileSync(catalogFile, 'utf8'));
  catalog.models.push({ slug: 123, visibility: 'list' });
  catalog.models.push({ slug: 'gpt-6-astra', visibility: 'list' });
  catalog.models.push({ slug: 'custom/plain', visibility: 'list' });
  writeFileSync(catalogFile, JSON.stringify(catalog));
  // Non-string, null, native, and non-router slugs are ignored by the stale check.
  // The catalog still matches the repository, so verification succeeds.
  assert.equal(verify(catalogFile).status, 0, verify(catalogFile).stderr);
  build();
  const edit = change => {
    const data = JSON.parse(readFileSync(catalogFile, 'utf8'));
    change(new Map(data.models.map(model => [model?.slug, model])), data);
    writeFileSync(catalogFile, JSON.stringify(data));
  };
  edit(models => { models.get('deepseek/deepseek-v4.1-flash-1017').base_instructions += 'x'; });
  let result = verify(catalogFile);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^The prompts for deepseek\/deepseek-v4\.1-flash-1017 differ/);
  build();
  edit(models => { models.get('deepseek/deepseek-v4.1-flash-1017').model_messages.instructions_template += 'x'; });
  result = verify(catalogFile);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^The prompts for deepseek\/deepseek-v4\.1-flash-1017 differ/);
  build();
  edit(models => { models.get('deepseek/deepseek-v4.1-flash-1017').auto_compact_token_limit = 123; });
  result = verify(catalogFile);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /has auto_compact_token_limit 123, but the repository sets null/);
  build();
  edit((models, data) => {
    const target = models.get('deepseek/deepseek-v4.1-flash-1017');
    delete target.context_window;
    void data;
  });
  result = verify(catalogFile);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /has context_window null, but the repository sets 960000/);
});

// ---------- verify-credentials ----------

function validHome(t, extraEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), 'router-verify-creds-'));
  mkdirSync(join(home, 'unified-router'), { mode: 0o700 });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const envFile = join(home, 'unified-router', 'openrouter.env');
  const config = join(home, 'config.toml');
  const runWith = (script, args, env = {}) => run(script, args, { env: { ...extraEnv, ...env } });
  succeeds(runWith('scripts/prepare-credentials.mjs', [envFile], { OPENROUTER_API_KEY: 'synthetic-key' }));
  const profile = join(home, 'unified-openrouter.config.toml');
  succeeds(runWith('scripts/merge-config.mjs', [config, home, config, envFile, profile]));
  return { home, envFile, config, profile, runWith };
}

test('verify-credentials usage and missing credential states', t => {
  let result = run('scripts/verify-credentials.mjs', []);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage: verify-credentials\.mjs/);
  const home = mkdtempSync(join(tmpdir(), 'router-creds-missing-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  result = run('scripts/verify-credentials.mjs', [home]);
  assert.notEqual(result.status, 0);
  mkdirSync(join(home, 'unified-router'), { recursive: true });
  const envFile = join(home, 'unified-router', 'openrouter.env');
  writeFileSync(envFile, `CODEX_ROUTER_TOKEN=${'a'.repeat(64)}\n`);
  result = run('scripts/verify-credentials.mjs', [home]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Router credentials are missing/);
  writeFileSync(envFile, 'OPENROUTER_API_KEY=synthetic-key\n');
  result = run('scripts/verify-credentials.mjs', [home]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Router credentials are missing/);
  writeFileSync(envFile, `OPENROUTER_API_KEY=synthetic-key\nCODEX_ROUTER_TOKEN=${'b'.repeat(64)}\n`);
  result = run('scripts/verify-credentials.mjs', [home]);
  assert.notEqual(result.status, 0);
});

test('verify-credentials managed block and provider mismatches', t => {
  const { home, config, profile, runWith } = validHome(t);
  const original = readFileSync(config, 'utf8');
  const originalProfile = readFileSync(profile, 'utf8');
  writeFileSync(config, original.replace('# BEGIN codex-unified-router managed keys', '# BEGIN codex-unified-router managed keys\n# BEGIN codex-unified-router managed keys'));
  assert.match(runWith('scripts/verify-credentials.mjs', [home]).stderr, /Missing or duplicate managed/);
  writeFileSync(config, original.replace('# END codex-unified-router managed keys', ''));
  assert.match(runWith('scripts/verify-credentials.mjs', [home]).stderr, /Unterminated or duplicate/);
  writeFileSync(config, original.replace('# END codex-unified-router managed keys', '# END codex-unified-router managed keys\n# END codex-unified-router managed keys'));
  assert.match(runWith('scripts/verify-credentials.mjs', [home]).stderr, /Unterminated or duplicate/);
  const swapped = original.replace('# BEGIN codex-unified-router managed keys', '# TEMP')
    .replace('# END codex-unified-router managed keys', '# BEGIN codex-unified-router managed keys')
    .replace('# TEMP', '# END codex-unified-router managed keys');
  writeFileSync(config, swapped);
  assert.match(runWith('scripts/verify-credentials.mjs', [home]).stderr, /Unterminated or duplicate/);
  writeFileSync(config, original);
  succeeds(runWith('scripts/verify-credentials.mjs', [home]));
  writeFileSync(config, original.replace('model_provider = "unified"', 'model_provider = "other"'));
  assert.match(runWith('scripts/verify-credentials.mjs', [home]).stderr, /Managed provider or catalog path differs/);
  writeFileSync(config, original.replace('models.json', 'other.json'));
  assert.match(runWith('scripts/verify-credentials.mjs', [home]).stderr, /Managed provider or catalog path differs/);
  writeFileSync(config, original);
  writeFileSync(config, original.replace('requires_openai_auth = true', 'requires_openai_auth = false'));
  assert.match(runWith('scripts/verify-credentials.mjs', [home]).stderr, /Managed transport settings/);
  writeFileSync(config, original);
  writeFileSync(profile, originalProfile.replace('preserve-model-v1', 'other-policy'));
  assert.match(runWith('scripts/verify-credentials.mjs', [home]).stderr, /Managed transport settings/);
  writeFileSync(profile, originalProfile);
  succeeds(runWith('scripts/verify-credentials.mjs', [home]));
  // A provider table removed from the managed block fails the transport check.
  const withoutProvider = original.replace('[model_providers.unified]\n', '');
  writeFileSync(config, withoutProvider);
  assert.match(runWith('scripts/verify-credentials.mjs', [home]).stderr, /Managed transport settings/);
  writeFileSync(config, original);
});

test('verify-credentials feature, analytics, agent, and sandbox gates', t => {
  const { home, config, runWith } = validHome(t);
  const original = readFileSync(config, 'utf8');
  // Apps: wrong value fails, opting out passes, profile (openrouter-only) skips.
  writeFileSync(config, original.replace('apps = false', 'apps = true'));
  assert.match(runWith('scripts/verify-credentials.mjs', [home]).stderr, /apps are not disabled/);
  assert.equal(runWith('scripts/verify-credentials.mjs', [home], { CODEX_ROUTER_DISABLE_APPS: '0' }).status, 0);
  writeFileSync(config, original.replace('[features]', '[features-drifted]'));
  assert.match(runWith('scripts/verify-credentials.mjs', [home]).stderr, /apps are not disabled/);
  writeFileSync(config, original);
  // Guardian enabled explicitly.
  const guardEnv = { CODEX_ROUTER_DISABLE_GUARDIAN: '1' };
  const { home: guardHome, runWith: guardRun } = validHome(t, guardEnv);
  const guardOriginal = readFileSync(join(guardHome, 'config.toml'), 'utf8');
  assert.match(guardOriginal, /guardian_approval = false/);
  succeeds(guardRun('scripts/verify-credentials.mjs', [guardHome]));
  writeFileSync(join(guardHome, 'config.toml'), guardOriginal.replace('guardian_approval = false', 'guardian_approval = true'));
  assert.match(guardRun('scripts/verify-credentials.mjs', [guardHome]).stderr, /guardian is not disabled/);
  assert.equal(guardRun('scripts/verify-credentials.mjs', [guardHome], { CODEX_ROUTER_DISABLE_GUARDIAN: '0' }).status, 0);
  void config;
  // Analytics: wrong value and duplicate table fail.
  writeFileSync(join(home, 'config.toml'), original.replace('enabled = false', 'enabled = true'));
  assert.match(runWith('scripts/verify-credentials.mjs', [home]).stderr, /analytics are not disabled/);
  assert.equal(runWith('scripts/verify-credentials.mjs', [home], { CODEX_ROUTER_DISABLE_ANALYTICS: '0' }).status, 0);
  writeFileSync(join(home, 'config.toml'), `${original}\n[analytics]\nenabled = false\n`);
  assert.match(runWith('scripts/verify-credentials.mjs', [home]).stderr, /analytics are not disabled/);
  writeFileSync(join(home, 'config.toml'), original);
  // Agents: drifted limit fails, opting out passes.
  writeFileSync(join(home, 'config.toml'), original.replace('max_concurrent_threads_per_session = 10', 'max_concurrent_threads_per_session = 5'));
  fails(runWith('scripts/verify-credentials.mjs', [home]));
  succeeds(runWith('scripts/verify-credentials.mjs', [home], { CODEX_ROUTER_AGENT_THREADS: '5' }));
  succeeds(runWith('scripts/verify-credentials.mjs', [home], { CODEX_ROUTER_AGENT_THREADS: '0' }));
  writeFileSync(join(home, 'config.toml'), `${original}\n[agents]\nmax_concurrent_threads_per_session = 10\n`);
  fails(runWith('scripts/verify-credentials.mjs', [home]));
  writeFileSync(join(home, 'config.toml'), original);
  // Sandbox without a managed block fails on the missing block, not the sandbox gate
  // (the enabled gate is covered in the sandbox test below).
  assert.equal(runWith('scripts/verify-credentials.mjs', [home], { CODEX_ROUTER_SANDBOX_NETWORK: '1' }).status, 1);
});

test('verify-credentials sandbox enabled and private-path branches', t => {
  const allow = { CODEX_ROUTER_SANDBOX_NETWORK: '1' };
  const { home, envFile, runWith } = validHome(t);
  const config = join(home, 'config.toml');
  const profile = join(home, 'unified-openrouter.config.toml');
  succeeds(runWith('scripts/merge-config.mjs', [config, home, config, envFile, profile], allow));
  succeeds(runWith('scripts/verify-credentials.mjs', [home], allow));
  writeFileSync(config, readFileSync(config, 'utf8').replace('network_access = true', 'network_access = false'));
  fails(runWith('scripts/verify-credentials.mjs', [home], allow));
  succeeds(runWith('scripts/merge-config.mjs', [config, home, config, envFile, profile], allow));
  succeeds(runWith('scripts/verify-credentials.mjs', [home], allow));
  if (windowsHost) return;
  chmodSync(profile, 0o644);
  fails(runWith('scripts/verify-credentials.mjs', [home]));
  chmodSync(profile, 0o600);
  succeeds(runWith('scripts/verify-credentials.mjs', [home]));
  chmodSync(envFile, 0o644);
  fails(runWith('scripts/verify-credentials.mjs', [home]));
  chmodSync(envFile, 0o600);
  // Windows skips private-path checks even with loose permissions.
  const loose = runWin32('scripts/verify-credentials.mjs', [home]);
  assert.equal(loose.status, 0, loose.stderr);
  // A faked owner mismatch also fails the private-path check.
  const uidResult = runWithPreload('scripts/verify-credentials.mjs', [home],
    'const original = process.getuid?.bind(process); if (original) process.getuid = () => original() + 100000;\n');
  if (typeof process.getuid === 'function') {
    assert.notEqual(uidResult.status, 0);
    assert.match(uidResult.stderr, /private, current-user-owned/);
  }
});

// ---------- verify-router ----------

test('verify-router usage, missing modules, and drifted sources', t => {
  let result = run('scripts/verify-router.mjs', []);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage: verify-router\.mjs/);
  const home = mkdtempSync(join(tmpdir(), 'router-verify-router-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  result = run('scripts/verify-router.mjs', [home]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing router module/);
  const installedDir = join(home, 'unified-router');
  mkdirSync(installedDir, { recursive: true });
  const sourceDir = join(root, 'router');
  for (const name of readdirSync(sourceDir).filter(file => file.endsWith('.mjs') && file !== 'unified-router.mjs').sort()) {
    copyFileSync(join(sourceDir, name), join(installedDir, name));
  }
  result = run('scripts/verify-router.mjs', [home]);
  assert.notEqual(result.status, 0);
  copyFileSync(join(sourceDir, 'unified-router.mjs'), join(installedDir, 'router.mjs'));
  result = run('scripts/verify-router.mjs', [home]);
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(join(installedDir, 'router.mjs'), `${readFileSync(join(installedDir, 'router.mjs'), 'utf8')}\n// drift\n`);
  result = run('scripts/verify-router.mjs', [home]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /installed router differs/);
  copyFileSync(join(sourceDir, 'unified-router.mjs'), join(installedDir, 'router.mjs'));
  assert.equal(run('scripts/verify-router.mjs', [home]).status, 0);
  rmSync(join(installedDir, readdirSync(installedDir).find(name => name !== 'router.mjs')), { force: true });
  result = run('scripts/verify-router.mjs', [home]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing router module/);
});

// ---------- build-catalog ----------

test('build-catalog argument, bundled, and entry edge cases', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-build-edge-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const catalogDir = join(directory, 'catalog');
  mkdirSync(catalogDir, { recursive: true });
  writeFileSync(join(catalogDir, 'entry.json'), JSON.stringify({ slug: 'openrouter/vendor/model' }));
  writeFileSync(join(directory, 'bundled.json'), JSON.stringify({ models: [] }));
  const output = join(directory, 'models.json');
  const build = args => run('scripts/build-catalog.mjs', args);
  fails(build(['foo']));
  assert.match(build(['foo']).stderr, /Unexpected argument/);
  fails(build(['--bundled']));
  assert.match(build(['--bundled']).stderr, /Missing value/);
  assert.match(build(['--bundled', '--catalog-dir', catalogDir]).stderr, /Missing value/);
  fails(build(['--bundled', join(directory, 'bundled.json')]));
  assert.match(build(['--bundled', join(directory, 'bundled.json')]).stderr, /Missing --/);
  fails(build(['--bundled', join(directory, 'bundled.json'), '--catalog-dir', catalogDir]));
  assert.match(build(['--bundled', join(directory, 'bundled.json'), '--catalog-dir', catalogDir]).stderr, /Missing --output/);
  writeFileSync(join(directory, 'bad-bundled.json'), JSON.stringify({}));
  fails(build(['--bundled', join(directory, 'bad-bundled.json'), '--catalog-dir', catalogDir, '--output', output]));
  assert.match(build(['--bundled', join(directory, 'bad-bundled.json'), '--catalog-dir', catalogDir, '--output', output]).stderr, /no models array/);
  writeFileSync(join(directory, 'bad-bundled.json'), JSON.stringify({ models: 'x' }));
  assert.match(build(['--bundled', join(directory, 'bad-bundled.json'), '--catalog-dir', catalogDir, '--output', output]).stderr, /no models array/);
  for (const [name, entry] of [['missing.json', {}], ['empty.json', { slug: '' }], ['number.json', { slug: 123 }], ['null.json', null]]) {
    const dir = mkdtempSync(join(directory, `cat-${name}-`));
    writeFileSync(join(dir, name), JSON.stringify(entry));
    const r = build(['--bundled', join(directory, 'bundled.json'), '--catalog-dir', dir, '--output', output]);
    assert.notEqual(r.status, 0, name);
    assert.match(r.stderr, /without a slug/, name);
  }
  const arrayDir = mkdtempSync(join(directory, 'array-'));
  writeFileSync(join(arrayDir, 'models.json'), JSON.stringify([
    { slug: 'openrouter/vendor/a' }, { slug: 'openrouter/vendor/b' },
  ]));
  succeeds(build(['--bundled', join(directory, 'bundled.json'), '--catalog-dir', arrayDir, '--output', output]));
  const models = JSON.parse(readFileSync(output, 'utf8')).models;
  assert.deepEqual(models.map(model => model.slug), ['openrouter/vendor/a', 'openrouter/vendor/b']);
  assert.match(build(['--bundled', join(directory, 'bundled.json'), '--catalog-dir', catalogDir,
    '--instructions', join(root, 'prompts', 'openrouter-instructions.md'), '--output', output]).stderr,
    /Pass both --instructions and --persistent/);
});

// ---------- toml-lines ----------

test('toml-lines multi-line strings, escapes, comments, and markers', () => {
  assert.deepEqual(logicalLines(''), ['']);
  assert.deepEqual(logicalLines('a = 1\nb = 2').join('\n'), 'a = 1\nb = 2');
  assert.deepEqual(logicalLines('a = 1\r\nb = 2'), ['a = 1', 'b = 2']);
  // Triple-double-quoted string with an escaped backslash stays one logical line set.
  const escaped = 'key = """a\\\\b"""\nnext = 1';
  assert.equal(logicalLines(escaped).length, 2);
  assert.equal(logicalLines(escaped).join('\n'), escaped);
  // Triple-single-quoted backslashes do not escape the delimiter.
  const single = "key = '''a\\b'''\nnext = 1";
  assert.equal(logicalLines(single).length, 2);
  // Unterminated triple-quoted string joins the following lines.
  assert.deepEqual(logicalLines('a = """foo\nbar\nbaz = 1'), ['a = """foo\nbar\nbaz = 1']);
  assert.deepEqual(logicalLines("a = '''foo\nbar"), ["a = '''foo\nbar"]);
  // Extra quotes directly after a closing delimiter stay on the same line.
  assert.deepEqual(logicalLines('a = """foo""""\nnext = 1'), ['a = """foo""""', 'next = 1']);
  assert.deepEqual(logicalLines('a = """foo""""" \nnext = 1'), ['a = """foo""""" ', 'next = 1']);
  assert.deepEqual(logicalLines("a = '''foo''''\nnext = 1"), ["a = '''foo''''", 'next = 1']);
  // Quotes inside comments never open strings.
  assert.deepEqual(logicalLines('# """\na = 1'), ['# """', 'a = 1']);
  assert.deepEqual(logicalLines('a = 1 # """\nb = 2'), ['a = 1 # """', 'b = 2']);
  // Quotes inside single-line strings never open multi-line strings.
  assert.deepEqual(logicalLines('note = "a \\"\\"\\" inside"\na = 1'), ['note = "a \\"\\"\\" inside"', 'a = 1']);
  assert.deepEqual(logicalLines("note = 'a \"\"\" inside'\na = 1"), ["note = 'a \"\"\" inside'", 'a = 1']);
  // Escaped quotes inside double-quoted single-line strings are skipped.
  assert.deepEqual(logicalLines('a = "x \\"y\\" z"\nb = 1'), ['a = "x \\"y\\" z"', 'b = 1']);
  assert.deepEqual(logicalLines("a = 'x \"y\" z'\nb = 1"), ["a = 'x \"y\" z'", 'b = 1']);
  assert.equal(hasManagedKeysMarker('# BEGIN codex-unified-router managed keys'), true);
  assert.equal(hasManagedKeysMarker('  # BEGIN codex-unified-router managed keys  '), true);
  assert.equal(hasManagedKeysMarker('x = "# BEGIN codex-unified-router managed keys"'), false);
  assert.equal(hasManagedKeysMarker('# BEGIN codex-unified-router managed keys extra'), false);
  assert.equal(hasManagedKeysMarker('text = """\n# BEGIN codex-unified-router managed keys\n"""'), false);
});

// ---------- prepare-credentials ----------

test('prepare-credentials usage, quoting, and platform branches', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-prepare-edge-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const envFile = join(directory, 'openrouter.env');
  assert.notEqual(run('scripts/prepare-credentials.mjs', []).status, 0);
  assert.match(run('scripts/prepare-credentials.mjs', []).stderr, /Usage: prepare-credentials/);
  assert.notEqual(run('scripts/prepare-credentials.mjs', [envFile, '--unknown']).status, 0);
  assert.notEqual(run('scripts/prepare-credentials.mjs', [envFile, '--api-key-file']).status, 0);
  assert.notEqual(run('scripts/prepare-credentials.mjs', [envFile, '--api-key-file', 'a', 'b']).status, 0);
  assert.notEqual(run('scripts/prepare-credentials.mjs', [envFile, '--api-key-stdin', 'extra']).status, 0);
  writeFileSync(envFile, 'OPENROUTER_API_KEY="synthetic-double-key"\n');
  succeeds(run('scripts/prepare-credentials.mjs', [envFile], { env: { OPENROUTER_API_KEY: '' } }));
  assert.match(readFileSync(envFile, 'utf8'), /^OPENROUTER_API_KEY=synthetic-double-key$/m);
  writeFileSync(envFile, "OPENROUTER_API_KEY='synthetic-single-key'\n");
  succeeds(run('scripts/prepare-credentials.mjs', [envFile], { env: { OPENROUTER_API_KEY: '' } }));
  assert.match(readFileSync(envFile, 'utf8'), /^OPENROUTER_API_KEY=synthetic-single-key$/m);
  writeFileSync(envFile, 'OPENROUTER_API_KEY="mismatched\n');
  succeeds(run('scripts/prepare-credentials.mjs', [envFile], { env: { OPENROUTER_API_KEY: '' } }));
  assert.match(readFileSync(envFile, 'utf8'), /^OPENROUTER_API_KEY="mismatched$/m);
  writeFileSync(envFile, "OPENROUTER_API_KEY='mismatched\n");
  succeeds(run('scripts/prepare-credentials.mjs', [envFile], { env: { OPENROUTER_API_KEY: '' } }));
  assert.match(readFileSync(envFile, 'utf8'), /^OPENROUTER_API_KEY='mismatched$/m);
  writeFileSync(envFile, '# comment\n\nnot-a-setting\nOPENROUTER_API_KEY=synthetic-key\nCODEX_ROUTER_LOG_LEVEL=info\n');
  succeeds(run('scripts/prepare-credentials.mjs', [envFile], { env: { OPENROUTER_API_KEY: '' } }));
  assert.match(readFileSync(envFile, 'utf8'), /CODEX_ROUTER_LOG_LEVEL=info/);
  const empty = join(directory, 'empty.env');
  assert.notEqual(run('scripts/prepare-credentials.mjs', [empty], { env: { OPENROUTER_API_KEY: '' } }).status, 0);
  if (!windowsHost) {
    chmodSync(envFile, 0o644);
    succeeds(run('scripts/prepare-credentials.mjs', [envFile], { env: { OPENROUTER_API_KEY: 'synthetic-key' } }));
    assert.equal(statSync(envFile).mode & 0o777, 0o600);
  }
  const winEnv = join(directory, 'win.env');
  writeFileSync(winEnv, 'OPENROUTER_API_KEY=synthetic-key\n');
  if (!windowsHost) chmodSync(winEnv, 0o644);
  const winResult = runWin32('scripts/prepare-credentials.mjs', [winEnv], { env: { OPENROUTER_API_KEY: 'synthetic-key' } });
  assert.equal(winResult.status, 0, winResult.stderr);
  if (!windowsHost) assert.equal(statSync(winEnv).mode & 0o777, 0o644);
});

test('verify-catalog covers array entries, non-router skips, and empty repos via temp root', t => {
  const repo = mkdtempSync(join(tmpdir(), 'router-verify-temp-root-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, 'prompts'), { recursive: true });
  mkdirSync(join(repo, 'catalog', 'vendor'), { recursive: true });
  writeFileSync(join(repo, 'prompts', 'openrouter-instructions.md'), 'synthetic instructions');
  writeFileSync(join(repo, 'prompts', 'openrouter-persistent.md'), 'synthetic persistent');
  writeFileSync(join(repo, 'catalog', 'vendor', 'array.json'), JSON.stringify([
    { slug: 'openrouter/vendor/a', display_name: 'A' },
    { slug: 'openrouter/vendor/b', display_name: 'B' },
  ]));
  writeFileSync(join(repo, 'catalog', 'vendor', 'single.json'),
    JSON.stringify({ slug: 'openrouter/vendor/c', display_name: 'C' }));
  const directory = mkdtempSync(join(tmpdir(), 'router-verify-temp-out-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'bundled.json'), JSON.stringify({ models: [] }));
  const catalogFile = join(directory, 'models.json');
  const build = spawnSync(process.execPath, [join(root, 'scripts', 'build-catalog.mjs'),
    '--bundled', join(directory, 'bundled.json'), '--catalog-dir', join(repo, 'catalog'),
    '--instructions', join(repo, 'prompts', 'openrouter-instructions.md'),
    '--persistent', join(repo, 'prompts', 'openrouter-persistent.md'),
    '--output', catalogFile], { encoding: 'utf8' });
  succeeds(build, build.stderr);
  // A non-router entry is skipped by the verifier (builds reject it).
  writeFileSync(join(repo, 'catalog', 'vendor', 'plain.json'),
    JSON.stringify({ slug: 'custom/plain', display_name: 'Plain' }));
  const verify = spawnSync(process.execPath, [join(root, 'scripts', 'verify-catalog.mjs'), catalogFile], {
    encoding: 'utf8', env: { ...process.env, CODEX_ROUTER_REPO_ROOT: repo },
  });
  succeeds(verify, verify.stderr);
  const empty = mkdtempSync(join(tmpdir(), 'router-verify-empty-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  mkdirSync(join(empty, 'prompts'), { recursive: true });
  mkdirSync(join(empty, 'catalog', 'vendor'), { recursive: true });
  writeFileSync(join(empty, 'prompts', 'openrouter-instructions.md'), 'synthetic instructions');
  writeFileSync(join(empty, 'prompts', 'openrouter-persistent.md'), 'synthetic persistent');
  writeFileSync(join(empty, 'catalog', 'vendor', 'plain.json'),
    JSON.stringify({ slug: 'custom/plain', display_name: 'Plain' }));
  const emptyCatalog = join(directory, 'empty.json');
  writeFileSync(emptyCatalog, JSON.stringify({ models: [] }));
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'verify-catalog.mjs'), emptyCatalog], {
    encoding: 'utf8', env: { ...process.env, CODEX_ROUTER_REPO_ROOT: empty },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No router catalog entries were checked/);
});
