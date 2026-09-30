# shibaox — item 8: MCP em todos os runtimes, skills por papel, Playwright, `shibaox mcp`

Data: 2026-09-30. Item 8 do roteiro pós-base (memória `shibaox-post-base-roadmap`).

## Objectivo

Um papel declara as ferramentas MCP e as skills que usa; o adapter direct (qualquer modelo) e
o Claude Code ligam-se aos mesmos servidores; o browser (Playwright MCP) vem no catálogo de
origem; `shibaox mcp list|test` e o `doctor` dizem o que está ligado e o que falta.

## Esquema

- `CatalogEntrySchema.server` (obrigatório quando `type: mcp`): `{ transport: stdio|http,
  command?, args?: [], url?, env?: {}, env_keys?: [], headers?: {}, tools?: [] (allowlist),
  timeout_ms? (default 30000) }`. `stdio` exige `command`; `http` exige `url` (`http(s)://`).
- `RoleSchema.mcp: [id]` e `RoleSchema.skills: [id]` (default `[]`).
- `loadOrg` valida: cada `role.mcp` existe no catálogo com `type: mcp`; cada `role.skills`
  tem `skills/<id>/SKILL.md` no org (erro claro com o ficheiro do papel).

## Core (`packages/core/src/mcp.ts`)

- `mcpServerSpec(entry, env)` → `{ id, transport, command, args, env, url, headers, tools?,
  timeoutMs }`: `env` = `entry.server.env` + as `env_keys` lidas do ambiente (cofre por cima);
  chave em falta → erro `catalog entry "x" needs KEY in the vault (shibaox keys set KEY)`.
- `skillsPrompt(orgRoot, ids)` → texto `## Skill: <id>\n<SKILL.md sem frontmatter>` por skill;
  ficheiro em falta → erro. Ambos os adapters anexam-no ao system prompt do papel.

## Adapter direct (`packages/adapter-direct/src/mcp.ts`)

- Cliente com `@modelcontextprotocol/sdk` (`StdioClientTransport` / `StreamableHTTPClientTransport`):
  `connectMcp(spec, {log}) → { tools: [{name, description, inputSchema}], call(name, args),
  close() }`; nomes `mcp__<id>__<tool>`; allowlist `tools` filtra. Resultado = texto dos
  `content` (json quando `structuredContent`), `isError` → `{error}`.
- `DirectAdapterOptions.mcpServers?: (job) => McpServerSpec[]`; em `run()` liga-se a todos
  (paralelo) antes da primeira chamada, fecha no fim (também em abort). Falha a ligar →
  evento `error` "mcp server "x" failed to start: …" (a tarefa falha: o papel pediu-o).
- As ferramentas MCP correm sem aprovação (documentado: quem lista um servidor num papel
  confia nas ferramentas dele; o Playwright navega para onde o modelo mandar).

## Adapter Claude Code

- `mcpServers` do daemon junta o catálogo do papel: `stdio {type, command, args, env}` /
  `http {type, url, headers}`; `allowedTools` `mcp__<id>__*` ou, com allowlist,
  `mcp__<id>__<tool>` por ferramenta.

## Daemon / API / CLI

- `buildRuntime` resolve `mcpFor(job)` a partir de `org.catalog` + `job.role.mcp` com
  `o.env`; passa-o aos dois adapters; `skillsPrompt` idem.
- `GET /mcp?org=` → `[{id, description, transport, target (command+args | url), tools?,
  roles: [papéis que o usam], keys: [{name, present}]}]`; `POST /mcp/:id/test?org=` liga-se
  (20 s) e devolve `{ok, tools: [{name, description}]}` ou `{ok: false, error}`; 404 id
  desconhecido. Cliente `mcpList(org)`, `mcpTest(id, org)`.
- CLI `shibaox mcp list [--org]`, `shibaox mcp test <id> [--org]`. `doctor`: linha `mcp`
  "N server(s) in the catalog: a, b; missing keys: KEY (b)" quando o daemon responde.
- Template `org/catalog/playwright.yaml` (`npx -y @playwright/mcp@latest --headless`), sem
  papel a usá-lo por defeito; docs explicam `mcp: [playwright]`.

## Fora de âmbito

SSE legado; OAuth em servidores http; aprovação por ferramenta MCP; skills com ficheiros
auxiliares além do SKILL.md (o prompt só leva o SKILL.md).
