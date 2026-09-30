import { existsSync } from 'node:fs';
import { detectStack, STACKS, type Stack } from '@wizardingcode/shibaox-core';
import { scaffoldOrg } from '@wizardingcode/shibaox-daemon';

export { STACKS, scaffoldOrg };

/** `shibaox init [dir] [--stack node|python|php-laravel|go|auto]`. */
export function initCommand(dir: string, o: { stack?: string } = {}): number {
  let stack: Stack | undefined;
  if (o.stack === 'auto') {
    if (!existsSync(dir)) {
      console.log(
        `${dir} does not exist yet: writing the generic org (pass --stack to choose one)`,
      );
    } else {
      stack = detectStack(dir);
      console.log(
        stack
          ? `stack: ${stack} (detected in ${dir})`
          : `no stack detected in ${dir}: writing the generic org (pass --stack to choose one)`,
      );
    }
  } else if (o.stack !== undefined) {
    if (!(STACKS as readonly string[]).includes(o.stack)) {
      console.error(`unknown stack "${o.stack}": one of ${STACKS.join(', ')}, or auto`);
      return 1;
    }
    stack = o.stack as Stack;
    console.log(`stack: ${stack}`);
  }
  const kept: string[] = [];
  const created = scaffoldOrg(dir, { stack, onKept: (rel) => kept.push(rel) });
  if (created.length === 0 && kept.length === 0) {
    console.log('Nothing to do: org/ and vault/ already exist.');
    return 0;
  }
  if (created.length > 0) {
    console.log(`Created ${created.length} files under ${dir}:`);
    for (const f of created) console.log(`  ${f}`);
  }
  if (kept.length > 0) {
    console.log(`Kept existing (not rewritten): ${kept.join(', ')}`);
    console.log(
      '  → wire the stack by hand where needed: `typecheck` in the team gates and the qa gates, `security-scan` in the team workflows, `frontend` in the team roles.',
    );
  }
  console.log(
    `\nNext: shibaox doctor && shibaox run hello-feature --org ./org --project <path> --input "..."${
      stack
        ? '\nCommit shibaox.yaml with the project (worktree runs read it from the checkout).\nThe weekly security scan is a routine file: shibaox routine sync --org ./org'
        : ''
    }`,
  );
  return 0;
}
