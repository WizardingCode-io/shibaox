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

/** `${KEY}`: a vault key expanded in a header value. */
const key = (name: string) => `\${${name}}`;

const OAUTH =
  'Signs in with OAuth through the Claude Code runtime; the direct runtime cannot sign in yet';
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
    note: 'Two modes (Plugins → Higgsfield): the account signs in with the Higgsfield CLI (higgsfield auth login) and this server; with an API key from open.higgsfield.ai the daemon calls the API itself and this server stays off.',
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
      headers: { Authorization: `Bearer ${key('GH_TOKEN')}` },
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
        description: `Optional: higher rate limits (add a CONTEXT7_API_KEY: ${key('CONTEXT7_API_KEY')} header)`,
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
    server: npx('@modelcontextprotocol/server-filesystem', '/path/to/allow'),
    note: 'Replace /path/to/allow with the directories it may touch (one argument each) before adding.',
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
      headers: { Authorization: `Bearer ${key('STRIPE_SECRET_KEY')}` },
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
        optional: true,
      },
    ],
    server: http('https://mcp.exa.ai/mcp'),
    note: 'Works without a key at lower limits; to use yours, put ?exaApiKey=… in the URL when adding.',
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    vendor: 'Brave',
    verified: true,
    category: 'Search',
    description: 'Web and local search through the Brave Search API.',
    keys: [
      {
        name: 'BRAVE_API_KEY',
        signupUrl: 'https://api-dashboard.search.brave.com/app/keys',
        description: 'A Brave Search API key',
      },
    ],
    server: { ...npx('@brave/brave-search-mcp-server'), env_keys: ['BRAVE_API_KEY'] },
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
];

/** The built-in connector registry, every server with its defaults applied. */
export function connectorRegistry(): ConnectorTemplate[] {
  return TEMPLATES.map((t) => ({ ...t, server: McpServerSchema.parse(t.server) }));
}
