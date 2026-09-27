import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Options, query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  type AgentTool,
  type ApprovalHandler,
  type Capability,
  conversationOf,
  type ExecutionContext,
  type RuntimeAdapter,
  type RuntimeEvent,
  type TaskJob,
} from '@shibaox/core';
import { describeError } from '@shibaox/providers';
import type { ApprovalCategory } from './bash-command.js';
import { sdkMcpServer } from './mcp.js';
import { buildCanUseTool } from './permissions.js';
import { mapRoleTools } from './tools-map.js';

export type QueryFn = (args: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;
export type McpServers = NonNullable<Options['mcpServers']>;

export interface ClaudeCodeAdapterOptions {
  /** Answers push/deploy approvals; `canUseTool` blocks on it. */
  approvals: ApprovalHandler;
  /** Org directory; role `system_prompt` paths resolve against it. */
  orgRoot?: string;
  model?: (job: TaskJob) => string | undefined;
  /**
   * The job's full model ref (`<provider>/<model>`). For `anthropic-subscription/...` the
   * subprocess gets no `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`, so Claude Code uses the
   * `claude` login instead of billing the API key.
   */
  modelRef?: (job: TaskJob) => string | undefined;
  mcpServers?: (job: TaskJob) => McpServers;
  /** Default 60. */
  maxTurns?: number;
  /** Injectable for tests; defaults to the SDK's `query`. */
  queryFn?: QueryFn;
  /** Extra env for the Claude Code process (static or per job), merged over the minimal inherited env. */
  env?: Record<string, string> | ((job: TaskJob) => Record<string, string>);
  /** Tools the daemon adds for this job (orchestration, memory), served in-process as MCP `shibaox`. */
  extraTools?: (job: TaskJob) => AgentTool[];
  /** Context appended to the role prompt (project profile, memory). */
  preamble?: (job: TaskJob) => string | undefined;
}

const RULES =
  'You are running as an autonomous worker inside shibaox. Work only inside the current working directory. Do not push, deploy or publish unless the tool call is explicitly approved. When done, summarise what you changed.';
const ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'TERM',
  'CLAUDE_CONFIG_DIR',
  'SSH_AUTH_SOCK',
];
const ENV_PREFIXES = ['LC_', 'ANTHROPIC_', 'CLAUDE_CODE_'];
/** Credentials that make Claude Code bill the API instead of the subscription login. */
export const API_KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
export const isSubscriptionRef = (ref: string | undefined): boolean =>
  ref?.startsWith('anthropic-subscription/') ?? false;

/**
 * The subprocess env. The SDK's `env` replaces the whole environment, so only what Claude Code
 * needs is inherited: other secrets in the shibaox process (provider keys, tokens) stay out.
 * With `subscription`, the API credentials are removed (also from `extra`).
 */
export function buildSubprocessEnv(
  extra: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
  opts: { subscription?: boolean } = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(source))
    if (v !== undefined && (ENV_KEYS.includes(k) || ENV_PREFIXES.some((p) => k.startsWith(p))))
      env[k] = v;
  const out: Record<string, string> = { ...env, CLAUDE_AGENT_SDK_CLIENT_APP: 'shibaox', ...extra };
  if (opts.subscription) for (const k of API_KEY_VARS) delete out[k];
  return out;
}

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
    const preamble = this.opts.preamble?.(job);
    return `${prompt}\n\n${RULES}${preamble ? `\n\n${preamble}` : ''}`;
  }

  async *run(job: TaskJob, ctx: ExecutionContext): AsyncIterable<RuntimeEvent> {
    yield { type: 'started' };
    if (ctx.signal.aborted) {
      yield { type: 'error', message: 'aborted' };
      return;
    }
    const abort = new AbortController();
    const onAbort = () => abort.abort(new Error('aborted'));
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    let deferred: { category: ApprovalCategory; approvalId: string } | undefined;
    const pending = (): RuntimeEvent & { type: 'error' } => ({
      type: 'error',
      message: `approval pending for ${deferred?.category}: task ${job.nodeId} waits for the inbox`,
      reason: 'approval_pending',
      approvalId: deferred?.approvalId,
    });

    const { allowedTools, disallowedTools } = mapRoleTools(job.role);
    const extra = this.opts.extraTools?.(job) ?? [];
    const mcpServers: McpServers = {
      ...this.opts.mcpServers?.(job),
      ...(extra.length > 0 ? { shibaox: sdkMcpServer('shibaox', extra) } : {}),
    };
    const roleBudget = job.role.budget_usd;
    const maxBudgetUsd =
      roleBudget === undefined
        ? job.budgetRemainingUsd
        : job.budgetRemainingUsd === undefined
          ? roleBudget
          : Math.min(roleBudget, job.budgetRemainingUsd);
    const options: Options = {
      systemPrompt: { type: 'preset', preset: 'claude_code', append: this.rolePrompt(job) },
      cwd: job.workspace,
      model: this.opts.model?.(job),
      allowedTools: [...allowedTools, ...Object.keys(mcpServers).map((n) => `mcp__${n}__*`)],
      disallowedTools,
      permissionMode: 'default',
      canUseTool: buildCanUseTool({
        role: job.role,
        cwd: job.workspace,
        approvals: this.opts.approvals,
        runId: job.runId,
        nodeId: job.nodeId,
        log: ctx.log,
        approvedCommands: job.approvedCommands,
        onDeferred: (category, approvalId) => {
          deferred = { category, approvalId };
        },
      }),
      maxTurns: job.role.max_turns ?? this.opts.maxTurns ?? 60,
      maxBudgetUsd,
      mcpServers,
      settingSources: [],
      outputFormat: job.outputSchema
        ? { type: 'json_schema', schema: job.outputSchema }
        : undefined,
      abortController: abort,
      resume: job.resumeSessionId,
      env: buildSubprocessEnv(
        typeof this.opts.env === 'function' ? this.opts.env(job) : this.opts.env,
        process.env,
        { subscription: isSubscriptionRef(this.opts.modelRef?.(job)) },
      ),
    };
    // the conversation is transcribed ahead of the task; it never travels inside the input JSON
    const { messages: _messages, ...input } = job.input;
    const conversation = conversationOf(job.input);
    const transcript =
      conversation.length > 0
        ? [
            'Conversation so far:',
            ...conversation.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`),
          ].join('\n')
        : undefined;
    // a resumed session already has the task: it only needs to know what was decided
    const prompt =
      job.resumeSessionId !== undefined
        ? (job.resumeNote ?? 'Continue the task.')
        : [
            ...(transcript ? [transcript] : []),
            `Task: ${job.instruction}`,
            `Input: ${JSON.stringify(input)}`,
            `Previous outputs: ${JSON.stringify(job.context.previousOutputs).slice(0, 60_000)}`,
            `Last gate report: ${JSON.stringify(job.context.lastGateReport ?? null).slice(0, 20_000)}`,
            ...(job.resumeNote ? [job.resumeNote] : []),
          ].join('\n\n');

    const toolNames = new Map<string, string>();
    const toolStarted = new Map<string, number>();
    try {
      for await (const m of this.queryFn({ prompt, options })) {
        if (m.type === 'system' && m.subtype === 'init') {
          if (m.session_id)
            yield { type: 'session', runtime: 'claude-code', sessionId: m.session_id };
          const mcp = m.mcp_servers.map((s) => `${s.name}:${s.status}`).join(',');
          // runtime details belong to the log, not to the conversation the user reads
          ctx.log(
            `[claude-code] ready: model=${m.model} apiKeySource=${m.apiKeySource} tools=${m.tools.length} mcp=${mcp || 'none'}`,
          );
          for (const s of m.mcp_servers)
            if (s.status === 'failed' || s.status === 'needs-auth')
              ctx.log(`[claude-code] warning: MCP server ${s.name} ${s.status}`);
        } else if (m.type === 'assistant') {
          const parentToolUseId = m.parent_tool_use_id ?? undefined;
          for (const block of m.message.content) {
            if (block.type === 'text') yield { type: 'text', text: block.text, parentToolUseId };
            else if (block.type === 'tool_use') {
              toolNames.set(block.id, block.name);
              toolStarted.set(block.id, Date.now());
              yield {
                type: 'tool_use',
                id: block.id,
                name: block.name,
                input: block.input,
                parentToolUseId,
              };
              const fp = (block.input as { file_path?: unknown } | null)?.file_path;
              if (typeof fp === 'string' && FILE_TOOLS.includes(block.name))
                yield { type: 'file_changed', path: fp };
            }
          }
        } else if (m.type === 'user') {
          const content = m.message.content;
          const parentToolUseId = m.parent_tool_use_id ?? undefined;
          if (Array.isArray(content))
            for (const block of content)
              if (block.type === 'tool_result') {
                const started = toolStarted.get(block.tool_use_id);
                yield {
                  type: 'tool_result',
                  id: block.tool_use_id,
                  name: toolNames.get(block.tool_use_id) ?? 'unknown',
                  output: block.content,
                  durationMs: started === undefined ? undefined : Date.now() - started,
                  parentToolUseId,
                };
              }
        } else if (m.type === 'result') {
          const cost = {
            usd: m.total_cost_usd,
            inputTokens: m.usage.input_tokens,
            outputTokens: m.usage.output_tokens,
          };
          if (deferred) yield { ...pending(), cost };
          else if (m.subtype === 'error_max_budget_usd')
            // the run budget is spent: the engine pauses the run (resume --budget) instead of failing
            yield {
              type: 'error',
              message: 'claude-code stopped at the run budget (error_max_budget_usd)',
              reason: 'budget_exceeded',
              cost,
            };
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
      if (deferred) yield pending();
      else yield { type: 'error', message: 'claude-code ended without a result' };
    } catch (e) {
      if (deferred) yield pending();
      else yield { type: 'error', message: abort.signal.aborted ? 'aborted' : describeError(e) };
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
    }
  }
}
