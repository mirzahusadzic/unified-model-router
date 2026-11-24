import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const unixInstall = readFileSync(join(root, 'platform/unix/install.sh'), 'utf8');
const winInstall = readFileSync(join(root, 'platform/windows/install.ps1'), 'utf8').replaceAll('\r\n', '\n');
const unixVerify = readFileSync(join(root, 'platform/unix/verify-install.sh'), 'utf8');
const winVerify = readFileSync(join(root, 'platform/windows/verify-install.ps1'), 'utf8').replaceAll('\r\n', '\n');
const entry = readFileSync(join(root, 'install.mjs'), 'utf8');

function expectBoth(unixText, winText, markers, label) {
  for (const marker of markers) {
    assert.ok(unixText.includes(marker), `unix missing ${label}: ${marker}`);
    assert.ok(winText.includes(marker), `windows missing ${label}: ${marker}`);
  }
}

test('installers validate the same environment settings and key sources', () => {
  // Every installer setting install.mjs --help documents must be validated by both scripts.
  const settings = ['CODEX_ROUTER_RESTART_DAEMON', 'CODEX_ROUTER_PIN_DAEMON', 'CODEX_ROUTER_NATIVE_MODELS',
    'CODEX_ROUTER_DISABLE_APPS', 'CODEX_ROUTER_DISABLE_GUARDIAN', 'CODEX_ROUTER_DISABLE_ANALYTICS',
    'CODEX_ROUTER_AGENT_THREADS', 'CODEX_ROUTER_SANDBOX_NETWORK'];
  for (const name of settings) {
    assert.ok(unixInstall.includes(name), `unix install.sh misses ${name}`);
    assert.ok(winInstall.includes(name), `windows install.ps1 misses ${name}`);
    assert.ok(entry.includes(name), `install.mjs help misses ${name}`);
  }
  expectBoth(unixInstall, winInstall, ['OPENROUTER_API_KEY', 'CODEX_HOME'], 'key/home sources');
  expectBoth(unixInstall, winInstall, ['CODEX_ROUTER_NATIVE_MODELS must be auto, show, or hide'], 'native-models error');
  expectBoth(unixInstall, winInstall,
    ['CODEX_ROUTER_AGENT_THREADS must be 0 or a whole number from 1 to 999'], 'agent-threads error');
  expectBoth(unixInstall, winInstall, ['must be 0 or 1'], 'boolean-setting error');
  expectBoth(unixInstall, winInstall, ['Required command not found:'], 'codex/node prerequisite');
});

test('installers share flags, collision guard, and key-prompt behavior', () => {
  for (const [unix, win] of [['--force', '$Force'], ['--no-service', '$NoService'],
    ['--api-key-file', '$ApiKeyFile'], ['--change-api-key', '$ChangeApiKey']]) {
    assert.ok(unixInstall.includes(unix), `unix misses flag ${unix}`);
    assert.ok(winInstall.includes(win), `windows misses parameter ${win}`);
  }
  expectBoth(unixInstall, winInstall, ['install.mjs --help'], 'help delegation');
  assert.ok(unixInstall.includes('Use either --api-key-file or --change-api-key, not both'),
    'unix states the exclusive key options');
  assert.ok(winInstall.includes('Use either -ApiKeyFile or -ChangeApiKey, not both'),
    'windows states the exclusive key options');
  expectBoth(unixInstall, winInstall, ['API key file not found:'], 'missing key-file error');
  expectBoth(unixInstall, winInstall, ['No terminal to ask for the OpenRouter API key'],
    'no-terminal key error');
  expectBoth(unixInstall, winInstall, ['config-managed.mjs'], 'managed-config probe');
  expectBoth(unixInstall, winInstall,
    ['unified-openrouter.config.toml', 'backs these files up', 'The files are backed up first'],
    'unmanaged-config consent before backup');
  expectBoth(unixInstall, winInstall,
    ['Using the OpenRouter API key you entered', 'Using the OpenRouter API key from OPENROUTER_API_KEY',
      'Using the stored OpenRouter API key', 'Reading the OpenRouter API key from'],
    'key-source progress steps');
});

test('installers back up and retire the same managed file set', () => {
  const backedUp = ['config.toml', 'deepseek.config.toml', 'unified-openrouter.config.toml', 'models.json'];
  for (const name of backedUp) {
    assert.ok(unixInstall.includes(name), `unix misses backup of ${name}`);
    assert.ok(winInstall.includes(name), `windows misses backup of ${name}`);
  }
  assert.ok(unixInstall.includes('backups/codex-unified-router-'), 'unix backup directory pattern');
  assert.ok(winInstall.includes('backups\\codex-unified-router-'), 'windows backup directory pattern');
  expectBoth(unixInstall, winInstall, ['Backing up the current configuration to'],
    'backup progress step');
  expectBoth(unixInstall, winInstall, ['deepseek.config.toml.retired'], 'legacy profile retirement');
  expectBoth(unixInstall, winInstall, ['codex-unified-router', 'models.json'], 'backup naming');
});

test('installers invoke the same catalog, config, and credential helpers', () => {
  expectBoth(unixInstall, winInstall,
    ['chatgpt-plan.mjs', 'build-catalog.mjs', 'prepare-credentials.mjs', 'merge-config.mjs', 'verify-catalog.mjs'],
    'generation helpers');
  expectBoth(unixInstall, winInstall, ['codex debug models --bundled'], 'bundled catalog source');
  expectBoth(unixInstall, winInstall, ['--native-models', 'no active ChatGPT plan'],
    'native-model auto detection');
  expectBoth(unixInstall, winInstall, ['Hiding native OpenAI models from /model'],
    'hidden-native progress step');
  expectBoth(unixInstall, winInstall, ['--api-key-stdin', '--api-key-file'],
    'credential staging modes');
  // Credentials are staged before the merge so a failed merge keeps stored ones.
  assert.match(unixInstall, /prepare-credentials[\s\S]*merge-config/);
  assert.match(winInstall, /prepare-credentials[\s\S]*merge-config/);
  expectBoth(unixInstall, winInstall, ['verify-catalog.mjs'], 'generated-catalog check');
  expectBoth(unixInstall, winInstall, ['Installing the loopback router at 127.0.0.1:18766'],
    'loopback install step');
  expectBoth(unixInstall, winInstall,
    ['CODEX_ROUTER_ENV_FILE', 'CODEX_MODEL_CATALOG', 'CODEX_ROUTER_PORT', '18766'],
    'router runtime environment');
});

test('installers sync the same router file set and service modules', () => {
  expectBoth(unixInstall, winInstall, ['openrouter.env', 'unified-router.mjs', 'router.mjs'],
    'router entry and environment file');
  expectBoth(unixInstall, winInstall,
    ['A module this version no longer has is removed', 'revision covers every one'],
    'stale-module removal rule');
});

test('installers share service, no-service, and daemon handling', () => {
  assert.ok(unixInstall.includes('--no-service'), 'unix misses --no-service branch');
  assert.ok(winInstall.includes('$NoService'), 'windows misses -NoService branch');
  expectBoth(unixInstall, winInstall, ['verify-health.mjs', 'http://127.0.0.1:18766/health',
    'did not become healthy'], 'service health check');
  assert.ok(unixInstall.includes('wait_for_service_router'), 'unix health waits for the service router');
  assert.ok(winInstall.includes('--service-pid=$ServicePids'), 'windows passes the supervisor pids to health');
  expectBoth(unixInstall, winInstall, ['codex-daemon.mjs', '--codex-runs-installer'],
    'daemon restart and pin step');
  expectBoth(unixInstall, winInstall, ['explains when it skips either'],
    'daemon skip documentation');
  expectBoth(unixInstall, winInstall, ['app-server', 'codex'],
    'daemon ancestry detection');
  assert.ok(unixInstall.includes('node install.mjs --verify --no-service'),
    'unix points at --no-service verification when no supervisor exists');
  // install.mjs only pins/restarts with a service; the platform scripts gate the daemon on it too.
  assert.ok(entry.includes('pinsDaemon'), 'entry must gate daemon pinning on service installs');
  assert.ok(winInstall.includes('if (-not $NoService)'), 'windows must gate service and daemon on NoService');
});

test('verifiers require the same files, config markers, and checks', () => {
  for (const required of ['config.toml', 'unified-openrouter.config.toml', 'models.json', 'router.mjs']) {
    assert.ok(unixVerify.includes(required), `unix verifier misses ${required}`);
    assert.ok(winVerify.includes(required), `windows verifier misses ${required}`);
  }
  assert.ok(unixVerify.includes('--no-service'), 'unix verifier accepts --no-service');
  assert.ok(winVerify.includes('[switch]$NoService'), 'windows verifier accepts -NoService');
  expectBoth(unixVerify, winVerify, ['Missing required file:'], 'missing-file report');
  expectBoth(unixVerify, winVerify,
    ['verify-credentials.mjs', 'verify-router.mjs', 'verify-catalog.mjs'],
    'verifier helper checks');
  expectBoth(unixVerify, winVerify,
    ['# BEGIN codex-unified-router managed keys', 'model_provider = "unified"', '[model_providers.unified]',
      'requires_openai_auth = true', 'supports_websockets = false'],
    'managed config markers');
  expectBoth(unixVerify, winVerify,
    ['verify-health.mjs', 'http://127.0.0.1:18766/health', '--service-pid',
      'codex-daemon.mjs', '--verify', 'verify-catalog.mjs', '--report',
      'Install looks valid.', 'Default main model:'],
    'service health, daemon pin, and closing report');
});

test('installers print the same default-model and isolation text', () => {
  const slugs = ['ultra-spark-private/deepseek-v4.1-flash-1017', 'ultra-spark/deepseek-v4.1-flash-1017',
    'openrouter/meta/muse-spark-1.3', 'openrouter/meta/muse-spark-1.3-contributor',
    'openrouter/openai/gpt-6.2-sol', 'anthropic/claude-fable-5-2',
    'anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5-5', 'gpt-6.2-astra'];
  expectBoth(unixInstall, winInstall, slugs, 'closing model list');
  expectBoth(unixInstall, winInstall,
    ['Meta trains on everything sent to Muse Spark 1.3 Contributor',
      "Ultra Spark Contributor's workers, so use them for share-safe code only."],
    'training notice');
  expectBoth(unixInstall, winInstall,
    ['Tracked Codex sessions never mix OpenAI, Claude, or non-training',
      'Ultra Spark models with Muse Spark 1.3 Contributor'],
    'isolation notice');
  expectBoth(unixInstall, winInstall,
    ['Native OpenAI models are hidden from /model', 'requires a ChatGPT plan',
      'Restart Codex windows opened before this install'],
    'native-model and restart text');
});

test('entry point translates flags to both platform installers and verifiers', () => {
  for (const [unix, win] of [['--force', '-Force'], ['--no-service', '-NoService'],
    ['--change-api-key', '-ChangeApiKey'], ['--api-key-file', '-ApiKeyFile']]) {
    assert.ok(entry.includes(`'${unix}'`), `entry misses unix flag ${unix}`);
    assert.ok(entry.includes(`'${win}'`), `entry misses windows flag ${win}`);
  }
  assert.ok(entry.includes('platform') && entry.includes('verify-install'),
    'entry must route --verify to the platform verifier');
  assert.ok(entry.includes("'ps1'") && entry.includes("'sh'"),
    'entry must select the installer per platform');
  assert.ok(entry.includes("'verify-install'") && entry.includes("'install'"),
    'entry must route verify and install separately');
});

test('documented platform-only differences stay explicit', () => {
  // Unix-only: POSIX service managers, file modes, shell prompts, and the
  // no-supervisor manual-start hint (Windows always writes start-router.cmd).
  for (const marker of ['launchctl', 'systemctl', 'LaunchAgents', 'systemd', 'chmod 700', 'install -m 600',
    'mktemp -d', "read -r -s -p 'OpenRouter API key: '", 'MINGW',
    'Verify this installation with: node install.mjs --verify --no-service']) {
    assert.ok(unixInstall.includes(marker) || unixVerify.includes(marker), `unix-only marker lost: ${marker}`);
    assert.ok(!winInstall.includes(marker) && !winVerify.includes(marker),
      `windows must not carry unix marker: ${marker}`);
  }
  // Windows-only: ACL hardening, Startup launcher, and console-safe prompts.
  for (const marker of ['Set-PrivatePath', 'Assert-PrivatePath', 'start-router.cmd',
    'Codex Unified Router.vbs', 'wscript.exe', 'AsSecureString', 'Get-CimInstance']) {
    assert.ok(winInstall.includes(marker) || winVerify.includes(marker),
      `windows-only marker lost: ${marker}`);
    assert.ok(!unixInstall.includes(marker) && !unixVerify.includes(marker),
      `unix must not carry windows marker: ${marker}`);
  }
});
