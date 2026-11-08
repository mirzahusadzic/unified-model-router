import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyOpenRouterPrompts, readPrompts, suffixField, usesOpenRouterPrompts } from '../scripts/openrouter-prompts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const readEntry = name => JSON.parse(readFileSync(join(root, 'catalog', name), 'utf8'));
const prompts = readPrompts(join(root, 'prompts', 'openrouter-instructions.md'),
  join(root, 'prompts', 'openrouter-persistent.md'));
const normalize = value => value.replace(/\r\n/g, '\n');
const muse = readEntry('muse-model.json');
const museStandard = readEntry('muse-standard-model.json');
const deepseek = readEntry('deepseek-model.json');
const ultraSpark = readEntry('deepseek-ultra-spark-model.json');
const ultraSparkPrivate = readEntry('deepseek-ultra-spark-private-model.json');

test('checked-in OpenRouter entries carry the rendered maintained prompts', () => {
  let checked = 0;
  for (const name of readdirSync(join(root, 'catalog')).filter(value => value.endsWith('.json'))) {
    const value = readEntry(name);
    for (const entry of Array.isArray(value) ? value : [value]) {
      assert.equal(typeof entry.slug, 'string', `${name}: missing model slug`);
      if (!usesOpenRouterPrompts(entry.slug)) continue;
      const expected = applyOpenRouterPrompts(entry, prompts);
      const stale = `${name}: run node scripts/render-openrouter-entries.mjs`;
      assert.equal(normalize(entry.base_instructions), normalize(expected.base_instructions), stale);
      assert.equal(normalize(entry.model_messages.instructions_template),
        normalize(expected.model_messages.instructions_template), stale);
      assert.equal(normalize(entry.model_messages.persistent_instructions),
        normalize(expected.model_messages.persistent_instructions), stale);
      checked += 1;
    }
  }
  assert.equal(checked, 10);
});

test('OpenRouter prompts never mention Codex tools that OpenRouter threads lack', () => {
  // The verifier pins installed prompts to these entries, so checking them here covers installations too.
  for (const name of readdirSync(join(root, 'catalog')).filter(value => value.endsWith('.json'))) {
    const value = readEntry(name);
    for (const entry of (Array.isArray(value) ? value : [value]).filter(item => usesOpenRouterPrompts(item.slug))) {
      for (const text of [entry.base_instructions, entry.model_messages?.instructions_template,
        entry.model_messages?.persistent_instructions]) {
        assert.doesNotMatch(text ?? '', /update_plan|send_user_message_async|clock\.sleep|update_up_next/, `${name}: ${entry.slug}`);
      }
    }
  }
});

test('Muse Spark 1.3 Contributor catalog entry matches the OpenRouter model capabilities', () => {
  assert.equal(muse.slug, 'openrouter/meta/muse-spark-1.3-contributor');
  assert.equal(muse.context_window, 1048576);
  assert.equal(muse.max_context_window, 1048576);
  assert.equal(muse.effective_context_window_percent, 95);
  // Reasoning is mandatory upstream, so `none` must not be offered.
  assert.deepEqual(muse.supported_reasoning_levels.map(level => level.effort), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(muse.default_reasoning_level, 'medium');
  assert.equal(muse.supports_parallel_tool_calls, false);
  assert.match(muse.description, /Meta may train on prompts and completions/);
  assert.match(deepseek.description, /DeepSeek's own endpoint may train on prompts and completions/);
});

test('Muse Spark 1.3 is the Contributor entry on the endpoint that does not train', () => {
  assert.equal(museStandard.slug, 'openrouter/meta/muse-spark-1.3');
  assert.equal(museStandard.display_name, 'Muse Spark 1.3');
  assert.match(museStandard.description, /does not train on prompts or completions/);
  // Everything but the model's identity matches the Contributor entry.
  const identity = ({ slug, display_name, description, ...rest }) => rest;
  assert.deepEqual(identity(museStandard), identity(muse));
});

test('Claude catalog entries match the model capabilities on each route', () => {
  for (const [name, slug, displayName, visibility, parallel] of [
    ['claude-sonnet-model.json', 'anthropic/claude-sonnet-5-5', 'Claude Sonnet 5.5', 'list', true],
    ['claude-opus-model.json', 'anthropic/claude-opus-5-5', 'Claude Opus 5.5', 'list', true],
    // OpenRouter-only entries stay usable by name, for threads that started on them.
    ['claude-sonnet-openrouter-model.json', 'openrouter/anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5', 'hide', false],
    ['claude-opus-openrouter-model.json', 'openrouter/anthropic/claude-opus-5.5', 'Claude Opus 5.5', 'hide', false],
  ]) {
    const entry = readEntry(name);
    assert.equal(entry.slug, slug);
    assert.equal(entry.display_name, displayName);
    assert.equal(entry.visibility, visibility);
    assert.equal(entry.context_window, 1000000);
    assert.equal(entry.max_context_window, 1000000);
    assert.equal(entry.effective_context_window_percent, 95);
    // Thinking cannot be turned off on these models, so `none` must not be offered.
    assert.deepEqual(entry.supported_reasoning_levels.map(level => level.effort), ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.equal(entry.default_reasoning_level, 'medium');
    // Anthropic's API runs parallel tool calls; OpenRouter lists no parallel_tool_calls parameter for Claude.
    assert.equal(entry.supports_parallel_tool_calls, parallel);
    assert.deepEqual(entry.input_modalities, ['text', 'image']);
  }
});

test('GPT-6.1 Sol on OpenRouter keeps its own name beside the native model', () => {
  const sol = readEntry('gpt-sol-openrouter-model.json');
  assert.equal(sol.slug, 'openrouter/openai/gpt-6.1-sol');
  assert.equal(sol.display_name, 'GPT-6.1 Sol (OpenRouter)');
  assert.equal(sol.visibility, 'list');
  assert.equal(sol.context_window, 272000);
  assert.equal(sol.max_context_window, 1050000);
  // OpenRouter rejects `ultra`, which the native model offers.
  assert.deepEqual(sol.supported_reasoning_levels.map(level => level.effort), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(sol.default_reasoning_level, 'low');
  assert.equal(sol.supports_search_tool, false);
});

test('Ultra Spark is DeepSeek with a delegation policy that keeps thread history away from workers', () => {
  const identity = ['slug', 'display_name', 'description', 'priority', 'default_reasoning_level', suffixField,
    'base_instructions', 'model_messages'];
  const capabilities = entry => Object.fromEntries(Object.entries(entry).filter(([key]) => !identity.includes(key)));
  assert.equal(ultraSpark.slug, 'ultra-spark/deepseek-v4.1-flash-1017');
  assert.equal(ultraSpark.display_name, 'DeepSeek V4.1 Flash 1017 · Ultra Spark Contributor');
  assert.deepEqual(capabilities(ultraSpark), capabilities(deepseek));
  assert.equal(ultraSpark[suffixField], 'ultra-spark.md');
  assert.equal(ultraSpark.default_reasoning_level, 'max');
  const policy = readFileSync(join(root, 'prompts', 'ultra-spark.md'), 'utf8');
  assert.match(policy, new RegExp(`model: "${muse.slug.replaceAll('.', '\\.')}"`));
  assert.match(policy, /fork_context: false/);
  assert.match(policy, /Never fork this thread's history into a worker/);
});

test('non-training Ultra Spark is the same entry and policy with Muse Spark 1.3 workers', () => {
  const identity = ['slug', 'display_name', 'description', suffixField, 'base_instructions', 'model_messages'];
  const settings = entry => Object.fromEntries(Object.entries(entry).filter(([key]) => !identity.includes(key)));
  assert.equal(ultraSparkPrivate.slug, 'ultra-spark-private/deepseek-v4.1-flash-1017');
  assert.equal(ultraSparkPrivate.display_name, 'DeepSeek V4.1 Flash 1017 · Ultra Spark');
  assert.match(ultraSparkPrivate.description, /do not train on inputs/);
  assert.deepEqual(settings(ultraSparkPrivate), settings(ultraSpark));
  assert.equal(ultraSparkPrivate[suffixField], 'ultra-spark-private.md');
  // The two policies differ only in the worker model and what workers may be given.
  const read = name => readFileSync(join(root, 'prompts', name), 'utf8').split('\n');
  const contributor = read('ultra-spark.md');
  const nonTraining = read('ultra-spark-private.md');
  assert.equal(nonTraining.length, contributor.length);
  const changed = contributor.flatMap((line, index) => (line === nonTraining[index] ? [] : [index]));
  for (const index of changed) {
    const swapped = contributor[index].replaceAll(muse.slug, museStandard.slug);
    if (swapped !== nonTraining[index]) assert.match(contributor[index], /^- Never give workers secrets/);
  }
  assert.ok(!nonTraining.join('\n').includes(muse.slug));
  assert.match(nonTraining.join('\n'), new RegExp(`model: "${museStandard.slug.replaceAll('.', '\\.')}"`));
});

test('catalog builds append an entry suffix and omit the router-only field from Codex', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-catalog-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'bundled.json'), '{"models":[]}\n');
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'build-catalog.mjs'),
    '--bundled', join(directory, 'bundled.json'), '--catalog-dir', join(root, 'catalog'),
    '--instructions', join(root, 'prompts', 'openrouter-instructions.md'),
    '--persistent', join(root, 'prompts', 'openrouter-persistent.md'),
    '--output', join(directory, 'models.json')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const models = new Map(JSON.parse(readFileSync(join(directory, 'models.json'), 'utf8')).models
    .map(model => [model.slug, model]));
  const policy = readFileSync(join(root, 'prompts', 'ultra-spark.md'), 'utf8');
  assert.equal(models.get(ultraSpark.slug).base_instructions, `${prompts.instructions}\n${policy}`);
  assert.equal(models.get(deepseek.slug).base_instructions, prompts.instructions);
  for (const model of models.values()) assert.equal(Object.hasOwn(model, suffixField), false);
});

test('catalog builds reject missing prompts, duplicate slugs, and replacements of bundled models', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-catalog-checks-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const instructions = join(root, 'prompts', 'openrouter-instructions.md');
  const persistent = join(root, 'prompts', 'openrouter-persistent.md');
  const build = (bundledModels, catalogEntries, promptArgs) => {
    const catalogDir = mkdtempSync(join(directory, 'catalog-'));
    catalogEntries.forEach((entry, index) => writeFileSync(join(catalogDir, `${index}.json`), JSON.stringify(entry)));
    writeFileSync(join(directory, 'bundled.json'), JSON.stringify({ models: bundledModels }));
    return spawnSync(process.execPath, [join(root, 'scripts', 'build-catalog.mjs'),
      '--bundled', join(directory, 'bundled.json'), '--catalog-dir', catalogDir,
      ...promptArgs, '--output', join(directory, 'models.json')], { encoding: 'utf8' });
  };
  const prompted = ['--instructions', instructions, '--persistent', persistent];
  const entry = { slug: 'openrouter/vendor/model' };

  assert.equal(build([], [entry], prompted).status, 0);
  assert.match(build([], [entry], ['--instructions', instructions, '--persistent', join(directory, 'missing.md')]).stderr,
    /Prompt file not found/);
  assert.match(build([], [entry], ['--instructions', instructions]).stderr, /Pass both --instructions and --persistent/);
  assert.match(build([], [entry, { ...entry }], prompted).stderr, /duplicate catalog slug openrouter\/vendor\/model/);
  assert.match(build([{ slug: 'openrouter/vendor/bundled', context_window: 272000 }],
    [{ slug: 'openrouter/vendor/bundled', context_window: 999999 }], prompted).stderr,
    /openrouter\/vendor\/bundled would replace a bundled Codex model/);
  assert.match(build([], [{ slug: 'open-router/vendor/typo' }], prompted).stderr,
    /open-router\/vendor\/typo must start with anthropic\/, deepseek\/, openrouter\/, ultra-spark\/, or ultra-spark-private\//);
  for (const slug of ['openrouter/', 'ultra-spark-private/', 'deepseek/ spaced', 'anthropic//claude']) {
    assert.match(build([], [{ slug }], prompted).stderr, /needs a model name after its prefix/, slug);
  }
});

test('prompt suffixes must name a file in the prompts directory', () => {
  for (const suffix of ['../secret.md', 'ultra-spark.txt', '/etc/passwd']) {
    assert.throws(() => applyOpenRouterPrompts({ slug: 'openrouter/vendor/model', [suffixField]: suffix }, prompts),
      /must name a \.md file/);
  }
});

test('verify-catalog checks router entries against the repository and reports what /model lists', t => {
  const directory = mkdtempSync(join(tmpdir(), 'router-verify-catalog-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const catalogFile = join(directory, 'models.json');
  writeFileSync(join(directory, 'bundled.json'), JSON.stringify({ models: [
    { slug: 'gpt-6-astra', visibility: 'list' }, { slug: 'codex-auto-review', visibility: 'hide' }] }));
  const build = nativeModels => spawnSync(process.execPath, [join(root, 'scripts', 'build-catalog.mjs'),
    '--bundled', join(directory, 'bundled.json'), '--catalog-dir', join(root, 'catalog'),
    '--instructions', join(root, 'prompts', 'openrouter-instructions.md'),
    '--persistent', join(root, 'prompts', 'openrouter-persistent.md'),
    '--native-models', nativeModels, '--output', catalogFile], { encoding: 'utf8' });
  const verify = (...args) => spawnSync(process.execPath, [join(root, 'scripts', 'verify-catalog.mjs'), ...args],
    { encoding: 'utf8' });
  const edit = change => {
    const catalog = JSON.parse(readFileSync(catalogFile, 'utf8'));
    change(new Map(catalog.models.map(model => [model.slug, model])), catalog);
    writeFileSync(catalogFile, JSON.stringify(catalog));
  };

  assert.equal(build('show').status, 0);
  assert.equal(verify(catalogFile).status, 0, verify(catalogFile).stderr);
  const shown = verify('--report', catalogFile);
  assert.equal(shown.stdout, 'Router models: anthropic/claude-opus-5-5, anthropic/claude-sonnet-5-5, '
    + `${deepseek.slug}, ${ultraSpark.slug}, ${ultraSparkPrivate.slug}, openrouter/openai/gpt-6.1-sol, ${muse.slug}, ${museStandard.slug}\n`
    + 'Router models usable by name: openrouter/anthropic/claude-opus-5.5, openrouter/anthropic/claude-sonnet-5.5\n'
    + 'Native OpenAI models: 1 in /model (require a ChatGPT plan)\n');
  assert.equal(build('hide').status, 0);
  assert.match(verify('--report', catalogFile).stdout, /^Native OpenAI models: hidden from \/model$/m);

  // Limits come from the repository's entries, so a changed window is caught without a hardcoded size.
  edit(models => { models.get(deepseek.slug).context_window -= 1; });
  let result = verify(catalogFile);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, `${deepseek.slug} has context_window ${deepseek.context_window - 1}, `
    + `but the repository sets ${deepseek.context_window}; rerun the installer.\n`);
  assert.equal(build('hide').status, 0);
  edit(models => { models.get(muse.slug).model_messages.persistent_instructions += 'x'; });
  assert.match(verify(catalogFile).stderr, /^The prompts for openrouter\/meta\/muse-spark-1\.3-contributor differ/);
  assert.equal(build('show').status, 0);
  edit(models => { models.get(muse.slug).supported_reasoning_levels[0].effort = 'none'; });
  result = verify(catalogFile);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^openrouter\/meta\/muse-spark-1\.3-contributor differs from the repository in supported_reasoning_levels;/);
  assert.equal(build('show').status, 0);
  edit(models => { models.get(deepseek.slug)[suffixField] = 'ultra-spark.md'; });
  result = verify(catalogFile);
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`^${deepseek.slug.replaceAll('.', '\\.')} differs from the repository in ${suffixField};`));
  assert.equal(build('show').status, 0);
  edit((models, catalog) => { catalog.models = catalog.models.filter(model => model.slug !== ultraSpark.slug); });
  assert.match(verify(catalogFile).stderr, /^The model catalog lacks ultra-spark\/deepseek-v4\.1-flash-1017;/);
  assert.equal(build('show').status, 0);
  edit((models, catalog) => { catalog.models.push({ ...models.get(ultraSparkPrivate.slug), slug: 'ultra-spark-private/stale' }); });
  assert.match(verify(catalogFile).stderr, /^The model catalog has ultra-spark-private\/stale, which the repository does not;/);
  writeFileSync(catalogFile, 'not json');
  result = verify(catalogFile);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Cannot read the model catalog .*; rerun the installer\.\n$/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
  assert.equal(verify().status, 2);
  assert.equal(verify('--report').status, 2);
});
