import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
  approval_required: [push, deploy]
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
  approval_required: [push, deploy]
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
touches. Write the review as Markdown: what is wrong first (with file and line), then what is
risky, then what is fine. Say whether it can merge. You never merge, push or comment yourself:
the workflow publishes your text after a person approves it.
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
  'vault/00-org/.gitkeep': '',
  'vault/10-projects/.gitkeep': '',
  'vault/20-clients/.gitkeep': '',
  'vault/30-knowledge/.gitkeep': '',
  'vault/90-system/.gitkeep': '',
};

/** Writes the org/vault template files that do not exist yet; returns the created paths. */
export function scaffoldOrg(dir: string): string[] {
  const created: string[] = [];
  for (const [rel, content] of Object.entries(ORG_TEMPLATE)) {
    const file = join(dir, rel);
    if (existsSync(file)) continue;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    created.push(rel);
  }
  return created;
}
