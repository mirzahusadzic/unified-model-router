import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Every entry the router serves (OpenRouter models and Claude, on either of its
// routes) shares the maintained prompts.
// An entry may append one more prompt from the same directory by naming it in
// `router_instructions_suffix`; the generated Codex catalog omits that field.
export const suffixField = 'router_instructions_suffix';

export function usesOpenRouterPrompts(slug) {
  return ['anthropic/', 'deepseek/', 'openrouter/', 'ultra-spark/', 'ultra-spark-private/'].some(prefix => slug.startsWith(prefix));
}

export function readPrompts(instructionsFile, persistentFile) {
  return {
    directory: dirname(instructionsFile),
    instructions: readFileSync(instructionsFile, 'utf8'),
    persistent: readFileSync(persistentFile, 'utf8'),
  };
}

export function applyOpenRouterPrompts(entry, prompts) {
  if (!usesOpenRouterPrompts(entry.slug)) return entry;
  const suffix = entry[suffixField];
  if (suffix !== undefined && !/^[a-z0-9-]+\.md$/.test(suffix)) {
    throw new Error(`${entry.slug}: ${suffixField} must name a .md file in the prompts directory`);
  }
  const instructions = suffix === undefined
    ? prompts.instructions
    : `${prompts.instructions}\n${readFileSync(join(prompts.directory, suffix), 'utf8')}`;
  return {
    ...entry,
    base_instructions: instructions,
    model_messages: {
      ...entry.model_messages,
      instructions_template: instructions,
      persistent_instructions: prompts.persistent,
    },
  };
}
