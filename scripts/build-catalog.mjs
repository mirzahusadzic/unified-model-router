import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyOpenRouterPrompts, namesRouterModel, readPrompts, suffixField, usesOpenRouterPrompts } from './openrouter-prompts.mjs';

function parseArguments(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const value = values[index + 1];
    if (value == null || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    options[key.slice(2)] = value;
    index += 1;
  }
  return options;
}

function readEntries(directory) {
  const entries = [];
  for (const name of readdirSync(directory).filter(value => value.endsWith('.json')).sort()) {
    const file = join(directory, name);
    const value = JSON.parse(readFileSync(file, 'utf8'));
    const values = Array.isArray(value) ? value : [value];
    for (const entry of values) {
      if (!entry || typeof entry.slug !== 'string' || entry.slug.length === 0) {
        throw new Error(`${file} contains a model entry without a slug`);
      }
      entries.push({ ...entry, __source: file });
    }
  }
  return entries;
}

const options = parseArguments(process.argv.slice(2));
for (const required of ['bundled', 'catalog-dir', 'output']) {
  if (!options[required]) throw new Error(`Missing --${required}`);
}

const bundled = JSON.parse(readFileSync(options.bundled, 'utf8'));
if (!Array.isArray(bundled.models)) throw new Error('The bundled catalog has no models array');
// Bundled models are native OpenAI models. Hiding them removes them from the
// /model picker without the ChatGPT plan they require; they stay usable by name.
const nativeModels = options['native-models'] ?? 'show';
if (!['show', 'hide'].includes(nativeModels)) throw new Error('--native-models must be show or hide');
if (nativeModels === 'hide') bundled.models = bundled.models.map(model => ({ ...model, visibility: 'hide' }));

// Prompts are optional, but a requested prompt file must exist.
if (Boolean(options.instructions) !== Boolean(options.persistent)) {
  throw new Error('Pass both --instructions and --persistent, or neither');
}
for (const file of [options.instructions, options.persistent].filter(Boolean)) {
  if (!existsSync(file)) throw new Error(`Prompt file not found: ${file}`);
}
const prompts = options.instructions ? readPrompts(options.instructions, options.persistent) : null;

const entries = readEntries(options['catalog-dir'])
  .map(entry => (prompts ? applyOpenRouterPrompts(entry, prompts) : entry));

// Native models keep Codex's bundled definitions and limits.
const order = bundled.models.map(model => model.slug);
const bySlug = new Map(bundled.models.map(model => [model.slug, model]));
const catalogSlugs = new Set();
for (const entry of entries) {
  const { __source, [suffixField]: _suffix, ...model } = entry;
  if (!usesOpenRouterPrompts(model.slug)) {
    throw new Error(`${__source}: ${model.slug} must start with anthropic/, deepseek/, openrouter/, ultra-spark/, or ultra-spark-private/`);
  }
  if (!namesRouterModel(model.slug)) throw new Error(`${__source}: ${model.slug} needs a model name after its prefix`);
  if (catalogSlugs.has(model.slug)) throw new Error(`${__source}: duplicate catalog slug ${model.slug}`);
  if (bySlug.has(model.slug)) throw new Error(`${__source}: ${model.slug} would replace a bundled Codex model`);
  catalogSlugs.add(model.slug);
  order.push(model.slug);
  bySlug.set(model.slug, model);
}

const models = order.map(slug => bySlug.get(slug));
writeFileSync(options.output, `${JSON.stringify({ ...bundled, models }, null, 2)}\n`, 'utf8');
