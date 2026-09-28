import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentTool } from '@wizardingcode/shibaox-core';

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
