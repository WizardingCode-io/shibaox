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

const STACK_DEFAULTS: Record<
  Stack,
  { tests: string; lint?: string; typecheck?: string; audit: string; criteria: string[] }
> = {
  node: {
    tests: 'npm test',
    audit: 'npm audit --audit-level=high',
    criteria: [
      'No new `any` or type assertions that hide a real type problem',
      'Errors are handled or propagated, never swallowed; async code awaits what it starts',
      'No stray console.log or commented-out code in the diff',
      'New behaviour has tests next to it; existing tests were not weakened',
    ],
  },
  python: {
    tests: 'pytest',
    lint: 'ruff check .',
    audit: 'pip-audit',
    criteria: [
      'Public functions have type hints; no bare `except:`',
      'No print debugging left; logging is used where output matters',
      'Dependencies added to the project file, never installed ad hoc',
      'New behaviour has tests next to it; existing tests were not weakened',
    ],
  },
  'php-laravel': {
    tests: 'php artisan test',
    lint: 'vendor/bin/pint --test',
    audit: 'composer audit',
    criteria: [
      'Validation lives in FormRequests, not in controllers',
      'No queries or business logic in Blade views',
      'Migrations are reversible (down) and never edit a migration that already ran',
      'New behaviour has feature or unit tests; existing tests were not weakened',
    ],
  },
  go: {
    tests: 'go test ./...',
    typecheck: 'go vet ./...',
    audit: 'govulncheck ./...',
    criteria: [
      'Every error is handled or returned wrapped with context (%w); none discarded with _',
      'context.Context is passed to everything that blocks or does I/O',
      'No panic in library code; goroutines have a way to stop',
      'New behaviour has tests next to it; existing tests were not weakened',
    ],
  },
};

const yamlList = (items: string[]) => `[${items.join(', ')}]`;
const quote = (s: string) => JSON.stringify(s);

/** The files a stack adds on top of the generic scaffold, computed from the project directory. */
function stackFiles(dir: string, stack: Stack): Record<string, string> {
  const d = STACK_DEFAULTS[stack];
  const setup = detectSetupCommand(dir)?.command;
  const tests = detectTestCommand(dir) ?? d.tests;
  const lint = detectLintCommand(dir) ?? d.lint;
  const typecheck = detectTypecheckCommand(dir) ?? d.typecheck;
  const project = [
    `# shibaox.yaml: what a run needs to know about this ${stack} project (every key optional)`,
    ...(setup
      ? [`setup: ${quote(setup)}                    # dependency install in a fresh worktree`]
      : []),
    `tests: ${quote(tests)}`,
    ...(lint ? [`lint: ${quote(lint)}`] : []),
    ...(typecheck ? [`typecheck: ${quote(typecheck)}`] : []),
    `protected: ['.github/workflows/**', '.env', '.env.*']   # never written by a run without a protected approval`,
    '',
  ].join('\n');
  const files: Record<string, string> = {
    'shibaox.yaml': project,
    'org/gates/review.yaml': `gate: review
checks:
  # a code review by the judge model, criterion by criterion (the ${stack} checklist; edit freely)
  - name: review
    type: review
    criteria:
${d.criteria.map((c) => `      - ${quote(c)}`).join('\n')}
`,
    'org/workflows/security-scan.yaml': `workflow: security-scan
team: engineering
description: Weekly dependency audit; a triage of what it found.
start: audit
nodes:
  audit:  { type: code, command: ${quote(d.audit)}, skip_if_missing: true, next: triage }   # passes with a note when the tool is not installed
  triage: { type: task, role: analyst, instruction: "Read the audit output in the previous outputs. List each vulnerability with its severity and the package; propose the smallest upgrade or workaround for each; say when nothing was found." }
`,
    'org/routines/security-scan.yaml': `routine: security-scan
name: Weekly security scan
on: { cron: "0 9 * * 1" }       # Mondays 09:00 (daemon local time)
workflow: security-scan
input: Weekly dependency audit.
max_daily_usd: 2
# load it with: shibaox routine sync --org ./org
`,
    'org/teams/engineering.yaml': `team: engineering
lead: team-leader
roles: ${yamlList(['team-leader', 'analyst', 'backend', ...(stack === 'node' ? ['frontend'] : [])])}
gates: ${yamlList(['tests', ...(typecheck ? ['typecheck'] : [])])}
workflows: [hello-feature, land-feature, fix-issue, review-pr, security-scan]
`,
  };
  // no checker found: no gate (add `typecheck:` to shibaox.yaml and a gate file later)
  if (typecheck)
    files['org/gates/typecheck.yaml'] = `gate: typecheck
checks:
  - { name: typecheck, type: code, command: ${quote(typecheck)}, timeout_ms: 300000 }
`;
  if (stack === 'node') {
    files['org/roles/frontend.yaml'] = `role: frontend
description: Implements UI and client-side changes with tests.
model_tier: strong
tools: [read, write, git, node, npm, pnpm, npx]
permissions:
  approval_required: [push, deploy]
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
export function scaffoldOrg(dir: string, o: { stack?: Stack } = {}): string[] {
  const created: string[] = [];
  const write = (rel: string, content: string) => {
    const file = join(dir, rel);
    if (existsSync(file)) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    created.push(rel);
  };
  if (o.stack)
    for (const [rel, content] of Object.entries(stackFiles(dir, o.stack))) write(rel, content);
  for (const [rel, content] of Object.entries(ORG_TEMPLATE)) write(rel, content);
  return created;
}
