import { readFileSync } from 'node:fs';

/** The CLI's own version (from package.json); the daemon reports it in `/health`. */
export const CLI_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
