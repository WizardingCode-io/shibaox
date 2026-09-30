import { z } from 'zod';
import { Id } from './common.js';

/** What wakes a routine up. */
export const RoutineTriggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('cron'), cron: z.string().min(1) }),
  z.object({
    type: z.literal('github'),
    watch: z.enum(['issues', 'prs', 'checks']),
    /** `owner/name`; the project's `origin` remote when absent. */
    repo: z.string().optional(),
    /** issues/prs: only those with this label. */
    label: z.string().optional(),
    /** checks: the branch whose workflow runs are watched (default: the repository's default branch). */
    branch: z.string().optional(),
  }),
  z.object({ type: z.literal('url'), url: z.string().url() }),
  z.object({ type: z.literal('file'), path: z.string().min(1) }),
  z.object({ type: z.literal('command'), command: z.string().min(1) }),
]);
export type RoutineTrigger = z.infer<typeof RoutineTriggerSchema>;

/** The `on:` block of a routine file: exactly one trigger, written the short way. */
const OnSchema = z
  .object({
    cron: z.string().min(1).optional(),
    github: z.enum(['issues', 'prs', 'checks']).optional(),
    repo: z.string().optional(),
    label: z.string().optional(),
    branch: z.string().optional(),
    url: z.string().url().optional(),
    file: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
  })
  .transform((on, ctx): RoutineTrigger => {
    const kinds = (['cron', 'github', 'url', 'file', 'command'] as const).filter(
      (k) => on[k] !== undefined,
    );
    if (kinds.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'on: needs exactly one of cron, github, url, file, command',
      });
      return z.NEVER;
    }
    switch (kinds[0]) {
      case 'cron':
        return { type: 'cron', cron: on.cron as string };
      case 'github':
        return {
          type: 'github',
          watch: on.github as 'issues' | 'prs' | 'checks',
          ...(on.repo ? { repo: on.repo } : {}),
          ...(on.label ? { label: on.label } : {}),
          ...(on.branch ? { branch: on.branch } : {}),
        };
      case 'url':
        return { type: 'url', url: on.url as string };
      case 'file':
        return { type: 'file', path: on.file as string };
      default:
        return { type: 'command', command: on.command as string };
    }
  });

/** `org/routines/<id>.yaml`: a routine as code. Paths are relative to the org directory. */
export const RoutineFileSchema = z
  .object({
    routine: Id,
    name: z.string().optional(),
    on: OnSchema,
    workflow: Id,
    input: z.string().default(''),
    /** The project the run works on, relative to the org directory (default: the org's parent). */
    project: z.string().optional(),
    adapter: z.enum(['mock', 'direct', 'claude-code']).optional(),
    budget_usd: z.number().positive().optional(),
    /** Spend across this routine's runs in a day beyond which it stops firing until tomorrow. */
    max_daily_usd: z.number().positive().optional(),
    /** `on_change` (watchers: fire when what they see changes) or `always` (every occurrence). */
    mode: z.enum(['always', 'on_change']).optional(),
    /** Seconds between looks for watchers (default 120; cron ignores it). */
    every: z.number().int().positive().default(120),
    enabled: z.boolean().default(true),
  })
  .transform((r) => ({
    ...r,
    mode: r.mode ?? (r.on.type === 'cron' ? ('always' as const) : ('on_change' as const)),
  }));
export type RoutineFile = z.infer<typeof RoutineFileSchema>;
