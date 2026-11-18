import { readdirSync } from 'node:fs';
import { join } from 'node:path';

// The catalog's entry files, in folders by vendor: paths relative to the
// catalog directory, with forward slashes. They sort without the extension,
// so an entry comes before its variants (opus.json, then opus-openrouter.json).
// The folders are walked here: readdir's `recursive` option needs Node 20.1.
export function catalogFiles(directory) {
  const key = name => name.slice(0, -'.json'.length);
  const walk = folder => readdirSync(join(directory, folder), { withFileTypes: true }).flatMap(entry => {
    const name = folder ? `${folder}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return walk(name);
    return name.endsWith('.json') ? [name] : [];
  });
  return walk('').sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}
