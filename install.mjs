#!/usr/bin/env node
// Install or verify the router on any platform: runs the matching script under
// platform/ with the same options, environment, and terminal.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = 'https://github.com/mirzahusadzic/unified-model-router';
const help = `Install or update the Unified Model Router, or verify an installation.

Usage:
  node install.mjs [options]
  node install.mjs --verify [--no-service]

Examples:
  # Install or update; asks for your OpenRouter key the first time
  node install.mjs

  # Replace the stored OpenRouter key
  node install.mjs --change-api-key

  # Install without native OpenAI models in /model
  CODEX_ROUTER_NATIVE_MODELS=hide node install.mjs

  # Check an existing installation
  node install.mjs --verify

Options:
  --change-api-key       Ask for a new OpenRouter key and replace the stored one
  --api-key-file <path>  Read the OpenRouter key from a file, for scripts
  --force                Merge into an unmanaged Codex configuration without
                         asking (it is backed up first), for scripts
  --no-service           Write files only: do not start the router or restart
                         the Codex daemon; with --verify, skip service checks
  --verify               Verify the installation instead of installing
  -h, --help             Show this help

Environment:
  CODEX_HOME                      Codex home directory (default: ~/.codex)
  CODEX_ROUTER_NATIVE_MODELS      Native OpenAI models in /model: auto (default,
                                  hidden without a ChatGPT plan), show, or hide
  CODEX_ROUTER_DISABLE_APPS       1 (default) turns off ChatGPT apps;
                                  0 leaves Codex's setting alone
  CODEX_ROUTER_DISABLE_GUARDIAN   1 (default) turns off Codex's guardian, which
                                  sends transcripts to OpenAI for review;
                                  0 leaves Codex's setting alone
  CODEX_ROUTER_DISABLE_ANALYTICS  1 (default) turns off Codex analytics;
                                  0 leaves Codex's setting alone
  CODEX_ROUTER_AGENT_THREADS      Spawned-agent limit: 10 (default), 1-999,
                                  or 0 to leave it to Codex
  CODEX_ROUTER_SANDBOX_NETWORK    1 lets sandboxed shell commands reach the
                                  network without asking; 0 (default) leaves
                                  Codex's setting alone
  CODEX_ROUTER_RESTART_DAEMON     1 (default) restarts a running Codex daemon
                                  so it loads the new settings; 0 skips it
  CODEX_ROUTER_PIN_DAEMON         1 (default) pins the Codex daemon to the
                                  CLI's Codex so it stops updating itself;
                                  0 leaves its updates to Codex
  OPENROUTER_API_KEY              OpenRouter key for automation; prefer
                                  --api-key-file, which stays out of the
                                  environment

Docs:   ${repository}/blob/main/docs/setup.md
Issues: ${repository}/issues`;

const knownOptions = ['--verify', '--force', '--no-service', '--change-api-key', '--api-key-file', '--help'];
function editDistance(left, right) {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[right.length];
}
function closestOption(arg) {
  const [best] = knownOptions
    .map(option => ({ option, distance: editDistance(arg, option) }))
    .sort((left, right) => left.distance - right.distance);
  return best.distance <= 3 ? best.option : null;
}
// Say what went wrong and how to fix it, instead of only printing usage.
function fail(message) {
  console.error(`${message}\nRun 'node install.mjs --help' for usage.`);
  process.exit(2);
}

const options = { verify: false, force: false, noService: false, apiKeyFile: null, changeApiKey: false };
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg.startsWith('--api-key-file=')) {
    options.apiKeyFile = arg.slice('--api-key-file='.length);
    if (!options.apiKeyFile) fail('--api-key-file needs a path, for example: --api-key-file ~/openrouter.key');
    continue;
  }
  switch (arg) {
    case '--verify': options.verify = true; break;
    case '--force': options.force = true; break;
    case '--no-service': options.noService = true; break;
    case '--change-api-key': options.changeApiKey = true; break;
    case '--api-key-file':
      options.apiKeyFile = args[index + 1] ?? null;
      if (!options.apiKeyFile || options.apiKeyFile.startsWith('-')) fail('--api-key-file needs a path, for example: --api-key-file ~/openrouter.key');
      index += 1;
      break;
    case '--help':
    case '-h':
      console.log(help);
      process.exit(0);
      break;
    default: {
      if (!arg.startsWith('-')) fail(`Unexpected argument: ${arg}\nThe installer takes options only.`);
      const guess = closestOption(arg);
      fail(`Unknown option: ${arg}${guess ? `\nDid you mean ${guess}?` : ''}`);
    }
  }
}
if (options.verify && (options.force || options.apiKeyFile || options.changeApiKey)) {
  fail('--verify checks an installation and accepts only --no-service.');
}
if (options.apiKeyFile && options.changeApiKey) {
  fail('Use either --api-key-file or --change-api-key, not both.');
}

const windows = process.platform === 'win32';

// Codex can change request headers and catalog templates between versions.
// Warn, without stopping, when the CLI or the shared app-server daemon, which
// keeps and may update its own copy of Codex, differs from the tested version.
// An installation with a service pins the daemon to the CLI's Codex unless
// asked not to, so only the CLI's version matters then.
const testedCodexVersion = '0.167.0';
function codex(commandArgs) {
  const run = spawnSync('codex', commandArgs, { encoding: 'utf8', shell: windows, timeout: 15000 });
  return run.status === 0 ? run.stdout : '';
}
const cliVersion = codex(['--version']).match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
let daemon = null;
try {
  daemon = JSON.parse(codex(['app-server', 'daemon', 'version']));
} catch {}
const pinsDaemon = !options.verify && !options.noService && (process.env.CODEX_ROUTER_PIN_DAEMON || '1') === '1';
const cliNote = cliVersion && cliVersion !== testedCodexVersion && `the Codex CLI is ${cliVersion}`;
const daemonNote = !pinsDaemon && daemon?.status === 'running' && typeof daemon.appServerVersion === 'string'
  && daemon.appServerVersion !== testedCodexVersion && `the Codex app-server daemon runs ${daemon.appServerVersion}`;
if (cliNote || daemonNote) {
  const fixes = [cliNote && `npm install -g @openai/codex@${testedCodexVersion}`,
    daemonNote && 'codex app-server daemon update --from-cli --yes'].filter(Boolean);
  console.error(`Warning: this router is tested with Codex ${testedCodexVersion}, but ${[cliNote, daemonNote].filter(Boolean).join(' and ')}.`
    + ` To match it: ${fixes.join(', then ')}`);
}

const script = join(fileURLToPath(new URL('.', import.meta.url)), 'platform', windows ? 'windows' : 'unix',
  `${options.verify ? 'verify-install' : 'install'}.${windows ? 'ps1' : 'sh'}`);
const flags = windows
  ? [options.force && '-Force', options.noService && '-NoService', options.changeApiKey && '-ChangeApiKey',
    ...(options.apiKeyFile ? ['-ApiKeyFile', options.apiKeyFile] : [])]
  : [options.force && '--force', options.noService && '--no-service', options.changeApiKey && '--change-api-key',
    ...(options.apiKeyFile ? ['--api-key-file', options.apiKeyFile] : [])];
// Bypass applies to this one PowerShell process, so a restrictive default
// execution policy does not block the installer the user just asked to run.
const [command, commandArgs] = windows
  ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...flags.filter(Boolean)]]
  : ['bash', [script, ...flags.filter(Boolean)]];

const result = spawnSync(command, commandArgs, { stdio: 'inherit' });
if (result.error) {
  console.error(`Could not run ${script}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
