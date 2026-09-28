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
  decision: openrouter/typesafe/jev-router       # any model ref, or jev-latest with TYPESAFE_API_KEY
gates:
  judge: anthropic/claude-haiku-4-5              # judge and review checks (default: decision, then strong)
```

You never have to edit that file: `shibaox tiers` shows the tiers, the judge, the default adapter and the budget per run, `shibaox tiers set strong openrouter/openai/gpt-5` changes one (comments in the YAML are kept), and `/tiers` in the dashboard does the same with the model list. `none` clears `judge` or `adapter`.

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
