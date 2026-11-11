// Render the maintained prompts into every checked-in catalog entry routed
// through OpenRouter. Run after editing prompts/ or adding an entry.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogFiles } from './catalog-files.mjs';
import { applyOpenRouterPrompts, readPrompts } from './openrouter-prompts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const prompts = readPrompts(join(root, 'prompts', 'openrouter-instructions.md'),
  join(root, 'prompts', 'openrouter-persistent.md'));
const catalogDir = join(root, 'catalog');
for (const name of catalogFiles(catalogDir)) {
  const file = join(catalogDir, name);
  const value = JSON.parse(readFileSync(file, 'utf8'));
  const rendered = Array.isArray(value)
    ? value.map(entry => applyOpenRouterPrompts(entry, prompts))
    : applyOpenRouterPrompts(value, prompts);
  writeFileSync(file, `${JSON.stringify(rendered, null, 2)}\n`);
}
