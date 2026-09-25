import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ORG_TEMPLATE } from '../templates.js';

export function scaffoldOrg(dir: string): string[] {
  const created: string[] = [];
  for (const [rel, content] of Object.entries(ORG_TEMPLATE)) {
    const file = join(dir, rel);
    if (existsSync(file)) continue;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    created.push(rel);
  }
  return created;
}

export function initCommand(dir: string): void {
  const created = scaffoldOrg(dir);
  if (created.length === 0) {
    console.log('Nothing to do: org/ and vault/ already exist.');
    return;
  }
  console.log(`Created ${created.length} files under ${dir}:`);
  for (const f of created) console.log(`  ${f}`);
  console.log(
    '\nNext: shibaox doctor && shibaox run hello-feature --org ./org --project <path> --input "..."',
  );
}
