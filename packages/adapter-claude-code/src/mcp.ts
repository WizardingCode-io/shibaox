import {
  createSdkMcpServer,
  type McpHttpServerConfig,
  type McpSdkServerConfigWithInstance,
  type McpStdioServerConfig,
  type SdkMcpToolDefinition,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentTool, McpServerSpec } from '@wizardingcode/shibaox-core';

/** The MCP tool definitions of a set of daemon tools: results and errors travel as JSON text. */
export function mcpToolDefinitions(tools: AgentTool[]): SdkMcpToolDefinition[] {
  return tools.map(
    (t) =>
      // zod's readonly shape is what the SDK expects at runtime; the generic disagrees on readonly
      tool(t.name, t.description, t.input.shape as never, async (args: unknown) => {
        try {
          const result = await t.execute(args as Record<string, unknown>);
          return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          return { content: [{ type: 'text', text: JSON.stringify({ error }) }], isError: true };
        }
      }) as unknown as SdkMcpToolDefinition,
  );
}

/** An in-process MCP server (no subprocess) exposing the daemon's tools to Claude Code. */
export function sdkMcpServer(name: string, tools: AgentTool[]): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name, tools: mcpToolDefinitions(tools), alwaysLoad: true });
}

/** The SDK configs of the role's catalog servers: a process on stdio, or an http endpoint. */
export function mcpServerConfigs(
  specs: readonly McpServerSpec[],
): Record<string, McpStdioServerConfig | McpHttpServerConfig> {
  const out: Record<string, McpStdioServerConfig | McpHttpServerConfig> = {};
  for (const s of specs)
    out[s.id] =
      s.transport === 'stdio'
        ? { type: 'stdio', command: s.command ?? '', args: s.args ?? [], env: s.env }
        : { type: 'http', url: s.url ?? '', headers: s.headers ?? {} };
  return out;
}

/** Allow rules for those servers: every tool, or only the allowlisted ones. */
export function mcpAllowRules(specs: readonly McpServerSpec[]): string[] {
  return specs.flatMap((s) =>
    s.tools ? s.tools.map((t) => `mcp__${s.id}__${t}`) : [`mcp__${s.id}__*`],
  );
}
