import { scaffoldOrg } from '@wizardingcode/shibaox-daemon';

export { scaffoldOrg };

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
