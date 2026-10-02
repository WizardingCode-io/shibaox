# Providers and models

## The catalog

The built-in catalog (`packages/providers/catalog.yaml`) lists the supported providers: hosted APIs (Anthropic, OpenAI, Google, OpenRouter, Groq, Mistral, xAI, DeepSeek, …), gateways (Vercel, Cloudflare, LiteLLM, …), local servers (Ollama, LM Studio) and the subscription routes that go through a coding CLI (`anthropic-subscription`, via Claude Code). Model refs are `provider/model`.

```sh
shibaox providers list                # every provider and whether it is configured
shibaox providers list --configured   # only the usable ones
shibaox providers test groq           # one short real call with the first catalog model
shibaox providers test ollama --model qwen2.5-coder:7b
shibaox models --org ./org            # how each role of the org resolves to a model
```

## Keys: the vault

API keys and tokens live in Shibaox's own vault, `~/.shibaox/secrets.json` (0600, inside the 0700 home), shared by the daemon, the CLI and the dashboard:

```sh
shibaox keys list                              # every key Shibaox knows, set or missing, where from
shibaox keys set OPENROUTER_API_KEY sk-or-...   # or: echo sk-or-... | shibaox keys set OPENROUTER_API_KEY
shibaox keys unset OPENROUTER_API_KEY
```

In the dashboard `/keys` shows the vault and `/key NAME value` sets one. A key set this way is used by the next run at once, reaches the launchd service whatever your shell exports, and wins over the environment. Keys exported in the shell still work, and `doctor` says which of the two a key comes from. The Telegram channel follows its token in the vault: set it and it starts, remove it and it stops, no restart.

Each provider reads its key from the variable shown by `providers list` (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `OPENAI_API_KEY`, …). Also: `TYPESAFE_API_KEY` for Jev through TypeSafe's typed API, `SHIBAOX_JEV_BASE_URL` to override its endpoint.

## Discovery: what a provider really offers

`/model` and `GET /models` list the catalog, then ask the providers: with an `OPENROUTER_API_KEY` the whole OpenRouter catalogue with its prices and context windows; LM Studio and Ollama what they have running (and, for LM Studio, the context length each loaded model runs with). What discovery learns feeds every run: real cost per turn, the context percentage under the prompt, and a check at submit that a `--model` really exists on that provider (a typo is refused at once, not minutes later). Local models cost nothing.

## Tiers

`models.yaml` names a model per tier; roles pick a tier, and `roles:` can override the model per role:

```yaml
tiers:
  strong: anthropic/claude-sonnet-5              # API key, direct adapter
  # strong: anthropic-subscription/claude-sonnet-5   # Claude subscription, via Claude Code
  cheap: openrouter/qwen/qwen3-coder
  decision: jev-latest                           # Jev's typed API (TYPESAFE_API_KEY), or any model ref
gates:
  judge: anthropic/claude-haiku-4-5              # judge and review checks (default: decision, then strong)
routing:                                         # Jev routing of chat turns (optional)
  jev: true                                      # default: on with TYPESAFE_API_KEY when Jev decides
  cheap_min_confidence: 0.75                     # a "cheap" route from this confidence runs on the cheap tier
```

### The decision tier: jev-latest

`decision: jev-latest` makes Jev, TypeSafe's typed API, decide decide nodes: one call with the node's options as a `choice`, an answer with a confidence (below 0.8 the strong tier decides instead) and a cost of a fraction of a cent. It needs `TYPESAFE_API_KEY`; without it the strong tier decides. A model ref (`openrouter/typesafe/jev-1.13`) makes that model decide as an LLM: with the key set, `shibaox doctor`, `GET /decisions` and the TypeSafe card say "the key is set: switch the decision tier to jev-latest for typed decisions", and **Use Jev for decisions** on the card switches it (nothing switches by itself). With `jev-latest` and the key, Jev also runs `jev` checks of the gates.

### Routing: Jev reads every chat turn first

With routing on, each chat turn (the app, Telegram, a routine's chat run; never a dispatched run, an event turn, a turn on the `mock` adapter, or a conversation workflow with its own `router` node) goes through ONE Jev fan-out before the orchestrator runs: its **intent** (`chat`, `media`, `code`, `research`, `workflow:<id>` for each of the org's non-conversation workflows (an id longer than 120 characters is left out), `human`; below 0.6 it is `unsure`), the **tier** it needs (`cheap` or `strong`) and whether it is **risky** (push, deploy, publish, delete, pay, message someone; a flag from 0.7). Jev sees the request (at most 4 000 characters), the names of attached files and the org's non-conversation workflows with their descriptions. A request that is refused anyway (a model the provider does not list, a protected attachment) fails before Jev is asked.

- When you did not pick a model, the intent is confident (not `unsure`), the turn is not risky and the route says `cheap` with a confidence of at least `cheap_min_confidence` (0.75), the turn runs on the org's cheap tier (when it is usable and its provider lists it), recorded as the run's model; otherwise the role's own tier. A cheap route also switches the runtime to the cheap model's provider (a direct provider runs through the direct loop even when the strong tier lives behind Claude Code). A turn that asked for an explicit adapter (a Telegram turn on `claude-code`, `--adapter`) is never moved to another runtime: when the cheap tier runs elsewhere the default tier runs, with a warning.
- The orchestrator reads a line before your message with Jev's own answer, `[router] intent=media (0.98) tier=cheap risky=no: generate it with Higgsfield now` (the Higgsfield advice only when media generation is set up: a role with the `higgsfield` MCP or Higgsfield in API mode with its key; for a workflow: start it with `start_workflow` unless you only ask about it; research: use the fetch/search tools; human: ask one precise question). Your message in the thread is unchanged.
- The route is recorded as two decisions of the run, `router` (the intent) and `router:tier` (the tier APPLIED: `cheap` only when the turn ran on the cheap tier, else `strong`), by `jev`, with the fan-out's cost added to the run's spend; `GET /decisions` lists them and the chat shows the applied tier, "Routed by Jev · media (0.98) · cheap".
- `risky` keeps the turn off the cheap tier; otherwise it only annotates: the approvals gate the actions themselves.
- Jev failing or slow (8 s) never breaks a turn: the daemon logs a `[router]` line and the turn runs unrouted.

`shibaox tiers --routing on|off`, the routing row of `/tiers` in the dashboard, the Jev routing control of Customize → Models and the TypeSafe card change `routing.jev`; `PUT /orgs/config` takes `{routing: {jev, cheap_min_confidence}}` (`null` goes back to the default; `routing: null` resets both). **Use Jev for decisions** and **Route requests with Jev** appear on the TypeSafe card only with `TYPESAFE_API_KEY` (without it the actions answer 409 `no_key`).

You never have to edit that file: `shibaox tiers` shows the tiers, the judge, the default adapter and the budget per run, `shibaox tiers set strong openrouter/openai/gpt-5` changes one (comments in the YAML are kept), and `/tiers` in the dashboard does the same with the model list. `none` clears `judge` or `adapter`. `shibaox tiers --routing on|off` turns Jev routing of chat turns on or off (below).

## Choosing the model for a run

`/model` in the dashboard, `--model provider/model` on `shibaox run`. Every task of the run uses it and the adapter follows: a subscription model goes through Claude Code, an API or local model through the direct loop. In a run tab `/model` sets the model of the next turns. `default` goes back to the org's routing.

## Adapters

`shibaox run` uses `--adapter mock|direct|claude-code`, else `adapter:` in `org.yaml`, else what the tiers imply; `resume` keeps the adapter the run started with. With `mock` no model is called. With `direct` or `claude-code` every role is resolved before the run starts and printed (`<role> → <target>`); a role that cannot resolve to a configured model stops the run with `cannot start: role "<role>" → <reason>` before any event is stored.

## Local models

Ollama (`ollama serve`, port 11434) and LM Studio (port 1234) need no key:

```sh
ollama pull qwen2.5-coder:7b
shibaox tiers set strong ollama/qwen2.5-coder:7b      # or lmstudio/<model>
shibaox providers test ollama --model qwen2.5-coder:7b
```

## Costs and budgets

Spend is computed from token usage and the price per million tokens (the catalog's, else the provider's listing); failed attempts count too. `--budget <usd>` or `budgets.per_run_usd` in `org.yaml` caps a run: when a task hits the cap the run pauses (`paused_budget`) and `shibaox resume <runId> --budget <higher>` continues it. A hosted model with no known price cannot be stopped by a budget; the run warns about it. Claude subscription spend is notional (Claude Code reports a USD equivalent) and still counts against the budget.
