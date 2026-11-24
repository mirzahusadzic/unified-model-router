// Service lifecycle orchestration without live services.
//
// Fake supervisors stand in where real launchd/systemd is unavailable; the
// install, verify, and ephemeral-router steps run in a scratch CODEX_HOME on
// an ephemeral loopback port. Tests that need the Codex CLI skip without it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertScratch,
  checkOwnRouterHealth,
  fakeSupervisorBin,
  freePort,
  installNoService,
  installedFiles,
  liveRouterPort,
  realSmokeInstructions,
  repoRoot,
  startEphemeralRouter,
  stopRouter,
  verifyInstalledRouter,
  verifyNoService,
} from './service-lifecycle.mjs';

const helper = fileURLToPath(new URL('../../platform/unix/service-pids.sh', import.meta.url));
const unixSkip = process.platform === 'win32' ? 'the Unix service helper needs bash' : false;
const codexWorks = spawnSync('codex', ['--version'],
  { encoding: 'utf8', shell: process.platform === 'win32', timeout: 30000 }).status === 0;
const lifecycleSkip = unixSkip || (codexWorks ? false : 'the Codex CLI is not installed');

function scratchHome(t) {
  const root = mkdtempSync(join(tmpdir(), 'router-lifecycle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'codex-home');
}

test('fake supervisors resolve service PIDs without touching real services', { skip: unixSkip }, t => {
  const root = mkdtempSync(join(tmpdir(), 'router-fake-supervisor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = fakeSupervisorBin(root);
  const run = script => spawnSync('bash', ['-c', `source "${helper}"; ${script}`], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
  });
  const launchd = run('LAUNCHCTL_OUTPUT=\'\\tstate = running\\n\\tpid = 4242\\n\' PGREP_CHILDREN=\'4242:4243\' service_pids Darwin label unit');
  assert.equal(launchd.status, 0, launchd.stderr);
  assert.equal(launchd.stdout, '4242,4243');
  const stopped = run('SYSTEMD_PID=0 service_pids Linux label unit');
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(stopped.stdout, '');
});

test('the scratch guard refuses live configuration and the production port', () => {
  assert.throws(() => assertScratch(join(tmpdir(), '..', 'real-home'), 18080), /live Codex home|Refusing/);
  const home = join(tmpdir(), 'router-lifecycle-guard');
  assert.throws(() => assertScratch(home, liveRouterPort), /production router port/);
  assert.doesNotThrow(() => assertScratch(home, 18080));
});

test('no-service install, verify, and ephemeral health form one scratch lifecycle', { skip: lifecycleSkip }, async t => {
  const codexHome = scratchHome(t);
  mkdirSync(codexHome, { recursive: true });

  const installed = installNoService(codexHome);
  assert.equal(installed.status, 0, `install --no-service failed:\n${installed.stderr.slice(-3000)}`);
  for (const file of installedFiles(codexHome)) {
    assert.ok(existsSync(join(codexHome, file)), `missing installed file: ${file}`);
  }
  const verified = verifyNoService(codexHome);
  assert.equal(verified.status, 0, `verify --no-service failed:\n${verified.stderr.slice(-3000)}`);
  const router = verifyInstalledRouter(codexHome);
  assert.equal(router.status, 0, `installed router differs:\n${router.stderr.slice(-2000)}`);

  const port = await freePort();
  assert.notEqual(port, liveRouterPort);
  const child = await startEphemeralRouter(codexHome, port);
  try {
    const health = checkOwnRouterHealth(codexHome, port, child);
    assert.equal(health.status, 0, `ephemeral health check failed:\n${health.stderr.slice(-2000)}`);
  } finally {
    await stopRouter(child);
  }
  assert.ok(child.exitCode !== null, 'the ephemeral router must stop without touching real services');
});

test('real service smoke stays a printed checklist', () => {
  const instructions = realSmokeInstructions();
  assert.ok(instructions.includes('never in CI'), 'release smoke must stay manual');
  assert.ok(instructions.includes('launchctl print'), 'release smoke must name the macOS service check');
  assert.ok(instructions.includes('systemctl --user status'), 'release smoke must name the Linux service check');
});

test('the orchestrator module resolves from this repository', () => {
  assert.ok(repoRoot.length > 0 && existsSync(join(repoRoot, 'install.mjs')));
});
