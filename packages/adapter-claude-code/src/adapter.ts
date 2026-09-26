import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Options, query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  Capability,
  ExecutionContext,
  HumanHandler,
  RuntimeAdapter,
  RuntimeEvent,
  TaskJob,
} from '@shibaox/core';
import { describeError } from '@shibaox/providers';
import { buildCanUseTool, type ToolCategory } from './permissions.js';
import { mapRoleTools } from './tools-map.js';

export type QueryFn = (args: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;
export type McpServers = NonNullable<Options['mcpServers']>;

export interface ClaudeCodeAdapterOptions {
  human: HumanHandler;
  /** Org directory; role `system_prompt` paths resolve against it. */
  orgRoot?: string;
  model?: (job: TaskJob) => string | undefined;
  mcpServers?: (job: TaskJob) => McpServers;
  /** Default 60. */
  maxTurns?: number;
  /** Injectable for tests; defaults to the SDK's `query`. */
  queryFn?: QueryFn;
  /** Extra env for the Claude Code process, merged over `process.env`. */
  env?: Record<string, string>;
}

const RULES =
  'You are running as an autonomous worker inside shibaox. Work only inside the current working directory. Do not push, deploy or publish unless the tool call is explicitly approved. When done, summarise what you changed.';
const FILE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

/** Runs tasks through Claude Code via the Claude Agent SDK. */
export class ClaudeCodeAdapter implements RuntimeAdapter {
  readonly id = 'claude-code';
  private readonly queryFn: QueryFn;

  constructor(private readonly opts: ClaudeCodeAdapterOptions) {
    this.queryFn = opts.queryFn ?? (query as unknown as QueryFn);
  }

  capabilities(): Capability[] {
    return ['write-code', 'run-tests', 'shell'];
  }

  private rolePrompt(job: TaskJob): string {
    let prompt = job.role.description ?? `You are the ${job.role.role}.`;
    if (job.role.system_prompt && this.opts.orgRoot) {
      const p = join(this.opts.orgRoot, job.role.system_prompt);
      if (existsSync(p)) prompt = readFileSync(p, 'utf8');
    }
    return `${prompt}\n\n${RULES}`;
  }

  async *run(job: TaskJob, ctx: ExecutionContext): AsyncIterable<RuntimeEvent> {
    yield { type: 'started' };
    const abort = new AbortController();
    const onAbort = () => abort.abort(new Error('aborted'));
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener('abort', onAbort, { once: true });
    let deferred: Exclude<ToolCategory, 'other'> | undefined;
    const pending = () =>
      `approval pending for ${deferred}: run is waiting for a human (task ${job.nodeId} cannot continue until approvals are persisted)`;

    const { allowedTools, disallowedTools, askTools } = mapRoleTools(job.role);
    const mcpServers = this.opts.mcpServers?.(job) ?? {};
    const options: Options = {
      systemPrompt: { type: 'preset', preset: 'claude_code', append: this.rolePrompt(job) },
      cwd: job.workspace,
      model: this.opts.model?.(job),
      allowedTools: [...allowedTools, ...Object.keys(mcpServers).map((n) => `mcp__${n}__*`)],
      disallowedTools,
      permissionMode: 'default',
      // Flag-level settings still apply with settingSources: []; ask rules route gated commands to canUseTool.
      settings: { permissions: { ask: askTools } },
      canUseTool: buildCanUseTool({
        role: job.role,
        human: this.opts.human,
        runId: job.runId,
        nodeId: job.nodeId,
        log: ctx.log,
        onDeferred: (c) => {
          deferred = c;
        },
      }),
      maxTurns: this.opts.maxTurns ?? 60,
      maxBudgetUsd: job.budgetRemainingUsd,
      mcpServers,
      settingSources: [],
      outputFormat: job.outputSchema
        ? { type: 'json_schema', schema: job.outputSchema }
        : undefined,
      abortController: abort,
      // Options.env REPLACES the subprocess env, so inherit process.env explicitly.
      env: this.opts.env ? { ...process.env, ...this.opts.env } : undefined,
    };
    const prompt = [
      `Task: ${job.instruction}`,
      `Input: ${JSON.stringify(job.input)}`,
      `Previous outputs: ${JSON.stringify(job.context.previousOutputs).slice(0, 60_000)}`,
      `Last gate report: ${JSON.stringify(job.context.lastGateReport ?? null).slice(0, 20_000)}`,
    ].join('\n\n');

    const toolNames = new Map<string, string>();
    try {
      for await (const m of this.queryFn({ prompt, options })) {
        if (m.type === 'system' && m.subtype === 'init') {
          const mcp = m.mcp_servers.map((s) => `${s.name}:${s.status}`).join(',');
          yield {
            type: 'text',
            text: `claude-code ready: model=${m.model} tools=${m.tools.length} mcp=${mcp || 'none'}`,
          };
          for (const s of m.mcp_servers)
            if (s.status === 'failed' || s.status === 'needs-auth')
              ctx.log(`[claude-code] warning: MCP server ${s.name} ${s.status}`);
        } else if (m.type === 'assistant') {
          for (const block of m.message.content) {
            if (block.type === 'text') yield { type: 'text', text: block.text };
            else if (block.type === 'tool_use') {
              toolNames.set(block.id, block.name);
              yield { type: 'tool_use', name: block.name, input: block.input };
              const fp = (block.input as { file_path?: unknown } | null)?.file_path;
              if (typeof fp === 'string' && FILE_TOOLS.includes(block.name))
                yield { type: 'file_changed', path: fp };
            }
          }
        } else if (m.type === 'user') {
          const content = m.message.content;
          if (Array.isArray(content))
            for (const block of content)
              if (block.type === 'tool_result')
                yield {
                  type: 'tool_result',
                  name: toolNames.get(block.tool_use_id) ?? 'unknown',
                  output: block.content,
                };
        } else if (m.type === 'result') {
          const cost = {
            usd: m.total_cost_usd,
            inputTokens: m.usage.input_tokens,
            outputTokens: m.usage.output_tokens,
          };
          if (deferred) yield { type: 'error', message: pending(), cost };
          else if (m.subtype === 'success')
            yield {
              type: 'result',
              output: m.structured_output ?? { text: m.result },
              summary: m.result.slice(0, 200),
              cost,
            };
          else {
            const denied = m.permission_denials.map((d) => d.tool_name);
            const denials = denied.length
              ? ` (${denied.length} permission denials: ${[...new Set(denied)].join(', ')})`
              : '';
            yield { type: 'error', message: `claude-code ended with ${m.subtype}${denials}`, cost };
          }
          return;
        }
      }
      yield {
        type: 'error',
        message: deferred ? pending() : 'claude-code ended without a result',
      };
    } catch (e) {
      yield {
        type: 'error',
        message: abort.signal.aborted ? 'aborted' : deferred ? pending() : describeError(e),
      };
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
    }
  }
}
