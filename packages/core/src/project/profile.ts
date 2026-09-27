import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { detectTestCommand } from '../gates/detect.js';

export interface ProjectProfile {
  name: string;
  path: string;
  git: boolean;
  /** Frameworks and languages found from marker files, most specific first. */
  stack: string[];
  packageManager?: string;
  testCommand?: string;
  /** Files counted (excluding dependencies, build output and VCS metadata). */
  files: number;
  /** True when the walk stopped at `maxFiles`. */
  truncated: boolean;
  /** Top extensions by file count. */
  languages: { ext: string; files: number }[];
  /** `Next.js · React · TypeScript · pnpm test · 412 files`, or `empty directory`. */
  summary: string;
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'vendor',
  'dist',
  'build',
  '.next',
  'target',
  '.shibaox',
  '.venv',
  'venv',
  '__pycache__',
  '.turbo',
  'coverage',
]);

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  php: 'PHP',
  py: 'Python',
  go: 'Go',
  rs: 'Rust',
  dart: 'Dart',
  cs: 'C#',
  gd: 'GDScript',
  rb: 'Ruby',
  java: 'Java',
  kt: 'Kotlin',
  swift: 'Swift',
  vue: 'Vue',
};

/** Node frameworks by the dependency that marks them (checked in this order). */
const NODE_FRAMEWORKS: [string, string][] = [
  ['next', 'Next.js'],
  ['nuxt', 'Nuxt'],
  ['@remix-run/react', 'Remix'],
  ['astro', 'Astro'],
  ['@nestjs/core', 'NestJS'],
  ['express', 'Express'],
  ['fastify', 'Fastify'],
  ['hono', 'Hono'],
  ['electron', 'Electron'],
  ['react-native', 'React Native'],
  ['expo', 'Expo'],
  ['svelte', 'Svelte'],
  ['vue', 'Vue'],
  ['@angular/core', 'Angular'],
  ['react', 'React'],
  ['phaser', 'Phaser'],
];

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function packageManagerOf(dir: string): string | undefined {
  const has = (f: string) => existsSync(join(dir, f));
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (has('bun.lock') || has('bun.lockb')) return 'bun';
  if (has('package-lock.json') || has('package.json')) return 'npm';
  if (has('composer.json')) return 'composer';
  if (has('poetry.lock')) return 'poetry';
  if (has('uv.lock')) return 'uv';
  if (has('requirements.txt') || has('pyproject.toml')) return 'pip';
  if (has('go.mod')) return 'go';
  if (has('Cargo.toml')) return 'cargo';
  if (has('pubspec.yaml')) return 'pub';
  if (has('Gemfile')) return 'bundler';
  return undefined;
}

function stackOf(dir: string, languages: { ext: string; files: number }[]): string[] {
  const has = (f: string) => existsSync(join(dir, f));
  const out: string[] = [];
  const add = (s: string) => {
    if (!out.includes(s)) out.push(s);
  };
  const pkg = has('package.json') ? readJson(join(dir, 'package.json')) : undefined;
  if (pkg) {
    const deps = {
      ...(pkg.dependencies as Record<string, string> | undefined),
      ...(pkg.devDependencies as Record<string, string> | undefined),
    };
    for (const [dep, name] of NODE_FRAMEWORKS) if (dep in deps) add(name);
  }
  const composer = has('composer.json') ? readJson(join(dir, 'composer.json')) : undefined;
  if (composer) {
    const req = {
      ...(composer.require as Record<string, string> | undefined),
      ...(composer['require-dev'] as Record<string, string> | undefined),
    };
    if ('laravel/framework' in req) add('Laravel');
    else if ('symfony/framework-bundle' in req) add('Symfony');
    add('PHP');
  }
  if (has('manage.py')) {
    add('Django');
    add('Python');
  } else if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) {
    const py = readText(join(dir, 'pyproject.toml')) + readText(join(dir, 'requirements.txt'));
    if (/\bfastapi\b/i.test(py)) add('FastAPI');
    else if (/\bflask\b/i.test(py)) add('Flask');
    add('Python');
  }
  if (has('go.mod')) add('Go');
  if (has('Cargo.toml')) add('Rust');
  if (has('pubspec.yaml')) {
    if (/^\s*flutter\s*:/m.test(readText(join(dir, 'pubspec.yaml')))) add('Flutter');
    add('Dart');
  }
  if (has('project.godot')) add('Godot');
  if (has('Gemfile')) {
    if (/\brails\b/.test(readText(join(dir, 'Gemfile')))) add('Rails');
    add('Ruby');
  }
  if (has('Assets') && has('ProjectSettings')) add('Unity');
  // languages seen in the files that no marker named yet
  for (const { ext } of languages) {
    const lang = LANGUAGE_BY_EXT[ext];
    if (lang && !out.includes(lang)) add(lang);
  }
  return out;
}

function walk(
  dir: string,
  counts: Map<string, number>,
  budget: { left: number; truncated: boolean },
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (budget.left <= 0) {
      budget.truncated = true;
      return;
    }
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(full); // symlinks are never followed: no loops, no escapes
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, counts, budget);
    else if (st.isFile()) {
      budget.left -= 1;
      const ext = extname(name).slice(1).toLowerCase();
      if (ext) counts.set(ext, (counts.get(ext) ?? 0) + 1);
    }
  }
}

/** What a directory is: stack, tooling and size, from marker files and a bounded file walk. */
export function profileProject(dir: string, o: { maxFiles?: number } = {}): ProjectProfile {
  const maxFiles = o.maxFiles ?? 20_000;
  const counts = new Map<string, number>();
  const budget = { left: maxFiles, truncated: false };
  walk(dir, counts, budget);
  const files = maxFiles - budget.left;
  const languages = [...counts]
    .filter(([ext]) => ext in LANGUAGE_BY_EXT)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([ext, n]) => ({ ext, files: n }));
  const pkg = existsSync(join(dir, 'package.json'))
    ? readJson(join(dir, 'package.json'))
    : undefined;
  const name = (typeof pkg?.name === 'string' && pkg.name) || basename(dir);
  const stack = stackOf(dir, languages);
  const testCommand = detectTestCommand(dir);
  const truncated = budget.truncated;
  const summary =
    files === 0 && stack.length === 0
      ? 'empty directory'
      : [...stack.slice(0, 3), testCommand, `${files}${truncated ? '+' : ''} files`]
          .filter(Boolean)
          .join(' · ');
  return {
    name,
    path: dir,
    git: existsSync(join(dir, '.git')),
    stack,
    packageManager: packageManagerOf(dir),
    testCommand,
    files,
    truncated,
    languages,
    summary,
  };
}

/** The vault note for a profile (`10-projects/<name>/profile.md`). */
export function renderProfileNote(p: ProjectProfile): string {
  const q = (v: string | number | boolean) =>
    typeof v === 'string' ? JSON.stringify(v) : String(v);
  return [
    '---',
    'type: project-profile',
    `project: ${q(p.name)}`,
    `path: ${q(p.path)}`,
    `git: ${q(p.git)}`,
    `files: ${q(p.files)}`,
    `updated_at: ${q(new Date().toISOString())}`,
    '---',
    '',
    `# ${p.name}`,
    '',
    `- stack: ${p.stack.join(', ') || 'unknown'}`,
    `- package manager: ${p.packageManager ?? 'unknown'}`,
    `- tests: ${p.testCommand ?? 'none detected'}`,
    `- files: ${p.files}${p.truncated ? '+' : ''}`,
    `- languages: ${p.languages.map((l) => `${l.ext} (${l.files})`).join(', ') || 'none'}`,
    '',
  ].join('\n');
}
