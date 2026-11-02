import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasManagedKeysMarker, logicalLines, managedKeysMarker } from './toml-lines.mjs';

const [existingFile, codexHome, outputFile, routerEnvFile, openrouterProfileFile, force] = process.argv.slice(2);
if (!codexHome || !outputFile || !routerEnvFile || (force !== undefined && force !== '--force')) {
  console.error('Usage: merge-config.mjs <existing-config-or-empty> <codex-home> <output> <router-env> [openrouter-profile-output] [--force]');
  process.exit(2);
}
const routerToken = readFileSync(routerEnvFile, 'utf8').match(/^CODEX_ROUTER_TOKEN=([a-f0-9]{64})\r?$/m)?.[1];
if (!routerToken) throw new Error('Prepare router credentials before merging the Codex configuration');

const managedKeysEnd = '# END codex-unified-router managed keys';
const managedProviderMarker = '# BEGIN codex-unified-router provider';
const managedProviderEnd = '# END codex-unified-router provider';
const tableMarker = (table, edge) => `# ${edge} codex-unified-router ${table.name}`;

// Entries the router manages inside user tables. `lines: null` removes an
// earlier managed block and leaves the setting to the user. `ownedKeys` are
// the keys the router currently sets, and replace the user's values; inside
// its block, a table also drops any key in `blockKeys` it may have set before.
//
// ChatGPT apps add tens of thousands of connector-tool tokens to every
// request, including OpenRouter requests. Set CODEX_ROUTER_DISABLE_APPS=0 to
// leave Codex's own apps setting untouched.
const disableAppsSetting = process.env.CODEX_ROUTER_DISABLE_APPS ?? '1';
if (!['0', '1'].includes(disableAppsSetting)) throw new Error('CODEX_ROUTER_DISABLE_APPS must be 0 or 1');
// Codex's guardian sends the agent transcript to OpenAI's codex-auto-review
// model to assess some actions, even when approvals go to the user. Set
// CODEX_ROUTER_DISABLE_GUARDIAN=0 to leave Codex's guardian setting alone.
const disableGuardianSetting = process.env.CODEX_ROUTER_DISABLE_GUARDIAN ?? '1';
if (!['0', '1'].includes(disableGuardianSetting)) throw new Error('CODEX_ROUTER_DISABLE_GUARDIAN must be 0 or 1');
const featureSettings = [
  disableAppsSetting === '1' && ['apps', 'CODEX_ROUTER_DISABLE_APPS=0'],
  disableGuardianSetting === '1' && ['guardian_approval', 'CODEX_ROUTER_DISABLE_GUARDIAN=0'],
].filter(Boolean);
// Ultra Spark fans work out to parallel workers; raise Codex's spawned-agent
// limit. Set CODEX_ROUTER_AGENT_THREADS=0 to leave the limit to Codex.
// Codex sends usage analytics and metrics to OpenAI by default. Set
// CODEX_ROUTER_DISABLE_ANALYTICS=0 to leave Codex's analytics setting alone.
const disableAnalyticsSetting = process.env.CODEX_ROUTER_DISABLE_ANALYTICS ?? '1';
if (!['0', '1'].includes(disableAnalyticsSetting)) throw new Error('CODEX_ROUTER_DISABLE_ANALYTICS must be 0 or 1');
const agentThreadsSetting = process.env.CODEX_ROUTER_AGENT_THREADS ?? '10';
if (!/^(0|[1-9][0-9]{0,2})$/.test(agentThreadsSetting)) {
  throw new Error('CODEX_ROUTER_AGENT_THREADS must be 0 or a whole number from 1 to 999');
}
// Codex's workspace-write sandbox keeps shell commands off the network unless
// the user approves each one. Set CODEX_ROUTER_SANDBOX_NETWORK=1 to let them
// reach it without asking, for every model; 0, the default, leaves it to Codex.
const sandboxNetworkSetting = process.env.CODEX_ROUTER_SANDBOX_NETWORK ?? '0';
if (!['0', '1'].includes(sandboxNetworkSetting)) throw new Error('CODEX_ROUTER_SANDBOX_NETWORK must be 0 or 1');
const managedTables = [
  {
    name: 'features',
    lines: featureSettings.length > 0 ? featureSettings.map(([key]) => `${key} = false`) : null,
    ownedKeys: featureSettings.map(([key]) => key),
    blockKeys: ['apps', 'guardian_approval'],
    optOut: featureSettings.map(([, optOut]) => optOut).join(' and '),
  },
  {
    name: 'analytics',
    lines: disableAnalyticsSetting === '1' ? ['enabled = false'] : null,
    ownedKeys: ['enabled'],
    optOut: 'CODEX_ROUTER_DISABLE_ANALYTICS=0',
  },
  {
    name: 'agents',
    lines: agentThreadsSetting === '0' ? null : [`max_concurrent_threads_per_session = ${agentThreadsSetting}`],
    // max_threads is Codex's legacy alias for the same limit.
    ownedKeys: ['max_concurrent_threads_per_session', 'max_threads'],
    optOut: 'CODEX_ROUTER_AGENT_THREADS=0',
  },
  {
    name: 'sandbox_workspace_write',
    lines: sandboxNetworkSetting === '1' ? ['network_access = true'] : null,
    ownedKeys: ['network_access'],
    optOut: 'CODEX_ROUTER_SANDBOX_NETWORK=0',
  },
];
function readExisting(path) {
  return path && existsSync(path) ? readFileSync(path, 'utf8') : '';
}

const profilePath = join(codexHome, 'unified-openrouter.config.toml');
const existingProfile = openrouterProfileFile ? readExisting(profilePath) : '';
if (openrouterProfileFile && existsSync(profilePath) && force !== '--force'
    && !hasManagedKeysMarker(existingProfile)) {
  throw new Error('Existing unmanaged unified-openrouter profile; rerun the installer with --force (Windows: -Force) to merge it');
}

// Codex's TOML editor inserts new keys and tables before trailing comments,
// so they can land inside a managed block. Lines a block does not own are
// therefore kept: foreign keys stay in their table, and foreign tables keep
// their content after the block.
// `defaultKeys` are written on the first merge only. Later merges keep the
// values in the managed block, which Codex updates when the user picks a model.
function merge(existing, ownedKeys, keys, provider, tables = [], defaultKeys = []) {
  const preserved = [];
  const kept = new Map();
  const managedBefore = hasManagedKeysMarker(existing);
  let insideManagedKeys = false;
  let insideManagedProvider = false;
  let insideProviderTable = false;
  let insideUnmanagedUnifiedProvider = false;
  // A table that appeared inside a managed block; its lines are kept as they are.
  let foreign = false;
  let currentTable = null;
  let topLevel = true;
  const state = new Map(tables.map(table => [table, { inside: false, header: false, placed: false, emitted: false }]));
  // Keys written below the last router-created table header belong to it.
  let orphanedTable = null;
  const block = (table, ...header) => [tableMarker(table, 'BEGIN'), ...header, ...table.lines, tableMarker(table, 'END')];
  const tableNameOf = trimmed => trimmed.match(/^\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/)?.[1]?.trim();
  const keyOf = line => line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)?.[1];
  const keepForeign = (line, tableName) => {
    if (tableName) {
      foreign = true;
      currentTable = tableName;
      topLevel = false;
    }
    preserved.push(line);
  };
  for (const line of logicalLines(existing)) {
    const trimmed = line.trim();
    const tableName = tableNameOf(trimmed);
    const beginning = tables.find(table => trimmed === tableMarker(table, 'BEGIN'));
    if (beginning) {
      Object.assign(state.get(beginning), { inside: true, header: false, emitted: false });
      orphanedTable = null;
      foreign = false;
      continue;
    }
    const ending = tables.find(table => trimmed === tableMarker(table, 'END'));
    if (ending) {
      state.get(ending).inside = false;
      orphanedTable = state.get(ending).header && !foreign && !state.get(ending).emitted ? ending : null;
      foreign = false;
      continue;
    }
    const within = tables.find(table => state.get(table).inside);
    if (within) {
      const managed = state.get(within);
      if (foreign) {
        keepForeign(line, tableName);
        continue;
      }
      if (trimmed === `[${within.name}]`) {
        managed.header = true;
        currentTable = within.name;
        topLevel = false;
        continue;
      }
      if (tableName) {
        keepForeign(line, tableName);
        continue;
      }
      const key = keyOf(line);
      if (!key || (within.blockKeys ?? within.ownedKeys).includes(key)) continue;
      // A foreign key in a router-created table needs the table header first,
      // in the same layout as keys written below the block.
      if (managed.header && !managed.emitted) {
        preserved.push(`[${within.name}]`, ...(within.lines && !managed.placed ? block(within) : []));
        managed.placed ||= Boolean(within.lines);
        managed.emitted = true;
        currentTable = within.name;
        topLevel = false;
      }
      preserved.push(line);
      continue;
    }
    if (orphanedTable && trimmed !== '' && !trimmed.startsWith('#')) {
      const orphan = orphanedTable;
      const managed = state.get(orphan);
      orphanedTable = null;
      if (!trimmed.startsWith('[')) {
        preserved.push(`[${orphan.name}]`);
        if (orphan.lines && !managed.placed) preserved.push(...block(orphan));
        managed.placed ||= Boolean(orphan.lines);
        currentTable = orphan.name;
        topLevel = false;
      }
    }
    if (trimmed === managedKeysMarker) {
      insideManagedKeys = true;
      foreign = false;
      continue;
    }
    if (trimmed === managedKeysEnd) {
      insideManagedKeys = false;
      foreign = false;
      continue;
    }
    if (trimmed === managedProviderMarker) {
      insideManagedProvider = true;
      insideProviderTable = false;
      foreign = false;
      continue;
    }
    if (trimmed === managedProviderEnd) {
      insideManagedProvider = false;
      foreign = false;
      continue;
    }
    if (insideManagedKeys) {
      if (foreign || tableName) {
        keepForeign(line, tableName);
        continue;
      }
      const key = keyOf(line);
      if (key && managedBefore && defaultKeys.includes(key)) kept.set(key, line.trim());
      else if (key && !ownedKeys.includes(key)) preserved.push(line);
      continue;
    }
    if (insideManagedProvider) {
      if (tableName === 'model_providers.unified' || tableName?.startsWith('model_providers.unified.')) {
        insideProviderTable = true;
        foreign = false;
        continue;
      }
      if (foreign || tableName) {
        insideProviderTable = false;
        keepForeign(line, tableName);
      }
      continue;
    }

    if (tableName) topLevel = false;
    if (tableName === 'model_providers.unified' || tableName?.startsWith('model_providers.unified.')) {
      insideUnmanagedUnifiedProvider = true;
      continue;
    }
    if (insideUnmanagedUnifiedProvider) {
      if (tableName) insideUnmanagedUnifiedProvider = false;
      else continue;
    }
    if (tableName) currentTable = tableName;
    const dotted = tables.find(table => table.lines && topLevel && new RegExp(`^\\s*${table.name}\\s*[.=]`).test(line));
    if (dotted) {
      throw new Error(`Move top-level ${dotted.name} settings into a [${dotted.name}] table, or set ${dotted.optOut}`);
    }
    const opened = tables.find(table => table.lines && tableName === table.name && !state.get(table).placed);
    if (opened) {
      preserved.push(line, ...block(opened));
      state.get(opened).placed = true;
      continue;
    }

    const key = keyOf(line);
    if (topLevel && key && ownedKeys.includes(key)) continue;
    const owner = tables.find(table => table.lines && table.name === currentTable);
    if (owner && key && owner.ownedKeys.includes(key)) continue;
    preserved.push(line);
  }
  if (insideManagedKeys || insideManagedProvider || tables.some(table => state.get(table).inside)) {
    throw new Error('Unterminated managed configuration block; repair it before merging');
  }
  while (preserved.length > 0 && preserved[0].trim() === '') preserved.shift();
  while (preserved.length > 0 && preserved.at(-1).trim() === '') preserved.pop();
  // Place the router's tables after the top-level keys but before the first
  // other table, with its leading comments, so they are never last in the file.
  let split = preserved.findIndex(line => tableNameOf(line.trim()));
  if (split < 0) split = preserved.length;
  while (split > 0 && (preserved[split - 1].trim() === '' || preserved[split - 1].trim().startsWith('#'))) split -= 1;
  const routerTables = [
    [managedProviderMarker, ...provider, managedProviderEnd].join('\n'),
    ...tables.filter(table => table.lines && !state.get(table).placed)
      .map(table => block(table, `[${table.name}]`).join('\n')),
  ];
  return [
    [managedKeysMarker, ...keys.map(line => kept.get(keyOf(line)) ?? line), managedKeysEnd].join('\n'),
    preserved.slice(0, split).join('\n').trim(),
    ...routerTables,
    preserved.slice(split).join('\n').trim(),
  ].filter(Boolean).join('\n\n') + '\n';
}

const keys = [
  'model = "deepseek/deepseek-v4.1-flash-1017"',
  'model_provider = "unified"',
  'model_reasoning_effort = "xhigh"',
  `model_catalog_json = ${JSON.stringify(`${codexHome}/models.json`)}`,
];

const provider = [
  '[model_providers.unified]',
  'name = "Unified Model Router"',
  'base_url = "http://127.0.0.1:18766/v1"',
  'wire_api = "responses"',
  'requires_openai_auth = true',
  'supports_websockets = false',
  `http_headers = { "X-Codex-Router-Token" = "${routerToken}" }`,
];

const main = merge(readExisting(existingFile), ['model', 'model_provider', 'model_reasoning_effort', 'model_catalog_json'], keys, provider, managedTables,
  ['model', 'model_reasoning_effort']);
const profile = openrouterProfileFile ? merge(existingProfile, ['model_provider', 'model_catalog_json'], [
  'model_provider = "unified"',
  `model_catalog_json = ${JSON.stringify(`${codexHome}/models.json`)}`,
], provider.map(line => line === 'requires_openai_auth = true' ? 'requires_openai_auth = false'
  : line.startsWith('http_headers =')
    ? `http_headers = { "X-Codex-Router-Token" = "${routerToken}", "X-Codex-Routing-Policy" = "preserve-model-v1" }`
    : line)) : null;
writeFileSync(outputFile, main, { encoding: 'utf8', mode: 0o600 });
if (profile !== null) writeFileSync(openrouterProfileFile, profile, { encoding: 'utf8', mode: 0o600 });
