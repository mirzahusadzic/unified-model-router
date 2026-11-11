import { readdirSync } from 'node:fs';

// The catalog's entry files, in folders by vendor: paths relative to the
// catalog directory, with forward slashes. They sort without the extension,
// so an entry comes before its variants (opus.json, then opus-openrouter.json).
export function catalogFiles(directory) {
  const key = name => name.slice(0, -'.json'.length);
  return readdirSync(directory, { recursive: true })
    .map(name => String(name).replaceAll('\\', '/'))
    .filter(name => name.endsWith('.json'))
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}
