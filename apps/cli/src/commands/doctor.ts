import { runCommand } from '@shibaox/core';

interface CheckLine {
  name: string;
  ok: boolean;
  detail: string;
  required: boolean;
}

async function which(bin: string, versionFlag = '--version'): Promise<CheckLine> {
  const r = await runCommand({
    command: `${bin} ${versionFlag}`,
    cwd: process.cwd(),
    timeoutMs: 10_000,
  });
  const ok = r.exitCode === 0;
  return {
    name: bin,
    ok,
    detail: ok ? (r.stdout.trim().split('\n')[0] ?? '') : 'not found',
    required: false,
  };
}

export async function doctorCommand(): Promise<number> {
  const lines: CheckLine[] = [];
  lines.push({ ...(await which('node')), required: true });
  lines.push({ ...(await which('git')), required: true });
  lines.push(await which('uv'));
  lines.push(await which('graphify'));
  lines.push(await which('claude'));
  lines.push(await which('codex'));
  lines.push(await which('cursor'));
  for (const env of ['ANTHROPIC_API_KEY', 'TYPESAFE_API_KEY']) {
    lines.push({
      name: env,
      ok: Boolean(process.env[env]),
      detail: process.env[env] ? 'set' : 'missing',
      required: env === 'ANTHROPIC_API_KEY',
    });
  }
  for (const l of lines)
    console.log(
      `${l.ok ? 'OK  ' : l.required ? 'FAIL' : 'warn'}  ${l.name.padEnd(20)} ${l.detail}`,
    );
  const failed = lines.some((l) => l.required && !l.ok);
  console.log(
    failed
      ? '\nFix the FAIL lines before running workflows.'
      : '\nReady for mock runs. Phase 1B adds real runtimes.',
  );
  return failed ? 1 : 0;
}
