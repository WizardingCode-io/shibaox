export const ORG_TEMPLATE: Record<string, string> = {
  'org/.gitignore': '.shibaox/\n',
  'org/org.yaml': `organization: my-org
budgets:
  per_run_usd: 5
teams: [engineering]
# Runtime adapter for task nodes: mock (default, no model calls) or direct (real models,
# see models.yaml). \`shibaox run --adapter\` overrides it.
# adapter: direct
`,
  'org/models.yaml': `# Model refs are <provider>/<model>; see \`shibaox providers list\` for the catalog.
# anthropic/... uses ANTHROPIC_API_KEY. With a Claude subscription instead of an API key,
# use anthropic-subscription/<model> (e.g. anthropic-subscription/claude-sonnet-5): it runs
# through the Claude Code runtime (phase 1B-2), not through the direct adapter.
# Local models: ollama/<model> (Ollama on :11434) or lmstudio/<model> (LM Studio on :1234).
providers: {}
tiers:
  strong: anthropic/claude-sonnet-5
  cheap: ollama/llama3.2
  decision: jev-latest
roles: {}
gates: {}
`,
  'org/teams/engineering.yaml': `team: engineering
lead: team-leader
roles: [team-leader, analyst, backend]
gates: [tests]
workflows: [hello-feature]
`,
  'org/roles/team-leader.yaml': `role: team-leader
description: Judges readiness, approves or sends back.
model_tier: strong
system_prompt: prompts/team-leader.md
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
tools: [git, node, pnpm]
permissions:
  approval_required: [push, deploy]
system_prompt: prompts/backend.md
`,
  'org/gates/tests.yaml': `gate: tests
checks:
  - { name: unit-tests, type: code, command: "npm test", timeout_ms: 120000 }
  # - { name: spec, type: jev, question: "The outputs implement the request", threshold: 0.8 }   # uncomment when TYPESAFE_API_KEY is set
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
