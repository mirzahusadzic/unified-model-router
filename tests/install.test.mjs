import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { logicalLines } from '../scripts/toml-lines.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const windows = process.platform === 'win32';
// The installer or verifier for this platform under platform/unix or platform/windows.
const platformScript = name => join(root, 'platform', windows ? 'windows' : 'unix', name + (windows ? '.ps1' : '.sh'));
// Each setting with its table, so assertions survive layout changes.
function settings(text) {
  let table = '';
  return logicalLines(text).map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'))
    .flatMap(line => (line.startsWith('[') ? ((table = line), []) : [`${table} ${line}`]));
}

test('no-service installer guards collisions before mutation and preserves backed-up profile preferences', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-install-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, 'codex-home');
  const bin = join(directory, 'bin');
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(join(bin, windows ? 'codex.cmd' : 'codex'), windows
    ? '@echo off\r\necho {"models":[]}\r\n'
    : '#!/bin/sh\nprintf \'{"models":[]}\\n\'\n', { mode: 0o700 });
  const environment = { ...process.env, HOME: directory, CODEX_HOME: home,
    PATH: bin + (windows ? ';' : ':') + process.env.PATH, OPENROUTER_API_KEY: 'synthetic-install-key',
    CODEX_ROUTER_TOKEN: '', CODEX_ROUTER_DISABLE_APPS: '1' };
  function invoke(verify = false, force = false) {
    const script = platformScript(verify ? 'verify-install' : 'install');
    return spawnSync(windows ? 'powershell.exe' : 'bash', windows
      ? ['-NoProfile', '-File', script, '-NoService', ...(force ? ['-Force'] : [])]
      : [script, '--no-service', ...(force ? ['--force'] : [])],
    { env: environment, encoding: 'utf8', timeout: 30000 });
  }
  const profile = join(home, 'unified-openrouter.config.toml');
  const original = 'model = "deepseek/custom"\nmodel_reasoning_effort = "high"\n'
    + '[features]\nshell_tool = false\n';
  writeFileSync(profile, original);
  const collision = invoke();
  assert.equal(collision.status, 2, collision.stderr);
  assert.equal(readFileSync(profile, 'utf8'), original);
  assert.deepEqual(readdirSync(home), ['unified-openrouter.config.toml']);
  const converted = invoke(false, true);
  assert.equal(converted.status, 0, converted.stderr);
  const first = readFileSync(profile, 'utf8');
  for (const setting of settings(original)) assert.ok(settings(first).includes(setting), setting);
  const backups = readdirSync(join(home, 'backups'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(home, 'backups', backups[0], 'unified-openrouter.config.toml'), 'utf8'), original);
  const verified = invoke(true);
  assert.equal(verified.status, 0, verified.stderr);
  const updated = invoke();
  assert.equal(updated.status, 0, updated.stderr);
  assert.equal(readFileSync(profile, 'utf8'), first);
  assert.equal(existsSync(join(home, 'unified-router/start-router.cmd')), false);
  rmSync(profile);
  assert.notEqual(invoke(true).status, 0);
});

test('marker text in a comment or string still requires an explicit first conversion', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-install-marker-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, 'codex-home');
  const bin = join(directory, 'bin');
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(join(bin, windows ? 'codex.cmd' : 'codex'), windows
    ? '@echo off\r\necho {"models":[]}\r\n'
    : '#!/bin/sh\nprintf \'{"models":[]}\\n\'\n', { mode: 0o700 });
  const config = join(home, 'config.toml');
  const original = 'model = "mine" # see # BEGIN codex-unified-router managed keys\n'
    + 'developer_instructions = """\n# BEGIN codex-unified-router managed keys\nKeep these instructions.\n"""\n';
  writeFileSync(config, original);
  const result = spawnSync(windows ? 'powershell.exe' : 'bash', windows
    ? ['-NoProfile', '-File', platformScript('install'), '-NoService']
    : [platformScript('install'), '--no-service'], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, HOME: directory, CODEX_HOME: home, PATH: bin + (windows ? ';' : ':') + process.env.PATH,
      OPENROUTER_API_KEY: 'synthetic-install-key', CODEX_ROUTER_TOKEN: '', CODEX_ROUTER_DISABLE_APPS: '1' },
  });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(readFileSync(config, 'utf8'), original);
});

test('installer settings are validated before anything is written', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-install-settings-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, 'codex-home');
  mkdirSync(home);
  for (const [name, value] of [['CODEX_ROUTER_RESTART_DAEMON', 'yes'], ['CODEX_ROUTER_PIN_DAEMON', 'yes'], ['CODEX_ROUTER_NATIVE_MODELS', 'maybe'],
    ['CODEX_ROUTER_DISABLE_APPS', 'yes'], ['CODEX_ROUTER_DISABLE_GUARDIAN', 'on'], ['CODEX_ROUTER_DISABLE_ANALYTICS', 'no'], ['CODEX_ROUTER_AGENT_THREADS', '1000'],
    ['CODEX_ROUTER_SANDBOX_NETWORK', 'yes']]) {
    const result = spawnSync(windows ? 'powershell.exe' : 'bash', windows
      ? ['-NoProfile', '-File', platformScript('install'), '-NoService']
      : [platformScript('install'), '--no-service'], {
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, HOME: directory, CODEX_HOME: home, OPENROUTER_API_KEY: 'synthetic-install-key', [name]: value },
    });
    assert.equal(result.status, 2, `${name}: ${result.stderr}`);
    assert.match(result.stderr, new RegExp(name));
    assert.deepEqual(readdirSync(home), []);
  }
});

test('installs with a key file, and fails without a key when it cannot prompt', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-install-key-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, 'codex-home');
  const bin = join(directory, 'bin');
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(join(bin, windows ? 'codex.cmd' : 'codex'), windows
    ? '@echo off\r\necho {"models":[]}\r\n'
    : '#!/bin/sh\nprintf \'{"models":[]}\\n\'\n', { mode: 0o700 });
  const keyFile = join(directory, 'openrouter.key');
  writeFileSync(keyFile, 'synthetic-file-key\n', { mode: 0o600 });
  const install = (extra, env = {}, codexHome = home) => spawnSync(windows ? 'powershell.exe' : 'bash', windows
    ? ['-NoProfile', '-File', platformScript('install'), '-NoService', ...extra]
    : [platformScript('install'), '--no-service', ...extra], {
    encoding: 'utf8', timeout: 30000, input: '',
    env: { ...process.env, HOME: directory, CODEX_HOME: codexHome, PATH: bin + (windows ? ';' : ':') + process.env.PATH,
      OPENROUTER_API_KEY: '', CODEX_ROUTER_TOKEN: '', CODEX_ROUTER_DISABLE_APPS: '1', ...env },
  });

  const missing = install([]);
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, windows ? /-ApiKeyFile/ : /--api-key-file/);
  assert.deepEqual(readdirSync(home), []);

  const installed = install(windows ? ['-ApiKeyFile', keyFile] : ['--api-key-file', keyFile]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.doesNotMatch(installed.stdout + installed.stderr, /synthetic-file-key/);
  assert.match(readFileSync(join(home, 'unified-router', 'openrouter.env'), 'utf8'), /^OPENROUTER_API_KEY=synthetic-file-key$/m);
  // The closing summary lists one model per entry, with its command on its own
  // line, and warns about isolation whether native models are shown or hidden:
  // hidden ones stay usable by name.
  const checkSummary = (stdout, nativeShown) => {
    const summary = stdout.slice(stdout.indexOf('Start Codex'));
    for (const slug of ['ultra-spark-private/deepseek-v4.1-flash-1017', 'ultra-spark/deepseek-v4.1-flash-1017',
      'openrouter/meta/muse-spark-1.3',
      'openrouter/meta/muse-spark-1.3-contributor',
      'openrouter/openai/gpt-6.1-sol',
      'anthropic/claude-fable-5-2', 'anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5-5']) {
      assert.match(summary, new RegExp(`^ {4}codex -m ${slug.replaceAll('.', '\\.')}\\r?$`, 'm'));
    }
    assert.equal(/^ {4}codex -m gpt-6-astra\r?$/m.test(summary), nativeShown);
    assert.equal(/^Native OpenAI models are hidden from \/model/m.test(summary), !nativeShown);
    assert.match(summary, /^Tracked Codex sessions never mix OpenAI, Claude, or non-training\r?\nUltra Spark models with Muse Spark 1\.3 Contributor or Ultra Spark\r?\nContributor\.\r?$/m);
    for (const line of summary.split(/\r?\n/)) assert.ok(line.length <= 80, line);
  };
  checkSummary(installed.stdout, false);
  const shownHome = join(directory, 'codex-home-shown');
  mkdirSync(shownHome);
  const shown = install(windows ? ['-ApiKeyFile', keyFile] : ['--api-key-file', keyFile],
    { CODEX_ROUTER_NATIVE_MODELS: 'show' }, shownHome);
  assert.equal(shown.status, 0, shown.stderr);
  checkSummary(shown.stdout, true);
});

test('a failed configuration merge leaves the stored credentials untouched', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-install-merge-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, 'codex-home');
  const bin = join(directory, 'bin');
  mkdirSync(join(home, 'unified-router'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(bin, windows ? 'codex.cmd' : 'codex'), windows
    ? '@echo off\r\necho {"models":[]}\r\n'
    : '#!/bin/sh\nprintf \'{"models":[]}\\n\'\n', { mode: 0o700 });
  const routerEnv = join(home, 'unified-router', 'openrouter.env');
  const stored = `OPENROUTER_API_KEY=stored-key\nCODEX_ROUTER_TOKEN=${'b'.repeat(64)}\n`;
  writeFileSync(routerEnv, stored, { mode: 0o600 });
  // A managed block without its end marker passes the collision check, then fails the merge.
  const config = join(home, 'config.toml');
  const original = '# BEGIN codex-unified-router managed keys\nmodel = "mine"\n';
  writeFileSync(config, original);
  const result = spawnSync(windows ? 'powershell.exe' : 'bash', windows
    ? ['-NoProfile', '-File', platformScript('install'), '-NoService']
    : [platformScript('install'), '--no-service'], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, HOME: directory, CODEX_HOME: home, PATH: bin + (windows ? ';' : ':') + process.env.PATH,
      OPENROUTER_API_KEY: 'new-key', CODEX_ROUTER_TOKEN: '', CODEX_ROUTER_DISABLE_APPS: '1' },
  });
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /Unterminated managed configuration block/);
  assert.equal(readFileSync(routerEnv, 'utf8'), stored);
  assert.equal(readFileSync(config, 'utf8'), original);
});

test('install.mjs runs the platform installer and verifier with translated flags', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-install-entry-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, 'codex-home');
  const bin = join(directory, 'bin');
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(join(bin, windows ? 'codex.cmd' : 'codex'), windows
    ? '@echo off\r\necho {"models":[]}\r\n'
    : '#!/bin/sh\nprintf \'{"models":[]}\\n\'\n', { mode: 0o700 });
  const keyFile = join(directory, 'openrouter.key');
  writeFileSync(keyFile, 'synthetic-entry-key\n', { mode: 0o600 });
  const entry = args => spawnSync(process.execPath, [join(root, 'install.mjs'), ...args], {
    encoding: 'utf8', timeout: 60000, input: '',
    env: { ...process.env, HOME: directory, CODEX_HOME: home, PATH: bin + (windows ? ';' : ':') + process.env.PATH,
      OPENROUTER_API_KEY: '', CODEX_ROUTER_TOKEN: '', CODEX_ROUTER_DISABLE_APPS: '1' },
  });

  const installed = entry(['--no-service', '--api-key-file', keyFile]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(readFileSync(join(home, 'unified-router', 'openrouter.env'), 'utf8'), /^OPENROUTER_API_KEY=synthetic-entry-key$/m);
  const verified = entry(['--verify', '--no-service']);
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Install looks valid/);
  // The fake Codex bundles no native models, so the report lists only router models.
  assert.match(verified.stdout, /^Router models: anthropic\/claude-fable-5-2, anthropic\/claude-opus-5-5, anthropic\/claude-sonnet-5-5, deepseek\/deepseek-v4\.1-flash-1017, ultra-spark\/deepseek-v4\.1-flash-1017, /m);
  assert.match(verified.stdout, /^Native OpenAI models: hidden from \/model\r?$/m);
  for (const args of [['--bogus'], ['--verify', '--force'], ['--api-key-file'], ['--verify', '--change-api-key'],
    ['--change-api-key', '--api-key-file', keyFile]]) {
    assert.equal(entry(args).status, 2, args.join(' '));
  }
  // Without a terminal, --change-api-key stops before replacing the stored key.
  const unchanged = entry(['--no-service', '--change-api-key']);
  assert.equal(unchanged.status, 1, unchanged.stderr);
  assert.match(unchanged.stderr, /No terminal to ask for the OpenRouter API key/);
  assert.match(readFileSync(join(home, 'unified-router', 'openrouter.env'), 'utf8'), /^OPENROUTER_API_KEY=synthetic-entry-key$/m);
});

test('install.mjs warns, without stopping, when Codex differs from the tested version', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-install-version-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, 'codex-home');
  const bin = join(directory, 'bin');
  mkdirSync(home);
  mkdirSync(bin);
  // A Codex stand-in that reports a newer version but still serves an empty bundled catalog.
  writeFileSync(join(bin, windows ? 'codex.cmd' : 'codex'), windows
    ? '@echo off\r\nif "%1"=="--version" (echo codex-cli 9.9.9) else (echo {"models":[]})\r\n'
    : '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 9.9.9"; else printf \'{"models":[]}\\n\'; fi\n', { mode: 0o700 });
  const result = spawnSync(process.execPath, [join(root, 'install.mjs'), '--no-service'], {
    encoding: 'utf8', timeout: 60000, input: '',
    env: { ...process.env, HOME: directory, CODEX_HOME: home, PATH: bin + (windows ? ';' : ':') + process.env.PATH,
      OPENROUTER_API_KEY: 'synthetic-install-key', CODEX_ROUTER_TOKEN: '', CODEX_ROUTER_DISABLE_APPS: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /tested with Codex 0\.167\.0, but the Codex CLI is 9\.9\.9/);
  assert.match(result.stderr, /npm install -g @openai\/codex@0\.167\.0/);
});

test('install.mjs --help lists every installer setting in docs/setup.md, and errors point to it', () => {
  const entry = args => spawnSync(process.execPath, [join(root, 'install.mjs'), ...args], { encoding: 'utf8', timeout: 30000 });
  const help = entry(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stderr, '');
  assert.equal(entry(['-h']).stdout, help.stdout);
  assert.match(help.stdout, /^Examples:$/m);
  const setup = readFileSync(join(root, 'docs', 'setup.md'), 'utf8');
  const table = setup.slice(setup.indexOf('#### Installer settings'), setup.indexOf('#### Codex version'));
  const settings = [...table.matchAll(/^\| `([^` ]+)/gm)].map(match => match[1]);
  assert.ok(settings.length >= 10, settings.join(' '));
  for (const setting of settings) assert.match(help.stdout, new RegExp(`^ {2}${setting}\\b`, 'm'), setting);
  for (const line of help.stdout.split('\n')) {
    if (!line.includes('https://')) assert.ok(line.length <= 80, line);
  }

  for (const [args, message] of [
    [['--change-api-ke'], /^Unknown option: --change-api-ke\nDid you mean --change-api-key\?$/m],
    [['--frce'], /Did you mean --force\?/],
    [['-x'], /^Unknown option: -x\nRun/m],
    [['.'], /^Unexpected argument: \.$/m],
    [['--api-key-file'], /--api-key-file needs a path/],
    [['--api-key-file', '--force'], /--api-key-file needs a path/],
    [['--api-key-file='], /--api-key-file needs a path/],
    [['--verify', '--force'], /--verify checks an installation/],
    [['--change-api-key', '--api-key-file', 'key'], /either --api-key-file or --change-api-key/],
  ]) {
    const result = entry(args);
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.stdout, '', args.join(' '));
    assert.match(result.stderr, message, args.join(' '));
    assert.match(result.stderr, /Run 'node install\.mjs --help' for usage\.$/m, args.join(' '));
  }

  if (!windows) {
    for (const name of ['install', 'verify-install']) {
      const platformHelp = spawnSync('bash', [platformScript(name), '--help'], { encoding: 'utf8', timeout: 30000 });
      assert.equal(platformHelp.status, 0, platformHelp.stderr);
      assert.equal(platformHelp.stdout, help.stdout, name);
      const unknown = spawnSync('bash', [platformScript(name), '--bogus'], { encoding: 'utf8', timeout: 30000 });
      assert.equal(unknown.status, 2, name);
      assert.match(unknown.stderr, /^Unknown option: --bogus\nRun 'node install\.mjs --help' for usage\.$/m, name);
    }
  }
});

test('Unix scripts need no jq, since CI runner images ship it and would hide a new dependency', () => {
  for (const name of ['install.sh', 'verify-install.sh']) {
    const code = readFileSync(join(root, 'platform', 'unix', name), 'utf8')
      .split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');
    assert.doesNotMatch(code, /\bjq\b/, name);
  }
});

// A Codex stand-in for the daemon commands: it records each call and answers
// `daemon version` only while FAKE_DAEMON is `running`.
function fakeDaemonCodex(directory) {
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'fake-codex.mjs'), `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2).join(' ');
appendFileSync(process.env.FAKE_CODEX_LOG, args + '\\n');
if (args === '--version') {
  console.log('codex-cli 0.167.0');
} else if (args === 'app-server daemon version') {
  if (process.env.FAKE_DAEMON !== 'running') process.exit(1);
  const managed = process.env.FAKE_MANAGED_VERSION || '0.167.0';
  console.log(JSON.stringify({ status: 'running', managedCodexVersion: managed, appServerVersion: managed, cliVersion: '0.167.0' }));
} else if (args === 'app-server daemon update --from-cli --yes') {
  process.exit(Number(process.env.FAKE_PIN_STATUS || 0));
}
`);
  writeFileSync(join(bin, windows ? 'codex.cmd' : 'codex'), windows
    ? '@node "%~dp0fake-codex.mjs" %*\r\n'
    : '#!/bin/sh\nexec node "$(dirname "$0")/fake-codex.mjs" "$@"\n', { mode: 0o700 });
  return bin;
}

test('the daemon step pins the daemon to the CLI, restarts it only when allowed, and skips a missing one', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-daemon-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = fakeDaemonCodex(directory);
  const log = join(directory, 'calls.log');
  const pin = 'update --from-cli --yes';
  for (const scenario of [
    { name: 'running daemon', daemon: 'running', calls: ['version', pin], stdout: /^Pinned the Codex app-server daemon to the CLI's Codex and restarted it\.$/m },
    { name: 'pinning turned off', daemon: 'running', env: { CODEX_ROUTER_PIN_DAEMON: '0' }, calls: ['version', 'restart'], stdout: /^Restarted the Codex app-server daemon\.$/m },
    { name: 'restarts turned off', daemon: 'running', env: { CODEX_ROUTER_RESTART_DAEMON: '0' }, calls: ['version'], stderr: /was not pinned, because CODEX_ROUTER_RESTART_DAEMON=0/ },
    { name: 'stopped daemon', installed: true, calls: ['version', pin], stdout: /^Pinned the Codex app-server daemon to the CLI's Codex\.$/m },
    { name: 'no daemon', calls: ['version'], stderr: /^No Codex app-server daemon is installed, so there is none to pin\./m },
    { name: 'Codex runs the installer', daemon: 'running', flags: ['--codex-runs-installer'], calls: ['version'], stderr: /not restarted or pinned\. Afterwards run: codex app-server daemon update --from-cli --yes/ },
    { name: 'pinning fails', daemon: 'running', env: { FAKE_PIN_STATUS: '1' }, calls: ['version', pin, 'restart'], stderr: /Could not pin/ },
  ]) {
    const home = join(directory, scenario.name.replaceAll(' ', '-'));
    mkdirSync(scenario.installed ? join(home, 'packages', 'app-server-daemon', 'current') : home, { recursive: true });
    rmSync(log, { force: true });
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'codex-daemon.mjs'), home, ...(scenario.flags ?? [])], {
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, PATH: bin + (windows ? ';' : ':') + process.env.PATH, FAKE_CODEX_LOG: log,
        FAKE_DAEMON: scenario.daemon ?? '', CODEX_ROUTER_PIN_DAEMON: '', CODEX_ROUTER_RESTART_DAEMON: '', ...scenario.env },
    });
    assert.equal(result.status, 0, `${scenario.name}: ${result.stderr}`);
    const calls = readFileSync(log, 'utf8').trim().split(/\r?\n/).map(call => call.replace(/^app-server daemon /, ''));
    assert.deepEqual(calls, scenario.calls, scenario.name);
    if (scenario.stdout) assert.match(result.stdout, scenario.stdout, scenario.name);
    if (scenario.stderr) assert.match(result.stderr, scenario.stderr, scenario.name);
  }
});

test('install.mjs suggests pinning a daemon on another Codex when it does not pin the daemon itself', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-install-daemon-version-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, 'codex-home');
  mkdirSync(home);
  const bin = fakeDaemonCodex(directory);
  // Verification never pins, so the daemon's version is reported with the command that pins it.
  const result = spawnSync(process.execPath, [join(root, 'install.mjs'), '--verify', '--no-service'], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, HOME: directory, CODEX_HOME: home, PATH: bin + (windows ? ';' : ':') + process.env.PATH,
      FAKE_CODEX_LOG: join(directory, 'calls.log'), FAKE_DAEMON: 'running', FAKE_MANAGED_VERSION: '0.163.0' },
  });
  assert.match(result.stderr, /^Warning: this router is tested with Codex 0\.167\.0, but the Codex app-server daemon runs 0\.163\.0\. To match it: codex app-server daemon update --from-cli --yes$/m);
  assert.doesNotMatch(result.stderr, /npm install/);
});

test('the daemon check fails while the daemon updates itself or runs another Codex than the CLI', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-daemon-verify-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = fakeDaemonCodex(directory);
  const home = join(directory, 'codex-home');
  const packageRoot = join(home, 'packages', 'app-server-daemon');
  mkdirSync(join(packageRoot, 'current'), { recursive: true });
  const check = (env = {}) => spawnSync(process.execPath, [join(root, 'scripts', 'codex-daemon.mjs'), '--verify', home], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, PATH: bin + (windows ? ';' : ':') + process.env.PATH, FAKE_CODEX_LOG: join(directory, 'calls.log'),
      FAKE_DAEMON: 'running', CODEX_ROUTER_PIN_DAEMON: '', ...env },
  });
  assert.equal(check().status, 0, check().stderr);
  const drifted = check({ FAKE_MANAGED_VERSION: '0.168.0' });
  assert.equal(drifted.status, 1);
  assert.match(drifted.stderr, /runs Codex 0\.168\.0, but the CLI is 0\.167\.0/);
  writeFileSync(join(packageRoot, 'auto-update-version'), '0.167.0-aarch64-apple-darwin');
  const unpinned = check();
  assert.equal(unpinned.status, 1);
  assert.match(unpinned.stderr, /updates itself instead of following the CLI/);
  assert.equal(check({ CODEX_ROUTER_PIN_DAEMON: '0' }).status, 0);
  rmSync(packageRoot, { recursive: true });
  const missing = check({ FAKE_DAEMON: '' });
  assert.equal(missing.status, 0);
  assert.match(missing.stderr, /^No Codex app-server daemon is installed, so there is none to pin\. If Codex installs one later, rerun the installer/m);
});

test('the verifier names what is missing from an incomplete installation', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-verify-missing-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, 'codex-home');
  mkdirSync(home);
  const verify = () => spawnSync(windows ? 'powershell.exe' : 'bash', windows
    ? ['-NoProfile', '-File', platformScript('verify-install'), '-NoService']
    : [platformScript('verify-install'), '--no-service'],
  { encoding: 'utf8', timeout: 30000, env: { ...process.env, HOME: directory, CODEX_HOME: home } });
  const missing = verify();
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Missing required file: .*config\.toml/);
});

test('verification requires every router module as this repository has it, and reinstalling removes modules it no longer has', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-modules-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, 'codex-home');
  const bin = join(directory, 'bin');
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(join(bin, windows ? 'codex.cmd' : 'codex'), windows
    ? '@echo off\r\necho {"models":[]}\r\n'
    : '#!/bin/sh\nprintf \'{"models":[]}\\n\'\n', { mode: 0o700 });
  const environment = { ...process.env, HOME: directory, CODEX_HOME: home,
    PATH: bin + (windows ? ';' : ':') + process.env.PATH, OPENROUTER_API_KEY: 'synthetic-install-key',
    CODEX_ROUTER_TOKEN: '', CODEX_ROUTER_DISABLE_APPS: '1' };
  const invoke = (verify = false) => spawnSync(windows ? 'powershell.exe' : 'bash', windows
    ? ['-NoProfile', '-File', platformScript(verify ? 'verify-install' : 'install'), '-NoService']
    : [platformScript(verify ? 'verify-install' : 'install'), '--no-service'],
  { env: environment, encoding: 'utf8', timeout: 30000 });
  const routerDir = join(home, 'unified-router');
  assert.equal(invoke().status, 0);
  assert.equal(invoke(true).status, 0);
  // The entry cannot start without its modules.
  rmSync(join(routerDir, 'anthropic.mjs'));
  const missing = invoke(true);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Missing router module: .*anthropic\.mjs/);
  assert.equal(invoke().status, 0);
  writeFileSync(join(routerDir, 'upstream.mjs'), `${readFileSync(join(routerDir, 'upstream.mjs'), 'utf8')}\n// edited\n`);
  assert.match(invoke(true).stderr, /installed router differs from this repository/);
  // A module from another version, or a copy of the entry under its repository name,
  // would change the revision; reinstalling removes both.
  writeFileSync(join(routerDir, 'retired.mjs'), 'export {};\n');
  writeFileSync(join(routerDir, 'unified-router.mjs'), 'export {};\n');
  assert.equal(invoke().status, 0);
  assert.ok(!readdirSync(routerDir).includes('retired.mjs'));
  assert.ok(!readdirSync(routerDir).includes('unified-router.mjs'));
  assert.equal(invoke(true).status, 0);
});
