# Jev consolidated: typed decisions, request routing, checks — one place to see it

Date: 2026-10-02. Status: approved by Andre ("já coloquei a API key directa do Jev … vamos ter que
colocar isto a funcionar tanto para router como para tomar decisões, isto tem que estar bem
consolidado"). Reference: TypeSafe docs https://docs.typesafe.ai (llms.txt index; `patterns/intent-routing`,
`patterns/confidence-routing`, `primitives/choice|noul|score`, `confidence`), the official agent skill
`typesafe-ai/skills` (skill `typesafe-ai`, MIT) — installed into Andre's org as `org/skills/typesafe-ai`
and attached to the assistant.

## Where Jev already is (verified today)

- `packages/jev`: `JevClient.fanOut(state, questions)` over `@typesafe-ai/sdk` (`systemOne`), cost
  `JEV_INPUT_USD_PER_M`; `JevDecider` (Choice, `gateByConfidence` threshold 0.8, fallback LLM decider);
  `jevCheckRunner` (Noul/Score checks with escalation to the judge); `noulFanOut`, `truncateState`.
- `packages/core/run/autorouting.ts` `selectCapabilities` (per run: catalog capabilities attached to the
  first task's role by Jev nouls, thresholds attach 0.8 / ask 0.5; tag matching without Jev).
- `daemon/runtime.ts`: `JevDecider` when `tiers.decision` is not a `provider/model` ref (`jev-latest`)
  and `TYPESAFE_API_KEY` is set; `deciderInfo` for `GET /decisions`; Jev check runner when the key is set.
- Andre's org: decision tier switched today from `openrouter/typesafe/jev-1.13` (Jev as a chat model via
  OpenRouter, an LLM decider) to `jev-latest` (the typed API): `GET /decisions` → `{kind:'jev', usable}`;
  the live call `fanOut({request}, {intent: choice(…)})` answered `image`, confidence 1, $0.000015.

## What is missing (this cycle)

1. **Request routing by Jev, every chat turn.** Nothing routes a user's message today: the orchestrator
   (an LLM) decides alone what to do and always runs on the role's tier. Jev classifies each turn in one
   fan-out before the orchestrator runs and the result is visible and recorded.
2. **One place that shows Jev at work**: the TypeSafe plugin card says only "API key" and "Jev decides".
3. **Default to Jev when the key exists**: an org created before the key (decision tier an OpenRouter ref)
   keeps using an LLM decider silently.

## Design

### A. The router (`packages/jev/src/router.ts`, wired in the daemon)

`routeRequest(client, {request, workflows, hasMedia, hasCode, attachments}) → RouteResult`: ONE
`fanOut` with three questions (the state is the request text, bounded to 4 000 chars, the attachment
names/kinds, and the list of org workflows with their descriptions):

- `intent`: Choice over `chat` (answer or discuss), `media` (an image, video, audio or 3D asset),
  `code` (change, build or fix software in the project), `research` (look things up on the web or in
  repositories), `workflow:<id>` for every non-conversation workflow of the org (its description as the
  criterion), `human` (needs a person's decision or something only the user can do).
- `tier`: Choice over `cheap` (a short, simple or conversational request) and `strong` (reasoning,
  multi-step work, code changes, anything risky or ambiguous).
- `risky`: Noul "the request asks to push, deploy, publish, delete, pay, send or message someone".

`RouteResult = {intent, intentConfidence, tier, tierConfidence, risky, riskyProbability, cost, model:
'jev-latest'}`. Confidence gating (TypeSafe's confidence-routing pattern): below 0.6 the intent is
`unsure` and the tier falls back to the role's default; `risky` ≥ 0.7 is a flag. Any error → no routing
(a `[note]` in the log; the turn runs as today). Cost is added to the run's spend.

**Effect on the turn** (daemon `RunManager.submit`, only for conversation workflows, i.e. the chat and
Telegram turns, and for routines' chat runs):
- **Model tier**: when the request did not name a model (`req.model` empty) and the route says `cheap`
  with confidence ≥ 0.75, the turn runs on the org's cheap tier; `strong` or unsure → the role's default
  (today the strong tier). Recorded on the run (`model`) like a chosen model is.
- **Hint to the orchestrator**: a line prepended to the task input for the model:
  `[router] intent=<intent> (<confidence>) tier=<tier> risky=<yes|no>` plus, for `media`: "generate it
  with Higgsfield now", for `workflow:<id>`: "start workflow <id> with start_workflow unless the user is
  only asking about it", for `research`: "use your fetch/search tools", for `human`: "ask one precise
  question". The hint is part of the model's input, not of the user's text (the thread shows the user's
  message unchanged).
- **Record**: a `DecisionMade` run event with `nodeId: 'router'`, `choice: <intent>`, `confidence`,
  `by: 'jev'`, `cost`; a second one `nodeId: 'router:tier'` with the tier. `GET /decisions` lists them
  (they already carry `by`). The engine's reducer must accept a `DecisionMade` for a node that is not in
  the workflow (today `nodeId` is free text in the schema; check the reducer and the thread view ignore
  unknown nodes gracefully — add a `router` card kind if needed, see C).
- **Off switch**: `models.yaml` `routing: { jev: true|false, cheap_min_confidence: 0.75 }` (schema +
  `OrgConfig`/`OrgConfigPatch` + `PUT /orgs/config` + `/tiers`); default on when `TYPESAFE_API_KEY`
  exists and the decider is Jev. `risky` only annotates (approvals already gate the actions).

### B. Default to Jev (`deciderInfo`, templates, config)

- When `TYPESAFE_API_KEY` is set and the decision tier is a ref whose model name contains `jev`
  (`openrouter/typesafe/jev-*`), `deciderInfo` reports `kind:'model'` with `reason: 'the key is set:
  switch the decision tier to jev-latest for typed decisions'` and the plugin card offers **Use Jev for
  decisions** (`use_jev` action → `PUT /orgs/config {tiers:{decision:'jev-latest'}}`, local-only like the
  other org writes). Nothing switches by itself.
- `doctor` `decisions` line says the same.

### C. The TypeSafe plugin card and the chat

- Checks: `API key (TYPESAFE_API_KEY)`; `Jev decides` (decider kind jev; detail `jev-latest` or "the
  decision tier is <ref>: an LLM decides"); `Jev routes requests` (routing on; detail "last: <intent>
  <confidence>" from the newest router decision); `Jev runs checks` (check runner on; detail: count of
  `jev` checks in the last 24 h if cheap to get, else omit). Actions: `use_jev` (shown when not jev),
  `routing_on`/`routing_off` (toggle `routing.jev`), `docs` (https://docs.typesafe.ai), `skill` is in
  brings. Brings: `skills: ['typesafe-ai']` from a new skill source `typesafe-ai/skills` (path `skills`,
  vendor TypeSafe) in `registry/skills.ts`, `tools: []`.
- Status: ready when key + decides + routes; partial when key only.
- Chat: a turn that was routed shows a small muted line under the user's message or at the top of the
  reply: `Routed by Jev · media (0.98) · cheap` (the thread view turns the `router` decisions into a
  `route` block on the agent message; `packages/view` `stream.ts`/`thread.ts`; the app renders it with
  the existing muted meta style). The Decisions card on the Models tab lists router decisions with
  `by jev` like the others.
- CLI: `shibaox decisions` (if it exists) shows them; `shibaox tiers --routing on|off`.

### D. Docs

`docs/wiki/Providers-and-models.md` (decision tier, `jev-latest`, routing block), new section in
`docs/wiki/MCP-and-skills.md` Plugins → TypeSafe (what Jev does: decisions, routing, checks, autorouting;
cost; the skill), `App.md` (the Routed line, the card), `CLI-reference.md`.

### E. Tests

- `packages/jev`: `routeRequest` with a fake `fanOut` (intent/tier/risky mapping, confidence gating,
  `workflow:<id>` options built from the org, request bounded, error → undefined).
- daemon: `submit` of a chat turn with a fake Jev (`SHIBAOX_JEV_BASE_URL` to a local fake, or an injected
  router) → cheap tier chosen only above the threshold and only when no model was named; the two
  `DecisionMade` events with `by: 'jev'`; the hint reaches the task input and not the thread text; routing
  off → nothing; Jev failing → the turn runs unrouted with a log line; `GET /decisions` lists them;
  `deciderInfo` reason for the OpenRouter jev ref; `PUT /orgs/config` routing patch; plugin checks and
  actions; template `models.yaml` comment.
- view: `route` block from router decisions. app: the Routed line; the card's checks/actions; Models tab
  tiers form with the routing toggle.

### Out of scope

Routing of dispatched (non-conversation) runs; learning thresholds; per-role routing policies.
