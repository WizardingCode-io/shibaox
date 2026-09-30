# Orchestrator

The org template ships an `assistant` role and a `chat` workflow marked `conversation: true`: the orchestrator you talk to in the dashboard or from Telegram. It answers in your language and, in one turn, can:

- **act** — read and write files in the project, run the programs listed in its `tools`, fetch pages from the hosts its `permissions.network` allows;
- **dispatch** — start one of the org's workflows with the `start_workflow` tool; the run gets a `parentRunId`, joins the conversation, and its outcome comes back as a turn the orchestrator replies to;
- **remember** — `remember` and `recall` notes in the vault (see [Memory](Memory)).

Every task starts with a preamble: the project's profile (stack, test command, size) and the memory notes.

## The role behind it

```yaml
role: assistant
capabilities: [orchestrate, memory]   # orchestrate → start_workflow; memory → remember/recall
tools: [read, write, git, node, npm, pnpm, bun, python3]
permissions:
  network: ['*']                       # hosts it may fetch (`*` = any; `github.com` covers subdomains)
  approval_required: [push, deploy]
max_steps: 40                          # direct adapter tool-loop steps (default 12)
max_turns: 80                          # Claude Code agent turns (default 60)
budget_usd: 1                          # optional cap per task, within the run budget
model_tier: cheap                      # the conversation runs on the cheap tier; teams use their own
```

`write` in `tools` is what lets the direct adapter write files. With `permissions.network` set, the direct adapter exposes `web_fetch` (GET as text, HTML reduced to text, 200 kB) and the Claude Code adapter allows `WebFetch`/`WebSearch`, both checked per host, redirects included.

A `conversation: true` workflow runs **in place** on your checkout; dispatched team runs use the org default (a worktree in a git repository). The turn Shibaox submits when a dispatched run ends never gets `start_workflow`, so nothing re-dispatches without you. Memory notes reach only roles with the `memory` capability, quoted as data.

## Models without tool calling

Many local models and some routers write their tool calls as text (`<tools>{"name": …}</tools>`, `<tool_call>…</tool_call>`, a fenced JSON block, or `finish` followed by JSON). The direct adapter runs those as real tool calls, hands the results back and lets the model continue, so the conversation shows `⊙ start_workflow …` rather than raw XML. Text streams as it arrives, held back from the first sign of a call written as text so no half-written call ever shows.

## Long conversations

Each turn carries the conversation so far as `messages`. When that outgrows about 32k tokens (estimated), the daemon folds the oldest turns into one summary written by the org's `cheap` tier (else `strong`, else the run's model; without a callable model the turns are cut to lines), marked `summary: true` and kept first; the newest turns stay whole and the latest exchange is never cut. The adapters put the summary in the system prompt, the dashboard and Telegram continue from the compacted thread, and `POST /runs` answers with the `messages` it used (warning `conversation compacted`).

## Cost and context

Under the prompt the dashboard shows the model, how full its context window is, and the cost of the thread. Prices come from the catalog and from the providers' own listings (OpenRouter's, at discovery); local models cost nothing. See [Providers and models](Providers-and-models).

## Seeing and steering the runs it dispatched

Besides `start_workflow`, an orchestrator role (`capabilities: [orchestrate]`) has `list_runs` (the runs dispatched in this conversation: id, workflow, status, spend), `run_status` (each node, what the run waits for, its error), `steer_run` (a note for the running task: it stops and starts again with it, its session kept) and `cancel_run`. They work on the runs of its own conversation only, never on other runs. Every turn of a chat is a run of its own, so the runs share a **thread** (the id of the conversation's first run, `RunCreated.thread`, `GET /runs?thread=`): a run dispatched three turns ago is still visible, steerable and cancellable from the current one. On an event turn (a dispatched run ended) the orchestrator keeps `list_runs`, `run_status`, `steer_run` and `cancel_run` but never `start_workflow`, so a finished child cannot start a chain of new ones on its own.

A note from the orchestrator reaches the task as "Steering from the orchestrating agent (not the operator)", a note from you as "Steering from the operator (via cli|telegram|api)": the task never mistakes the agent's instruction for yours. Only a **task** with a live model call can be steered: a gate, a git step, a decision or a human node has nothing to tell, and a task that finished a moment before the note gets nothing (the daemon answers 409). A task whose adapter finishes anyway after the note has that attempt set aside (`NodeAttemptDiscarded`, its cost counted) and runs again with the note.

`start_workflow` also takes an `output_schema`, a JSON Schema the dispatched run must answer in. It is asked of the run's **answering tasks**: those from which no other task is reachable (a human, git or gate step after them is fine, so a template workflow that ends with an approval still answers from its last task). The direct adapter shows the schema in the prompt and its `finish` refuses an output that misses it (the model is told what is wrong and asked again, once per round); a result that still misses fails that node with the reasons. The answer comes back in the event turn (`answer: {...}`, the `answer` field of the run's state). The schema subset: `type` (including `integer`), `properties`, `required`, `items`, `enum`, `minLength`/`maxLength`, `minimum`/`maximum`, `minItems`; other keywords are ignored.
