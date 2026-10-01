import {
  type McpServer,
  type McpServerInput,
  McpServerSchema,
} from '@wizardingcode/shibaox-schemas';
import { parse } from 'yaml';
import { ORG_TEMPLATE } from '../templates.js';

export const CONNECTOR_CATEGORIES = [
  'Code',
  'Browser',
  'Data',
  'Docs',
  'Design & media',
  'Productivity',
  'Infra',
  'Search',
] as const;
export type ConnectorCategory = (typeof CONNECTOR_CATEGORIES)[number];

/** A key a connector needs (or may use), with where to get one. */
export interface ConnectorKey {
  name: string;
  signupUrl?: string;
  description: string;
  /** The server works without it (a higher rate limit or more tools with it). */
  optional?: boolean;
}

/** A connector of the built-in registry: a ready catalog entry (`server`) with its keys. */
export interface ConnectorTemplate {
  id: string;
  name: string;
  vendor: string;
  /** Run by the vendor itself (an official server). */
  verified: boolean;
  category: ConnectorCategory;
  description: string;
  keys: ConnectorKey[];
  server: McpServer;
  /** Skills of the org that go with it. */
  skills?: string[];
  /** A line for the add dialog ("signs in on first use"). */
  note?: string;
}

type Template = Omit<ConnectorTemplate, 'server'> & { server: McpServerInput };

/** The server of a scaffold catalog file (`org/catalog/<id>.yaml`): one source for both. */
const scaffoldServer = (id: string): McpServerInput =>
  (parse(ORG_TEMPLATE[`org/catalog/${id}.yaml`] as string) as { server: McpServerInput }).server;

const OAUTH = 'Signs in on first use (OAuth in the browser); no key to set.';
const http = (url: string, extra: Partial<McpServerInput> = {}): McpServerInput => ({
  transport: 'http',
  url,
  ...extra,
});
const npx = (pkg: string, ...args: string[]): McpServerInput => ({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', pkg, ...args],
});

const TEMPLATES: Template[] = [
  {
    id: 'higgsfield',
    name: 'Higgsfield',
    vendor: 'Higgsfield',
    verified: true,
    category: 'Design & media',
    description:
      'Images, video, audio and 3D from 40+ models (GPT Image, Seedance, Kling, Veo, Soul…), presets and Marketing Studio.',
    keys: [],
    server: scaffoldServer('higgsfield'),
    skills: ['higgsfield'],
    note: 'Signs in with the Higgsfield CLI (higgsfield auth login): see Plugins → Higgsfield.',
  },
  {
    id: 'playwright',
    name: 'Playwright',
    vendor: 'Microsoft',
    verified: true,
    category: 'Browser',
    description: 'A headless browser: open pages, click, fill forms, read the page, screenshots.',
    keys: [],
    server: scaffoldServer('playwright'),
  },
  {
    id: 'github',
    name: 'GitHub',
    vendor: 'GitHub',
    verified: true,
    category: 'Code',
    description:
      'Repositories, issues, pull requests, Actions and code search through GitHub’s own MCP.',
    keys: [
      {
        name: 'GH_TOKEN',
        signupUrl: 'https://github.com/settings/personal-access-tokens/new',
        description: 'A GitHub personal access token (repo, issues and pull requests scopes)',
      },
    ],
    server: http('https://api.githubcopilot.com/mcp/', {
      headers: { Authorization: 'Bearer ${GH_TOKEN}' },
      env_keys: ['GH_TOKEN'],
    }),
  },
  {
    id: 'context7',
    name: 'Context7',
    vendor: 'Upstash',
    verified: true,
    category: 'Docs',
    description: 'Current, version-specific documentation and code examples for libraries.',
    keys: [
      {
        name: 'CONTEXT7_API_KEY',
        signupUrl: 'https://context7.com/dashboard',
        description:
          'Optional: higher rate limits (add a CONTEXT7_API_KEY: ${CONTEXT7_API_KEY} header)',
        optional: true,
      },
    ],
    server: http('https://mcp.context7.com/mcp'),
  },
  {
    id: 'fetch',
    name: 'Fetch',
    vendor: 'Model Context Protocol',
    verified: true,
    category: 'Search',
    description: 'Fetches a web page and returns it as Markdown.',
    keys: [],
    server: { transport: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] },
    note: 'Needs uv (uvx) on the daemon’s machine.',
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    vendor: 'Model Context Protocol',
    verified: true,
    category: 'Data',
    description: 'Reads and writes files under the directories given as arguments.',
    keys: [],
    server: npx('@modelcontextprotocol/server-filesystem', '.'),
    note: 'Edit the last argument to the directories it may touch.',
  },
  {
    id: 'memory',
    name: 'Memory',
    vendor: 'Model Context Protocol',
    verified: true,
    category: 'Productivity',
    description: 'A knowledge graph the model keeps across conversations (entities, relations).',
    keys: [],
    server: npx('@modelcontextprotocol/server-memory'),
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential thinking',
    vendor: 'Model Context Protocol',
    verified: true,
    category: 'Productivity',
    description: 'A scratchpad for step-by-step reasoning that can branch and revise.',
    keys: [],
    server: npx('@modelcontextprotocol/server-sequential-thinking'),
  },
  {
    id: 'notion',
    name: 'Notion',
    vendor: 'Notion',
    verified: true,
    category: 'Productivity',
    description: 'Search, read and edit Notion pages and databases.',
    keys: [],
    server: http('https://mcp.notion.com/mcp'),
    note: OAUTH,
  },
  {
    id: 'linear',
    name: 'Linear',
    vendor: 'Linear',
    verified: true,
    category: 'Productivity',
    description: 'Issues, projects and comments in Linear.',
    keys: [],
    server: http('https://mcp.linear.app/mcp'),
    note: OAUTH,
  },
  {
    id: 'sentry',
    name: 'Sentry',
    vendor: 'Sentry',
    verified: true,
    category: 'Infra',
    description: 'Errors, issues and releases from Sentry, with stack traces.',
    keys: [],
    server: http('https://mcp.sentry.dev/mcp'),
    note: OAUTH,
  },
  {
    id: 'stripe',
    name: 'Stripe',
    vendor: 'Stripe',
    verified: true,
    category: 'Infra',
    description: 'Customers, payments, products and the Stripe docs.',
    keys: [
      {
        name: 'STRIPE_SECRET_KEY',
        signupUrl: 'https://dashboard.stripe.com/apikeys',
        description: 'A Stripe secret or restricted key (use a test-mode key first)',
      },
    ],
    server: http('https://mcp.stripe.com', {
      headers: { Authorization: 'Bearer ${STRIPE_SECRET_KEY}' },
      env_keys: ['STRIPE_SECRET_KEY'],
    }),
  },
  {
    id: 'supabase',
    name: 'Supabase',
    vendor: 'Supabase',
    verified: true,
    category: 'Data',
    description: 'Supabase projects: tables, SQL, migrations, edge functions, logs.',
    keys: [],
    server: http('https://mcp.supabase.com/mcp'),
    note: OAUTH,
  },
  {
    id: 'cloudflare-docs',
    name: 'Cloudflare docs',
    vendor: 'Cloudflare',
    verified: true,
    category: 'Docs',
    description: 'Searches the Cloudflare developer documentation.',
    keys: [],
    server: http('https://docs.mcp.cloudflare.com/mcp'),
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    vendor: 'Firecrawl',
    verified: true,
    category: 'Search',
    description: 'Scrapes, crawls and searches the web into clean Markdown.',
    keys: [
      {
        name: 'FIRECRAWL_API_KEY',
        signupUrl: 'https://www.firecrawl.dev/app/api-keys',
        description: 'A Firecrawl API key',
      },
    ],
    server: { ...npx('firecrawl-mcp'), env_keys: ['FIRECRAWL_API_KEY'] },
  },
  {
    id: 'exa',
    name: 'Exa',
    vendor: 'Exa',
    verified: true,
    category: 'Search',
    description: 'Web search, code search and page contents built for models.',
    keys: [
      {
        name: 'EXA_API_KEY',
        signupUrl: 'https://dashboard.exa.ai/api-keys',
        description: 'An Exa API key',
      },
    ],
    server: http('https://mcp.exa.ai/mcp', {
      headers: { 'x-api-key': '${EXA_API_KEY}' },
      env_keys: ['EXA_API_KEY'],
    }),
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    vendor: 'Model Context Protocol',
    verified: false,
    category: 'Search',
    description: 'Web and local search through the Brave Search API.',
    keys: [
      {
        name: 'BRAVE_API_KEY',
        signupUrl: 'https://api-dashboard.search.brave.com/app/keys',
        description: 'A Brave Search API key',
      },
    ],
    server: { ...npx('@modelcontextprotocol/server-brave-search'), env_keys: ['BRAVE_API_KEY'] },
  },
  {
    id: 'postgres',
    name: 'Postgres',
    vendor: 'Model Context Protocol',
    verified: false,
    category: 'Data',
    description: 'Read-only SQL against a Postgres database, with its schema.',
    keys: [],
    server: npx('@modelcontextprotocol/server-postgres', 'postgresql://localhost:5432/postgres'),
    note: 'The connection URL is the last argument: edit it (it is not read from the vault).',
  },
  {
    id: 'figma',
    name: 'Figma',
    vendor: 'Figma',
    verified: true,
    category: 'Design & media',
    description: 'Frames, components, variables and code hints from Figma files.',
    keys: [],
    server: http('https://mcp.figma.com/mcp'),
    note: OAUTH,
  },
  {
    id: 'vercel',
    name: 'Vercel',
    vendor: 'Vercel',
    verified: true,
    category: 'Infra',
    description: 'Projects, deployments, logs and the Vercel docs.',
    keys: [],
    server: http('https://mcp.vercel.com'),
    note: OAUTH,
  },
  {
    id: 'slack',
    name: 'Slack',
    vendor: 'Model Context Protocol',
    verified: false,
    category: 'Productivity',
    description: 'Channels, messages, threads and reactions in a Slack workspace.',
    keys: [
      {
        name: 'SLACK_BOT_TOKEN',
        signupUrl: 'https://api.slack.com/apps',
        description: 'A Slack bot token (xoxb-…) of an app installed in the workspace',
      },
      {
        name: 'SLACK_TEAM_ID',
        signupUrl: 'https://api.slack.com/apps',
        description: 'The workspace id (T…)',
      },
    ],
    server: {
      ...npx('@modelcontextprotocol/server-slack'),
      env_keys: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
    },
  },
];

/** The built-in connector registry, every server with its defaults applied. */
export function connectorRegistry(): ConnectorTemplate[] {
  return TEMPLATES.map((t) => ({ ...t, server: McpServerSchema.parse(t.server) }));
}
