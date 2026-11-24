// Service lifecycle orchestration for CI and manual release checks.
//
// Everything here runs against a scratch CODEX_HOME and an ephemeral
// loopback port: it never registers a real launchd/systemd service, never
// touches port 18766, and never restarts the Codex daemon. Where a real
// supervisor is unavailable, callers use fakeSupervisorBin() so the same
// lookup path is exercised. Real release smoke stays a printed checklist
// (see realSmokeInstructions()); no command here performs it.
//
// Run directly for a manual end-to-end check:
//   node tests/integration/service-lifecycle.mjs --check
//   node tests/integration/service-lifecycle.mjs --real-smoke
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
export const liveRouterPort = 18766;
const windows = process.platform === 'win32';

// Refuse live configuration and the production port before doing anything.
export function assertScratch(codexHome, port) {
  const scratch = tmpdir();
  if (!codexHome.startsWith(scratch)) throw new Error(`Refusing live Codex home: ${codexHome}`);
  if (Number(port) === liveRouterPort) throw new Error(`Refusing the production router port ${liveRouterPort}`);
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

// Fake launchd/systemd/pgrep/id on PATH, so service lookups run in CI without
// a real supervisor. Outputs come from the environment, as in service-pids tests.
export function fakeSupervisorBin(parent) {
  const bin = join(parent, 'fake-supervisor-bin');
  mkdirSync(bin, { recursive: true });
  const scripts = {
    launchctl: '#!/usr/bin/env bash\nprintf "%b" "$LAUNCHCTL_OUTPUT"\n',
    systemctl: '#!/usr/bin/env bash\ncase "$*" in *"show -p MainPID --value"*) printf "%s\\n" "$SYSTEMD_PID" ;; esac\n',
    pgrep: '#!/usr/bin/env bash\nfor pair in $PGREP_CHILDREN; do [[ "${pair%%:*}" == "$2" ]] && printf "%s\\n" "${pair#*:}"; done\nexit 0\n',
    id: '#!/usr/bin/env bash\nprintf "501\\n"\n',
  };
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  return bin;
}

function installerEnv(codexHome) {
  const parent = join(codexHome, '..');
  return {
    ...process.env,
    HOME: parent,
    USERPROFILE: parent,
    CODEX_HOME: codexHome,
    OPENROUTER_API_KEY: '',
    CODEX_ROUTER_RESTART_DAEMON: '0',
    CODEX_ROUTER_PIN_DAEMON: '0',
  };
}

// Install without a service into a scratch home, using a synthetic key file.
// --no-service also skips the Codex daemon restart and pin step.
export function installNoService(codexHome) {
  assertScratch(codexHome, 1);
  const keyFile = join(codexHome, '..', 'synthetic-openrouter.key');
  writeFileSync(keyFile, 'synthetic-lifecycle-key\n', { mode: 0o600 });
  return spawnSync(process.execPath, [join(repoRoot, 'install.mjs'),
    '--no-service', '--force', '--api-key-file', keyFile],
  { env: installerEnv(codexHome), encoding: 'utf8', timeout: 180000 });
}

export function verifyNoService(codexHome) {
  assertScratch(codexHome, 1);
  return spawnSync(process.execPath, [join(repoRoot, 'install.mjs'), '--verify', '--no-service'],
    { env: installerEnv(codexHome), encoding: 'utf8', timeout: 120000 });
}

export function verifyInstalledRouter(codexHome) {
  assertScratch(codexHome, 1);
  return spawnSync(process.execPath, [join(repoRoot, 'scripts', 'verify-router.mjs'), codexHome],
    { encoding: 'utf8', timeout: 60000 });
}

export function installedFiles(codexHome) {
  return ['config.toml', 'models.json', join('unified-router', 'router.mjs'), join('unified-router', 'openrouter.env')];
}

// Start the installed router copy on an ephemeral loopback port and wait for
// health. Returns the child process; the caller must stopRouter() it.
export async function startEphemeralRouter(codexHome, port) {
  assertScratch(codexHome, port);
  const routerFile = join(codexHome, 'unified-router', 'router.mjs');
  if (!existsSync(routerFile)) throw new Error(`No installed router at ${routerFile}; install with --no-service first`);
  const child = spawn(process.execPath, [routerFile], {
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_ROUTER_ENV_FILE: join(codexHome, 'unified-router', 'openrouter.env'),
      CODEX_MODEL_CATALOG: join(codexHome, 'models.json'),
      CODEX_ROUTER_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const url = `http://127.0.0.1:${port}/health`;
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Ephemeral router exited early: ${output.slice(-2000)}`);
    try {
      const health = await getJson(url);
      if (health?.ok === true) return child;
    } catch {}
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`Ephemeral router never became healthy: ${output.slice(-2000)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (error) { reject(error); }
      });
      response.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(2000, () => request.destroy(new Error('timed out')));
  });
}

// The running router must be this router's own child process, the same check
// the installer applies to real services with their supervisor PIDs.
export function checkOwnRouterHealth(codexHome, port, child) {
  assertScratch(codexHome, port);
  return spawnSync(process.execPath,
    [join(repoRoot, 'scripts', 'verify-health.mjs'), join(repoRoot, 'router', 'unified-router.mjs'),
      `http://127.0.0.1:${port}/health`, `--service-pid=${child.pid}`],
    { encoding: 'utf8', timeout: 30000 });
}

export async function stopRouter(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// Release smoke against real services. Printed, never executed: restarting a
// service interrupts its requests, so this only runs by hand on a release
// machine after the ephemeral lifecycle above passes.
export function realSmokeInstructions() {
  return [
    'Real release smoke (by hand on a release machine, never in CI):',
    '1. Run the ephemeral lifecycle first: node tests/integration/service-lifecycle.mjs --check',
    '2. Install for real: node install.mjs && node install.mjs --verify',
    '3. Confirm the service owns the router: macOS: launchctl print "gui/$(id -u)/com.mirza.codex-unified-router";',
    '   Linux: systemctl --user status codex-unified-router.service; then rerun step 2.',
    '4. Compare Codex versions when the tested version changed: see tests/integration/README.md.',
    '5. Roll back with the codex-<version> tag if health fails: see docs/operations.md.',
  ].join('\n');
}

async function runCheck() {
  const root = mkdtempSync(join(tmpdir(), 'router-lifecycle-'));
  const codexHome = join(root, 'codex-home');
  mkdirSync(codexHome);
  const steps = [];
  try {
    const port = await freePort();
    assertScratch(codexHome, port);
    const installed = installNoService(codexHome);
    steps.push(['install --no-service', installed.status === 0]);
    if (installed.status !== 0) throw new Error(installed.stderr.slice(-3000));
    for (const file of installedFiles(codexHome)) {
      if (!existsSync(join(codexHome, file))) throw new Error(`Missing installed file: ${file}`);
    }
    const verified = verifyNoService(codexHome);
    steps.push(['verify --no-service', verified.status === 0]);
    if (verified.status !== 0) throw new Error(verified.stderr.slice(-3000));
    const router = verifyInstalledRouter(codexHome);
    steps.push(['installed router matches this repository', router.status === 0]);
    if (router.status !== 0) throw new Error(router.stderr.slice(-2000) || router.stdout.slice(-2000));
    const child = await startEphemeralRouter(codexHome, port);
    try {
      const health = checkOwnRouterHealth(codexHome, port, child);
      steps.push(['ephemeral router answers as its own process', health.status === 0]);
      if (health.status !== 0) throw new Error(health.stderr.slice(-2000) || health.stdout.slice(-2000));
    } finally {
      await stopRouter(child);
    }
    steps.push(['ephemeral router stopped', true]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  for (const [name, ok] of steps) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  if (arg === '--real-smoke') console.log(realSmokeInstructions());
  else if (arg === '--check') await runCheck();
  else {
    console.log('Orchestrate the router service lifecycle in a scratch home, never live services.\n\n'
      + 'Usage:\n  node tests/integration/service-lifecycle.mjs --check\n  node tests/integration/service-lifecycle.mjs --real-smoke');
    process.exit(arg === '--help' ? 0 : 2);
  }
}
