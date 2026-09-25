import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { CatalogSchema, type ProviderEntry } from './catalog-schema.js';

export const DEFAULT_CATALOG_PATH = fileURLToPath(new URL('../catalog.yaml', import.meta.url));

export function loadCatalog(path: string = DEFAULT_CATALOG_PATH): ProviderEntry[] {
  const raw = parse(readFileSync(path, 'utf8'));
  const r = CatalogSchema.safeParse(raw);
  if (!r.success)
    throw new Error(
      `invalid provider catalog ${path}: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  const ids = new Set<string>();
  for (const e of r.data) {
    if (ids.has(e.id)) throw new Error(`invalid provider catalog ${path}: duplicate id "${e.id}"`);
    ids.add(e.id);
  }
  return r.data;
}
