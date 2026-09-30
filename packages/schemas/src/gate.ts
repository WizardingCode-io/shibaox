import { z } from 'zod';
import { Id } from './common.js';

const base = { name: Id };
export const CheckSchema = z.discriminatedUnion('type', [
  z.object({
    ...base,
    type: z.literal('code'),
    command: z.string().min(1),
    timeout_ms: z.number().int().positive().default(300_000),
    /** When the program is not installed (exit 127, "not found"), pass with a note instead of failing. */
    skip_if_missing: z.boolean().default(false),
  }),
  /** Runs the project's type checker, detected in the workspace (shibaox.yaml typecheck, a typecheck script, tsc, mypy/pyright, go build, phpstan), or `command`; none, or one not installed, passes with a note. */
  z.object({
    ...base,
    type: z.literal('typecheck'),
    command: z.string().min(1).optional(),
    timeout_ms: z.number().int().positive().default(300_000),
  }),
  /** Runs the project's own test runner, detected in the workspace (npm/pnpm/yarn/bun test, pytest, go test, cargo test, make test, phpunit, rspec). */
  z.object({
    ...base,
    type: z.literal('tests'),
    timeout_ms: z.number().int().positive().default(300_000),
  }),
  /** Runs the project's linter, detected in the workspace (lint script, biome, eslint, ruff, phpstan, golangci-lint/go vet, clippy, make lint), or `command`. */
  z.object({
    ...base,
    type: z.literal('lint'),
    command: z.string().min(1).optional(),
    timeout_ms: z.number().int().positive().default(300_000),
  }),
  /** A code review by the judge model, criterion by criterion (the built-in rubric when none is given). */
  z.object({
    ...base,
    type: z.literal('review'),
    criteria: z.array(z.string().min(1)).min(1).optional(),
  }),
  z.object({
    ...base,
    type: z.literal('jev'),
    question: z.string().min(1),
    kind: z.enum(['noul', 'score']).default('noul'),
    threshold: z.number().min(0).max(1).default(0.8),
  }),
  /** Waits for the pull request's checks (`gh pr checks`) and passes when they all passed. */
  z.object({
    ...base,
    type: z.literal('ci'),
    timeout_ms: z.number().int().positive().default(1_800_000),
    /** How often the checks are asked about while some are pending. */
    interval_ms: z.number().int().positive().default(30_000),
    /** How long to wait for checks to appear after a push before passing with a note. */
    grace_ms: z.number().int().nonnegative().default(120_000),
  }),
  z.object({ ...base, type: z.literal('judge'), role: Id, rubric: z.string().min(1) }),
  z.object({ ...base, type: z.literal('human'), prompt: z.string().min(1) }),
  z.object({
    ...base,
    type: z.literal('mock'),
    passes: z.boolean(),
    evidence: z.string().default('mock check'),
  }),
]);
export type Check = z.infer<typeof CheckSchema>;

export const GateSchema = z.object({
  gate: Id,
  description: z.string().optional(),
  checks: z.array(CheckSchema).min(1),
});
export type Gate = z.infer<typeof GateSchema>;
