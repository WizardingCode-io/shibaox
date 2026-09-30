# shibaox — item 10: templates de equipa por stack (`shibaox init --stack`)

Data: 2026-09-30. Item 10 do roteiro pós-base.

## Objectivo

`shibaox init [dir] --stack node|python|php-laravel|go|auto` escreve, por cima do scaffold
genérico, o que uma equipa desse stack precisa no primeiro dia: `shibaox.yaml` com os
comandos certos e ficheiros protegidos, um gate `typecheck`, um `review` com critérios do
stack, um workflow + rotina `security-scan` semanal, e (node) o papel `frontend`.

## Detecção (`packages/core/src/gates/detect.ts`)

- `detectStack(dir)`: `package.json` → `node`; `pyproject.toml`/`requirements.txt`/`setup.py`
  → `python`; `composer.json` + `artisan` → `php-laravel`; `go.mod` → `go`; senão `undefined`.
- `detectTypecheckCommand(dir)`: `shibaox.yaml typecheck` primeiro; node com `tsconfig.json` →
  `<runner> exec tsc --noEmit` (`pnpm exec`/`yarn`/`bunx --no-install`? → usar `npx --no tsc
  --noEmit`); python com `mypy.ini`/`[tool.mypy]` → `mypy .`, `pyrightconfig.json` → `pyright`;
  go → `go vet ./...`; php com `phpstan.neon(.dist)` → `vendor/bin/phpstan analyse
  --no-progress`; senão `undefined`.
- `ProjectFileSchema.typecheck?: string`.

## Scaffold (`packages/daemon/src/templates.ts`)

`scaffoldOrg(dir, { stack? })`: escreve primeiro os ficheiros do stack, depois o genérico
(nunca sobrepõe ficheiros existentes). Por stack:

- `shibaox.yaml` (em `dir`): `setup` detectado (ou o canónico do stack), `tests`, `lint`,
  `typecheck` (quando detectado), `protected: ['.github/workflows/**', '.env', '.env.*']`
  (+ `composer.lock`/`go.sum`? não: lockfiles mudam de propósito).
- `org/gates/typecheck.yaml`: `{ name: typecheck, type: code, command: <detectado> }`; sem
  comando detectado, o ficheiro leva o check comentado.
- `org/gates/review.yaml`: `criteria` do stack (node: tipos sem `any` novos, erros tratados,
  sem `console.log`, testes ao lado; python: type hints, sem `except:` vazio, sem prints;
  laravel: validação em FormRequest, sem queries em views, migrações reversíveis; go: erros
  tratados e embrulhados, contextos passados, sem `panic` em código de biblioteca).
- `org/workflows/security-scan.yaml`: `audit` (code, `npm audit --audit-level=high` /
  `pip-audit` / `composer audit` / `govulncheck ./...`, `skip_if_missing: true`) → `triage`
  (task, analyst: resume as vulnerabilidades e propõe correcções) — sem nó humano.
- `org/routines/security-scan.yaml`: `on: { cron: '0 9 * * 1' }`, `workflow: security-scan`,
  `max_daily_usd: 2` (carregada com `shibaox routine sync --org`).
- node: `org/roles/frontend.yaml` (read, write, node, npm/pnpm, npx) + prompt.
- `teams/engineering.yaml`: `gates: [tests, typecheck]` quando o typecheck existe; roles +=
  `frontend` (node); workflows += `security-scan`.

## CLI

`shibaox init [dir] [--stack <s>]`; `auto` detecta em `dir` e diz o que escolheu; sem stack
detectável, `auto` cai no genérico com uma nota. A saída lista o stack e os ficheiros.

## Docs

Installation/Quickstart (`shibaox init --stack auto`), Configuration (`shibaox.yaml
typecheck`, gate `typecheck`), Gates, Routines (`security-scan`), CLI reference, README.

## Revisão (2026-09-30, passagem de correcções)

- O `typecheck` passou a ser um tipo de check (`type: typecheck`) resolvido em cada run (como
  `tests`/`lint`); o gate é escrito sempre e entra nos gates `qa` dos workflows genéricos, que
  o scaffold do stack reescreve com `[tests, typecheck]` (assim não há injecção de gates de
  equipa noutro sítio); `security-scan` tem `team_gates: false`.
- O nó `code` ganhou `ok_exit_codes` (default `[0]`): o audit encontra vulnerabilidades e sai
  com 1 (npm/pnpm/pip-audit/composer) ou 3 (govulncheck) e a triagem corre na mesma; o comando
  do audit depende do lockfile (pnpm/yarn/bun/npm, `--package-lock-only` sem lockfile;
  `pip-audit -r requirements.txt` ou `uv run --with pip-audit pip-audit .`).
- `shibaox.yaml` escreve só `protected` (com `shibaox.yaml` e `.env.local`/`.env.*.local`);
  o que foi detectado fica em comentário (a detecção corre em cada checkout, nunca fica
  congelada). `go` usa `go build ./...` como typecheck. Checks `code` aceitam
  `skip_if_missing`.
- `init --stack` num org existente lista os ficheiros que manteve e como ligar o resto à mão;
  `auto` numa pasta inexistente diz que ela não existe.
