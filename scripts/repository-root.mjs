import { fileURLToPath } from 'node:url';

// Tests can point helpers at a temporary repository without executing them
// against the checkout. Production uses the directory above scripts/.
export function repositoryRoot(environment = process.env) {
  return environment.CODEX_ROUTER_REPO_ROOT || fileURLToPath(new URL('../', import.meta.url));
}
