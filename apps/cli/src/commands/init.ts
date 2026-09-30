import { detectStack, STACKS, type Stack } from '@wizardingcode/shibaox-core';
import { scaffoldOrg } from '@wizardingcode/shibaox-daemon';

export { STACKS, scaffoldOrg };

/** `shibaox init [dir] [--stack node|python|php-laravel|go|auto]`. */
export function initCommand(dir: string, o: { stack?: string } = {}): number {
  let stack: Stack | undefined;
  if (o.stack === 'auto') {
    stack = detectStack(dir);
    console.log(
      stack
        ? `stack: ${stack} (detected in ${dir})`
        : `no stack detected in ${dir}: writing the generic org (pass --stack to choose one)`,
    );
  } else if (o.stack !== undefined) {
    if (!(STACKS as readonly string[]).includes(o.stack)) {
      console.error(`unknown stack "${o.stack}": one of ${STACKS.join(', ')}, or auto`);
      return 1;
    }
    stack = o.stack as Stack;
    console.log(`stack: ${stack}`);
  }
  const created = scaffoldOrg(dir, { stack });
  if (created.length === 0) {
    console.log('Nothing to do: org/ and vault/ already exist.');
    return 0;
  }
  console.log(`Created ${created.length} files under ${dir}:`);
  for (const f of created) console.log(`  ${f}`);
  console.log(
    `\nNext: shibaox doctor && shibaox run hello-feature --org ./org --project <path> --input "..."${
      stack ? '\nThe weekly security scan is a routine file: shibaox routine sync --org ./org' : ''
    }`,
  );
  return 0;
}
