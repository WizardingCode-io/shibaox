# shibaox — item 9: aprovações semânticas e ficheiros protegidos

Data: 2026-09-30. Item 9 do roteiro pós-base.

## Objectivo

Uma única política de comandos para os dois runtimes, com categorias com significado
(`push`, `deploy`, `execute`, `network`, `protected`), e ficheiros que um run não pode tocar
sem um humano dizer que sim.

## Política (`packages/core/src/run/command-policy.ts`)

- `classifyArgv(argv, ctx?) → { program, category?, refused? }` com `ctx = { network?: string[],
  localBin?: (name) => boolean }`:
  - `push`: `git push` / `send-pack` (o parser de git do Claude Code mantém-se; o direct usa
    o mesmo classificador depois do seu split).
  - `deploy`: a tabela única `DEPLOY_VERBS`/`DEPLOY_FLAGS`/`VERCEL_READ_ONLY` (hoje duplicada e
    mais fraca no direct) + `gh` escrita (`ghPolicy`); `refused` para `gh` recusado.
  - `execute`: código arbitrário fora da allowlist: `sh|bash|zsh|dash|fish -c`, `node -e|--eval|
    -p|--print`, `python|python3 -c`, `ruby|perl -e`, `php -r`, `sudo`/`doas` (sempre), `npx`/
    `npm exec`/`bunx` quando o binário não é local (`ctx.localBin(name)`: `node_modules/.bin/
    <name>` ou `node_modules/<pkg>`), `pnpm dlx`/`yarn dlx`/`uvx`/`pipx run` (sempre remoto).
  - `network`: `curl`, `wget`, `http`/`https`/`xh` (URLs nos argumentos: todas as hosts em
    `ctx.network` → sem categoria; qualquer outra ou nenhuma URL reconhecível → `network`);
    `ssh`, `scp`, `sftp`, `rsync` com destino remoto → `network`.
  - Tudo o resto: sem categoria (a "tabela de leitura-só" é implícita: `git status`, `gh pr
    view`, `kubectl get` não pedem nada).
- `protectedGlobs(role, projectFile?)` = `role.permissions.protected` + `shibaox.yaml protected`;
  `isProtected(relPath, globs)` com `node:path.matchesGlob` (relativo à raiz do workspace,
  `**` suportado, uma pasta `infra/**` protege tudo lá dentro).

## Esquema

- `RoleSchema.permissions.protected: string[]` (default `[]`); `approval_required` aceita
  `push|deploy|execute|network|protected` (enum; outro valor é erro).
- `ProjectFileSchema.protected` deixa de ser "reservado".
- `ToolApprovalRequested.tool: 'Bash' | 'file'`, `category` alargada; `PendingApproval`,
  `ApprovalRequest`, inbox `detail.category` idem.

## Adapters

- Direct `run_command`: `classifyArgv` com `network` do papel e `localBin` do workspace; uma
  categoria pede aprovação como hoje (`approval_required` → pergunta; senão recusa com a
  mensagem `X requires approval_required: [X] in the role`). `write_file` num caminho protegido
  → categoria `protected` (tool `file`, argv `['write', rel]`) com o mesmo fluxo.
- Claude Code `canUseTool`: Bash idem (o `analyseBashCommand` devolve `argv`, a categoria vem
  de `classifyArgv`); ferramentas de escrita (`Edit`/`Write`/`MultiEdit`/`NotebookEdit`) num
  caminho protegido → `protected` com o mesmo fluxo (`interrupt` quando diferido).
- O daemon passa a ambos `protected: (job) => globs` (papel + `shibaox.yaml` da raiz do
  workspace) e a lista `network` já vem do papel.

## Fora de âmbito

Edições a ficheiros protegidos por comandos shell (`sed -i`) — documentado como lacuna; a
recusa do nó `commit` para ficheiros protegidos (a seguir, se fizer falta).
