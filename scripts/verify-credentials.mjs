import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { logicalLines } from './toml-lines.mjs';

const [codexHome] = process.argv.slice(2);
if (!codexHome) throw new Error('Usage: verify-credentials.mjs <codex-home>');
const envFile = join(codexHome, 'unified-router', 'openrouter.env');
const configFile = join(codexHome, 'config.toml');
const profileFile = join(codexHome, 'unified-openrouter.config.toml');
const env = readFileSync(envFile, 'utf8');
const token = env.match(/^CODEX_ROUTER_TOKEN=([a-f0-9]{64})\r?$/m)?.[1];
if (!token || !/^OPENROUTER_API_KEY=.+\r?$/m.test(env)) {
  throw new Error('Router credentials are missing; rerun the installer');
}
// Anthropic does not allow subscription sign-in tokens in other tools; the router ignores one.
if (/^ANTHROPIC_API_KEY=["']?sk-ant-oat/m.test(env)) {
  throw new Error('ANTHROPIC_API_KEY holds a Claude sign-in token; use an Anthropic API key');
}
function managedBlock(text, name) {
  const lines = logicalLines(text).map(line => line.trim());
  const begins = lines.flatMap((line, index) => (line === `# BEGIN codex-unified-router ${name}` ? [index] : []));
  const ends = lines.flatMap((line, index) => (line === `# END codex-unified-router ${name}` ? [index] : []));
  if (begins.length !== 1) throw new Error('Missing or duplicate managed configuration block; rerun the installer');
  if (ends.length !== 1 || ends[0] < begins[0]) {
    throw new Error('Unterminated or duplicate managed configuration block; rerun the installer');
  }
  return lines.slice(begins[0] + 1, ends[0]).filter(Boolean);
}
for (const [file, openrouterOnly] of [[configFile, false], [profileFile, true]]) {
  const config = readFileSync(file, 'utf8');
  const keys = managedBlock(config, 'managed keys');
  if (!keys.includes('model_provider = "unified"')
      || !keys.includes(`model_catalog_json = ${JSON.stringify(`${codexHome}/models.json`)}`)) {
    throw new Error('Managed provider or catalog path differs; rerun the installer');
  }
  // Codex can insert its own tables inside the block; check only the provider table.
  const providerBlock = managedBlock(config, 'provider');
  const providerStart = providerBlock.indexOf('[model_providers.unified]');
  const providerEnd = providerBlock.findIndex((line, index) => index > providerStart && line.startsWith('['));
  const provider = providerStart < 0 ? [] : providerBlock.slice(providerStart, providerEnd < 0 ? undefined : providerEnd)
    .filter(line => !line.startsWith('#'));
  const expected = [
    '[model_providers.unified]', 'name = "Unified Model Router"',
    'base_url = "http://127.0.0.1:18766/v1"', 'wire_api = "responses"',
    `requires_openai_auth = ${!openrouterOnly}`, 'supports_websockets = false',
    openrouterOnly
      ? `http_headers = { "X-Codex-Router-Token" = "${token}", "X-Codex-Routing-Policy" = "preserve-model-v1" }`
      : `http_headers = { "X-Codex-Router-Token" = "${token}" }`,
  ];
  if (JSON.stringify(provider) !== JSON.stringify(expected)) {
    throw new Error('Managed transport settings or local tokens differ; rerun the installer');
  }
  if (!openrouterOnly && (process.env.CODEX_ROUTER_DISABLE_APPS ?? '1') === '1'
      && (!managedBlock(config, 'features').includes('apps = false')
        || logicalLines(config).filter(line => line.trim() === '[features]').length !== 1)) {
    throw new Error('Codex apps are not disabled by the managed configuration; rerun the installer');
  }
  if (!openrouterOnly && (process.env.CODEX_ROUTER_DISABLE_GUARDIAN ?? '1') === '1'
      && (!managedBlock(config, 'features').includes('guardian_approval = false')
        || logicalLines(config).filter(line => line.trim() === '[features]').length !== 1)) {
    throw new Error('The Codex guardian is not disabled by the managed configuration; rerun the installer');
  }
  if (!openrouterOnly && (process.env.CODEX_ROUTER_DISABLE_ANALYTICS ?? '1') === '1'
      && (!managedBlock(config, 'analytics').includes('enabled = false')
        || logicalLines(config).filter(line => line.trim() === '[analytics]').length !== 1)) {
    throw new Error('Codex analytics are not disabled by the managed configuration; rerun the installer');
  }
  const agentThreads = process.env.CODEX_ROUTER_AGENT_THREADS ?? '10';
  if (!openrouterOnly && agentThreads !== '0'
      && (!managedBlock(config, 'agents').includes(`max_concurrent_threads_per_session = ${agentThreads}`)
        || logicalLines(config).filter(line => line.trim() === '[agents]').length !== 1)) {
    throw new Error('The managed agent thread limit differs; rerun the installer');
  }
  if (!openrouterOnly && process.env.CODEX_ROUTER_SANDBOX_NETWORK === '1'
      && (!managedBlock(config, 'sandbox_workspace_write').includes('network_access = true')
        || logicalLines(config).filter(line => line.trim() === '[sandbox_workspace_write]').length !== 1)) {
    throw new Error('Sandbox network access is not enabled by the managed configuration; rerun the installer');
  }
}
if (process.platform !== 'win32') {
  for (const file of [envFile, configFile, profileFile, join(codexHome, 'unified-router')]) {
    const stat = statSync(file);
    if ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) {
      throw new Error(`Expected a private, current-user-owned path: ${file}`);
    }
  }
}
