# App, fatia 2: Scheduled · Skills · Memory · Integrations · Settings completo — plano

> Executado inline (testes primeiro, revisão no fim, uma passagem de correcções, merge, release 0.2.2). Spec: `docs/superpowers/specs/2026-09-30-shibaox-app-design.md`.

## Tarefas

### T1 daemon `OrgInfo` mais rico
- `descriptions: Record<workflow, description>` e `catalog: {id, type, description}[]` (para Skills). Teste em `org-config.test.ts`/`server.test.ts`.

### T2 cliente do browser
- `routines, runRoutine, pauseRoutine, resumeRoutine, removeRoutine, addRoutine, syncRoutines, keys, setKey, unsetKey, orgConfig, setOrgConfig, mcpList, mcpTest, projectProfile` com os caminhos do `DaemonClient`. Testes de caminhos.

### T3 store
- Secções carregadas a pedido: `loadRoutines()`, `loadIntegrations(org)` (mcp, modelos, chaves, config), `loadSkills(org)`, `loadMemory(project, org)`; acções `runRoutine/pauseRoutine/resumeRoutine/removeRoutine/addRoutine/syncRoutines`, `setKey/unsetKey`, `setOrgConfig`, `mcpTest`, `runWorkflow({workflow, text, project?, model?})` (abre a thread), `setThreadModel(rootId, ref)` usado no próximo turno; erros → `state.error`. Testes com cliente falso.

### T4 ecrãs (design system)
- **Scheduled**: Card por rotina (nome, trigger em palavras, projecto, último disparo, Badge on/paused, origem org/api), botões **Run now**, **Pause**/**Resume**, **Remove** (api); **Add routine** (formulário: trigger `cron|github|url|file|command` + valor, workflow, pedido, projecto) e **Sync from org**. Contagem no NavItem = rotinas activas.
- **Skills**: Card por workflow do org (descrição) com **Run task** (formulário: pedido, projecto, modelo → thread nova); entradas do catálogo (`skill`, `plugin`, `tool`) listadas.
- **Memory**: perfil do projecto (stack, branch, ficheiros, gestor, comando de testes), org (nome, adapter, tiers), onde vivem o vault e as notas.
- **Integrations**: MCP (Card por servidor: transporte, alvo, papéis, chaves em falta, **Test** → ferramentas), Providers e modelos (linhas: ref, configurado/em falta/local), Keys (linha por chave: estado, origem, mascarada; **Set** com Input, **Unset**), Tiers (strong/cheap/decision/judge/adapter/budget com **Save**).
- **Conversa**: escolha do modelo por conversa (botão quiet com o modelo → lista de `GET /models` configurados) aplicada ao próximo turno; **Settings** já completo (ligação, tema, nome, defaults, versão, Disconnect).
- Testes testing-library por ecrã com o cliente falso.

### T5 docs + release 0.2.2
- `App.md` (secções), CLI-reference sem alterações; wiki sync; memória.
