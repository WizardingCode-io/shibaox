import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  detectLintCommand,
  detectSetupCommand,
  detectTestCommand,
  detectTypecheckCommand,
  type Stack,
} from '@wizardingcode/shibaox-core';

export const ORG_TEMPLATE: Record<string, string> = {
  'org/.gitignore': '.shibaox/\n',
  'org/org.yaml': `organization: my-org
budgets:
  per_run_usd: 5
teams: [engineering]
# Runtime adapter for task nodes: mock (default, no model calls), direct (real models,
# see models.yaml) or claude-code (Claude Code for anthropic-subscription/... roles, direct
# for the rest). \`shibaox run --adapter\` overrides it.
# adapter: direct
# Obsidian vault for run and decision notes (relative to this directory).
vault: ../vault
`,
  'org/models.yaml': `# Model refs are <provider>/<model>; see \`shibaox providers list\` for the catalog.
# anthropic/... uses ANTHROPIC_API_KEY. With a Claude subscription instead of an API key,
# use anthropic-subscription/<model> (e.g. anthropic-subscription/claude-sonnet-5): it runs
# through the Claude Code runtime (adapter: claude-code), not through the direct adapter.
# Local models: ollama/<model> (Ollama on :11434) or lmstudio/<model> (LM Studio on :1234).
providers: {}
tiers:
  strong: anthropic/claude-sonnet-5
  cheap: ollama/llama3.2
  # decisions (decide nodes) and judge checks: a model ref runs them on that model through
  # its provider (e.g. openrouter/typesafe/jev-router); jev-latest uses TypeSafe's typed API
  # and needs TYPESAFE_API_KEY (without it, decisions fall back to the strong tier)
  decision: jev-latest
roles: {}
gates: {}
`,
  'org/teams/engineering.yaml': `team: engineering
lead: team-leader
roles: [team-leader, analyst, backend]
gates: [tests]
workflows: [hello-feature, land-feature, fix-issue, review-pr]
`,
  'org/roles/team-leader.yaml': `role: team-leader
description: Judges readiness, approves or sends back.
model_tier: strong
system_prompt: prompts/team-leader.md
`,
  'org/roles/assistant.yaml': `role: assistant
description: The orchestrator you talk to; it answers, acts, and dispatches the teams.
model_tier: cheap
capabilities: [orchestrate, memory]
tools: [read, write, git, node, npm, pnpm, bun, python3]
permissions:
  network: ['*']
  approval_required: [push, deploy, execute]   # execute: inline code (python3 -c, node -e) and npx of a package not installed ask first
max_steps: 40
max_turns: 80
system_prompt: prompts/assistant.md
`,
  'org/prompts/assistant.md': `# Orchestrator
You are the orchestrator of this organisation, talking with its owner inside shibaox (you
are shibaox's orchestrator, not "Claude Code"; never introduce yourself as another product).
Answer in the language the user writes in. Be direct; two or three lines unless asked for more.

Act. When the user asks for something, do it with your tools: read and write files in the
workspace, run the listed programs, fetch pages. Small work (a script, a fix, an answer, a
document) you do yourself, now. Larger work (a feature with tests, several parts, a review of
the whole codebase) you dispatch with \`start_workflow\` to the right workflow and tell the
user what you started; the run shows up in this same conversation. Never say you do not
implement changes.

A request for a file, a script, a document or data (a CSV, a JSON) is answered by creating
it in the workspace with \`write_file\` and saying where it is; the code you show in the reply
is for reading, the file is the deliverable.

Remember what matters with \`remember\` (user preferences → scope \`user\`, project decisions →
scope \`project\`) and look things up with \`recall\` before asking again.

Messages that start with \`[event]\` come from shibaox, not from the user: a dispatched run
finished or needs something. Summarise the outcome for the user in one or two lines.

Pushing, deploying and publishing are only done through approved tool calls.
`,
  'org/workflows/chat.yaml': `workflow: chat
description: Talk with the orchestrator; the default entry of the dashboard.
conversation: true
start: reply
nodes:
  reply: { type: task, role: assistant, instruction: "Reply to the user." }
`,
  'org/roles/analyst.yaml': `role: analyst
description: Reads the request and lists files and risks.
model_tier: cheap
tools: [read]
system_prompt: prompts/analyst.md
`,
  'org/roles/backend.yaml': `role: backend
description: Implements the change with tests.
model_tier: strong
tools: [read, write, git, node, npm, pnpm]
permissions:
  approval_required: [push, deploy]   # also: execute (sh -c, node -e, npx of a package not installed), network (curl outside permissions.network), protected (files under permissions.protected / shibaox.yaml protected)
system_prompt: prompts/backend.md
`,
  'org/roles/reviewer.yaml': `role: reviewer
description: Reads a pull request and writes a review; publishes nothing itself.
model_tier: strong
tools: [read, gh]
permissions:
  approval_required: [push, deploy]
system_prompt: prompts/reviewer.md
`,
  'org/prompts/reviewer.md': `# Reviewer
You review pull requests. Read the diff (\`gh pr diff <n>\`, \`gh pr view <n>\`) and the files it
touches. Write the whole review as Markdown in your final text (not a one-line summary): what
is wrong first (with file and line), then what is risky, then what is fine. Say whether it can
merge. You never merge, push or comment yourself: the workflow publishes your text after a
person approves it (gh pr review and gh pr comment ask for an approval you will not get).
`,
  'org/gates/ci.yaml': `gate: ci
checks:
  # waits for the pull request's checks on GitHub (gh pr checks) and passes when they all passed;
  # a run without a pull request passes with a note
  - { name: github-checks, type: ci, timeout_ms: 1800000, interval_ms: 30000 }
`,
  'org/workflows/fix-issue.yaml': `workflow: fix-issue
team: engineering
description: From an issue (shibaox run fix-issue --issue N) to a merged pull request, with CI and your approval in between.
start: analyse
nodes:
  analyse:   { type: task, role: analyst, instruction: "Analyse the issue and list the files to touch.", next: implement }
  implement: { type: task, role: backend, instruction: "Fix the issue. Keep tests green. Reference the issue in the commit.", next: qa }
  qa:        { type: gate, gates: [tests], on_pass: commit, on_fail: implement, max_retries: 2 }
  commit:    { type: git, action: commit, next: pr }
  pr:        { type: git, action: pr, next: checks }
  checks:    { type: gate, gates: [ci], on_pass: approve, on_fail: implement, max_retries: 1 }
  approve:   { type: human, action: approve-merge, prompt: "The checks passed. Merge the pull request?", next: land }
  land:      { type: git, action: merge_pr, method: squash }
`,
  'org/workflows/review-pr.yaml': `workflow: review-pr
team: engineering
team_gates: false   # a review publishes text: the team's test gate would be beside the point
description: Review a pull request (shibaox run review-pr --input "#13") and publish the review once you approve it.
start: review
nodes:
  review:  { type: task, role: reviewer, instruction: "Review the pull request named in the request (#N). Read its diff and the touched files; write the review.", next: approve }
  approve: { type: human, action: approve-review, prompt: "Publish this review on the pull request?", next: publish }
  publish: { type: git, action: review, from: review, event: comment }
`,
  'org/gates/tests.yaml': `gate: tests
checks:
  - { name: unit-tests, type: tests, timeout_ms: 120000 }   # runs the project's own test runner (npm/pnpm/yarn/bun, pytest, go, cargo, make…); passes with a note when there is none
  # - { name: spec, type: jev, question: "The outputs implement the request", threshold: 0.8 }   # uncomment when TYPESAFE_API_KEY is set
`,
  'org/gates/lint.yaml': `gate: lint
checks:
  - { name: lint, type: lint, timeout_ms: 120000 }   # the project's linter (scripts.lint, biome, eslint, ruff, phpstan, golangci-lint/go vet, clippy, make lint); passes with a note when there is none
  # - { name: style, type: lint, command: "pnpm biome check ." }   # a fixed command instead
`,
  'org/gates/review.yaml': `gate: review
checks:
  # a code review by the judge model (models.gates.judge, else decision, else strong), criterion by criterion;
  # without \`criteria\` the built-in rubric applies: scope, correctness, tests, hygiene, clarity
  - { name: review, type: review }
  # - { name: review, type: review, criteria: ["No TODOs left in the diff", "Public functions have doc comments"] }
`,
  'org/workflows/hello-feature.yaml': `workflow: hello-feature
team: engineering
description: Analyse, implement, test, judge, ship.
start: analyse
nodes:
  analyse:   { type: task, role: analyst, instruction: "Analyse the request and list the files to touch.", next: implement }
  implement: { type: task, role: backend, instruction: "Implement the request. Keep tests green.", next: qa }
  qa:        { type: gate, gates: [tests], on_pass: judge, on_fail: implement, max_retries: 2 }
  judge:     { type: decide, by: team-leader, question: "Is the work ready to ship?", options: [ship, rework], next: { ship: ship, rework: implement } }
  ship:      { type: human, action: approve-push, prompt: "Approve the push?" }
`,
  'org/workflows/land-feature.yaml': `workflow: land-feature
team: engineering
description: Analyse, implement, test, judge, approve, commit and land on the base branch (pushed when there is a remote).
start: analyse
nodes:
  analyse:   { type: task, role: analyst, instruction: "Analyse the request and list the files to touch.", next: implement }
  implement: { type: task, role: backend, instruction: "Implement the request. Keep tests green.", next: qa }
  qa:        { type: gate, gates: [tests], on_pass: judge, on_fail: implement, max_retries: 2 }   # add lint (once the base branch is lint-clean) and review (a model code review)
  judge:     { type: decide, by: team-leader, question: "Is the work ready to ship?", options: [ship, rework], next: { ship: ship, rework: implement } }
  ship:      { type: human, action: approve-push, prompt: "Land this on the base branch (and push it)?", next: commit }
  commit:    { type: git, action: commit, next: merge }
  merge:     { type: git, action: merge }
  # for a pull request instead: pr: { type: git, action: pr }   (needs a remote "origin" and gh)
`,
  'org/prompts/team-leader.md':
    '# Team leader\nYou judge whether work is ready. Be strict about tests and scope.\n',
  'org/prompts/analyst.md':
    '# Analyst\nYou read the request and the codebase and list what must change, with risks.\n',
  'org/prompts/backend.md':
    '# Backend\nYou implement changes with tests. Never push without approval.\n',
  'org/catalog/playwright.yaml': `id: playwright
type: mcp
description: "A browser (Playwright MCP): open pages, click, fill forms, read the page, screenshots."
tags: [browser, e2e]
# Add \`mcp: [playwright]\` to a role to give it these tools, in every runtime.
# The role then browses wherever the model decides: keep it on roles you trust with that.
# Pinned (npx fetches it on first use; bump deliberately). --isolated: a fresh browser profile per
# task, so parallel tasks never fight over one profile and no login carries over between runs.
server:
  transport: stdio
  command: npx
  args: ['-y', '@playwright/mcp@0.0.83', '--headless', '--isolated']
`,
  'vault/00-org/.gitkeep': '',
  'vault/10-projects/.gitkeep': '',
  'vault/20-clients/.gitkeep': '',
  'vault/30-knowledge/.gitkeep': '',
  'vault/90-system/.gitkeep': '',
};

/** The stacks `shibaox init --stack` knows (`auto` detects one from the directory). */
export { STACKS } from '@wizardingcode/shibaox-core';

const STACK_CRITERIA: Record<Stack, string[]> = {
  node: [
    'No new `any` or type assertions that hide a real type problem',
    'Errors are handled or propagated, never swallowed; async code awaits what it starts',
    'No stray console.log or commented-out code in the diff',
    'New behaviour has tests next to it; existing tests were not weakened',
  ],
  python: [
    'Public functions have type hints; no bare `except:`',
    'No print debugging left; logging is used where output matters',
    'Dependencies added to the project file, never installed ad hoc',
    'New behaviour has tests next to it; existing tests were not weakened',
  ],
  'php-laravel': [
    'Validation lives in FormRequests, not in controllers',
    'No queries or business logic in Blade views',
    'Migrations are reversible (down) and never edit a migration that already ran',
    'New behaviour has feature or unit tests; existing tests were not weakened',
  ],
  go: [
    'Every error is handled or returned wrapped with context (%w); none discarded with _',
    'context.Context is passed to everything that blocks or does I/O',
    'No panic in library code; goroutines have a way to stop',
    'New behaviour has tests next to it; existing tests were not weakened',
  ],
};

const yamlList = (items: string[]) => `[${items.join(', ')}]`;
const quote = (s: string) => JSON.stringify(s);
const has = (dir: string, file: string) => existsSync(join(dir, file));

/** The dependency audit of a project and the exit codes that still carry a report (findings). */
function auditFor(dir: string, stack: Stack): { command: string; ok: number[] } {
  switch (stack) {
    case 'node':
      if (has(dir, 'pnpm-lock.yaml'))
        return { command: 'pnpm audit --audit-level high', ok: [0, 1] };
      if (has(dir, 'yarn.lock'))
        return has(dir, '.yarnrc.yml')
          ? { command: 'yarn npm audit --severity high', ok: [0, 1] }
          : // classic yarn exits with a severity bitmask (up to 31) when it finds something
            { command: 'yarn audit --level high || [ $? -lt 32 ]', ok: [0] };
      if (has(dir, 'bun.lock') || has(dir, 'bun.lockb'))
        return { command: 'bun audit', ok: [0, 1] };
      if (has(dir, 'package-lock.json'))
        return { command: 'npm audit --audit-level=high', ok: [0, 1] };
      // no lockfile: npm audit needs one, so it is created first (install scripts never run)
      return {
        command: 'npm install --package-lock-only --ignore-scripts && npm audit --audit-level=high',
        ok: [0, 1],
      };
    case 'python':
      if (has(dir, 'uv.lock'))
        return { command: 'uv run --with pip-audit pip-audit .', ok: [0, 1] };
      if (has(dir, 'requirements.txt'))
        return { command: 'pip-audit -r requirements.txt', ok: [0, 1] };
      return { command: 'pip-audit .', ok: [0, 1] };
    case 'php-laravel':
      return { command: 'composer audit', ok: [0, 1, 2, 3] };
    case 'go':
      return { command: 'govulncheck ./...', ok: [0, 3] };
  }
}

/** The stack files that are written first (the generic scaffold fills the rest). */
export const STACK_FILES = [
  'shibaox.yaml',
  'org/gates/typecheck.yaml',
  'org/gates/review.yaml',
  'org/workflows/security-scan.yaml',
  'org/routines/security-scan.yaml',
  'org/teams/engineering.yaml',
  'org/workflows/hello-feature.yaml',
  'org/workflows/land-feature.yaml',
  'org/workflows/fix-issue.yaml',
  'org/roles/frontend.yaml',
  'org/prompts/frontend.md',
] as const;

/** The files a stack adds on top of the generic scaffold, computed from the project directory. */
function stackFiles(dir: string, stack: Stack): Record<string, string> {
  const detected: [string, string | undefined][] = [
    ['setup', detectSetupCommand(dir)?.command],
    ['tests', detectTestCommand(dir)],
    ['lint', detectLintCommand(dir)],
    ['typecheck', detectTypecheckCommand(dir)],
  ];
  const audit = auditFor(dir, stack);
  const project = [
    `# shibaox.yaml: what a run needs to know about this ${stack} project (every key optional).`,
    '# setup, tests, lint and typecheck are detected on every run from what the checkout contains;',
    '# set one only when detection is wrong for this project. Detected when this file was written:',
    ...detected.map(([k, v]) => `#   ${v ? `detected: ${k}: ${v}` : `${k}: nothing detected`}`),
    '# Files no run may write without a `protected` approval (see Security in the wiki):',
    `protected: ['shibaox.yaml', '.github/workflows/**', '.env', '.env.local', '.env.*.local']`,
    '',
  ].join('\n');
  // the generic workflows, with the team's gates in their own qa gate (so nothing is injected)
  const withTypecheck = (rel: string) =>
    (ORG_TEMPLATE[rel] ?? '').replace('gates: [tests]', 'gates: [tests, typecheck]');
  const files: Record<string, string> = {
    'shibaox.yaml': project,
    'org/gates/typecheck.yaml': `gate: typecheck
checks:
  # the project's type checker, found at run time: shibaox.yaml typecheck, a typecheck script,
  # tsc (tsconfig), mypy/pyright (their config), go build, phpstan; none, or not installed, passes with a note
  - { name: typecheck, type: typecheck, timeout_ms: 300000 }
`,
    'org/gates/review.yaml': `gate: review
checks:
  # a code review by the judge model, criterion by criterion (the ${stack} checklist; edit freely)
  - name: review
    type: review
    criteria:
${STACK_CRITERIA[stack].map((c) => `      - ${quote(c)}`).join('\n')}
`,
    'org/workflows/security-scan.yaml': `workflow: security-scan
team: engineering
team_gates: false                 # a scan runs no test or type gate of its own
description: Weekly dependency audit; a triage of what it found.
start: audit
nodes:
  # the audit exits non-zero when it finds something: those codes still complete the node (ok_exit_codes);
  # a tool that is not installed completes with { skipped: true } (skip_if_missing)
  audit:  { type: code, command: ${quote(audit.command)}, ok_exit_codes: ${yamlList(audit.ok.map(String))}, skip_if_missing: true, next: triage }
  triage: { type: task, role: analyst, instruction: "Read the audit output in the previous outputs (the audit node: exitCode, stdout, or skipped: true). If skipped is true, say the audit tool is not installed and how to install it. Otherwise list each vulnerability with its severity and the package, propose the smallest upgrade or workaround for each, and say plainly when nothing was found." }
`,
    'org/routines/security-scan.yaml': `routine: security-scan
name: Weekly security scan
on: { cron: "0 9 * * 1" }       # Mondays 09:00 (daemon local time)
workflow: security-scan
input: Weekly dependency audit.
max_daily_usd: 2
# adapter: direct                 # the org's adapter is used when unset (the scaffold defaults to mock: set one)
# load it with: shibaox routine sync --org ./org
`,
    'org/teams/engineering.yaml': `team: engineering
lead: team-leader
roles: ${yamlList(['team-leader', 'analyst', 'backend', ...(stack === 'node' ? ['frontend'] : [])])}
gates: [tests, typecheck]
workflows: [hello-feature, land-feature, fix-issue, review-pr, security-scan]
`,
    'org/workflows/hello-feature.yaml': withTypecheck('org/workflows/hello-feature.yaml'),
    'org/workflows/land-feature.yaml': withTypecheck('org/workflows/land-feature.yaml'),
    'org/workflows/fix-issue.yaml': withTypecheck('org/workflows/fix-issue.yaml'),
  };
  if (stack === 'node') {
    files['org/roles/frontend.yaml'] = `role: frontend
description: Implements UI and client-side changes with tests.
model_tier: strong
tools: [read, write, git, node, npm, pnpm, yarn, bun, npx]
permissions:
  approval_required: [push, deploy]   # add execute to be asked for npx of a package that is not installed
system_prompt: prompts/frontend.md
`;
    files['org/prompts/frontend.md'] = `# Frontend

You implement user-facing changes: components, styles, client state, accessibility. Keep the
existing conventions of the project (framework, component structure, test runner). Every
change ships with a test where the project has them. Do not touch build or CI config
unless the task is about it.
`;
  }
  return files;
}

/**
 * Writes the org/vault template files that do not exist yet; returns the created paths. With
 * a `stack`, the stack's files (shibaox.yaml, typecheck and review gates, security-scan
 * workflow and routine, frontend role) come first and the generic scaffold fills the rest.
 */
export function scaffoldOrg(
  dir: string,
  o: { stack?: Stack; onKept?: (rel: string) => void } = {},
): string[] {
  const created: string[] = [];
  const write = (rel: string, content: string, stackFile = false) => {
    const file = join(dir, rel);
    if (existsSync(file)) {
      if (stackFile) o.onKept?.(rel);
      return;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    created.push(rel);
  };
  if (o.stack)
    for (const [rel, content] of Object.entries(stackFiles(dir, o.stack)))
      write(rel, content, true);
  for (const [rel, content] of Object.entries(ORG_TEMPLATE)) write(rel, content);
  return created;
}
