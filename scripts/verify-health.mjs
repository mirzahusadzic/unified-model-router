import { readFileSync } from 'node:fs';
import http from 'node:http';
import { routerRevision } from '../router/common.mjs';

// --service-pid lists the service's own processes, comma-separated: launchd's
// or systemd's process and those it started, or the Windows supervisor's
// children; a version manager's shim runs the real node as such a child. Empty
// or 0 means the service runs none. Any other argument shape is refused, so a
// typo cannot skip the check.
const args = process.argv.slice(2);
const options = args.filter(arg => arg.startsWith('-'));
const [source, endpoint, ...extra] = args.filter(arg => !arg.startsWith('-'));
if (!source || extra.length > 0 || options.length > 1
    || options.some(arg => !/^--service-pid=(?:0|[1-9][0-9]*(?:,[1-9][0-9]*)*)?$/.test(arg))) {
  throw new Error('Usage: verify-health.mjs <installed-router-source> [local-health-url] [--service-pid=<pid>[,<pid>...]]');
}
const servicePidOption = options[0];
const revision = routerRevision(source);

async function fetchHealth(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password
      || url.search || url.hash || !['/health', '/v1/health'].includes(url.pathname)) {
    throw new Error('Expected a local 127.0.0.1 health endpoint');
  }
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      const request = http.get(url, response => {
        if (response.statusCode !== 200) {
          response.destroy();
          reject(new Error('Health endpoint must return HTTP 200; redirects are not accepted'));
          return;
        }
        const chunks = [];
        let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 16384) response.destroy(new Error('Health response exceeds 16 KiB'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      request.on('error', reject);
      timer = setTimeout(() => request.destroy(new Error('Health request timed out')), 2000);
    });
  } finally {
    clearTimeout(timer);
  }
}

const health = JSON.parse(endpoint ? await fetchHealth(endpoint) : readFileSync(0, 'utf8'));
const capabilities = health?.capabilities;
const includesAll = (value, required) => Array.isArray(value) && required.every(item => value.includes(item));
if (!health || !['ok', 'openai', 'openrouter', 'clientAuth'].every(key => health[key] === true)
    || !Array.isArray(capabilities?.routingPolicies)
    || !capabilities.routingPolicies.includes('preserve-model-v1')
    || capabilities.openrouterRejectionRecovery !== 'completed-diagnostic-v1'
    || capabilities.providerIsolation !== 'session-v3'
    || capabilities.revisionPrecondition !== true
    || !includesAll(capabilities.promptCacheModes, ['instructions', 'none'])
    || !includesAll(capabilities.dataPolicies, ['deny'])
    || !includesAll(capabilities.reports, ['provider'])
    || capabilities.generationLookup !== true
    || capabilities.endpointPins !== true
    || !includesAll(capabilities.fallbackPolicies, ['none'])
    || capabilities.thinkingBudgets !== true
    || capabilities.thinkingOff?.effort !== 'none'
    || !includesAll(capabilities.thinkingOff?.models, ['anthropic/claude-sonnet-5-5'])
    || !includesAll(capabilities.trainingDeclarations, ['declared-training', 'endpoint', 'provider-terms', 'unknown'])
    || capabilities.modelTraining !== 'training-v1' || health.revision !== revision) {
  throw new Error('Router health, required capabilities or installed source revision do not match; update and restart the router');
}
if (servicePidOption !== undefined) {
  const servicePids = servicePidOption.slice('--service-pid='.length).split(',').map(Number)
    .filter(pid => Number.isSafeInteger(pid) && pid > 0);
  if (servicePids.length === 0) {
    throw new Error(`The router service has no running process, yet router process ${health.pid ?? 'unknown'} answers; stop that process and restart the service`);
  }
  if (!servicePids.includes(health.pid)) {
    throw new Error(`Router process ${health.pid ?? 'unknown'} answers instead of the service's process ${servicePids.join(', ')}; stop it and restart the service`);
  }
}
