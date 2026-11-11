import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { catalogFiles } from './catalog-files.mjs';
import { applyOpenRouterPrompts, readPrompts, suffixField, usesOpenRouterPrompts } from './openrouter-prompts.mjs';

// Check a generated or installed Codex catalog against this checkout: every
// router entry must be present with the repository's context limits and
// prompts. With --report, print what /model lists instead.
const args = process.argv.slice(2);
const report = args[0] === '--report';
const catalogFile = report ? args[1] : args[0];
if (!catalogFile || args.length !== (report ? 2 : 1)) {
  console.error('Usage: verify-catalog.mjs [--report] <models.json>');
  process.exit(2);
}
function fail(message) {
  console.error(`${message}; rerun the installer.`);
  process.exit(1);
}

let installed;
try {
  installed = JSON.parse(readFileSync(catalogFile, 'utf8')).models;
} catch (error) {
  fail(`Cannot read the model catalog ${catalogFile}: ${error.message}`);
}
if (!Array.isArray(installed)) fail(`The model catalog ${catalogFile} has no models list`);

if (report) {
  const native = installed.filter(model => !usesOpenRouterPrompts(model.slug) && model.visibility !== 'hide').length;
  const router = installed.filter(model => usesOpenRouterPrompts(model.slug));
  console.log(`Router models: ${router.filter(model => model.visibility !== 'hide').map(model => model.slug).join(', ')}`);
  const byName = router.filter(model => model.visibility === 'hide').map(model => model.slug);
  if (byName.length > 0) console.log(`Router models usable by name: ${byName.join(', ')}`);
  console.log(native ? `Native OpenAI models: ${native} in /model (require a ChatGPT plan)` : 'Native OpenAI models: hidden from /model');
  process.exit(0);
}

const root = fileURLToPath(new URL('../', import.meta.url));
const prompts = readPrompts(join(root, 'prompts', 'openrouter-instructions.md'),
  join(root, 'prompts', 'openrouter-persistent.md'));
const bySlug = new Map(installed.map(model => [model.slug, model]));
const limitFields = ['context_window', 'max_context_window', 'effective_context_window_percent', 'auto_compact_token_limit'];

let checked = 0;
const repositorySlugs = new Set();
for (const name of catalogFiles(join(root, 'catalog'))) {
  const value = JSON.parse(readFileSync(join(root, 'catalog', name), 'utf8'));
  for (const entry of Array.isArray(value) ? value : [value]) {
    if (!usesOpenRouterPrompts(entry.slug)) continue;
    repositorySlugs.add(entry.slug);
    const model = bySlug.get(entry.slug);
    if (!model) fail(`The model catalog lacks ${entry.slug}`);
    for (const field of limitFields) {
      if ((model[field] ?? null) !== (entry[field] ?? null)) {
        fail(`${entry.slug} has ${field} ${model[field] ?? null}, but the repository sets ${entry[field] ?? null}`);
      }
    }
    const expected = applyOpenRouterPrompts(entry, prompts);
    if (model.base_instructions !== expected.base_instructions
        || model.model_messages?.instructions_template !== expected.model_messages.instructions_template
        || model.model_messages?.persistent_instructions !== expected.model_messages.persistent_instructions) {
      fail(`The prompts for ${entry.slug} differ from the repository`);
    }
    const { [suffixField]: _suffix, ...expectedModel } = expected;
    if (!isDeepStrictEqual(model, expectedModel)) {
      const fields = [...new Set([...Object.keys(model), ...Object.keys(expectedModel)])]
        .filter(field => !isDeepStrictEqual(model[field], expectedModel[field]));
      fail(`${entry.slug} differs from the repository${fields.length ? ` in ${fields.join(', ')}` : ''}`);
    }
    checked += 1;
  }
}
if (checked === 0) fail('No router catalog entries were checked');
// A router entry the repository does not have is stale or hand-made.
for (const model of installed) {
  if (typeof model?.slug === 'string' && usesOpenRouterPrompts(model.slug) && !repositorySlugs.has(model.slug)) {
    fail(`The model catalog has ${model.slug}, which the repository does not`);
  }
}
