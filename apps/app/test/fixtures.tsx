import { render } from '@testing-library/react';
import type { RunState } from '@wizardingcode/shibaox-core';
import type {
  ConnectorTemplate,
  Envelope,
  HiggsfieldView,
  InboxItem,
  PluginMode,
  PluginRow,
  RoleRow,
  RunSummaryPlus,
  SkillRow,
  SkillSource,
} from '@wizardingcode/shibaox-daemon';
import type { McpServer } from '@wizardingcode/shibaox-schemas';
import { App } from '../src/App.js';
import { AppHttpError, type RunFileContent } from '../src/api/client.js';
import type { McpRow } from '../src/screens/customize/types.js';
import { AppStore, type StoreClient } from '../src/store/store.js';

export const summary = (id: string, o: Partial<RunSummaryPlus> = {}): RunSummaryPlus =>
  ({
    runId: id,
    workflow: 'chat',
    status: 'completed',
    createdAt: '2026-09-30T10:00:00.000Z',
    updatedAt: '2026-09-30T10:00:30.000Z',
    spentUsd: 0.012,
    thread: id,
    project: '/p',
    orgRoot: '/o',
    ...o,
  }) as RunSummaryPlus;
export const state = (
  id: string,
  o: Partial<RunState> & { input?: Record<string, unknown> } = {},
): RunState =>
  ({
    runId: id,
    workflow: 'chat',
    status: 'completed',
    input: { spec: 'Find me a hotel in Porto' },
    workspace: '/p',
    nodes: {},
    pendingApprovals: [],
    pendingHumans: [],
    spentUsd: 0.012,
    thread: id,
    project: '/p',
    orgRoot: '/o',
    adapter: 'direct',
    workspaceMode: 'inplace',
    model: 'anthropic/claude-opus',
    workflowSnapshot: {
      workflow: 'chat',
      start: 'reply',
      conversation: true,
      nodes: { reply: { type: 'task', role: 'assistant' } },
    },
    ...o,
  }) as unknown as RunState;
export const runFrame = (seq: number, type: string, extra: Record<string, unknown>): Envelope =>
  ({
    kind: 'run',
    seq,
    cursor: `${seq}:0`,
    event: { seq, type, at: 't', runId: 'x', ...extra },
  }) as Envelope;
export const rtFrame = (seq: number, nodeId: string, event: Record<string, unknown>): Envelope =>
  ({
    kind: 'runtime',
    seq,
    cursor: `1:${seq}`,
    event: { runId: 'x', nodeId, seq, at: 't', event },
  }) as Envelope;

export const SKILLS: SkillRow[] = [
  {
    id: 'pdf',
    name: 'PDF',
    description: 'Read, fill and merge PDF forms',
    path: '/o/skills/pdf/SKILL.md',
    roles: ['assistant'],
  },
  {
    id: 'brand-voice',
    name: 'Brand voice',
    description: 'Write in the voice of the brand',
    path: '/o/skills/brand-voice/SKILL.md',
    roles: [],
  },
];
export const ROLES: RoleRow[] = [
  { id: 'assistant', name: 'Assistant', tools: [], mcp: [], skills: ['pdf'] },
  {
    id: 'browser-qa',
    name: 'Browser QA',
    model: 'openai/gpt-5',
    tools: [],
    mcp: ['playwright'],
    skills: [],
  },
];
/** A catalog server as the daemon answers with it (the schema's defaults applied). */
export const server = (s: Partial<McpServer> & Pick<McpServer, 'transport'>): McpServer => ({
  args: [],
  env: {},
  env_keys: [],
  headers: {},
  timeout_ms: 30_000,
  ...s,
});
export const CONNECTORS: ConnectorTemplate[] = [
  {
    id: 'github',
    name: 'GitHub',
    vendor: 'GitHub',
    verified: true,
    category: 'Code',
    description: 'Issues, pull requests and code search',
    keys: [
      {
        name: 'GH_TOKEN',
        signupUrl: 'https://github.com/settings/tokens',
        description: 'A GitHub token',
      },
    ],
    server: server({
      transport: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the catalog's own ${KEY} placeholder
      headers: { Authorization: 'Bearer ${GH_TOKEN}' },
      env_keys: ['GH_TOKEN'],
    }),
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    vendor: 'Firecrawl',
    verified: false,
    category: 'Search',
    description: 'Scrape and crawl websites',
    keys: [
      {
        name: 'FIRECRAWL_API_KEY',
        signupUrl: 'https://firecrawl.dev',
        description: 'Firecrawl API key',
      },
    ],
    server: server({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'firecrawl-mcp'],
      env_keys: ['FIRECRAWL_API_KEY'],
    }),
  },
  {
    id: 'playwright',
    name: 'Playwright',
    vendor: 'Microsoft',
    verified: false,
    category: 'Browser',
    description: 'Drive a browser',
    keys: [],
    server: server({ transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp'] }),
  },
  {
    id: 'notion',
    name: 'Notion',
    vendor: 'Notion',
    verified: true,
    category: 'Productivity',
    description: 'Pages and databases',
    keys: [],
    note: 'Signs in on first use (OAuth in the browser); no key to set.',
    server: server({ transport: 'http', url: 'https://mcp.notion.com/mcp' }),
  },
];
export const SOURCES: SkillSource[] = [
  {
    repo: 'anthropics/skills',
    name: 'Anthropic skills',
    vendor: 'Anthropic',
    description: 'Anthropic’s public skills: documents, design, development, communication.',
    path: 'skills',
    categories: ['Documents', 'Design', 'Development', 'Communication'],
  },
  {
    repo: 'higgsfield-ai/skills',
    name: 'Higgsfield skills',
    vendor: 'Higgsfield',
    description: 'Generate with Higgsfield',
  },
];
export const DISCOVER: Record<
  string,
  { id: string; name: string; description: string; path: string }[]
> = {
  // the daemon's paths are relative to the repository (anthropics/skills keeps them in skills/)
  'anthropics/skills': [
    { id: 'pdf', name: 'pdf', description: 'PDF tools', path: 'skills/pdf' },
    { id: 'xlsx', name: 'xlsx', description: 'Spreadsheets', path: 'skills/xlsx' },
    {
      id: 'canvas-design',
      name: 'canvas-design',
      description: 'Posters and art',
      path: 'skills/canvas-design',
    },
  ],
  'higgsfield-ai/skills': [
    {
      id: 'higgsfield',
      name: 'higgsfield',
      description: 'Images and video',
      path: 'higgsfield',
    },
    {
      id: 'product-shot',
      name: 'product-shot',
      description: 'Product photos',
      path: 'recipes/product-shot',
    },
  ],
  'acme/tools': [
    { id: 'invoice', name: 'invoice', description: 'Invoices', path: 'skills/invoice' },
    { id: 'pdf', name: 'pdf', description: 'Another pdf', path: 'skills/pdf' },
  ],
};
const HF_ACCOUNT: PluginMode = {
  id: 'account',
  name: 'Account',
  description: 'Your Higgsfield login: the CLI, the MCP and your plan credits',
  active: true,
  status: 'partial',
  checks: [
    { label: 'CLI installed', ok: true, detail: '1.1.26' },
    { label: 'Logged in', ok: true, detail: 'andre@example.com · plus · 3.5 credits' },
    { label: 'MCP reachable', ok: false, detail: 'unauthorized' },
  ],
  keys: [],
  actions: [
    {
      id: 'install',
      label: 'Install command',
      command: 'curl -fsSL https://higgsfield.ai/cli/install.sh | sh',
    },
    { id: 'login', label: 'Log in', href: '/integrations/higgsfield/login' },
    { id: 'signup', label: 'Create an account', href: 'https://higgsfield.ai?fpr=andre-4fae29' },
    { id: 'open', label: 'Open Higgsfield', href: 'https://higgsfield.ai' },
  ],
  brings: { connectors: ['higgsfield'], skills: ['higgsfield'] },
};

export const HF_API: PluginMode = {
  id: 'api',
  name: 'API',
  description: 'A developer key from open.higgsfield.ai: the REST API, billed to that account',
  active: false,
  status: 'off',
  checks: [
    { label: 'API key saved', ok: false, detail: 'no key' },
    { label: 'API key valid', ok: false, detail: 'no key' },
  ],
  keys: [{ name: 'HIGGSFIELD_API_KEY', present: false }],
  actions: [
    { id: 'connect_key', label: 'Connect API key', href: 'https://open.higgsfield.ai/api-keys' },
    { id: 'docs', label: 'API docs', href: 'https://docs.higgsfield.ai' },
  ],
  brings: {
    connectors: [],
    skills: ['higgsfield', 'higgsfield-app'],
    builtin: ['higgsfield', 'higgsfield-app'],
    tools: [
      'higgsfield_api_generate',
      'higgsfield_api_status',
      'higgsfield_api_cancel',
      'higgsfield_api_upload',
    ],
  },
};

/** The Higgsfield row with its API key saved; `active`: the API is what tasks use. */
export function higgsfieldApi(o: {
  active: boolean;
  configured?: 'auto' | 'account' | 'api';
  valid?: boolean;
}): PluginRow {
  const api: PluginMode = {
    ...HF_API,
    active: o.active,
    status: o.valid === false ? 'partial' : 'ready',
    checks: [
      { label: 'API key saved', ok: true },
      {
        label: 'API key valid',
        ok: o.valid !== false,
        detail: o.valid === false ? 'rejected by Higgsfield (401)' : 'accepted',
      },
    ],
    keys: [{ name: 'HIGGSFIELD_API_KEY', present: true }],
    actions: [
      { id: 'connect_key', label: 'Manage API key', href: 'https://open.higgsfield.ai/api-keys' },
      { id: 'docs', label: 'API docs', href: 'https://docs.higgsfield.ai' },
    ],
  };
  const account = { ...HF_ACCOUNT, active: !o.active };
  const top = o.active ? api : account;
  return {
    id: 'higgsfield',
    name: 'Higgsfield',
    description: 'Images, video, audio and 3D from 40+ models',
    status: top.status,
    checks: top.checks,
    keys: top.keys,
    actions: top.actions,
    brings: top.brings,
    modes: [account, api],
    mode: { configured: o.configured ?? 'auto', effective: o.active ? 'api' : 'account' },
  };
}

export const PLUGINS: PluginRow[] = [
  {
    id: 'higgsfield',
    name: 'Higgsfield',
    description: 'Images, video, audio and 3D from 40+ models',
    status: 'partial',
    checks: HF_ACCOUNT.checks,
    keys: [],
    actions: HF_ACCOUNT.actions,
    brings: { connectors: ['higgsfield'], skills: ['higgsfield'] },
    modes: [HF_ACCOUNT, HF_API],
    mode: { configured: 'auto', effective: 'account' },
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Issues, pull requests and the GitHub loop',
    status: 'ready',
    checks: [
      { label: 'gh installed', ok: true, detail: '/opt/homebrew/bin/gh' },
      { label: 'Token (GH_TOKEN or GITHUB_TOKEN)', ok: true },
    ],
    keys: [
      { name: 'GH_TOKEN', present: true },
      { name: 'GITHUB_TOKEN', present: false },
    ],
    actions: [
      { id: 'install', label: 'Install gh', href: 'https://cli.github.com' },
      {
        id: 'token',
        label: 'Create a token',
        href: 'https://github.com/settings/personal-access-tokens/new',
      },
    ],
    brings: { connectors: ['github'], skills: [] },
  },
  {
    id: 'telegram',
    name: 'Telegram',
    description: 'Talk to Shibaox from Telegram',
    status: 'off',
    checks: [{ label: 'Bot token', ok: false }],
    keys: [{ name: 'SHIBAOX_TELEGRAM_TOKEN', present: false }],
    actions: [{ id: 'docs', label: 'Channel docs', href: 'https://example.com/telegram' }],
    brings: { connectors: [], skills: [] },
  },
];

export function client(
  o: {
    runs?: RunSummaryPlus[];
    states?: Record<string, RunState>;
    frames?: Record<string, Envelope[]>;
    /** submitRun rejects (a failed send). */
    failSubmit?: boolean;
    /** Files of runs by path (fileContent answers from here first). */
    files?: Record<string, RunFileContent>;
    inbox?: InboxItem[];
    routines?: unknown[];
    skills?: SkillRow[];
    roles?: RoleRow[];
    plugins?: PluginRow[];
    mcp?: McpRow[];
    /** GET /keys answers these instead. */
    keys?: Awaited<ReturnType<StoreClient['keys']>>;
    /** addSkill skips these ids with that reason. */
    skip?: Record<string, string>;
    /** addSkill leaves these files out of the skills it adds. */
    omitted?: Record<string, string[]>;
    /** DELETE /skills answers 409 with these roles (unless detach). */
    inUse?: string[];
    /** discoverSkills fails this many times first. */
    discoverFails?: number;
    /** mcpTest answers a failure. */
    mcpTestFails?: boolean;
    /** These methods of the client fail (`<name> failed`). */
    fail?: (keyof StoreClient)[];
    /** GET /models answers these instead. */
    models?: Awaited<ReturnType<StoreClient['models']>>;
  } = {},
) {
  const calls: { name: string; args: unknown[] }[] = [];
  const rec = (name: string, ...args: unknown[]) => calls.push({ name, args });
  const c: StoreClient = {
    async health() {
      return {
        version: '0.2.1',
        uptimeSeconds: 1,
        runs: { running: 0, queued: 0, waiting: 0 },
        channels: [],
      };
    },
    async listRuns() {
      return o.runs ?? [];
    },
    async getRun(id) {
      const s = o.states?.[id];
      if (!s) throw new Error('not found');
      return s;
    },
    async inbox() {
      return o.inbox ?? [];
    },
    async submitRun(req) {
      rec('submitRun', req);
      if (o.failSubmit) throw new Error('the daemon refused it');
      return { runId: 'new-1', warnings: [] };
    },
    async answer(id, a) {
      rec('answer', id, a);
      return {};
    },
    async steer(id, s) {
      rec('steer', id, s);
      return o.states?.[id] as RunState;
    },
    async files(id) {
      rec('files', id);
      return { root: '/p', files: [] };
    },
    async writeFile(id, path, content) {
      rec('writeFile', id, path, content);
      return { path, size: content.length };
    },
    async fileContent(id, path) {
      rec('fileContent', id, path);
      const known = o.files?.[path];
      if (known) return known;
      return { path, size: 5, encoding: 'utf8' as const, content: 'name\n', truncated: false };
    },
    async fileBlob(id, path) {
      rec('fileBlob', id, path);
      return new Blob(['name\n']);
    },
    async auditMarkdown(id) {
      rec('auditMarkdown', id);
      return `# Audit ${id}`;
    },
    async cancel(id) {
      rec('cancel', id);
      return {};
    },
    async resume(id) {
      rec('resume', id);
      return {};
    },
    async higgsfield() {
      rec('higgsfield');
      return {
        cli: { installed: true, version: '1.1.26' },
        loggedIn: true,
        account: { email: 'andre@example.com', plan: 'plus', credits: 3.5 },
        mcp: 'ok' as const,
        signupUrl: 'https://higgsfield.ai?fpr=andre-4fae29',
        installCommand:
          'curl -fsSL https://raw.githubusercontent.com/higgsfield-ai/cli/main/install.sh | sh',
        site: 'https://higgsfield.ai',
        api: { keySet: false },
        mode: 'auto' as const,
        effective: 'account' as const,
      };
    },
    async higgsfieldLogin() {
      rec('higgsfieldLogin');
      return { started: true };
    },
    async setHiggsfieldMode(mode) {
      rec('setHiggsfieldMode', mode);
      return {} as never;
    },
    async decisions() {
      return {
        decider: {
          kind: 'model' as const,
          ref: 'openrouter/typesafe/jev-router',
          usable: false,
          reason: 'missing OPENROUTER_API_KEY',
        },
        decisions: [
          {
            runId: 'root',
            nodeId: 'judge',
            choice: 'ship',
            confidence: 0.91,
            by: 'model:openrouter/typesafe/jev-router',
            at: '2026-10-01T10:00:00.000Z',
          },
        ],
      };
    },
    async models() {
      if (o.models) return o.models;
      return [
        {
          ref: 'anthropic/claude-opus',
          provider: 'anthropic',
          model: 'claude-opus',
          configured: true,
        },
        {
          ref: 'lmstudio/qwen',
          provider: 'lmstudio',
          model: 'qwen',
          configured: true,
          local: true,
          available: true,
        },
        {
          ref: 'openai/gpt-5',
          provider: 'openai',
          model: 'gpt-5',
          configured: false,
          missing: ['OPENAI_API_KEY'],
        },
        {
          ref: 'openrouter/mistralai/mistral-large',
          provider: 'openrouter',
          model: 'mistralai/mistral-large',
          configured: true,
        },
        {
          ref: 'openrouter/meta/llama-3.3-70b',
          provider: 'openrouter',
          model: 'meta/llama-3.3-70b',
          configured: true,
          contextWindow: 131_072,
          pricing: { input_per_m: 0.12, output_per_m: 0.3 },
        },
        {
          ref: 'claude-code/opus',
          provider: 'claude-code',
          model: 'opus',
          configured: false,
          runtime: 'claude',
        },
      ];
    },
    async projects() {
      return [{ path: '/p', source: 'config' as const }];
    },
    async defaultOrg() {
      return { root: '/o', created: false };
    },
    async orgInfo() {
      return {
        workflows: ['chat', 'fix-issue', 'hello-feature'],
        single: ['chat'],
        subscription: false,
        adapter: 'direct' as const,
        descriptions: {
          'fix-issue': 'Fix a GitHub issue end to end',
          'hello-feature': 'Analyse, implement, test, judge, ship.',
        },
        catalog: [],
      };
    },
    async *stream(id) {
      for (const f of o.frames?.[id] ?? []) yield f;
      const st = o.states?.[id];
      if (st && st.status !== 'running')
        yield { kind: 'end', seq: 99, cursor: '99:0', status: st.status } as Envelope;
    },
    async routines() {
      return (o.routines ?? []) as never;
    },
    async runRoutine(id) {
      rec('runRoutine', id);
      return { runId: 'rr' };
    },
    async pauseRoutine(id) {
      rec('pauseRoutine', id);
      return {} as never;
    },
    async resumeRoutine(id) {
      rec('resumeRoutine', id);
      return {} as never;
    },
    async removeRoutine(id) {
      rec('removeRoutine', id);
    },
    async addRoutine(r) {
      rec('addRoutine', r);
      return {} as never;
    },
    async updateRoutine(id, patch) {
      rec('updateRoutine', id, patch);
      return {} as never;
    },
    async draftRoutine(r) {
      rec('draftRoutine', r);
      return {
        name: 'Daily briefing',
        description: 'What changed yesterday',
        trigger: { type: 'cron' as const, cron: '0 9 * * 1-5' },
        workflow: 'chat',
        input: "Summarise yesterday's commits, PRs and issues.",
        approvals: 'inbox' as const,
        words: 'Weekdays at 09:00',
      };
    },
    async syncRoutines(org) {
      rec('syncRoutines', org);
      return {};
    },
    async keys() {
      if (o.keys) return o.keys;
      return [
        { name: 'OPENAI_API_KEY', description: 'OpenAI', set: false },
        {
          name: 'GH_TOKEN',
          description: 'GitHub',
          set: true,
          source: 'vault' as const,
          masked: 'gh…12',
        },
        {
          name: 'GITHUB_TOKEN',
          description: 'GitHub (gh reads it when GH_TOKEN is not set)',
          set: false,
        },
        {
          name: 'SHIBAOX_TELEGRAM_TOKEN',
          description: 'Telegram bot (channels.telegram)',
          set: false,
        },
        { name: 'MISTRAL_API_KEY', description: 'Mistral', set: false },
        {
          name: 'HIGGSFIELD_API_KEY',
          description: 'Higgsfield API (open.higgsfield.ai): the id:secret pair as copied',
          set: false,
        },
      ];
    },
    async setKey(name, value) {
      rec('setKey', name, value);
      return { name, set: true as const };
    },
    async unsetKey(name) {
      rec('unsetKey', name);
      return { name, removed: true };
    },
    async orgConfig(root) {
      return {
        root,
        organization: 'wc',
        tiers: { strong: 'anthropic/claude-opus', cheap: 'openai/gpt-5-mini' },
        adapter: 'direct' as const,
        per_run_usd: 3,
      };
    },
    async setOrgConfig(root, patch) {
      rec('setOrgConfig', root, patch);
      return { root, organization: 'wc', tiers: {} };
    },
    async mcpList() {
      return (
        o.mcp ?? [
          {
            id: 'playwright',
            description: 'A browser',
            transport: 'stdio' as const,
            target: 'npx -y @playwright/mcp',
            roles: ['browser-qa'],
            keys: [{ name: 'PW_TOKEN', present: false }],
            server: server({
              transport: 'stdio',
              command: 'npx',
              args: ['-y', '@playwright/mcp'],
              env_keys: ['PW_TOKEN'],
            }),
          },
        ]
      );
    },
    async skills(org) {
      rec('skills', org);
      return o.skills ?? SKILLS;
    },
    async addSkill(org, req) {
      rec('addSkill', org, req);
      const ids =
        req.source === 'inline' || req.source === 'builtin'
          ? [req.id]
          : req.source === 'repo'
            ? (req.ids ?? [])
            : [req.path.split('/').pop() ?? 'x'];
      const skip = o.skip ?? {};
      return {
        added: ids
          .filter((id) => !skip[id])
          .map((id) => ({
            id,
            name: id,
            description: '',
            path: `/o/skills/${id}/SKILL.md`,
            roles: [],
            ...(o.omitted?.[id] ? { omitted: o.omitted[id] } : {}),
          })),
        skipped: ids.filter((id) => skip[id]).map((id) => ({ id, reason: skip[id] as 'exists' })),
      };
    },
    async discoverSkills(repo, path) {
      rec('discoverSkills', repo, path);
      if (repo === 'nope/nope') throw new Error('repository not found');
      if (o.discoverFails && o.discoverFails-- > 0) throw new Error('git clone timed out');
      return { repo, skills: DISCOVER[repo] ?? [] };
    },
    async removeSkill(org, id, detach) {
      rec('removeSkill', org, id, detach);
      if (o.inUse && !detach)
        throw new AppHttpError(409, 'in_use', `skill ${id} is used by ${o.inUse.join(', ')}`, {
          roles: o.inUse,
        });
      return { removed: true as const };
    },
    async skill(org, id) {
      rec('skill', org, id);
      const row = (o.skills ?? SKILLS).find((s) => s.id === id);
      if (!row) throw new AppHttpError(404, 'not_found', `skill ${id} not found`);
      return {
        ...row,
        content: `---\nname: ${row.name}\ndescription: ${row.description}\n---\n\n# ${row.name} guide\n\nFill the form **first**.\n`,
      };
    },
    async roles(org) {
      rec('roles', org);
      return o.roles ?? ROLES;
    },
    async setRoleLinks(org, id, links) {
      rec('setRoleLinks', org, id, links);
      return { id, name: id, tools: [], mcp: links.mcp ?? [], skills: links.skills ?? [] };
    },
    async addMcp(org, req) {
      rec('addMcp', org, req);
      return {} as never;
    },
    async removeMcp(org, id) {
      rec('removeMcp', org, id);
      return { removed: true as const };
    },
    async registryConnectors() {
      return CONNECTORS;
    },
    async registrySkills() {
      return SOURCES;
    },
    async plugins() {
      rec('plugins');
      return o.plugins ?? PLUGINS;
    },
    async mcpTest(id, org) {
      rec('mcpTest', id, org);
      if (o.mcpTestFails) return { ok: false, error: 'spawn npx ENOENT' };
      return { ok: true, tools: [{ name: 'browser_navigate', description: 'Open a page' }] };
    },
    async projectProfile(path) {
      return {
        name: 'sample',
        path,
        git: true,
        branch: 'main',
        stack: ['node'],
        packageManager: 'pnpm',
        testCommand: 'pnpm test',
        files: 12,
        truncated: false,
      } as never;
    },
  };
  for (const name of o.fail ?? [])
    (c as unknown as Record<string, unknown>)[name] = async () => {
      throw new Error(`${name} failed`);
    };
  return { client: c, calls };
}

export const storage = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
};

export const mount = (
  c: StoreClient,
  o: { hash?: string; connected?: boolean; store?: AppStore } = {},
) => {
  window.location.hash = o.hash ?? '';
  const st =
    o.store ?? new AppStore({ client: c, storage: storage(), intervals: { fast: 20, slow: 20 } });
  const s = storage();
  if (o.connected !== false)
    s.setItem('shibaox.connection', JSON.stringify({ base: 'http://d', token: 't' }));
  const ui = render(<App store={st} storage={s} connect={() => c} />);
  return { ...ui, store: st };
};
