# Higgsfield em dois modos: Conta (CLI + MCP) e API (key) — plano de implementação

## Contexto

O plugin Higgsfield (Customize → Plugins) só conhece hoje o caminho **Conta**: login pela CLI oficial, créditos do plano, MCP remoto com `bearer_command`, ferramenta `higgsfield_upload`. O Andre apontou que a Higgsfield tem um segundo caminho **completamente diferente**: a **API** para programadores (key criada em open.higgsfield.ai, REST em `https://api.higgsfield.ai`, `Authorization: Key <id:secret>`, submit → poll → cancel, uploads assinados, SDKs `@higgsfield/client`/`higgsfield-client`, template Studio `higgsfield-ai/app-templates/studio` e um prompt oficial "build an app on the Higgsfield API"). Os dois têm de ficar **muito bem definidos** no plugin, e o Shibaox tem de saber usar a API (gerar media com a key) e construir apps do zero sobre ela.

Contrato verificado hoje na documentação: header `Authorization: Key <id:secret>` (a key colada como está, contém `:`); submit `POST /<model-path>` → `{request_id, status_url, cancel_url}`; `GET /requests/{id}/status` → `status` em `queued|in_progress|completed|failed|nsfw|canceled`, `images[].url`, `video.url`, `audio.url`, `audios[].url`, `error`; backoff 2 s → 10 s; 401 = corrigir credenciais, 404 = id desconhecido, 5xx = retry; `POST /requests/{id}/cancel`; upload `POST /files/generate-upload-url {content_type}` → `{upload_url, upload_headers, public_url}`, PUT com exactamente `upload_headers` e sem credencial; modelos por `https://docs.higgsfield.ai/docs/llms.txt`. Sonda de validade verificada: key errada ou ausente → 401 no status de um id inexistente (key válida → 404).

Factos do código (exploração): nada escreve `daemon.yaml` (só `loadDaemonConfig`); `AgentTool.execute(input)` não recebe contexto nem sinal de abort (a key só pode chegar por closure, como `withMcp` em `higgsfield-tools.ts`); `higgsfield_upload` é ligado em `RunManager.taskTools().extra` (~:1015) quando `role.mcp` inclui `higgsfield`; o MCP é montado em `mcpFor` (`runtime.ts` ~:346) para os dois adapters; keys do vault nunca chegam aos subprocessos (`commandEnv`, `scrubbedEnv`, allowlist do claude-code); `KNOWN_KEYS`/`BUILT_IN` em `secrets.ts`; o poll do login na app procura o check "Logged in"; `needed-keys.ts` ignora plugins `off`.

## Decisões

- **Um plugin, dois modos** (`modes: [account, api]`), com estado, checks, acções e "brings" próprios; nível de topo = modo activo. Escolha `partners.higgsfield.mode: auto|account|api` em `daemon.yaml` (default `auto` = API se a key existir, senão Conta). O modo é lido **por tarefa** (não por run); um run em curso mantém a tarefa actual.
- **Ferramentas de API no daemon** (`higgsfield_api_generate|status|cancel|upload`) com a key em closure; em modo API o MCP `higgsfield` **não** arranca e `higgsfield_upload` não é oferecida; em modo Conta o inverso.
- **Uma skill `higgsfield`** que cobre os dois caminhos ("qual está activo: se tens `higgsfield_api_*` usa a API; se tens as tools MCP usa a conta; nunca os dois") e uma **nova skill `higgsfield-app`** com o prompt oficial "build an app on the Higgsfield API" (template Studio, "Connect API key", key só no servidor). Não é um stack novo (stacks são overlays de org; o scaffold é uma tarefa do assistant com `pnpm dlx shadcn…`).
- Key `HIGGSFIELD_API_KEY` no vault (par `id:secret` colado como está; validação `^[^\s:]+:\S+$`); copy exacta "Paste the API key copied from open.higgsfield.ai. Paste it as-is." num único campo password.
- Fonte de skills `builtin` (copiar do `ORG_TEMPLATE`) para o "brings" e para actualizar orgs existentes (`shibaox skills add higgsfield --builtin --replace`).

## Tarefas (ordem de dependência, TDD em cada uma)

### 1. `daemon.yaml`: modo e escritor
- Novo `packages/daemon/src/yaml-file.ts` com `readDoc`/`writeAtomic` (mover de `org-config.ts`, que re-exporta).
- `config.ts`: `HIGGSFIELD_MODES = ['auto','account','api']`, `HiggsfieldMode`; `PartnersSchema.higgsfield.mode` com default `auto` (os dois `.default({...})` literais levam `mode`); `writeDaemonConfig(path, {higgsfieldMode})` (setIn, valida com `DaemonConfigSchema`, mkdir, `writeAtomic`, devolve `loadDaemonConfig`).
- Testes: ficheiro ausente → `auto`; `mode: bogus` → erro; escritor mantém comentários e o bloco `listen`, cria o ficheiro, recusa modo inválido sem tocar no ficheiro.

### 2. Key no vault
- `secrets.ts`: `HIGGSFIELD_API_KEY` em `BUILT_IN` ("Higgsfield API (open.higgsfield.ai): the id:secret pair as copied"); `VALUE_RULES` aplicadas em `set()` depois de `trim()` com a mensagem "…the whole key as copied… (id:secret, with its colon): paste it as-is".
- Testes: trim; `abc`, `:def`, `abc:`, `a b:c` recusados com a mensagem; `list()` só mascarado; `PUT /keys/HIGGSFIELD_API_KEY {value:'nocolon'}` → 400.

### 3. `higgsfield.ts`: sonda da API e modos
- `HIGGSFIELD_API`, `apiBase(env)` (override `SHIBAOX_HIGGSFIELD_API_BASE` para testes/doctor), `PROBE_REQUEST_ID`, `apiValidity(status)` (401/403 → false, 404 → true, resto `'unknown'`), `effectiveHiggsfieldMode(mode, {keySet, loggedIn})` → `account|api|none`, `runtimeHiggsfieldMode(mode, keySet)` → `account|api`.
- `HiggsfieldView` ganha `api: {keySet, valid?, status?, checkedAt?}`, `mode`, `effective`; `HiggsfieldProbe.apiCheck?(key)` = GET status do id zero com `authorization: Key <key>`, 10 s, `redirect:'manual'`.
- Testes: tabelas de `apiValidity`/modos; sonda contra `http.createServer` local (path, header, 401/404/500/recusa de ligação).

### 4. Daemon, rota do modo, cliente
- `daemon.ts`: `higgsfieldAccount()` (cache actual), `higgsfieldApi()` (sem key → `{keySet:false}` sem sonda; cache 60 s por sha256 da key), `higgsfield()` compõe `{...account, api, mode, effective}`; `setKey/unsetKey` limpam a cache da API; `setHiggsfieldMode(mode)` → `writeDaemonConfig` + patch em memória + log.
- `server.ts`: `PUT /integrations/higgsfield {mode}` só para chamadas locais (403 caso contrário, mesma regra do login), 400 em modo inválido; `client.ts`: `setHiggsfieldMode`.
- Testes: sem key não sonda; cache; nova key sonda de novo; 401 → `valid:false`; `effective` nos três casos; PUT pelo socket escreve `mode: api` mantendo comentários; listener não-local e `X-Forwarded-For` → 403; `{mode:'x'}` → 400.

### 5. `plugins.ts`: modos
- `PluginMode {id, name, description, active, status, checks, keys, actions, brings}`; `PluginRow.modes?`, `PluginRow.mode? {configured, effective}`; `Brings` ganha `tools?` e `builtin?`.
- Conta: checks de hoje (labels iguais, "Logged in" mantém-se), acções de hoje, brings connector+skill+builtin `higgsfield`. API: checks "API key saved", "API key valid" (detalhe accepted / rejected by Higgsfield (401) / not checked / no key); keys `[{HIGGSFIELD_API_KEY, present}]`; acções `connect_key` (label Connect/Manage API key, href open.higgsfield.ai/api-keys), `docs`; brings skills `higgsfield`, `higgsfield-app` (builtin) e tools `higgsfield_api_*`. Topo = modo activo (`effective==='api'` → api, senão account). Outros plugins sem `modes`.
- Testes: só conta; key válida em auto → ready e key listada; `api` explícito sem key → `off` com `mode.configured 'api'`; GitHub sem `modes`.

### 6. Ferramentas da API (`runs/higgsfield-api-tools.ts`)
- Refactor: `uploadableFile(workspace, path, protectedGlobs)` extraída de `higgsfield-tools.ts` (mensagens iguais; testes actuais protegem).
- `HiggsfieldApiDeps {key(), fetch, workspace, protectedGlobs, base?, now?, sleep?, random?, signal?(), log?}`; `nextDelay` (2 s → ×1.5 até 10 s, jitter ±20 %); `scrub(text, key)` (key, a metade secreta e URLs com query → `[redacted]`).
- `higgsfield_api_generate {model_path, input: record, wait=true, timeout_s 10..900 (600)}`: path normalizado e validado (`^[a-z0-9][\w.-]*(\/[a-z0-9][\w.-]*)+$`, sem `..`, não `requests/`/`files/`); POST **nunca repetido** (5xx/rede → erro "pode existir ou não, não voltes a submeter, pergunta ao utilizador"); poll com backoff; 401/403 → "Higgsfield refused the API key: replace it in Customize → Plugins → Higgsfield"; 404 → id desconhecido; 5 falhas 5xx seguidas → `status:'unknown'` com nota; terminal → `{request_id, status, images[], video, audio[], error}`; no deadline cancel best-effort e `canceled_by_timeout`; abort do run → cancel e throw.
- `higgsfield_api_status {request_id}`, `higgsfield_api_cancel {request_id}`, `higgsfield_api_upload {path}` (confinamento de `uploadableFile`; generate-upload-url → PUT com exactamente `upload_headers`, sem Authorization, timeout `uploadTimeoutMs`; erro só com o `<Code>` do XML; devolve `{public_url, content_type, path, bytes}`; `upload_url` nunca devolvido nem logado).
- Regras: key lida em `d.key()` a cada chamada (ausente → "HIGGSFIELD_API_KEY is not set: Customize → Plugins → Higgsfield → Connect API key"); `AbortSignal.any([timeout 30 s, sinal do run])`; toda a mensagem/log passa por `scrub`.
- Testes com `fetch` falso e relógio falso: caminho feliz (um POST, header `Key id:secret`, delays 2000/3000, 2 imagens); failed/nsfw/canceled; 401 sem segredo na mensagem; 503 no submit sem retry; 5xx ×2 no status e depois completed; timeout → cancel; abort → cancel + rejeição; `wait:false`; paths maus recusados antes de qualquer fetch; upload feliz (headers deep-equal, sem authorization em qualquer caixa, ordem), erro sem URL assinada; recusas (`src/a.png`, `.env`, glob protegido, 51 MB, `.txt`, fora do workspace); key ausente; `scrub`.

### 7. Gating no runtime e no run manager
- `runtime.ts`: `roleMcpSpecs(org, env, job, skip?)` extraída de `mcpFor`; `RuntimeOptions.skipMcp?(job, id)`.
- Novo `runs/higgsfield-gate.ts`: `higgsfieldPlan(role, mode, hasCatalogServer)` → `{apiTools, upload, skipMcp}` (`wants = role.mcp` ou `role.tools` inclui `higgsfield`; `apiTools = wants && mode==='api'`; `upload = mode==='account' && role.mcp inclui && hasCatalogServer`; `skipMcp = mode==='api'`).
- `run-manager.ts`: `RunManagerOptions.higgsfield? {mode(), fetch?}`; `hfMode()` = `runtimeHiggsfieldMode(mode(), !!env.HIGGSFIELD_API_KEY)`; `buildEngine` passa `skipMcp`; em `taskTools().extra(job)` o bloco actual gated por `plan.upload` e `higgsfieldApiTools({...})` por `plan.apiTools`; `toolAborts: Map<runId, AbortController>` + `toolSignal(runId)`, abortado em `cancel()`, `stop()` e no `finally` de `execute()`. `daemon.ts` passa `higgsfield: {mode: () => this.config.partners.higgsfield.mode}`.
- Testes: tabela de `higgsfieldPlan`; `roleMcpSpecs` com skip (playwright mantido); teste de RunManager com adapter falso a capturar `mcpServers`/tools permitidas em `chat` nos dois modos; `cancel` aborta o controller.

### 8. Fonte de skills `builtin`
- `SkillAddRequest |= {source:'builtin', id, replace?}`; `BUILTIN_SKILLS` do `ORG_TEMPLATE`; 404 para id desconhecido; `exists` sem replace; replace reescreve. CLI `shibaox skills add <id> --builtin [--replace]`.
- Testes: cria com o texto do template; skipped quando existe; replace; 404; flag da CLI → body.

### 9. Templates, skills, prompt, registo, upgrade
- `assistant.yaml`: `skills: [higgsfield, higgsfield-app]`. Prompt: geração "pelas tools da API ou pelo MCP da conta, ver a skill higgsfield"; "When asked to build an app or product on Higgsfield, follow the higgsfield-app skill."
- `skills/higgsfield/SKILL.md`: (1) qual o caminho activo; (2) caminho API: modelos por defeito (imagem `higgsfield-ai/soul/standard`; vídeo `kling-video/v2.5-turbo/pro/text-to-video` ou `bytedance/seedance-2.0/text-to-video`; image-to-video `kling-video/v2.5-turbo/standard/image-to-video`), `web_fetch` do `llms.txt` antes de um modelo desconhecido, um pedido por resultado, perguntar antes de vídeo, referências via `higgsfield_api_upload` → `public_url`, `unknown`/`canceled_by_timeout` → `higgsfield_api_status` e nunca resubmeter, guardar com `download_file` em `outputs/`, falhas (401 → substituir key; nsfw → não repetir; failed → uma correcção só se o erro nomear um parâmetro); (3) caminho Conta: texto actual.
- `skills/higgsfield-app/SKILL.md`: o prompt oficial adaptado (scaffold `pnpm dlx shadcn@latest init -t next -n <app> --no-monorepo -y higgsfield-ai/app-templates/studio` ou `studio-bare`, `shadcn add higgsfield-ai/app-templates/<model>`; copy exacta do Connect API key num campo password; key só no servidor (`HF_CREDENTIALS`/`HF_KEY`, `.env.local`); `request_id` por utilizador; nunca repetir um POST às cegas; manter todos os modelos; verificar `pnpm build` e que `.next/static` não contém `HF_`/`Key `).
- `registry/connectors.ts`: nota com os dois modos. Doctor avisa quando a skill da org não contém `higgsfield_api_` (sugere `shibaox skills add higgsfield --builtin --replace`).
- Upgrade do org do Andre: `shibaox skills add higgsfield --builtin --replace`; Plugins → Higgsfield → API → + skill `higgsfield-app` (Roles: assistant); linha nova no prompt.
- Testes: scaffold tem as duas skills; skill `higgsfield` contém `higgsfield_api_generate`, `llms.txt`, "never both"; `higgsfield-app` contém a frase do Connect e `studio`; prompt contém "higgsfield-app skill"; nota do registo.

### 10. App
- `client.ts`: `setHiggsfieldMode`; store: `setHiggsfieldMode` (act + `refreshHiggsfield`), poll do login lê `modes` (check "Logged in" do modo account); `needed-keys.ts`: `HIGGSFIELD_API_KEY` em `BUILT_IN_KEYS`, plugins `off` só ignorados quando `mode.configured` não é `account|api`.
- `PluginsTab.tsx`: `PluginBody({part})`; com `modes`: `S.Segmented` Account | API (estado inicial = modo activo), `S.Select` "Use for generation" (Auto · Account · API → `store.setHiggsfieldMode`) + linha "Now: API/Account/nothing set up"; acção `connect_key` → botão primário que abre `ApiKeyDialog`; `addSkill` usa `{source:'builtin', id}` quando em `brings.builtin`; parágrafo de afiliado só no painel Conta; painel API diz que a geração é facturada à conta de programador.
- `dialogs/ApiKeyDialog.tsx`: Connect (título "Connect API key", descrição exacta "Paste the API key copied from open.higgsfield.ai. Paste it as-is.", um `Input type=password`, link "Get a key" para open.higgsfield.ai/api-keys com `rel=noopener noreferrer`, Save desactivado vazio, validação `^\S+:\S+$` com erro "Copy the whole key from open.higgsfield.ai (it has a colon)", `store.setKey('HIGGSFIELD_API_KEY', v.trim())`); Manage (mascarada + validade, Replace → formulário, Remove → ConfirmDialog → `unsetKey`; `source==='env'` esconde Remove).
- Testes: segmented troca os checks; copy exacta e um único input password; setKey com `['HIGGSFIELD_API_KEY','id:secret']`; `nocolon` recusado; Replace/Remove; Select → `setHiggsfieldMode('api')`; poll do login pára com `modes`; Keys lista `HIGGSFIELD_API_KEY` em Needed now com `mode.configured==='api'` e não em Providers; testes actuais de Plugins verdes.

### 11. CLI
- `shibaox plugins`: imprime `mode auto → api` e cada modo `[api] active ready` com checks; JSON mantém a linha inteira. `shibaox plugins higgsfield-mode <auto|account|api>`.
- Doctor: linha `higgsfield api` (`key set, valid · mode auto → api` / `key set, rejected (401)` / `no key (optional: …/api-keys)`) via `apiCheck` com `SHIBAOX_HIGGSFIELD_API_BASE`; aviso da skill desactualizada.
- `keys set`: imprime a mensagem do 400 e sai com 1.
- Testes: doctor contra servidor local (404/401/sem key); `keys set HIGGSFIELD_API_KEY nocolon` → 1; output de plugins com `[api]` e `[account]`.

### 12. Wiki
- `MCP-and-skills.md` "Plugins → Higgsfield: account or API" (modos, o que cada um traz, regra de selecção por tarefa, tools e limites, fonte builtin); `Configuration.md` (`partners.higgsfield.mode`, `SHIBAOX_HIGGSFIELD_API_BASE`, parágrafo de upgrade); `Security.md` (key só no vault e nas tools do daemon, nunca em subprocessos; sonda e cache; URLs assinadas nunca devolvidas/logadas; PUT sem credencial; `PUT /integrations/higgsfield` local-only); `App.md` (Plugins); `CLI-reference.md`.

## Riscos e rulings
- Poll assíncrono (`sleep`) não bloqueia o daemon; corre dentro da tool da tarefa, cap 900 s.
- Cancel do run → abort da tool → cancel best-effort na Higgsfield; mudança de modo a meio só afecta a tarefa seguinte.
- Sonda confirmada hoje (401 para key má); se mudar, só `valid` degrada para `unknown`.
- O binário `higgsfield` fica em `assistant.tools` em modo API; só a skill impede gastar créditos da conta (remover por modo = alterar o role em runtime; adiado).
- `input: z.record` é um objecto JSON aberto; providers de schema estrito podem recusar → fallback `input_json: string`.
- Os URLs CDN dos resultados aparecem nos eventos (como hoje); as URLs assinadas nunca.

## Processo e verificação
Ramo `feat/higgsfield-api` a partir de main; TDD por tarefa; revisão por agente fresco (daemon e app) com pacote `git diff main...HEAD -U8` (sem lock e vendor); uma passagem de correcções; `pnpm build && pnpm test && pnpm lint` (13 avisos aceites, 0 erros); merge ff; release 0.2.13; publish por pacote; tag; restart do daemon; wiki; memória; instalação do dmg.

Validação ao vivo: (1) `curl` do probe com key má → 401 (feito); (2) na app, Plugins → Higgsfield → API → Connect API key com a key do Andre (ele cola; nunca a imprimir) → "API key valid"; (3) "Use for generation: API" → `daemon.yaml` com `mode: api`; (4) um run "gera uma imagem de um shiba" → `higgsfield_api_generate` em `higgsfield-ai/soul/standard` → `outputs/*.png` (um pedido; custo da conta de programador); (5) com uma imagem anexa → `higgsfield_api_upload` → `public_url` usado como referência; (6) "Use for generation: Account" → o MCP volta e as tools da API desaparecem (eventos do run); (7) `shibaox doctor` e `shibaox plugins` mostram os dois modos; (8) `shibaox skills add higgsfield --builtin --replace` no org do Andre + `higgsfield-app` ligada ao assistant.
