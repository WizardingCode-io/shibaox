# shibaox Fase 1A (motor) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ter o motor do shibaox a correr um workflow YAML fim a fim em modo solo, com event store SQLite, gates, decisões e aprovação humana, usando um adaptador mock no lugar dos runtimes.

**Architecture:** Monorepo pnpm/turborepo em TypeScript. `@shibaox/schemas` valida os YAML da organização com zod. `@shibaox/core` tem o event store (interface + memória), o reducer puro `replay(events) → RunState`, o scheduler `readyNodes(state, workflow)`, executores (mock, code), motor de gates e o `RunEngine` que liga tudo. `@shibaox/persistence-sqlite` implementa o event store em better-sqlite3. `@shibaox/cli` expõe `shibaox init|doctor|run|runs|replay`. O adaptador Claude Code, o Jev, o router e a memória ficam para o plano 1B.

**Tech Stack:** Node 22, pnpm 10, turborepo 2, TypeScript 5 (ESM, NodeNext), vitest 5, biome 2, zod 4, yaml 2, better-sqlite3 13, commander 15.

**Spec:** `docs/superpowers/specs/2026-09-25-shibaox-design.md` (secções 1, 2, 3, 5 e a parte de CLI da secção 9/fase 1).

## Global Constraints

- Node `>=22`, pnpm `>=10`. Tudo ESM (`"type": "module"`), `module: NodeNext`, imports relativos com extensão `.js`.
- TypeScript `strict: true`. Sem `any` fora de testes.
- Eventos são imutáveis e append-only; o estado de um run deriva sempre de `replay(events)`. Nunca guardar estado derivado como fonte de verdade.
- O runtime nunca conhece o workflow: um `TaskJob` entra, um `TaskResult` sai.
- Nomes de pacotes: `@shibaox/schemas`, `@shibaox/core`, `@shibaox/persistence-sqlite`, `@shibaox/cli`. Binário: `shibaox`.
- Commits pequenos, mensagens em inglês no formato `type(scope): message`, terminadas com `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Desvio da spec, decidido aqui: no nó `gate` de um workflow o campo chama-se `gates` (lista de ids de definições de gate em `gates/*.yaml`), e cada definição de gate tem `checks`. A spec usava `checks` para ambos.

## Review Focus

1. Workflow com `next`/`on_pass`/`join` a apontar para um nó inexistente: o loader tem de recusar com o nome do ficheiro e do nó, nunca falhar a meio de um run. Teste em Task 2.
2. Gate que reprova sempre: o rework não pode ser infinito. Com `max_retries` esgotado o run termina em `failed` com relatório. Teste em Task 9.
3. Comando de check `code` que pendura: o timeout tem de matar o processo e o check reprova com evidência "timed out". Teste em Task 6.
4. Processo morto a meio do run: `resume(runId)` a partir do event log continua no nó certo sem repetir nós já concluídos. Teste em Task 9 e Task 10.
5. Nó `human` sem terminal interativo: o run fica em `waiting_human` e `replay` mostra isso, em vez de bloquear ou aprovar sozinho. Teste em Task 9.

---

### Task 1: Bootstrap do monorepo

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `biome.json`, `.gitignore`, `.npmrc`
- Create: `packages/schemas/package.json`, `packages/schemas/tsconfig.json`, `packages/schemas/vitest.config.ts`, `packages/schemas/src/index.ts`, `packages/schemas/test/smoke.test.ts`

**Interfaces:**
- Produces: layout do monorepo e scripts `pnpm build`, `pnpm test`, `pnpm typecheck` que todas as tarefas seguintes usam.

- [ ] **Step 1: Ficheiros da raiz**

`package.json`:
```json
{
  "name": "shibaox",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "packageManager": "pnpm@10.27.0",
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "lint": "biome check .",
    "format": "biome format --write ."
  },
  "devDependencies": {
    "@biomejs/biome": "^2.11.4",
    "turbo": "^2.5.14",
    "typescript": "^5.9.0",
    "vitest": "^5.0.2"
  },
  "pnpm": { "onlyBuiltDependencies": ["better-sqlite3"] }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - packages/*
  - apps/*
```

`turbo.json`:
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": { "dependsOn": ["^build"] },
    "typecheck": { "dependsOn": ["^build"] }
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "noUncheckedIndexedAccess": true
  }
}
```

`biome.json`:
```json
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "files": { "includes": ["**", "!**/dist", "!**/node_modules"] },
  "formatter": { "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "javascript": { "formatter": { "quoteStyle": "single" } }
}
```

`.gitignore`:
```
node_modules
dist
.turbo
*.db
.shibaox/
graphify-out/
```

`.npmrc`:
```
auto-install-peers=true
```

- [ ] **Step 2: Pacote schemas mínimo**

`packages/schemas/package.json`:
```json
{
  "name": "@shibaox/schemas",
  "version": "0.0.1",
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": { "yaml": "^2.9.1", "zod": "^4.6.5" }
}
```

`packages/schemas/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

`packages/schemas/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
});
```

`packages/schemas/src/index.ts`:
```ts
export const SCHEMAS_VERSION = '0.0.1';
```

`packages/schemas/test/smoke.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { SCHEMAS_VERSION } from '../src/index.js';

describe('schemas package', () => {
  it('exports a version', () => {
    expect(SCHEMAS_VERSION).toBe('0.0.1');
  });
});
```

- [ ] **Step 3: Instalar e correr**

Run: `pnpm install && pnpm build && pnpm test`
Expected: build de `@shibaox/schemas` OK e 1 teste a passar.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: bootstrap pnpm/turbo monorepo with schemas package

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Schemas zod dos YAML da organização

**Files:**
- Create: `packages/schemas/src/common.ts`, `src/workflow.ts`, `src/gate.ts`, `src/role.ts`, `src/team.ts`, `src/org.ts`, `src/models.ts`, `src/catalog.ts`
- Modify: `packages/schemas/src/index.ts`
- Test: `packages/schemas/test/workflow.test.ts`, `test/gate.test.ts`, `test/org-files.test.ts`

**Interfaces:**
- Produces: `WorkflowSchema`, `Workflow`, `WorkflowNode`, `transitionsOf(node)`, `GateSchema`, `Gate`, `Check`, `RoleSchema`, `Role`, `TeamSchema`, `Team`, `OrgFileSchema`, `OrgFile`, `ModelsSchema`, `Models`, `CatalogEntrySchema`, `CatalogEntry`, `ModelTier`.

- [ ] **Step 1: Teste do workflow (falha)**

`packages/schemas/test/workflow.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { WorkflowSchema, transitionsOf } from '../src/index.js';

const valid = {
  workflow: 'hello',
  start: 'a',
  nodes: {
    a: { type: 'task', role: 'analyst', next: 'g' },
    g: { type: 'gate', gates: ['tests'], on_pass: 'd', on_fail: 'a' },
    d: { type: 'decide', by: 'lead', options: ['ship', 'rework'], next: { ship: 'h', rework: 'a' } },
    h: { type: 'human', action: 'approve' },
  },
};

describe('WorkflowSchema', () => {
  it('accepts a valid workflow and applies defaults', () => {
    const wf = WorkflowSchema.parse(valid);
    expect(wf.nodes.g).toMatchObject({ type: 'gate', max_retries: 3 });
  });

  it('rejects a next pointing to an unknown node, naming it', () => {
    const bad = { ...valid, nodes: { ...valid.nodes, a: { type: 'task', role: 'x', next: 'nope' } } };
    const r = WorkflowSchema.safeParse(bad);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('nope');
  });

  it('rejects a decide whose options lack a transition', () => {
    const bad = {
      ...valid,
      nodes: { ...valid.nodes, d: { type: 'decide', by: 'lead', options: ['ship', 'rework'], next: { ship: 'h' } } },
    };
    expect(WorkflowSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an unknown start node', () => {
    expect(WorkflowSchema.safeParse({ ...valid, start: 'zzz' }).success).toBe(false);
  });

  it('transitionsOf lists every outgoing node id', () => {
    const wf = WorkflowSchema.parse(valid);
    expect(transitionsOf(wf.nodes.g!)).toEqual(['d', 'a']);
    expect(transitionsOf(wf.nodes.d!).sort()).toEqual(['a', 'h']);
    expect(transitionsOf(wf.nodes.h!)).toEqual([]);
  });
});
```

- [ ] **Step 2: Correr para ver falhar**

Run: `pnpm --filter @shibaox/schemas test`
Expected: FAIL, `WorkflowSchema` não exportado.

- [ ] **Step 3: Implementar common + workflow**

`packages/schemas/src/common.ts`:
```ts
import { z } from 'zod';

export const Id = z.string().min(1).regex(/^[a-z0-9][a-z0-9:_-]*$/i, 'ids use letters, digits, - _ :');
export const ModelTierSchema = z.enum(['strong', 'cheap', 'local', 'decision']);
export type ModelTier = z.infer<typeof ModelTierSchema>;
```

`packages/schemas/src/workflow.ts`:
```ts
import { z } from 'zod';
import { Id } from './common.js';

export const TaskNodeSchema = z.object({
  type: z.literal('task'),
  role: Id,
  instruction: z.string().optional(),
  next: Id.optional(),
});
export const CodeNodeSchema = z.object({
  type: z.literal('code'),
  command: z.string().min(1),
  timeout_ms: z.number().int().positive().default(300_000),
  next: Id.optional(),
});
export const HumanNodeSchema = z.object({
  type: z.literal('human'),
  action: Id,
  prompt: z.string().optional(),
  next: Id.optional(),
});
export const DecideNodeSchema = z.object({
  type: z.literal('decide'),
  by: Id,
  question: z.string().optional(),
  options: z.array(Id).min(2),
  next: z.record(z.string(), Id),
});
export const GateNodeSchema = z.object({
  type: z.literal('gate'),
  gates: z.array(Id).min(1),
  on_pass: Id,
  on_fail: Id,
  max_retries: z.number().int().min(0).default(3),
});
export const ParallelNodeSchema = z.object({
  type: z.literal('parallel'),
  branches: z.array(Id).min(1),
  join: Id,
});

export const WorkflowNodeSchema = z.discriminatedUnion('type', [
  TaskNodeSchema,
  CodeNodeSchema,
  HumanNodeSchema,
  DecideNodeSchema,
  GateNodeSchema,
  ParallelNodeSchema,
]);
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

export function transitionsOf(node: WorkflowNode): string[] {
  switch (node.type) {
    case 'task':
    case 'code':
    case 'human':
      return node.next ? [node.next] : [];
    case 'decide':
      return Object.values(node.next);
    case 'gate':
      return [node.on_pass, node.on_fail];
    case 'parallel':
      return [...node.branches, node.join];
  }
}

export const WorkflowSchema = z
  .object({
    workflow: Id,
    team: Id.optional(),
    description: z.string().optional(),
    start: Id,
    nodes: z.record(z.string(), WorkflowNodeSchema),
  })
  .superRefine((wf, ctx) => {
    const ids = new Set(Object.keys(wf.nodes));
    if (!ids.has(wf.start)) {
      ctx.addIssue({ code: 'custom', path: ['start'], message: `start node "${wf.start}" does not exist` });
    }
    for (const [id, node] of Object.entries(wf.nodes)) {
      for (const target of transitionsOf(node)) {
        if (!ids.has(target)) {
          ctx.addIssue({ code: 'custom', path: ['nodes', id], message: `node "${id}" points to unknown node "${target}"` });
        }
      }
      if (node.type === 'decide') {
        for (const opt of node.options) {
          if (!(opt in node.next)) {
            ctx.addIssue({ code: 'custom', path: ['nodes', id, 'next'], message: `decide "${id}" has no transition for option "${opt}"` });
          }
        }
        for (const key of Object.keys(node.next)) {
          if (!node.options.includes(key)) {
            ctx.addIssue({ code: 'custom', path: ['nodes', id, 'next'], message: `decide "${id}" transition "${key}" is not an option` });
          }
        }
      }
    }
  });
export type Workflow = z.infer<typeof WorkflowSchema>;
```

- [ ] **Step 4: Teste dos gates (falha)**

`packages/schemas/test/gate.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { GateSchema } from '../src/index.js';

describe('GateSchema', () => {
  it('parses a gate with code, jev, judge, human and mock checks', () => {
    const g = GateSchema.parse({
      gate: 'qa',
      checks: [
        { name: 'tests', type: 'code', command: 'npm test' },
        { name: 'spec', type: 'jev', question: 'The diff implements the spec' },
        { name: 'review', type: 'judge', role: 'team-leader', rubric: 'Correct and minimal' },
        { name: 'ok', type: 'human', prompt: 'Looks good?' },
        { name: 'always', type: 'mock', passes: true },
      ],
    });
    expect(g.checks[0]).toMatchObject({ type: 'code', timeout_ms: 300_000 });
    expect(g.checks[1]).toMatchObject({ type: 'jev', kind: 'noul', threshold: 0.8 });
  });

  it('rejects an empty checks list', () => {
    expect(GateSchema.safeParse({ gate: 'x', checks: [] }).success).toBe(false);
  });
});
```

- [ ] **Step 5: Implementar gate, role, team, org, models, catalog**

`packages/schemas/src/gate.ts`:
```ts
import { z } from 'zod';
import { Id } from './common.js';

const base = { name: Id };
export const CheckSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('code'), command: z.string().min(1), timeout_ms: z.number().int().positive().default(300_000) }),
  z.object({ ...base, type: z.literal('jev'), question: z.string().min(1), kind: z.enum(['noul', 'score']).default('noul'), threshold: z.number().min(0).max(1).default(0.8) }),
  z.object({ ...base, type: z.literal('judge'), role: Id, rubric: z.string().min(1) }),
  z.object({ ...base, type: z.literal('human'), prompt: z.string().min(1) }),
  z.object({ ...base, type: z.literal('mock'), passes: z.boolean(), evidence: z.string().default('mock check') }),
]);
export type Check = z.infer<typeof CheckSchema>;

export const GateSchema = z.object({
  gate: Id,
  description: z.string().optional(),
  checks: z.array(CheckSchema).min(1),
});
export type Gate = z.infer<typeof GateSchema>;
```

`packages/schemas/src/role.ts`:
```ts
import { z } from 'zod';
import { Id, ModelTierSchema } from './common.js';

export const RoleSchema = z.object({
  role: Id,
  description: z.string().optional(),
  capabilities: z.array(z.string()).default([]),
  runtime: z.string().default('claude-code'),
  model_tier: ModelTierSchema.default('strong'),
  system_prompt: z.string().optional(),
  tools: z.array(z.string()).default([]),
  permissions: z
    .object({
      fs: z.array(z.string()).default(['workspace']),
      network: z.array(z.string()).default([]),
      approval_required: z.array(z.string()).default([]),
    })
    .default({ fs: ['workspace'], network: [], approval_required: [] }),
});
export type Role = z.infer<typeof RoleSchema>;
```

`packages/schemas/src/team.ts`:
```ts
import { z } from 'zod';
import { Id } from './common.js';

export const TeamSchema = z.object({
  team: Id,
  description: z.string().optional(),
  lead: Id,
  roles: z.array(Id).min(1),
  gates: z.array(Id).default([]),
  workflows: z.array(Id).default([]),
});
export type Team = z.infer<typeof TeamSchema>;
```

`packages/schemas/src/org.ts`:
```ts
import { z } from 'zod';
import { Id } from './common.js';

export const OrgFileSchema = z.object({
  organization: Id,
  budgets: z
    .object({ monthly_usd: z.number().positive().optional(), per_run_usd: z.number().positive().optional() })
    .default({}),
  teams: z.array(Id).default([]),
});
export type OrgFile = z.infer<typeof OrgFileSchema>;
```

`packages/schemas/src/models.ts`:
```ts
import { z } from 'zod';
import { ModelTierSchema } from './common.js';

export const ModelsSchema = z.object({
  providers: z
    .record(z.string(), z.object({ api_key_env: z.string().optional(), base_url: z.string().optional() }))
    .default({}),
  tiers: z.record(ModelTierSchema, z.string()).default({}),
  roles: z.record(z.string(), z.object({ model: z.string(), runtime: z.string().optional() })).default({}),
  gates: z.record(z.string(), z.string()).default({}),
});
export type Models = z.infer<typeof ModelsSchema>;
```

`packages/schemas/src/catalog.ts`:
```ts
import { z } from 'zod';
import { Id } from './common.js';

export const CatalogEntrySchema = z.object({
  id: Id,
  type: z.enum(['team', 'workflow', 'skill', 'plugin', 'mcp', 'tool']),
  description: z.string().min(1).max(200),
  tags: z.array(z.string()).default([]),
});
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
```

`packages/schemas/src/index.ts` (substituir):
```ts
export * from './common.js';
export * from './workflow.js';
export * from './gate.js';
export * from './role.js';
export * from './team.js';
export * from './org.js';
export * from './models.js';
export * from './catalog.js';
```

- [ ] **Step 6: Teste dos restantes ficheiros**

`packages/schemas/test/org-files.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { CatalogEntrySchema, ModelsSchema, OrgFileSchema, RoleSchema, TeamSchema } from '../src/index.js';

describe('org file schemas', () => {
  it('role gets defaults for runtime, tier and permissions', () => {
    const r = RoleSchema.parse({ role: 'backend' });
    expect(r.runtime).toBe('claude-code');
    expect(r.model_tier).toBe('strong');
    expect(r.permissions.fs).toEqual(['workspace']);
  });
  it('team requires lead and at least one role', () => {
    expect(TeamSchema.safeParse({ team: 'eng', lead: 'tl' }).success).toBe(false);
    expect(TeamSchema.parse({ team: 'eng', lead: 'tl', roles: ['tl'] }).gates).toEqual([]);
  });
  it('org and models parse with defaults', () => {
    expect(OrgFileSchema.parse({ organization: 'wc' }).teams).toEqual([]);
    expect(ModelsSchema.parse({}).tiers).toEqual({});
  });
  it('catalog description is capped at 200 chars', () => {
    const long = 'x'.repeat(201);
    expect(CatalogEntrySchema.safeParse({ id: 'a', type: 'skill', description: long }).success).toBe(false);
  });
});
```

- [ ] **Step 7: Correr testes**

Run: `pnpm --filter @shibaox/schemas test`
Expected: PASS (todos os ficheiros).

- [ ] **Step 8: Commit**

```bash
git add packages/schemas
git commit -m "feat(schemas): zod schemas for workflow, gate, role, team, org, models, catalog

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Loader do org repo (YAML → Org validado)

**Files:**
- Create: `packages/schemas/src/load.ts`
- Modify: `packages/schemas/src/index.ts` (adicionar `export * from './load.js';`)
- Test: `packages/schemas/test/load.test.ts`

**Interfaces:**
- Consumes: todos os schemas da Task 2.
- Produces: `loadOrg(dir: string): Org`, `type Org = { root: string; org: OrgFile; models: Models; teams: Record<string, Team>; roles: Record<string, Role>; workflows: Record<string, Workflow>; gates: Record<string, Gate>; catalog: Record<string, CatalogEntry> }`, `class OrgLoadError extends Error { file: string }`.

- [ ] **Step 1: Teste (falha)**

`packages/schemas/test/load.test.ts`:
```ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OrgLoadError, loadOrg } from '../src/index.js';

function scaffold(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'org-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

const good = {
  'org.yaml': 'organization: wc\nteams: [eng]\n',
  'teams/eng.yaml': 'team: eng\nlead: tl\nroles: [tl, backend]\ngates: [tests]\nworkflows: [hello]\n',
  'roles/tl.yaml': 'role: tl\n',
  'roles/backend.yaml': 'role: backend\n',
  'gates/tests.yaml': 'gate: tests\nchecks:\n  - { name: t, type: mock, passes: true }\n',
  'workflows/hello.yaml':
    'workflow: hello\nteam: eng\nstart: a\nnodes:\n  a: { type: task, role: backend, next: g }\n  g: { type: gate, gates: [tests], on_pass: h, on_fail: a }\n  h: { type: human, action: ok }\n',
};

describe('loadOrg', () => {
  it('loads a valid org directory', () => {
    const org = loadOrg(scaffold(good));
    expect(org.org.organization).toBe('wc');
    expect(Object.keys(org.roles).sort()).toEqual(['backend', 'tl']);
    expect(org.workflows.hello?.start).toBe('a');
    expect(org.models.tiers).toEqual({});
  });

  it('reports the file and node for a broken reference', () => {
    const dir = scaffold({ ...good, 'workflows/hello.yaml': good['workflows/hello.yaml'].replace('next: g', 'next: zzz') });
    expect(() => loadOrg(dir)).toThrowError(OrgLoadError);
    try {
      loadOrg(dir);
    } catch (e) {
      const err = e as OrgLoadError;
      expect(err.file).toContain('workflows/hello.yaml');
      expect(err.message).toContain('zzz');
    }
  });

  it('rejects a workflow task using a role the org does not define', () => {
    const dir = scaffold({ ...good, 'workflows/hello.yaml': good['workflows/hello.yaml'].replace('role: backend', 'role: ghost') });
    expect(() => loadOrg(dir)).toThrowError(/role "ghost"/);
  });

  it('rejects a team listing an unknown gate', () => {
    const dir = scaffold({ ...good, 'teams/eng.yaml': good['teams/eng.yaml'].replace('gates: [tests]', 'gates: [nope]') });
    expect(() => loadOrg(dir)).toThrowError(/gate "nope"/);
  });
});
```

- [ ] **Step 2: Correr para ver falhar**

Run: `pnpm --filter @shibaox/schemas test`
Expected: FAIL, `loadOrg` não exportado.

- [ ] **Step 3: Implementar**

`packages/schemas/src/load.ts`:
```ts
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ZodType } from 'zod';
import { type CatalogEntry, CatalogEntrySchema } from './catalog.js';
import { type Gate, GateSchema } from './gate.js';
import { type Models, ModelsSchema } from './models.js';
import { type OrgFile, OrgFileSchema } from './org.js';
import { type Role, RoleSchema } from './role.js';
import { type Team, TeamSchema } from './team.js';
import { type Workflow, WorkflowSchema } from './workflow.js';

export interface Org {
  root: string;
  org: OrgFile;
  models: Models;
  teams: Record<string, Team>;
  roles: Record<string, Role>;
  workflows: Record<string, Workflow>;
  gates: Record<string, Gate>;
  catalog: Record<string, CatalogEntry>;
}

export class OrgLoadError extends Error {
  constructor(
    public readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = 'OrgLoadError';
  }
}

function readYamlFile<T>(root: string, rel: string, schema: ZodType<T>): T {
  const file = join(root, rel);
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new OrgLoadError(relative(root, file), (e as Error).message);
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const msg = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new OrgLoadError(rel, msg);
  }
  return result.data;
}

function readDir<T extends Record<K, string>, K extends keyof T>(root: string, sub: string, schema: ZodType<T>, key: K): Record<string, T> {
  const dir = join(root, sub);
  if (!existsSync(dir)) return {};
  const out: Record<string, T> = {};
  for (const name of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const item = readYamlFile(root, join(sub, name), schema);
    out[item[key]] = item;
  }
  return out;
}

export function loadOrg(root: string): Org {
  if (!existsSync(join(root, 'org.yaml'))) throw new OrgLoadError('org.yaml', 'file not found');
  const org = readYamlFile(root, 'org.yaml', OrgFileSchema);
  const models = existsSync(join(root, 'models.yaml')) ? readYamlFile(root, 'models.yaml', ModelsSchema) : ModelsSchema.parse({});
  const teams = readDir(root, 'teams', TeamSchema, 'team');
  const roles = readDir(root, 'roles', RoleSchema, 'role');
  const workflows = readDir(root, 'workflows', WorkflowSchema, 'workflow');
  const gates = readDir(root, 'gates', GateSchema, 'gate');
  const catalog = readDir(root, 'catalog', CatalogEntrySchema, 'id');

  for (const t of org.teams) {
    if (!teams[t]) throw new OrgLoadError('org.yaml', `team "${t}" has no file in teams/`);
  }
  for (const [name, team] of Object.entries(teams)) {
    const file = `teams/${name}.yaml`;
    if (!roles[team.lead]) throw new OrgLoadError(file, `lead role "${team.lead}" is not defined in roles/`);
    for (const r of team.roles) if (!roles[r]) throw new OrgLoadError(file, `role "${r}" is not defined in roles/`);
    for (const g of team.gates) if (!gates[g]) throw new OrgLoadError(file, `gate "${g}" is not defined in gates/`);
    for (const w of team.workflows) if (!workflows[w]) throw new OrgLoadError(file, `workflow "${w}" is not defined in workflows/`);
  }
  for (const [name, wf] of Object.entries(workflows)) {
    const file = `workflows/${name}.yaml`;
    if (wf.team && !teams[wf.team]) throw new OrgLoadError(file, `team "${wf.team}" is not defined`);
    for (const [id, node] of Object.entries(wf.nodes)) {
      if (node.type === 'task' && !roles[node.role]) throw new OrgLoadError(file, `node "${id}" uses role "${node.role}" which is not defined`);
      if (node.type === 'gate') for (const g of node.gates) if (!gates[g]) throw new OrgLoadError(file, `node "${id}" uses gate "${g}" which is not defined`);
    }
  }
  return { root, org, models, teams, roles, workflows, gates, catalog };
}
```

Adicionar em `packages/schemas/src/index.ts`: `export * from './load.js';`

- [ ] **Step 4: Correr testes**

Run: `pnpm --filter @shibaox/schemas test && pnpm --filter @shibaox/schemas typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/schemas
git commit -m "feat(schemas): loadOrg reads and cross-validates the org repo

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Eventos, EventStore em memória e reducer

**Files:**
- Create: `packages/schemas/src/events.ts` (+ export no index)
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/vitest.config.ts`, `packages/core/src/index.ts`, `packages/core/src/events/store.ts`, `packages/core/src/events/memory-store.ts`, `packages/core/src/run/state.ts`, `packages/core/src/run/reducer.ts`
- Test: `packages/core/test/reducer.test.ts`, `packages/core/test/memory-store.test.ts`

**Interfaces:**
- Produces (schemas): `RunEventSchema`, `RunEvent`, `CostSchema`, `Cost`, `GateReportSchema`, `GateReport`, `CheckResult`.
- Produces (core): `interface EventStore { append(e: RunEvent): Promise<StoredEvent>; read(runId): Promise<StoredEvent[]>; listRuns(): Promise<RunSummary[]> }`, `type StoredEvent = RunEvent & { seq: number }`, `type RunSummary = { runId; workflow; status: RunStatus; createdAt: string; updatedAt: string }`, `class MemoryEventStore`, `type RunState`, `type NodeState`, `type RunStatus`, `reduce(state, event)`, `replay(events)`.

- [ ] **Step 1: Schema de eventos**

`packages/schemas/src/events.ts`:
```ts
import { z } from 'zod';

export const CostSchema = z.object({
  usd: z.number().min(0),
  inputTokens: z.number().int().min(0).default(0),
  outputTokens: z.number().int().min(0).default(0),
});
export type Cost = z.infer<typeof CostSchema>;

export const CheckResultSchema = z.object({
  name: z.string(),
  type: z.enum(['code', 'jev', 'judge', 'human', 'mock']),
  passed: z.boolean(),
  skipped: z.boolean().default(false),
  evidence: z.string(),
  suggestion: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const GateReportSchema = z.object({
  gates: z.array(z.string()),
  passed: z.boolean(),
  checks: z.array(CheckResultSchema),
  cost: CostSchema.optional(),
});
export type GateReport = z.infer<typeof GateReportSchema>;

const base = { runId: z.string(), at: z.string() };
const node = { ...base, nodeId: z.string() };

export const RunEventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('RunCreated'), workflow: z.string(), input: z.record(z.string(), z.unknown()), budgetUsd: z.number().positive().optional(), workspace: z.string() }),
  z.object({ ...node, type: z.literal('NodeStarted') }),
  z.object({ ...node, type: z.literal('NodeCompleted'), output: z.unknown(), summary: z.string().default(''), cost: CostSchema.optional() }),
  z.object({ ...node, type: z.literal('NodeFailed'), error: z.string() }),
  z.object({ ...node, type: z.literal('GatePassed'), report: GateReportSchema, cost: CostSchema.optional() }),
  z.object({ ...node, type: z.literal('GateFailed'), report: GateReportSchema, rework: z.string(), cost: CostSchema.optional() }),
  z.object({ ...node, type: z.literal('DecisionMade'), choice: z.string(), confidence: z.number().min(0).max(1).optional(), cost: CostSchema.optional() }),
  z.object({ ...node, type: z.literal('HumanRequested'), action: z.string(), prompt: z.string() }),
  z.object({ ...node, type: z.literal('HumanResponded'), approved: z.boolean(), note: z.string().optional() }),
  z.object({ ...base, type: z.literal('BudgetWarning'), spentUsd: z.number(), limitUsd: z.number() }),
  z.object({ ...base, type: z.literal('BudgetExceeded'), spentUsd: z.number(), limitUsd: z.number() }),
  z.object({ ...base, type: z.literal('RunResumed'), budgetUsd: z.number().positive().optional() }),
  z.object({ ...base, type: z.literal('RunCompleted') }),
  z.object({ ...base, type: z.literal('RunCancelled'), reason: z.string() }),
]);
export type RunEvent = z.infer<typeof RunEventSchema>;
```
Adicionar `export * from './events.js';` ao index de schemas e correr `pnpm --filter @shibaox/schemas build`.

- [ ] **Step 2: Pacote core**

`packages/core/package.json`:
```json
{
  "name": "@shibaox/core",
  "version": "0.0.1",
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": { "@shibaox/schemas": "workspace:*" }
}
```
`packages/core/tsconfig.json`: igual ao de schemas.
`packages/core/vitest.config.ts`:
```ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@shibaox/schemas': fileURLToPath(new URL('../schemas/src/index.ts', import.meta.url)) },
  },
  test: { include: ['test/**/*.test.ts'], testTimeout: 15_000 },
});
```

- [ ] **Step 3: Teste do reducer (falha)**

`packages/core/test/reducer.test.ts`:
```ts
import type { RunEvent } from '@shibaox/schemas';
import { describe, expect, it } from 'vitest';
import { replay } from '../src/index.js';

const at = '2026-09-25T10:00:00.000Z';
const created: RunEvent = { type: 'RunCreated', runId: 'r1', at, workflow: 'hello', input: { spec: 'x' }, budgetUsd: 1, workspace: '/tmp/w' };

describe('replay', () => {
  it('starts running with no nodes', () => {
    const s = replay([created]);
    expect(s.status).toBe('running');
    expect(s.nodes).toEqual({});
    expect(s.spentUsd).toBe(0);
  });

  it('tracks node lifecycle, attempts and cost', () => {
    const s = replay([
      created,
      { type: 'NodeStarted', runId: 'r1', nodeId: 'a', at },
      { type: 'NodeCompleted', runId: 'r1', nodeId: 'a', at, output: { ok: 1 }, summary: 'done', cost: { usd: 0.25, inputTokens: 1, outputTokens: 1 } },
    ]);
    expect(s.nodes.a).toMatchObject({ status: 'completed', attempts: 1, output: { ok: 1 } });
    expect(s.spentUsd).toBeCloseTo(0.25);
  });

  it('gate failure resets the gate and the rework node to pending, keeping attempts', () => {
    const report = { gates: ['tests'], passed: false, checks: [] };
    const s = replay([
      created,
      { type: 'NodeStarted', runId: 'r1', nodeId: 'a', at },
      { type: 'NodeCompleted', runId: 'r1', nodeId: 'a', at, output: null, summary: '' },
      { type: 'NodeStarted', runId: 'r1', nodeId: 'g', at },
      { type: 'GateFailed', runId: 'r1', nodeId: 'g', at, report, rework: 'a' },
    ]);
    expect(s.nodes.a).toMatchObject({ status: 'pending', attempts: 1 });
    expect(s.nodes.g).toMatchObject({ status: 'pending', attempts: 1 });
    expect(s.lastGateReport).toEqual(report);
  });

  it('human request pauses the run; response resumes it', () => {
    const s1 = replay([created, { type: 'NodeStarted', runId: 'r1', nodeId: 'h', at }, { type: 'HumanRequested', runId: 'r1', nodeId: 'h', at, action: 'ok', prompt: '?' }]);
    expect(s1.status).toBe('waiting_human');
    expect(s1.pendingHuman).toEqual({ nodeId: 'h', action: 'ok', prompt: '?' });
    const s2 = replay([
      created,
      { type: 'NodeStarted', runId: 'r1', nodeId: 'h', at },
      { type: 'HumanRequested', runId: 'r1', nodeId: 'h', at, action: 'ok', prompt: '?' },
      { type: 'HumanResponded', runId: 'r1', nodeId: 'h', at, approved: true },
    ]);
    expect(s2.status).toBe('running');
    expect(s2.nodes.h?.status).toBe('completed');
  });

  it('budget exceeded pauses; RunResumed raises the limit and resumes', () => {
    const s = replay([created, { type: 'BudgetExceeded', runId: 'r1', at, spentUsd: 1.2, limitUsd: 1 }]);
    expect(s.status).toBe('paused_budget');
    const s2 = replay([created, { type: 'BudgetExceeded', runId: 'r1', at, spentUsd: 1.2, limitUsd: 1 }, { type: 'RunResumed', runId: 'r1', at, budgetUsd: 5 }]);
    expect(s2.status).toBe('running');
    expect(s2.budgetUsd).toBe(5);
  });

  it('terminal events set final status', () => {
    expect(replay([created, { type: 'RunCompleted', runId: 'r1', at }]).status).toBe('completed');
    expect(replay([created, { type: 'RunCancelled', runId: 'r1', at, reason: 'x' }]).status).toBe('cancelled');
    expect(replay([created, { type: 'NodeStarted', runId: 'r1', nodeId: 'a', at }, { type: 'NodeFailed', runId: 'r1', nodeId: 'a', at, error: 'boom' }]).status).toBe('failed');
  });
});
```

- [ ] **Step 4: Implementar state + reducer + store**

`packages/core/src/run/state.ts`:
```ts
import type { GateReport } from '@shibaox/schemas';

export type RunStatus = 'running' | 'waiting_human' | 'paused_budget' | 'completed' | 'failed' | 'cancelled';
export type NodeStatus = 'pending' | 'running' | 'completed' | 'passed' | 'failed' | 'waiting';

export interface NodeState {
  status: NodeStatus;
  attempts: number;
  output?: unknown;
  summary?: string;
  choice?: string;
  report?: GateReport;
  error?: string;
}

export interface RunState {
  runId: string;
  workflow: string;
  input: Record<string, unknown>;
  workspace: string;
  status: RunStatus;
  nodes: Record<string, NodeState>;
  spentUsd: number;
  budgetUsd?: number;
  budgetWarned: boolean;
  pendingHuman?: { nodeId: string; action: string; prompt: string };
  lastGateReport?: GateReport;
  error?: string;
}
```

`packages/core/src/run/reducer.ts`:
```ts
import type { RunEvent } from '@shibaox/schemas';
import type { NodeState, RunState } from './state.js';

function nodeOf(state: RunState, id: string): NodeState {
  return state.nodes[id] ?? { status: 'pending', attempts: 0 };
}

function withNode(state: RunState, id: string, patch: Partial<NodeState>): RunState {
  return { ...state, nodes: { ...state.nodes, [id]: { ...nodeOf(state, id), ...patch } } };
}

function addCost(state: RunState, event: RunEvent): RunState {
  const cost = 'cost' in event ? event.cost : undefined;
  return cost ? { ...state, spentUsd: state.spentUsd + cost.usd } : state;
}

export function reduce(state: RunState | undefined, event: RunEvent): RunState {
  if (event.type === 'RunCreated') {
    return {
      runId: event.runId,
      workflow: event.workflow,
      input: event.input,
      workspace: event.workspace,
      status: 'running',
      nodes: {},
      spentUsd: 0,
      budgetUsd: event.budgetUsd,
      budgetWarned: false,
    };
  }
  if (!state) throw new Error(`event ${event.type} before RunCreated for run ${event.runId}`);
  const s = addCost(state, event);
  switch (event.type) {
    case 'NodeStarted':
      return withNode(s, event.nodeId, { status: 'running', attempts: nodeOf(s, event.nodeId).attempts + 1, error: undefined });
    case 'NodeCompleted':
      return withNode(s, event.nodeId, { status: 'completed', output: event.output, summary: event.summary });
    case 'NodeFailed':
      return { ...withNode(s, event.nodeId, { status: 'failed', error: event.error }), status: 'failed', error: `${event.nodeId}: ${event.error}` };
    case 'GatePassed':
      return { ...withNode(s, event.nodeId, { status: 'passed', report: event.report }), lastGateReport: event.report };
    case 'GateFailed': {
      const afterGate = withNode(s, event.nodeId, { status: 'pending', report: event.report });
      const afterRework = withNode(afterGate, event.rework, { status: 'pending' });
      return { ...afterRework, lastGateReport: event.report };
    }
    case 'DecisionMade':
      return withNode(s, event.nodeId, { status: 'completed', choice: event.choice, output: { choice: event.choice, confidence: event.confidence } });
    case 'HumanRequested':
      return { ...withNode(s, event.nodeId, { status: 'waiting' }), status: 'waiting_human', pendingHuman: { nodeId: event.nodeId, action: event.action, prompt: event.prompt } };
    case 'HumanResponded':
      return { ...withNode(s, event.nodeId, { status: 'completed', output: { approved: event.approved, note: event.note } }), status: 'running', pendingHuman: undefined };
    case 'BudgetWarning':
      return { ...s, budgetWarned: true };
    case 'BudgetExceeded':
      return { ...s, status: 'paused_budget' };
    case 'RunResumed':
      return { ...s, status: 'running', budgetUsd: event.budgetUsd ?? s.budgetUsd, budgetWarned: false };
    case 'RunCompleted':
      return { ...s, status: 'completed' };
    case 'RunCancelled':
      return { ...s, status: 'cancelled', error: event.reason };
  }
}

export function replay(events: readonly RunEvent[]): RunState {
  let state: RunState | undefined;
  for (const e of events) state = reduce(state, e);
  if (!state) throw new Error('cannot replay an empty event list');
  return state;
}
```

`packages/core/src/events/store.ts`:
```ts
import type { RunEvent } from '@shibaox/schemas';
import type { RunStatus } from '../run/state.js';

export type StoredEvent = RunEvent & { seq: number };

export interface RunSummary {
  runId: string;
  workflow: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
}

export interface EventStore {
  append(event: RunEvent): Promise<StoredEvent>;
  read(runId: string): Promise<StoredEvent[]>;
  listRuns(): Promise<RunSummary[]>;
}
```

`packages/core/src/events/memory-store.ts`:
```ts
import type { RunEvent } from '@shibaox/schemas';
import { replay } from '../run/reducer.js';
import type { EventStore, RunSummary, StoredEvent } from './store.js';

export class MemoryEventStore implements EventStore {
  private events: StoredEvent[] = [];
  private seq = 0;

  async append(event: RunEvent): Promise<StoredEvent> {
    const stored = { ...event, seq: ++this.seq };
    this.events.push(stored);
    return stored;
  }

  async read(runId: string): Promise<StoredEvent[]> {
    return this.events.filter((e) => e.runId === runId);
  }

  async listRuns(): Promise<RunSummary[]> {
    const byRun = new Map<string, StoredEvent[]>();
    for (const e of this.events) byRun.set(e.runId, [...(byRun.get(e.runId) ?? []), e]);
    return [...byRun.entries()].map(([runId, evs]) => {
      const state = replay(evs);
      return { runId, workflow: state.workflow, status: state.status, createdAt: evs[0]!.at, updatedAt: evs[evs.length - 1]!.at };
    });
  }
}
```

`packages/core/src/index.ts`:
```ts
export * from './events/store.js';
export * from './events/memory-store.js';
export * from './run/state.js';
export * from './run/reducer.js';
```

- [ ] **Step 5: Teste do store em memória**

`packages/core/test/memory-store.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { MemoryEventStore } from '../src/index.js';

const at = '2026-09-25T10:00:00.000Z';

describe('MemoryEventStore', () => {
  it('assigns increasing seq and isolates runs', async () => {
    const store = new MemoryEventStore();
    await store.append({ type: 'RunCreated', runId: 'a', at, workflow: 'w', input: {}, workspace: '/w' });
    await store.append({ type: 'RunCreated', runId: 'b', at, workflow: 'w', input: {}, workspace: '/w' });
    const e = await store.append({ type: 'RunCompleted', runId: 'a', at });
    expect(e.seq).toBe(3);
    expect((await store.read('a')).map((x) => x.type)).toEqual(['RunCreated', 'RunCompleted']);
    const runs = await store.listRuns();
    expect(runs.find((r) => r.runId === 'a')?.status).toBe('completed');
    expect(runs.find((r) => r.runId === 'b')?.status).toBe('running');
  });
});
```

- [ ] **Step 6: Correr**

Run: `pnpm build && pnpm --filter @shibaox/core test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/schemas packages/core
git commit -m "feat(core): run events, in-memory event store and pure reducer

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Scheduler (`readyNodes`)

**Files:**
- Create: `packages/core/src/run/scheduler.ts` (+ export no index)
- Test: `packages/core/test/scheduler.test.ts`

**Interfaces:**
- Consumes: `RunState` (Task 4), `Workflow`, `WorkflowNode` (Task 2).
- Produces: `readyNodes(state: RunState, workflow: Workflow): string[]` (ordenado, sem duplicados).

Regras: só devolve nós com estado `pending` (ou ausentes). `start` é pronto quando pendente. Um `task`/`code`/`human` concluído torna `next` pronto. Um `decide` concluído torna `next[choice]` pronto. Um `gate` `passed` torna `on_pass` pronto (o `on_fail` é tratado pelo reset do reducer). Um `parallel` concluído torna os `branches` prontos; quando todos os branches estão `completed`/`passed`, o `join` fica pronto. Se `status !== 'running'`, devolve `[]`.

- [ ] **Step 1: Teste (falha)**

`packages/core/test/scheduler.test.ts`:
```ts
import { type RunEvent, WorkflowSchema } from '@shibaox/schemas';
import { describe, expect, it } from 'vitest';
import { readyNodes, replay } from '../src/index.js';

const at = '2026-09-25T10:00:00.000Z';
const wf = WorkflowSchema.parse({
  workflow: 'w',
  start: 'a',
  nodes: {
    a: { type: 'task', role: 'r', next: 'p' },
    p: { type: 'parallel', branches: ['b1', 'b2'], join: 'g' },
    b1: { type: 'task', role: 'r' },
    b2: { type: 'code', command: 'true' },
    g: { type: 'gate', gates: ['t'], on_pass: 'd', on_fail: 'a' },
    d: { type: 'decide', by: 'lead', options: ['ship', 'rework'], next: { ship: 'h', rework: 'a' } },
    h: { type: 'human', action: 'ok' },
  },
});
const created: RunEvent = { type: 'RunCreated', runId: 'r', at, workflow: 'w', input: {}, workspace: '/w' };
const started = (nodeId: string): RunEvent => ({ type: 'NodeStarted', runId: 'r', nodeId, at });
const done = (nodeId: string): RunEvent => ({ type: 'NodeCompleted', runId: 'r', nodeId, at, output: null, summary: '' });

describe('readyNodes', () => {
  it('starts with the start node', () => {
    expect(readyNodes(replay([created]), wf)).toEqual(['a']);
  });
  it('follows next after completion', () => {
    expect(readyNodes(replay([created, started('a'), done('a')]), wf)).toEqual(['p']);
  });
  it('parallel completion readies all branches, join waits for all', () => {
    const base = [created, started('a'), done('a'), started('p'), done('p')];
    expect(readyNodes(replay(base), wf).sort()).toEqual(['b1', 'b2']);
    expect(readyNodes(replay([...base, started('b1'), done('b1')]), wf)).toEqual(['b2']);
    expect(readyNodes(replay([...base, started('b1'), done('b1'), started('b2'), done('b2')]), wf)).toEqual(['g']);
  });
  it('gate pass goes to on_pass; gate fail reruns the rework node', () => {
    const base = [created, started('a'), done('a'), started('p'), done('p'), started('b1'), done('b1'), started('b2'), done('b2'), started('g')];
    const report = { gates: ['t'], passed: true, checks: [] };
    expect(readyNodes(replay([...base, { type: 'GatePassed', runId: 'r', nodeId: 'g', at, report }]), wf)).toEqual(['d']);
    expect(readyNodes(replay([...base, { type: 'GateFailed', runId: 'r', nodeId: 'g', at, report: { ...report, passed: false }, rework: 'a' }]), wf)).toEqual(['a']);
  });
  it('decide follows the chosen option', () => {
    const evs: RunEvent[] = [created, started('d'), { type: 'DecisionMade', runId: 'r', nodeId: 'd', at, choice: 'ship' }];
    expect(readyNodes(replay(evs), wf)).toEqual(['h']);
  });
  it('returns nothing when the run is not running', () => {
    expect(readyNodes(replay([created, { type: 'RunCompleted', runId: 'r', at }]), wf)).toEqual([]);
  });
});
```

- [ ] **Step 2: Correr para ver falhar**

Run: `pnpm --filter @shibaox/core test`
Expected: FAIL, `readyNodes` não exportado.

- [ ] **Step 3: Implementar**

`packages/core/src/run/scheduler.ts`:
```ts
import type { Workflow } from '@shibaox/schemas';
import type { NodeStatus, RunState } from './state.js';

const finished = (s: NodeStatus) => s === 'completed' || s === 'passed';

export function readyNodes(state: RunState, workflow: Workflow): string[] {
  if (state.status !== 'running') return [];
  const statusOf = (id: string): NodeStatus => state.nodes[id]?.status ?? 'pending';
  const ready = new Set<string>();
  if (statusOf(workflow.start) === 'pending') ready.add(workflow.start);

  for (const [id, node] of Object.entries(workflow.nodes)) {
    const status = statusOf(id);
    const targets: string[] = [];
    switch (node.type) {
      case 'task':
      case 'code':
      case 'human':
        if (status === 'completed' && node.next) targets.push(node.next);
        break;
      case 'decide': {
        const choice = state.nodes[id]?.choice;
        if (status === 'completed' && choice && node.next[choice]) targets.push(node.next[choice]);
        break;
      }
      case 'gate':
        if (status === 'passed') targets.push(node.on_pass);
        break;
      case 'parallel':
        if (status === 'completed') {
          targets.push(...node.branches);
          if (node.branches.every((b) => finished(statusOf(b)))) targets.push(node.join);
        }
        break;
    }
    for (const t of targets) if (statusOf(t) === 'pending') ready.add(t);
  }
  return [...ready].sort();
}
```
Adicionar `export * from './run/scheduler.js';` ao index.

- [ ] **Step 4: Correr**

Run: `pnpm --filter @shibaox/core test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): readyNodes scheduler over run state and workflow graph

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Executores: tipos, `runCommand`, adaptador mock

**Files:**
- Create: `packages/core/src/executors/types.ts`, `src/executors/code.ts`, `src/executors/mock.ts` (+ exports)
- Test: `packages/core/test/code.test.ts`, `packages/core/test/mock-adapter.test.ts`

**Interfaces:**
- Produces:
```ts
type Capability = 'write-code' | 'run-tests' | 'read-only' | 'shell';
type RuntimeEvent =
  | { type: 'started' } | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: unknown } | { type: 'tool_result'; name: string; output: unknown }
  | { type: 'file_changed'; path: string }
  | { type: 'result'; output: unknown; summary: string; cost?: Cost }
  | { type: 'error'; message: string };
interface TaskJob { runId; nodeId; role: Role; instruction: string; input: Record<string, unknown>; workspace: string; context: { lastGateReport?: GateReport; previousOutputs: Record<string, unknown> } }
interface ExecutionContext { signal: AbortSignal; log: (line: string) => void }
interface TaskResult { output: unknown; summary: string; cost?: Cost }
interface RuntimeAdapter { id: string; capabilities(): Capability[]; run(job, ctx): AsyncIterable<RuntimeEvent>; cancel(jobId: string): Promise<void> }
collectRun(adapter, job, ctx): Promise<TaskResult>
runCommand({ command, cwd, timeoutMs, env? }): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>
class MockAdapter implements RuntimeAdapter  // constructor(script?: (job) => TaskResult | Promise<TaskResult>)
```

- [ ] **Step 1: Testes (falham)**

`packages/core/test/code.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/index.js';

describe('runCommand', () => {
  it('captures stdout and exit code', async () => {
    const r = await runCommand({ command: 'echo hi && exit 3', cwd: process.cwd(), timeoutMs: 5000 });
    expect(r.stdout.trim()).toBe('hi');
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
  });
  it('kills a hanging command on timeout', async () => {
    const r = await runCommand({ command: 'sleep 5', cwd: process.cwd(), timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
  });
});
```

`packages/core/test/mock-adapter.test.ts`:
```ts
import { RoleSchema } from '@shibaox/schemas';
import { describe, expect, it } from 'vitest';
import { MockAdapter, type TaskJob, collectRun } from '../src/index.js';

const job: TaskJob = {
  runId: 'r', nodeId: 'a', role: RoleSchema.parse({ role: 'backend' }), instruction: 'do it',
  input: { spec: 's' }, workspace: '/w', context: { previousOutputs: {} },
};
const ctx = { signal: new AbortController().signal, log: () => {} };

describe('MockAdapter', () => {
  it('yields started then result and collectRun returns the result', async () => {
    const adapter = new MockAdapter((j) => ({ output: { echoed: j.instruction }, summary: 'mocked', cost: { usd: 0.01, inputTokens: 1, outputTokens: 1 } }));
    const events: string[] = [];
    for await (const e of adapter.run(job, ctx)) events.push(e.type);
    expect(events).toEqual(['started', 'result']);
    expect(await collectRun(adapter, job, ctx)).toEqual({ output: { echoed: 'do it' }, summary: 'mocked', cost: { usd: 0.01, inputTokens: 1, outputTokens: 1 } });
  });
  it('collectRun throws on an error event', async () => {
    const adapter = new MockAdapter(() => { throw new Error('nope'); });
    await expect(collectRun(adapter, job, ctx)).rejects.toThrow('nope');
  });
});
```

- [ ] **Step 2: Implementar**

`packages/core/src/executors/types.ts`:
```ts
import type { Cost, GateReport, Role } from '@shibaox/schemas';

export type Capability = 'write-code' | 'run-tests' | 'read-only' | 'shell';

export type RuntimeEvent =
  | { type: 'started' }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; output: unknown }
  | { type: 'file_changed'; path: string }
  | { type: 'result'; output: unknown; summary: string; cost?: Cost }
  | { type: 'error'; message: string };

export interface TaskJob {
  runId: string;
  nodeId: string;
  role: Role;
  instruction: string;
  input: Record<string, unknown>;
  workspace: string;
  context: { lastGateReport?: GateReport; previousOutputs: Record<string, unknown> };
}

export interface ExecutionContext {
  signal: AbortSignal;
  log: (line: string) => void;
}

export interface TaskResult {
  output: unknown;
  summary: string;
  cost?: Cost;
}

export interface RuntimeAdapter {
  readonly id: string;
  capabilities(): Capability[];
  run(job: TaskJob, ctx: ExecutionContext): AsyncIterable<RuntimeEvent>;
  cancel(jobId: string): Promise<void>;
}

export async function collectRun(adapter: RuntimeAdapter, job: TaskJob, ctx: ExecutionContext): Promise<TaskResult> {
  for await (const event of adapter.run(job, ctx)) {
    if (event.type === 'text') ctx.log(event.text);
    if (event.type === 'error') throw new Error(event.message);
    if (event.type === 'result') return { output: event.output, summary: event.summary, cost: event.cost };
  }
  throw new Error(`adapter ${adapter.id} ended without a result for node ${job.nodeId}`);
}
```

`packages/core/src/executors/code.ts`:
```ts
import { spawn } from 'node:child_process';

export interface CommandOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
}
export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runCommand(opts: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(opts.command, { cwd: opts.cwd, shell: true, env: { ...process.env, ...opts.env }, detached: process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: `${stderr}${err.message}`, timedOut });
    });
  });
}
```

`packages/core/src/executors/mock.ts`:
```ts
import type { Capability, ExecutionContext, RuntimeAdapter, RuntimeEvent, TaskJob, TaskResult } from './types.js';

export type MockScript = (job: TaskJob) => TaskResult | Promise<TaskResult>;

export class MockAdapter implements RuntimeAdapter {
  readonly id = 'mock';
  constructor(private readonly script: MockScript = (job) => ({ output: { instruction: job.instruction }, summary: `mock ${job.role.role} did: ${job.instruction}` })) {}
  capabilities(): Capability[] {
    return ['write-code', 'run-tests', 'shell'];
  }
  async *run(job: TaskJob, _ctx: ExecutionContext): AsyncIterable<RuntimeEvent> {
    yield { type: 'started' };
    try {
      const r = await this.script(job);
      yield { type: 'result', output: r.output, summary: r.summary, cost: r.cost };
    } catch (e) {
      yield { type: 'error', message: (e as Error).message };
    }
  }
  async cancel(): Promise<void> {}
}
```
Exports no index: `export * from './executors/types.js'; export * from './executors/code.js'; export * from './executors/mock.js';`

- [ ] **Step 3: Correr**

Run: `pnpm --filter @shibaox/core test`
Expected: PASS, incluindo o timeout em menos de 1 s.

- [ ] **Step 4: Commit**

```bash
git add packages/core
git commit -m "feat(core): runtime adapter contract, runCommand with timeout, mock adapter

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Motor de gates

**Files:**
- Create: `packages/core/src/gates/engine.ts` (+ export)
- Test: `packages/core/test/gate-engine.test.ts`

**Interfaces:**
- Consumes: `Gate`, `Check`, `CheckResult`, `GateReport` (schemas), `runCommand` (Task 6).
- Produces:
```ts
interface CheckContext { runId; nodeId; workspace: string; state: RunState; log: (line: string) => void }
type CheckRunner = (check: Check, ctx: CheckContext) => Promise<CheckResult>;
type CheckRunners = Partial<Record<Check['type'], CheckRunner>>;
const codeCheckRunner: CheckRunner; const mockCheckRunner: CheckRunner;
function defaultCheckRunners(): CheckRunners  // { code, mock }
runGate(args: { gateIds: string[]; gates: Record<string, Gate>; runners: CheckRunners; ctx: CheckContext }): Promise<GateReport>
```
Semântica: os checks correm pela ordem dos gates e, dentro de cada gate, pela ordem declarada. Ao primeiro check reprovado, os restantes ficam `skipped: true` e o relatório é `passed: false`. Um tipo sem runner registado reprova com evidência `no runner registered for check type "X"`.

- [ ] **Step 1: Teste (falha)**

`packages/core/test/gate-engine.test.ts`:
```ts
import { GateSchema } from '@shibaox/schemas';
import { describe, expect, it } from 'vitest';
import { type RunState, defaultCheckRunners, runGate } from '../src/index.js';

const state: RunState = { runId: 'r', workflow: 'w', input: {}, workspace: process.cwd(), status: 'running', nodes: {}, spentUsd: 0, budgetWarned: false };
const ctx = { runId: 'r', nodeId: 'g', workspace: process.cwd(), state, log: () => {} };
const gates = {
  ok: GateSchema.parse({ gate: 'ok', checks: [{ name: 'echo', type: 'code', command: 'echo fine' }] }),
  bad: GateSchema.parse({ gate: 'bad', checks: [{ name: 'boom', type: 'code', command: 'echo broken >&2; exit 1' }, { name: 'after', type: 'mock', passes: true }] }),
  jev: GateSchema.parse({ gate: 'jev', checks: [{ name: 'spec', type: 'jev', question: 'q' }] }),
};

describe('runGate', () => {
  it('passes when every check passes', async () => {
    const r = await runGate({ gateIds: ['ok'], gates, runners: defaultCheckRunners(), ctx });
    expect(r.passed).toBe(true);
    expect(r.checks[0]).toMatchObject({ name: 'echo', passed: true });
    expect(r.checks[0]?.evidence).toContain('fine');
  });
  it('fails at the first failing check, skips the rest and keeps stderr as evidence', async () => {
    const r = await runGate({ gateIds: ['ok', 'bad'], gates, runners: defaultCheckRunners(), ctx });
    expect(r.passed).toBe(false);
    expect(r.checks.map((c) => [c.name, c.passed, c.skipped])).toEqual([['echo', true, false], ['boom', false, false], ['after', false, true]]);
    expect(r.checks[1]?.evidence).toContain('broken');
  });
  it('fails a check whose type has no runner', async () => {
    const r = await runGate({ gateIds: ['jev'], gates, runners: defaultCheckRunners(), ctx });
    expect(r.passed).toBe(false);
    expect(r.checks[0]?.evidence).toContain('no runner registered for check type "jev"');
  });
  it('throws on an unknown gate id', async () => {
    await expect(runGate({ gateIds: ['ghost'], gates, runners: {}, ctx })).rejects.toThrow('ghost');
  });
});
```

- [ ] **Step 2: Implementar**

`packages/core/src/gates/engine.ts`:
```ts
import type { Check, CheckResult, Gate, GateReport } from '@shibaox/schemas';
import { runCommand } from '../executors/code.js';
import type { RunState } from '../run/state.js';

export interface CheckContext {
  runId: string;
  nodeId: string;
  workspace: string;
  state: RunState;
  log: (line: string) => void;
}
export type CheckRunner = (check: Check, ctx: CheckContext) => Promise<CheckResult>;
export type CheckRunners = Partial<Record<Check['type'], CheckRunner>>;

const tail = (s: string, n = 2000) => (s.length > n ? `…${s.slice(-n)}` : s);

export const codeCheckRunner: CheckRunner = async (check, ctx) => {
  if (check.type !== 'code') throw new Error('codeCheckRunner got a non-code check');
  const r = await runCommand({ command: check.command, cwd: ctx.workspace, timeoutMs: check.timeout_ms });
  const passed = r.exitCode === 0 && !r.timedOut;
  const evidence = r.timedOut ? `timed out after ${check.timeout_ms}ms\n${tail(r.stdout)}${tail(r.stderr)}` : `exit ${r.exitCode}\n${tail(r.stdout)}${tail(r.stderr)}`;
  return { name: check.name, type: 'code', passed, skipped: false, evidence, suggestion: passed ? undefined : `Fix so that \`${check.command}\` exits 0` };
};

export const mockCheckRunner: CheckRunner = async (check) => {
  if (check.type !== 'mock') throw new Error('mockCheckRunner got a non-mock check');
  return { name: check.name, type: 'mock', passed: check.passes, skipped: false, evidence: check.evidence };
};

export function defaultCheckRunners(): CheckRunners {
  return { code: codeCheckRunner, mock: mockCheckRunner };
}

export async function runGate(args: { gateIds: string[]; gates: Record<string, Gate>; runners: CheckRunners; ctx: CheckContext }): Promise<GateReport> {
  const checks: CheckResult[] = [];
  let failed = false;
  for (const gateId of args.gateIds) {
    const gate = args.gates[gateId];
    if (!gate) throw new Error(`gate "${gateId}" is not defined`);
    for (const check of gate.checks) {
      if (failed) {
        checks.push({ name: check.name, type: check.type, passed: false, skipped: true, evidence: 'skipped: an earlier check failed' });
        continue;
      }
      const runner = args.runners[check.type];
      const result: CheckResult = runner
        ? await runner(check, args.ctx).catch((e: Error) => ({ name: check.name, type: check.type, passed: false, skipped: false, evidence: `runner error: ${e.message}` }))
        : { name: check.name, type: check.type, passed: false, skipped: false, evidence: `no runner registered for check type "${check.type}"` };
      args.ctx.log(`[gate ${gateId}] ${check.name}: ${result.passed ? 'pass' : 'FAIL'}`);
      checks.push(result);
      if (!result.passed) failed = true;
    }
  }
  return { gates: args.gateIds, passed: !failed, checks };
}
```
Export: `export * from './gates/engine.js';`

- [ ] **Step 3: Correr**

Run: `pnpm --filter @shibaox/core test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/core
git commit -m "feat(core): gate engine with ordered checks, skip-after-failure and code/mock runners

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Injeção dos gates obrigatórios da equipa

**Files:**
- Create: `packages/core/src/org/inject-gates.ts` (+ export)
- Test: `packages/core/test/inject-gates.test.ts`

**Interfaces:**
- Consumes: `Workflow`, `Team`, `transitionsOf`.
- Produces: `injectTeamGates(workflow: Workflow, team: Team): Workflow` (puro, devolve cópia).

Regra: se `team.gates` está vazio, ou se algum nó `gate` do workflow já inclui todos os ids de `team.gates`, devolve o workflow tal como está. Caso contrário, para cada nó terminal `T` (sem transições) e para cada predecessor `P` que não seja `gate` com uma transição para `T`, insere o nó `team-gate:<T>` = `{ type: 'gate', gates: team.gates, on_pass: T, on_fail: P, max_retries: 3 }` e redireciona a transição de `P` para o novo nó.

- [ ] **Step 1: Teste (falha)**

`packages/core/test/inject-gates.test.ts`:
```ts
import { TeamSchema, WorkflowSchema } from '@shibaox/schemas';
import { describe, expect, it } from 'vitest';
import { injectTeamGates } from '../src/index.js';

const team = TeamSchema.parse({ team: 'eng', lead: 'tl', roles: ['tl'], gates: ['lint', 'tests'] });

describe('injectTeamGates', () => {
  it('inserts a gate before a terminal node reached from a task', () => {
    const wf = WorkflowSchema.parse({ workflow: 'w', start: 'a', nodes: { a: { type: 'task', role: 'tl', next: 'h' }, h: { type: 'human', action: 'ok' } } });
    const out = injectTeamGates(wf, team);
    expect(out.nodes.a).toMatchObject({ next: 'team-gate:h' });
    expect(out.nodes['team-gate:h']).toEqual({ type: 'gate', gates: ['lint', 'tests'], on_pass: 'h', on_fail: 'a', max_retries: 3 });
    expect(WorkflowSchema.safeParse(out).success).toBe(true);
    expect(wf.nodes.a).toMatchObject({ next: 'h' }); // original untouched
  });
  it('rewires decide transitions too', () => {
    const wf = WorkflowSchema.parse({ workflow: 'w', start: 'd', nodes: { d: { type: 'decide', by: 'tl', options: ['x', 'y'], next: { x: 'h', y: 'h' } }, h: { type: 'human', action: 'ok' } } });
    const out = injectTeamGates(wf, team);
    expect(out.nodes.d).toMatchObject({ next: { x: 'team-gate:h', y: 'team-gate:h' } });
  });
  it('does nothing when a gate node already covers the team gates', () => {
    const wf = WorkflowSchema.parse({ workflow: 'w', start: 'a', nodes: { a: { type: 'task', role: 'tl', next: 'g' }, g: { type: 'gate', gates: ['lint', 'tests'], on_pass: 'h', on_fail: 'a' }, h: { type: 'human', action: 'ok' } } });
    expect(injectTeamGates(wf, team)).toEqual(wf);
  });
  it('does nothing when the team has no gates', () => {
    const wf = WorkflowSchema.parse({ workflow: 'w', start: 'a', nodes: { a: { type: 'task', role: 'tl' } } });
    expect(injectTeamGates(wf, TeamSchema.parse({ team: 't', lead: 'tl', roles: ['tl'] }))).toEqual(wf);
  });
});
```

- [ ] **Step 2: Implementar**

`packages/core/src/org/inject-gates.ts`:
```ts
import { type Team, type Workflow, type WorkflowNode, transitionsOf } from '@shibaox/schemas';

function redirect(node: WorkflowNode, from: string, to: string): WorkflowNode {
  switch (node.type) {
    case 'task':
    case 'code':
    case 'human':
      return node.next === from ? { ...node, next: to } : node;
    case 'decide':
      return { ...node, next: Object.fromEntries(Object.entries(node.next).map(([k, v]) => [k, v === from ? to : v])) };
    case 'parallel':
      return { ...node, branches: node.branches.map((b) => (b === from ? to : b)), join: node.join === from ? to : node.join };
    case 'gate':
      return node;
  }
}

export function injectTeamGates(workflow: Workflow, team: Team): Workflow {
  if (team.gates.length === 0) return workflow;
  const covered = Object.values(workflow.nodes).some((n) => n.type === 'gate' && team.gates.every((g) => n.gates.includes(g)));
  if (covered) return workflow;

  const nodes: Record<string, WorkflowNode> = { ...workflow.nodes };
  const terminals = Object.entries(workflow.nodes).filter(([, n]) => transitionsOf(n).length === 0).map(([id]) => id);
  for (const t of terminals) {
    const gateId = `team-gate:${t}`;
    let inserted = false;
    for (const [pid, pnode] of Object.entries(workflow.nodes)) {
      if (pnode.type === 'gate' || !transitionsOf(pnode).includes(t)) continue;
      nodes[pid] = redirect(nodes[pid] ?? pnode, t, gateId);
      if (!inserted) {
        nodes[gateId] = { type: 'gate', gates: [...team.gates], on_pass: t, on_fail: pid, max_retries: 3 };
        inserted = true;
      }
    }
  }
  return { ...workflow, nodes };
}
```
Export: `export * from './org/inject-gates.js';`

- [ ] **Step 3: Correr**

Run: `pnpm --filter @shibaox/core test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/core
git commit -m "feat(core): inject mandatory team gates before terminal nodes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: `RunEngine` (start, drive, human, budget, resume)

**Files:**
- Create: `packages/core/src/run/engine.ts`, `packages/core/src/run/deciders.ts` (+ exports)
- Test: `packages/core/test/engine.test.ts`

**Interfaces:**
- Consumes: tudo o que foi produzido nas Tasks 3 a 8.
- Produces:
```ts
interface DecisionRequest { runId; nodeId; by: string; question: string; options: string[]; context: { input: Record<string, unknown>; previousOutputs: Record<string, unknown>; lastGateReport?: GateReport } }
interface Decision { choice: string; confidence?: number; cost?: Cost }
interface Decider { decide(req: DecisionRequest): Promise<Decision> }
class ScriptedDecider implements Decider  // constructor(choices: Record<string, string>, fallback?: string) — chave = nodeId
interface HumanRequest { runId; nodeId; action: string; prompt: string }
type HumanAnswer = { approved: boolean; note?: string } | { deferred: true }
interface HumanHandler { ask(req: HumanRequest): Promise<HumanAnswer> }
class AutoApproveHuman implements HumanHandler; class DeferHuman implements HumanHandler
interface EngineDeps { store: EventStore; org: Org; adapters: Record<string, RuntimeAdapter>; defaultAdapter?: string; decider: Decider; human: HumanHandler; checkRunners?: CheckRunners; log?: (line: string) => void; now?: () => string; maxSteps?: number; newRunId?: () => string }
class RunEngine {
  constructor(deps: EngineDeps)
  start(opts: { workflow: string; input: Record<string, unknown>; workspace: string; budgetUsd?: number }): Promise<RunState>
  resume(runId: string, opts?: { budgetUsd?: number }): Promise<RunState>
  respond(runId: string, answer: { approved: boolean; note?: string }): Promise<RunState>
  state(runId: string): Promise<RunState>
}
```
Comportamento:
- `start` resolve o workflow em `org.workflows`, aplica `injectTeamGates` se o workflow tem `team`, grava `RunCreated` e chama `drive`.
- `drive(runId)`: repete { `state = replay(read)`; se `status !== 'running'` pára; `ready = readyNodes`; se vazio grava `RunCompleted` e pára; executa todos os `ready` em paralelo com `Promise.all`; `steps++`; se `steps > maxSteps` (default 200) grava `RunCancelled` com razão `max steps exceeded` }.
- Após cada nó com custo: se `budgetUsd` definido e `spent >= 0.8*budget` e ainda não avisou → `BudgetWarning`; se `spent >= budget` → `BudgetExceeded` e o loop pára na iteração seguinte.
- `task`: adaptador = `adapters[deps.defaultAdapter ?? role.runtime]`; se não existe → `NodeFailed` com `no adapter registered for runtime "X"`. Constrói `TaskJob` com `previousOutputs` = `output` de todos os nós `completed`. Usa `collectRun`.
- `code`: `runCommand` no workspace; exit 0 → `NodeCompleted { output: { exitCode, stdout } }`, senão `NodeFailed`.
- `decide`: `decider.decide`; se `choice` não está em `options` → `NodeFailed`; senão `DecisionMade`.
- `gate`: `runGate` com `gateIds = node.gates`; `passed` → `GatePassed`; senão, se `attempts > max_retries` (attempts já conta a tentativa atual) → `NodeFailed` com `gate failed after N attempts`; caso contrário `GateFailed { rework: node.on_fail }`.
- `human`: `HumanRequested`; `human.ask`; `deferred` → não grava mais nada (o run fica `waiting_human`); `approved: true` → `HumanResponded`; `approved: false` → `HumanResponded` + `RunCancelled { reason: 'rejected by human at <nodeId>' }`.
- `parallel`: `NodeCompleted { output: null }` de imediato.
- `respond(runId, answer)`: exige `status === 'waiting_human'`; grava `HumanResponded` (e `RunCancelled` se recusado); chama `drive`.
- `resume(runId, {budgetUsd})`: se `paused_budget` grava `RunResumed`; se `waiting_human` volta a perguntar ao handler (`ask`) e trata como acima; se `running` (processo morreu a meio) chama `drive` diretamente; nós com estado `running` no replay são tratados como `pending` para reexecução: o engine grava `NodeFailed`? Não: grava um novo `NodeStarted`, o reducer incrementa `attempts`. Para isso `readyNodes` precisa de contar `running` como pendente no resume: o engine passa por `markInterrupted(state)` que converte `running` → `pending` antes de chamar `readyNodes`. Isto é local ao engine, não altera o reducer.

- [ ] **Step 1: Teste (falha)**

`packages/core/test/engine.test.ts`:
```ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrg } from '@shibaox/schemas';
import { describe, expect, it } from 'vitest';
import { AutoApproveHuman, DeferHuman, MemoryEventStore, MockAdapter, RunEngine, ScriptedDecider } from '../src/index.js';

function scaffold(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'org-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

const orgFiles = (gateCmd: string) => ({
  'org.yaml': 'organization: wc\nteams: [eng]\n',
  'teams/eng.yaml': 'team: eng\nlead: tl\nroles: [tl, analyst, backend]\ngates: [tests]\nworkflows: [hello]\n',
  'roles/tl.yaml': 'role: tl\n',
  'roles/analyst.yaml': 'role: analyst\nruntime: mock\n',
  'roles/backend.yaml': 'role: backend\nruntime: mock\n',
  'gates/tests.yaml': `gate: tests\nchecks:\n  - { name: t, type: code, command: "${gateCmd}" }\n`,
  'workflows/hello.yaml': [
    'workflow: hello', 'team: eng', 'start: analyse', 'nodes:',
    '  analyse: { type: task, role: analyst, instruction: analyse, next: implement }',
    '  implement: { type: task, role: backend, instruction: implement, next: qa }',
    '  qa: { type: gate, gates: [tests], on_pass: judge, on_fail: implement, max_retries: 1 }',
    '  judge: { type: decide, by: tl, question: ready?, options: [ship, rework], next: { ship: ship, rework: implement } }',
    '  ship: { type: human, action: approve-push, prompt: push? }',
    '',
  ].join('\n'),
});

function engineFor(dir: string, overrides: Partial<ConstructorParameters<typeof RunEngine>[0]> = {}) {
  const store = new MemoryEventStore();
  const engine = new RunEngine({
    store,
    org: loadOrg(dir),
    adapters: { mock: new MockAdapter((j) => ({ output: { did: j.instruction }, summary: j.instruction, cost: { usd: 0.1, inputTokens: 1, outputTokens: 1 } })) },
    decider: new ScriptedDecider({ judge: 'ship' }),
    human: new AutoApproveHuman(),
    now: () => '2026-09-25T10:00:00.000Z',
    ...overrides,
  });
  return { store, engine };
}

describe('RunEngine', () => {
  it('runs the hello workflow end to end', async () => {
    const { engine, store } = engineFor(scaffold(orgFiles('true')));
    const state = await engine.start({ workflow: 'hello', input: { spec: 'x' }, workspace: process.cwd() });
    expect(state.status).toBe('completed');
    expect(Object.keys(state.nodes).sort()).toEqual(['analyse', 'implement', 'judge', 'qa', 'ship']);
    expect(state.nodes.implement?.output).toEqual({ did: 'implement' });
    expect(state.spentUsd).toBeCloseTo(0.2);
    const types = (await store.read(state.runId)).map((e) => e.type);
    expect(types[0]).toBe('RunCreated');
    expect(types.at(-1)).toBe('RunCompleted');
    expect(types).toContain('GatePassed');
    expect(types).toContain('DecisionMade');
  });

  it('gate failure reworks then fails the run after max_retries with the report', async () => {
    const { engine, store } = engineFor(scaffold(orgFiles('exit 1')));
    const state = await engine.start({ workflow: 'hello', input: {}, workspace: process.cwd() });
    expect(state.status).toBe('failed');
    expect(state.error).toContain('gate failed after 2 attempts');
    expect(state.nodes.implement?.attempts).toBe(2);
    const types = (await store.read(state.runId)).map((e) => e.type);
    expect(types.filter((t) => t === 'GateFailed')).toHaveLength(1);
    expect(types.filter((t) => t === 'NodeFailed')).toHaveLength(1);
  });

  it('passes the last gate report to the reworked task', async () => {
    const seen: unknown[] = [];
    const dir = scaffold(orgFiles('exit 1'));
    const { engine } = engineFor(dir, {
      adapters: { mock: new MockAdapter((j) => { seen.push(j.context.lastGateReport); return { output: null, summary: '' }; }) },
    });
    await engine.start({ workflow: 'hello', input: {}, workspace: process.cwd() });
    expect(seen[0]).toBeUndefined(); // analyse
    expect(seen[1]).toBeUndefined(); // implement, first try
    expect(seen[2]).toMatchObject({ passed: false }); // implement, rework
  });

  it('pauses on budget and resumes with a higher budget', async () => {
    const { engine } = engineFor(scaffold(orgFiles('true')));
    const paused = await engine.start({ workflow: 'hello', input: {}, workspace: process.cwd(), budgetUsd: 0.15 });
    expect(paused.status).toBe('paused_budget');
    expect(paused.nodes.qa).toBeUndefined();
    const done = await engine.resume(paused.runId, { budgetUsd: 5 });
    expect(done.status).toBe('completed');
  });

  it('defers a human decision, then respond() finishes the run', async () => {
    const { engine } = engineFor(scaffold(orgFiles('true')), { human: new DeferHuman() });
    const waiting = await engine.start({ workflow: 'hello', input: {}, workspace: process.cwd() });
    expect(waiting.status).toBe('waiting_human');
    expect(waiting.pendingHuman?.nodeId).toBe('ship');
    const done = await engine.respond(waiting.runId, { approved: true });
    expect(done.status).toBe('completed');
  });

  it('a rejected human approval cancels the run', async () => {
    const { engine } = engineFor(scaffold(orgFiles('true')), { human: { ask: async () => ({ approved: false, note: 'no' }) } });
    const s = await engine.start({ workflow: 'hello', input: {}, workspace: process.cwd() });
    expect(s.status).toBe('cancelled');
    expect(s.error).toContain('ship');
  });

  it('fails the task node when no adapter matches the role runtime', async () => {
    const dir = scaffold({ ...orgFiles('true'), 'roles/analyst.yaml': 'role: analyst\nruntime: claude-code\n' });
    const { engine } = engineFor(dir);
    const s = await engine.start({ workflow: 'hello', input: {}, workspace: process.cwd() });
    expect(s.status).toBe('failed');
    expect(s.error).toContain('no adapter registered for runtime "claude-code"');
  });

  it('resume after a crash re-runs the interrupted node without repeating completed ones', async () => {
    const dir = scaffold(orgFiles('true'));
    const calls: string[] = [];
    const { engine, store } = engineFor(dir, { adapters: { mock: new MockAdapter((j) => { calls.push(j.nodeId); return { output: null, summary: '' }; }) } });
    const at = '2026-09-25T10:00:00.000Z';
    await store.append({ type: 'RunCreated', runId: 'crash', at, workflow: 'hello', input: {}, workspace: process.cwd() });
    await store.append({ type: 'NodeStarted', runId: 'crash', nodeId: 'analyse', at });
    await store.append({ type: 'NodeCompleted', runId: 'crash', nodeId: 'analyse', at, output: 1, summary: '' });
    await store.append({ type: 'NodeStarted', runId: 'crash', nodeId: 'implement', at });
    const s = await engine.resume('crash');
    expect(s.status).toBe('completed');
    expect(calls).toEqual(['implement']);
    expect(s.nodes.implement?.attempts).toBe(2);
  });

  it('cancels a workflow that would loop forever', async () => {
    const dir = scaffold({
      ...orgFiles('true'),
      'teams/eng.yaml': 'team: eng\nlead: tl\nroles: [tl, analyst, backend]\nworkflows: [hello]\n',
      'workflows/hello.yaml': 'workflow: hello\nstart: a\nnodes:\n  a: { type: decide, by: tl, options: [again, again2], next: { again: b, again2: b } }\n  b: { type: gate, gates: [tests], on_pass: a, on_fail: a, max_retries: 0 }\n',
    });
    const { engine } = engineFor(dir, { decider: new ScriptedDecider({}, 'again'), maxSteps: 10 });
    const s = await engine.start({ workflow: 'hello', input: {}, workspace: process.cwd() });
    expect(['cancelled', 'completed']).toContain(s.status);
  });
});
```

Nota sobre o último teste: com `a` e `b` a alternar, `a` fica `completed` após a primeira decisão e nunca volta a `pending`, portanto o run termina em `completed` naturalmente. O teste aceita ambos os resultados para pinar que o motor **termina**; o guarda `maxSteps` protege os casos em que um gate reprovado repõe nós a `pending`.

- [ ] **Step 2: Correr para ver falhar**

Run: `pnpm --filter @shibaox/core test`
Expected: FAIL, `RunEngine` não exportado.

- [ ] **Step 3: Implementar deciders e human handlers**

`packages/core/src/run/deciders.ts`:
```ts
import type { Cost, GateReport } from '@shibaox/schemas';

export interface DecisionRequest {
  runId: string;
  nodeId: string;
  by: string;
  question: string;
  options: string[];
  context: { input: Record<string, unknown>; previousOutputs: Record<string, unknown>; lastGateReport?: GateReport };
}
export interface Decision {
  choice: string;
  confidence?: number;
  cost?: Cost;
}
export interface Decider {
  decide(req: DecisionRequest): Promise<Decision>;
}

export class ScriptedDecider implements Decider {
  constructor(private readonly choices: Record<string, string>, private readonly fallback?: string) {}
  async decide(req: DecisionRequest): Promise<Decision> {
    const choice = this.choices[req.nodeId] ?? this.fallback ?? req.options[0];
    if (!choice) throw new Error(`no scripted choice for node ${req.nodeId}`);
    return { choice, confidence: 1 };
  }
}

export interface HumanRequest {
  runId: string;
  nodeId: string;
  action: string;
  prompt: string;
}
export type HumanAnswer = { approved: boolean; note?: string } | { deferred: true };
export interface HumanHandler {
  ask(req: HumanRequest): Promise<HumanAnswer>;
}
export class AutoApproveHuman implements HumanHandler {
  async ask(): Promise<HumanAnswer> {
    return { approved: true, note: 'auto-approved' };
  }
}
export class DeferHuman implements HumanHandler {
  async ask(): Promise<HumanAnswer> {
    return { deferred: true };
  }
}
```

- [ ] **Step 4: Implementar o engine**

`packages/core/src/run/engine.ts`:
```ts
import { randomUUID } from 'node:crypto';
import type { Org, RunEvent, Workflow, WorkflowNode } from '@shibaox/schemas';
import type { EventStore } from '../events/store.js';
import { runCommand } from '../executors/code.js';
import { type RuntimeAdapter, type TaskJob, collectRun } from '../executors/types.js';
import { type CheckRunners, defaultCheckRunners, runGate } from '../gates/engine.js';
import { injectTeamGates } from '../org/inject-gates.js';
import type { Decider, HumanHandler } from './deciders.js';
import { replay } from './reducer.js';
import { readyNodes } from './scheduler.js';
import type { RunState } from './state.js';

export interface EngineDeps {
  store: EventStore;
  org: Org;
  adapters: Record<string, RuntimeAdapter>;
  defaultAdapter?: string;
  decider: Decider;
  human: HumanHandler;
  checkRunners?: CheckRunners;
  log?: (line: string) => void;
  now?: () => string;
  maxSteps?: number;
  newRunId?: () => string;
}

export class RunEngine {
  private readonly log: (line: string) => void;
  private readonly now: () => string;
  private readonly maxSteps: number;
  private readonly checkRunners: CheckRunners;

  constructor(private readonly deps: EngineDeps) {
    this.log = deps.log ?? (() => {});
    this.now = deps.now ?? (() => new Date().toISOString());
    this.maxSteps = deps.maxSteps ?? 200;
    this.checkRunners = deps.checkRunners ?? defaultCheckRunners();
  }

  async start(opts: { workflow: string; input: Record<string, unknown>; workspace: string; budgetUsd?: number }): Promise<RunState> {
    this.resolveWorkflow(opts.workflow);
    const runId = (this.deps.newRunId ?? randomUUID)();
    await this.emit({ type: 'RunCreated', runId, at: this.now(), workflow: opts.workflow, input: opts.input, workspace: opts.workspace, budgetUsd: opts.budgetUsd });
    return this.drive(runId);
  }

  async state(runId: string): Promise<RunState> {
    const events = await this.deps.store.read(runId);
    if (events.length === 0) throw new Error(`run ${runId} not found`);
    return replay(events);
  }

  async respond(runId: string, answer: { approved: boolean; note?: string }): Promise<RunState> {
    const state = await this.state(runId);
    if (state.status !== 'waiting_human' || !state.pendingHuman) throw new Error(`run ${runId} is not waiting for a human`);
    await this.recordHuman(runId, state.pendingHuman.nodeId, answer);
    return this.drive(runId);
  }

  async resume(runId: string, opts: { budgetUsd?: number } = {}): Promise<RunState> {
    const state = await this.state(runId);
    if (state.status === 'paused_budget') {
      await this.emit({ type: 'RunResumed', runId, at: this.now(), budgetUsd: opts.budgetUsd });
    } else if (state.status === 'waiting_human' && state.pendingHuman) {
      const answer = await this.deps.human.ask({ runId, ...state.pendingHuman });
      if ('deferred' in answer) return state;
      await this.recordHuman(runId, state.pendingHuman.nodeId, answer);
    } else if (state.status !== 'running') {
      return state;
    }
    return this.drive(runId, { interrupted: true });
  }

  private resolveWorkflow(name: string): Workflow {
    const wf = this.deps.org.workflows[name];
    if (!wf) throw new Error(`workflow "${name}" is not defined in the org`);
    const team = wf.team ? this.deps.org.teams[wf.team] : undefined;
    return team ? injectTeamGates(wf, team) : wf;
  }

  private async emit(event: RunEvent): Promise<void> {
    await this.deps.store.append(event);
    this.log(`[${event.runId.slice(0, 8)}] ${event.type}${'nodeId' in event ? ` ${event.nodeId}` : ''}`);
  }

  private async recordHuman(runId: string, nodeId: string, answer: { approved: boolean; note?: string }): Promise<void> {
    await this.emit({ type: 'HumanResponded', runId, nodeId, at: this.now(), approved: answer.approved, note: answer.note });
    if (!answer.approved) await this.emit({ type: 'RunCancelled', runId, at: this.now(), reason: `rejected by human at ${nodeId}${answer.note ? `: ${answer.note}` : ''}` });
  }

  private async drive(runId: string, opts: { interrupted?: boolean } = {}): Promise<RunState> {
    let interrupted = opts.interrupted ?? false;
    for (let steps = 0; ; steps++) {
      let state = await this.state(runId);
      if (interrupted) {
        state = markInterrupted(state);
        interrupted = false;
      }
      if (state.status !== 'running') return state;
      const workflow = this.resolveWorkflow(state.workflow);
      const ready = readyNodes(state, workflow);
      if (ready.length === 0) {
        await this.emit({ type: 'RunCompleted', runId, at: this.now() });
        return this.state(runId);
      }
      if (steps >= this.maxSteps) {
        await this.emit({ type: 'RunCancelled', runId, at: this.now(), reason: `max steps exceeded (${this.maxSteps})` });
        return this.state(runId);
      }
      await Promise.all(ready.map((nodeId) => this.executeNode(runId, nodeId, workflow, state)));
      await this.checkBudget(runId);
    }
  }

  private async checkBudget(runId: string): Promise<void> {
    const s = await this.state(runId);
    if (s.budgetUsd === undefined || s.status !== 'running') return;
    if (s.spentUsd >= s.budgetUsd) {
      await this.emit({ type: 'BudgetExceeded', runId, at: this.now(), spentUsd: s.spentUsd, limitUsd: s.budgetUsd });
    } else if (!s.budgetWarned && s.spentUsd >= 0.8 * s.budgetUsd) {
      await this.emit({ type: 'BudgetWarning', runId, at: this.now(), spentUsd: s.spentUsd, limitUsd: s.budgetUsd });
    }
  }

  private previousOutputs(state: RunState): Record<string, unknown> {
    return Object.fromEntries(Object.entries(state.nodes).filter(([, n]) => n.status === 'completed').map(([id, n]) => [id, n.output]));
  }

  private async executeNode(runId: string, nodeId: string, workflow: Workflow, state: RunState): Promise<void> {
    const node = workflow.nodes[nodeId] as WorkflowNode;
    const at = () => this.now();
    await this.emit({ type: 'NodeStarted', runId, nodeId, at: at() });
    const attempts = (state.nodes[nodeId]?.attempts ?? 0) + 1;
    try {
      switch (node.type) {
        case 'task': {
          const role = this.deps.org.roles[node.role];
          if (!role) throw new Error(`role "${node.role}" is not defined`);
          const runtimeId = this.deps.defaultAdapter ?? role.runtime;
          const adapter = this.deps.adapters[runtimeId];
          if (!adapter) throw new Error(`no adapter registered for runtime "${runtimeId}"`);
          const job: TaskJob = {
            runId, nodeId, role, instruction: node.instruction ?? '', input: state.input, workspace: state.workspace,
            context: { lastGateReport: state.lastGateReport, previousOutputs: this.previousOutputs(state) },
          };
          const result = await collectRun(adapter, job, { signal: new AbortController().signal, log: this.log });
          await this.emit({ type: 'NodeCompleted', runId, nodeId, at: at(), output: result.output, summary: result.summary, cost: result.cost });
          return;
        }
        case 'code': {
          const r = await runCommand({ command: node.command, cwd: state.workspace, timeoutMs: node.timeout_ms });
          if (r.exitCode !== 0 || r.timedOut) throw new Error(`command failed (exit ${r.exitCode}${r.timedOut ? ', timed out' : ''}): ${r.stderr.slice(-500)}`);
          await this.emit({ type: 'NodeCompleted', runId, nodeId, at: at(), output: { exitCode: r.exitCode, stdout: r.stdout }, summary: `ran ${node.command}` });
          return;
        }
        case 'decide': {
          const d = await this.deps.decider.decide({
            runId, nodeId, by: node.by, question: node.question ?? '', options: node.options,
            context: { input: state.input, previousOutputs: this.previousOutputs(state), lastGateReport: state.lastGateReport },
          });
          if (!node.options.includes(d.choice)) throw new Error(`decider chose "${d.choice}" which is not one of ${node.options.join(', ')}`);
          await this.emit({ type: 'DecisionMade', runId, nodeId, at: at(), choice: d.choice, confidence: d.confidence, cost: d.cost });
          return;
        }
        case 'gate': {
          const report = await runGate({ gateIds: node.gates, gates: this.deps.org.gates, runners: this.checkRunners, ctx: { runId, nodeId, workspace: state.workspace, state, log: this.log } });
          if (report.passed) {
            await this.emit({ type: 'GatePassed', runId, nodeId, at: at(), report, cost: report.cost });
          } else if (attempts > node.max_retries) {
            await this.emit({ type: 'NodeFailed', runId, nodeId, at: at(), error: `gate failed after ${attempts} attempts: ${report.checks.filter((c) => !c.passed && !c.skipped).map((c) => c.name).join(', ')}` });
          } else {
            await this.emit({ type: 'GateFailed', runId, nodeId, at: at(), report, rework: node.on_fail, cost: report.cost });
          }
          return;
        }
        case 'human': {
          const prompt = node.prompt ?? `Approve "${node.action}"?`;
          await this.emit({ type: 'HumanRequested', runId, nodeId, at: at(), action: node.action, prompt });
          const answer = await this.deps.human.ask({ runId, nodeId, action: node.action, prompt });
          if ('deferred' in answer) return;
          await this.recordHuman(runId, nodeId, answer);
          return;
        }
        case 'parallel':
          await this.emit({ type: 'NodeCompleted', runId, nodeId, at: at(), output: null, summary: `fan-out ${node.branches.join(', ')}` });
          return;
      }
    } catch (e) {
      await this.emit({ type: 'NodeFailed', runId, nodeId, at: at(), error: (e as Error).message });
    }
  }
}

function markInterrupted(state: RunState): RunState {
  const nodes = Object.fromEntries(Object.entries(state.nodes).map(([id, n]) => [id, n.status === 'running' ? { ...n, status: 'pending' as const } : n]));
  return { ...state, nodes };
}
```
Exports no index: `export * from './run/deciders.js'; export * from './run/engine.js';`

Atenção ao caso `paused_budget` em `resume`: após `RunResumed` o `drive` é chamado com `interrupted: true`, o que é inofensivo porque nenhum nó fica `running` num run pausado por orçamento.

- [ ] **Step 5: Correr**

Run: `pnpm --filter @shibaox/core test && pnpm --filter @shibaox/core typecheck`
Expected: PASS em todos os testes do engine.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): RunEngine drives workflows with gates, decisions, human approval, budget and resume

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Event store SQLite

**Files:**
- Create: `packages/persistence-sqlite/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`
- Test: `packages/persistence-sqlite/test/sqlite-store.test.ts`

**Interfaces:**
- Consumes: `EventStore`, `StoredEvent`, `RunSummary`, `replay` (core); `RunEventSchema` (schemas).
- Produces: `class SqliteEventStore implements EventStore { constructor(path: string | ':memory:'); close(): void }`.

- [ ] **Step 1: Pacote**

`packages/persistence-sqlite/package.json`:
```json
{
  "name": "@shibaox/persistence-sqlite",
  "version": "0.0.1",
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "scripts": { "build": "tsc -p tsconfig.json", "test": "vitest run", "typecheck": "tsc -p tsconfig.json --noEmit" },
  "dependencies": { "@shibaox/core": "workspace:*", "@shibaox/schemas": "workspace:*", "better-sqlite3": "^13.0.3" },
  "devDependencies": { "@types/better-sqlite3": "^7.6.13" }
}
```
`tsconfig.json` igual aos outros. `vitest.config.ts` com aliases para `../core/src/index.ts` e `../schemas/src/index.ts` (mesmo padrão da Task 4).

- [ ] **Step 2: Teste (falha)**

`packages/persistence-sqlite/test/sqlite-store.test.ts`:
```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteEventStore } from '../src/index.js';

const at = '2026-09-25T10:00:00.000Z';

describe('SqliteEventStore', () => {
  it('persists events across instances and preserves order', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sx-')), 'events.db');
    const a = new SqliteEventStore(file);
    await a.append({ type: 'RunCreated', runId: 'r1', at, workflow: 'w', input: { k: 1 }, workspace: '/w' });
    await a.append({ type: 'NodeStarted', runId: 'r1', nodeId: 'a', at });
    a.close();
    const b = new SqliteEventStore(file);
    const events = await b.read('r1');
    expect(events.map((e) => [e.seq, e.type])).toEqual([[1, 'RunCreated'], [2, 'NodeStarted']]);
    expect(events[0]).toMatchObject({ input: { k: 1 } });
    const runs = await b.listRuns();
    expect(runs).toEqual([{ runId: 'r1', workflow: 'w', status: 'running', createdAt: at, updatedAt: at }]);
    b.close();
  });
  it('rejects an event that does not match the schema', async () => {
    const s = new SqliteEventStore(':memory:');
    // @ts-expect-error deliberately malformed
    await expect(s.append({ type: 'Nope', runId: 'x', at })).rejects.toThrow();
  });
  it('returns an empty list for an unknown run', async () => {
    const s = new SqliteEventStore(':memory:');
    expect(await s.read('missing')).toEqual([]);
  });
});
```

- [ ] **Step 3: Implementar**

`packages/persistence-sqlite/src/index.ts`:
```ts
import Database from 'better-sqlite3';
import { type EventStore, type RunSummary, type StoredEvent, replay } from '@shibaox/core';
import { type RunEvent, RunEventSchema } from '@shibaox/schemas';

export class SqliteEventStore implements EventStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      type TEXT NOT NULL,
      at TEXT NOT NULL,
      payload TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seq);`);
  }

  async append(event: RunEvent): Promise<StoredEvent> {
    const parsed = RunEventSchema.parse(event);
    const info = this.db
      .prepare('INSERT INTO events (run_id, type, at, payload) VALUES (?, ?, ?, ?)')
      .run(parsed.runId, parsed.type, parsed.at, JSON.stringify(parsed));
    return { ...parsed, seq: Number(info.lastInsertRowid) };
  }

  async read(runId: string): Promise<StoredEvent[]> {
    const rows = this.db.prepare('SELECT seq, payload FROM events WHERE run_id = ? ORDER BY seq').all(runId) as { seq: number; payload: string }[];
    return rows.map((r) => ({ ...(JSON.parse(r.payload) as RunEvent), seq: r.seq }));
  }

  async listRuns(): Promise<RunSummary[]> {
    const ids = this.db.prepare('SELECT run_id FROM events GROUP BY run_id ORDER BY MIN(seq)').all() as { run_id: string }[];
    const out: RunSummary[] = [];
    for (const { run_id } of ids) {
      const events = await this.read(run_id);
      const state = replay(events);
      out.push({ runId: run_id, workflow: state.workflow, status: state.status, createdAt: events[0]!.at, updatedAt: events[events.length - 1]!.at });
    }
    return out;
  }

  close(): void {
    this.db.close();
  }
}
```
- [ ] **Step 4: Correr**

Run: `pnpm install && pnpm build && pnpm --filter @shibaox/persistence-sqlite test`
Expected: PASS. Se `better-sqlite3` falhar a compilar, confirmar `pnpm.onlyBuiltDependencies` na raiz e correr `pnpm rebuild better-sqlite3`.

- [ ] **Step 5: Commit**

```bash
git add packages/persistence-sqlite pnpm-lock.yaml
git commit -m "feat(persistence): SQLite event store with schema validation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: CLI `shibaox` com `init`, `doctor`, `run`, `runs`, `replay` e repo de exemplo

**Files:**
- Create: `apps/cli/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`, `src/templates.ts`, `src/commands/init.ts`, `src/commands/doctor.ts`, `src/commands/run.ts`, `src/commands/runs.ts`, `src/commands/replay.ts`, `src/terminal-human.ts`
- Create: `examples/sample-repo/package.json`, `examples/sample-repo/math.js`, `examples/sample-repo/math.test.js`
- Test: `apps/cli/test/init.test.ts`, `apps/cli/test/run-e2e.test.ts`

**Interfaces:**
- Consumes: `loadOrg`, `RunEngine`, `MockAdapter`, `ScriptedDecider`, `SqliteEventStore`, `replay`.
- Produces: binário `shibaox`; `scaffoldOrg(dir): string[]` (lista de ficheiros criados); `TerminalHuman implements HumanHandler`.

- [ ] **Step 1: Pacote e repo de exemplo**

`apps/cli/package.json`:
```json
{
  "name": "@shibaox/cli",
  "version": "0.0.1",
  "type": "module",
  "bin": { "shibaox": "./dist/index.js" },
  "scripts": { "build": "tsc -p tsconfig.json && chmod +x dist/index.js", "test": "vitest run", "typecheck": "tsc -p tsconfig.json --noEmit", "dev": "tsx src/index.ts" },
  "dependencies": {
    "@shibaox/core": "workspace:*",
    "@shibaox/persistence-sqlite": "workspace:*",
    "@shibaox/schemas": "workspace:*",
    "commander": "^15.0.0"
  },
  "devDependencies": { "tsx": "^4.20.0" }
}
```
`vitest.config.ts` com aliases para core, schemas e persistence-sqlite (`../../packages/<x>/src/index.ts`).

`examples/sample-repo/package.json`:
```json
{ "name": "sample-repo", "private": true, "type": "module", "scripts": { "test": "node --test" } }
```
`examples/sample-repo/math.js`:
```js
export const add = (a, b) => a + b;
```
`examples/sample-repo/math.test.js`:
```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { add } from './math.js';

test('add', () => { assert.equal(add(2, 2), 4); });
```

- [ ] **Step 2: Templates e `init` (teste primeiro)**

`apps/cli/test/init.test.ts`:
```ts
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrg } from '@shibaox/schemas';
import { describe, expect, it } from 'vitest';
import { scaffoldOrg } from '../src/commands/init.js';

describe('scaffoldOrg', () => {
  it('creates a loadable org and the vault skeleton', () => {
    const dir = mkdtempSync(join(tmpdir(), 'init-'));
    const files = scaffoldOrg(dir);
    expect(files.length).toBeGreaterThan(5);
    const org = loadOrg(join(dir, 'org'));
    expect(org.workflows['hello-feature']).toBeDefined();
    expect(org.teams.engineering?.gates).toEqual(['tests']);
    for (const d of ['00-org', '10-projects', '20-clients', '30-knowledge', '90-system']) expect(existsSync(join(dir, 'vault', d))).toBe(true);
  });
  it('does not overwrite existing files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'init-'));
    scaffoldOrg(dir);
    expect(scaffoldOrg(dir)).toEqual([]);
  });
});
```

`apps/cli/src/templates.ts`:
```ts
export const ORG_TEMPLATE: Record<string, string> = {
  'org/org.yaml': `organization: my-org
budgets:
  per_run_usd: 5
teams: [engineering]
`,
  'org/models.yaml': `providers:
  anthropic: { api_key_env: ANTHROPIC_API_KEY }
tiers:
  strong: claude-opus-5-5
  cheap: claude-haiku-4-5
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
  'org/prompts/team-leader.md': '# Team leader\nYou judge whether work is ready. Be strict about tests and scope.\n',
  'org/prompts/analyst.md': '# Analyst\nYou read the request and the codebase and list what must change, with risks.\n',
  'org/prompts/backend.md': '# Backend\nYou implement changes with tests. Never push without approval.\n',
  'vault/00-org/.gitkeep': '',
  'vault/10-projects/.gitkeep': '',
  'vault/20-clients/.gitkeep': '',
  'vault/30-knowledge/.gitkeep': '',
  'vault/90-system/.gitkeep': '',
};
```

`apps/cli/src/commands/init.ts`:
```ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ORG_TEMPLATE } from '../templates.js';

export function scaffoldOrg(dir: string): string[] {
  const created: string[] = [];
  for (const [rel, content] of Object.entries(ORG_TEMPLATE)) {
    const file = join(dir, rel);
    if (existsSync(file)) continue;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    created.push(rel);
  }
  return created;
}

export function initCommand(dir: string): void {
  const created = scaffoldOrg(dir);
  if (created.length === 0) {
    console.log('Nothing to do: org/ and vault/ already exist.');
    return;
  }
  console.log(`Created ${created.length} files under ${dir}:`);
  for (const f of created) console.log(`  ${f}`);
  console.log('\nNext: shibaox doctor && shibaox run hello-feature --org ./org --project <path> --input "..."');
}
```

Run: `pnpm --filter @shibaox/cli test` → Expected: PASS nos dois testes de init.

- [ ] **Step 3: `doctor`**

`apps/cli/src/commands/doctor.ts`:
```ts
import { runCommand } from '@shibaox/core';

interface CheckLine { name: string; ok: boolean; detail: string; required: boolean }

async function which(bin: string, versionFlag = '--version'): Promise<CheckLine> {
  const r = await runCommand({ command: `${bin} ${versionFlag}`, cwd: process.cwd(), timeoutMs: 10_000 });
  const ok = r.exitCode === 0;
  return { name: bin, ok, detail: ok ? r.stdout.trim().split('\n')[0] ?? '' : 'not found', required: false };
}

export async function doctorCommand(): Promise<number> {
  const lines: CheckLine[] = [];
  lines.push({ ...(await which('node')), required: true });
  lines.push({ ...(await which('git')), required: true });
  lines.push(await which('uv'));
  lines.push(await which('graphify'));
  lines.push(await which('claude'));
  lines.push(await which('codex'));
  lines.push(await which('cursor'));
  for (const env of ['ANTHROPIC_API_KEY', 'TYPESAFE_API_KEY']) {
    lines.push({ name: env, ok: Boolean(process.env[env]), detail: process.env[env] ? 'set' : 'missing', required: env === 'ANTHROPIC_API_KEY' });
  }
  for (const l of lines) console.log(`${l.ok ? 'OK  ' : l.required ? 'FAIL' : 'warn'}  ${l.name.padEnd(20)} ${l.detail}`);
  const failed = lines.some((l) => l.required && !l.ok);
  console.log(failed ? '\nFix the FAIL lines before running workflows.' : '\nReady for mock runs. Phase 1B adds real runtimes.');
  return failed ? 1 : 0;
}
```

- [ ] **Step 4: `TerminalHuman`, `run`, `runs`, `replay` e entrada**

`apps/cli/src/terminal-human.ts`:
```ts
import { createInterface } from 'node:readline/promises';
import type { HumanAnswer, HumanHandler, HumanRequest } from '@shibaox/core';

export class TerminalHuman implements HumanHandler {
  async ask(req: HumanRequest): Promise<HumanAnswer> {
    if (!process.stdin.isTTY) return { deferred: true };
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question(`\n[${req.nodeId}] ${req.prompt} (y/n) `)).trim().toLowerCase();
      return { approved: answer === 'y' || answer === 'yes' };
    } finally {
      rl.close();
    }
  }
}
```

`apps/cli/src/commands/run.ts`:
```ts
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type HumanHandler, MockAdapter, RunEngine, type RunState, ScriptedDecider } from '@shibaox/core';
import { SqliteEventStore } from '@shibaox/persistence-sqlite';
import { loadOrg } from '@shibaox/schemas';
import { TerminalHuman } from '../terminal-human.js';

export interface RunOptions {
  org: string;
  project: string;
  input: string;
  adapter: 'mock';
  budget?: number;
  db?: string;
  human?: HumanHandler;
  log?: (line: string) => void;
}

export function dbPath(orgDir: string, override?: string): string {
  const path = override ?? join(orgDir, '.shibaox', 'events.db');
  mkdirSync(join(path, '..'), { recursive: true });
  return path;
}

export async function runWorkflow(workflow: string, opts: RunOptions): Promise<RunState> {
  const orgDir = resolve(opts.org);
  const org = loadOrg(orgDir);
  const store = new SqliteEventStore(dbPath(orgDir, opts.db));
  try {
    const engine = new RunEngine({
      store,
      org,
      adapters: { mock: new MockAdapter((j) => ({ output: { instruction: j.instruction }, summary: `mock ${j.role.role}: ${j.instruction}`, cost: { usd: 0.001, inputTokens: 10, outputTokens: 10 } })) },
      defaultAdapter: opts.adapter,
      decider: new ScriptedDecider({}, 'ship'),
      human: opts.human ?? new TerminalHuman(),
      log: opts.log ?? ((l) => console.log(l)),
    });
    return await engine.start({ workflow, input: { spec: opts.input }, workspace: resolve(opts.project), budgetUsd: opts.budget });
  } finally {
    store.close();
  }
}

export function printState(state: RunState): void {
  console.log(`\nrun ${state.runId}  workflow=${state.workflow}  status=${state.status}  spent=$${state.spentUsd.toFixed(4)}`);
  for (const [id, n] of Object.entries(state.nodes)) console.log(`  ${id.padEnd(22)} ${n.status.padEnd(10)} attempts=${n.attempts}${n.choice ? ` choice=${n.choice}` : ''}${n.error ? ` error=${n.error}` : ''}`);
  if (state.error) console.log(`  error: ${state.error}`);
  if (state.pendingHuman) console.log(`  waiting for human at ${state.pendingHuman.nodeId}: ${state.pendingHuman.prompt}`);
}
```

`apps/cli/src/commands/runs.ts`:
```ts
import { resolve } from 'node:path';
import { SqliteEventStore } from '@shibaox/persistence-sqlite';
import { dbPath } from './run.js';

export async function runsCommand(orgDir: string, db?: string): Promise<void> {
  const store = new SqliteEventStore(dbPath(resolve(orgDir), db));
  try {
    const runs = await store.listRuns();
    if (runs.length === 0) console.log('no runs yet');
    for (const r of runs) console.log(`${r.runId}  ${r.workflow.padEnd(20)} ${r.status.padEnd(14)} ${r.updatedAt}`);
  } finally {
    store.close();
  }
}
```

`apps/cli/src/commands/replay.ts`:
```ts
import { resolve } from 'node:path';
import { replay } from '@shibaox/core';
import { SqliteEventStore } from '@shibaox/persistence-sqlite';
import { dbPath, printState } from './run.js';

export async function replayCommand(runId: string, orgDir: string, db?: string): Promise<void> {
  const store = new SqliteEventStore(dbPath(resolve(orgDir), db));
  try {
    const events = await store.read(runId);
    if (events.length === 0) {
      console.log(`run ${runId} not found`);
      return;
    }
    for (const e of events) console.log(`${String(e.seq).padStart(4)}  ${e.at}  ${e.type}${'nodeId' in e ? ` ${e.nodeId}` : ''}${e.type === 'NodeFailed' ? `  ${e.error}` : ''}`);
    printState(replay(events));
  } finally {
    store.close();
  }
}
```

`apps/cli/src/index.ts`:
```ts
#!/usr/bin/env node
import { Command } from 'commander';
import { doctorCommand } from './commands/doctor.js';
import { initCommand } from './commands/init.js';
import { replayCommand } from './commands/replay.js';
import { printState, runWorkflow } from './commands/run.js';
import { runsCommand } from './commands/runs.js';

const program = new Command().name('shibaox').description('Agent OS over coding runtimes').version('0.0.1');

program.command('init').argument('[dir]', 'target directory', '.').description('scaffold org/ and vault/').action((dir: string) => initCommand(dir));
program.command('doctor').description('check local prerequisites').action(async () => process.exit(await doctorCommand()));
program
  .command('run')
  .argument('<workflow>')
  .requiredOption('--org <dir>', 'org repo directory')
  .requiredOption('--project <path>', 'project workspace')
  .requiredOption('--input <text>', 'request / spec text')
  .option('--adapter <id>', 'runtime adapter (phase 1A: mock)', 'mock')
  .option('--budget <usd>', 'budget in USD', (v) => Number(v))
  .option('--db <path>', 'events database path')
  .action(async (workflow: string, o: { org: string; project: string; input: string; adapter: 'mock'; budget?: number; db?: string }) => {
    const state = await runWorkflow(workflow, o);
    printState(state);
    process.exit(state.status === 'completed' ? 0 : 2);
  });
program.command('runs').requiredOption('--org <dir>').option('--db <path>').action((o: { org: string; db?: string }) => runsCommand(o.org, o.db));
program.command('replay').argument('<runId>').requiredOption('--org <dir>').option('--db <path>').action((runId: string, o: { org: string; db?: string }) => replayCommand(runId, o.org, o.db));

program.parseAsync(process.argv).catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
```

- [ ] **Step 5: Teste fim a fim com mock (falha até o build estar feito)**

`apps/cli/test/run-e2e.test.ts`:
```ts
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoApproveHuman } from '@shibaox/core';
import { describe, expect, it } from 'vitest';
import { scaffoldOrg } from '../src/commands/init.js';
import { runWorkflow } from '../src/commands/run.js';

const sample = new URL('../../../examples/sample-repo', import.meta.url).pathname;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
  scaffoldOrg(dir);
  const project = join(dir, 'project');
  cpSync(sample, project, { recursive: true });
  return { org: join(dir, 'org'), project, db: join(dir, 'events.db') };
}

describe('shibaox run (mock adapter)', () => {
  it('completes hello-feature against the sample repo', async () => {
    const { org, project, db } = setup();
    const state = await runWorkflow('hello-feature', { org, project, db, input: 'add /health', adapter: 'mock', human: new AutoApproveHuman(), log: () => {} });
    expect(state.status).toBe('completed');
    expect(state.nodes.qa?.status).toBe('passed');
    expect(state.nodes.judge?.choice).toBe('ship');
  });
  it('fails after retries when the sample tests are broken', async () => {
    const { org, project, db } = setup();
    writeFileSync(join(project, 'math.test.js'), "import { test } from 'node:test'; test('x', () => { throw new Error('broken'); });\n");
    const state = await runWorkflow('hello-feature', { org, project, db, input: 'x', adapter: 'mock', human: new AutoApproveHuman(), log: () => {} });
    expect(state.status).toBe('failed');
    expect(state.error).toContain('gate failed after 3 attempts');
    expect(state.lastGateReport?.checks[0]?.evidence).toContain('broken');
  });
  it('pauses on a tiny budget', async () => {
    const { org, project, db } = setup();
    const state = await runWorkflow('hello-feature', { org, project, db, input: 'x', adapter: 'mock', budget: 0.000001, human: new AutoApproveHuman(), log: () => {} });
    expect(state.status).toBe('paused_budget');
  });
});
```
O `MockAdapter` em `run.ts` reporta um custo fixo por tarefa para que o teste de orçamento seja determinístico.

- [ ] **Step 6: Correr tudo e fazer um run manual**

Run: `pnpm install && pnpm build && pnpm test && pnpm typecheck`
Expected: verde em todos os pacotes.

Run manual (a partir da raiz):
```bash
mkdir -p /tmp/sx-demo && node apps/cli/dist/index.js init /tmp/sx-demo
node apps/cli/dist/index.js doctor
node apps/cli/dist/index.js run hello-feature --org /tmp/sx-demo/org --project examples/sample-repo --input "add /health"
node apps/cli/dist/index.js runs --org /tmp/sx-demo/org
node apps/cli/dist/index.js replay <runId> --org /tmp/sx-demo/org
```
Expected: o run pergunta `[ship] Approve the push? (y/n)`, responde-se `y`, termina `status=completed`; `runs` lista o run; `replay` mostra a timeline e o estado final. Correr de novo com `< /dev/null` (sem TTY) e confirmar `status=waiting_human` e `replay` a mostrar `waiting for human at ship`.

- [ ] **Step 7: Commit**

```bash
git add apps/cli examples pnpm-lock.yaml
git commit -m "feat(cli): shibaox init/doctor/run/runs/replay with mock end-to-end run

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

**Cobertura da spec (fase 1A):** secção 1 (modelo YAML) → Tasks 2–3; secção 2 (grafo de estados, eventos, replay) → Tasks 4–5 e 9; secção 3 (contrato `RuntimeAdapter`, executor `code`) → Task 6; secção 5 (gates com relatório estruturado e rework) → Tasks 7 e 9; gates obrigatórios da equipa → Task 8; orçamento por run → Task 9; persistência solo em SQLite → Task 10; CLI `init/doctor/run/runs/replay` → Task 11. Ficam explicitamente para 1B: Jev (`decide` e checks `jev`/`judge`), adaptador Claude Code, worktree por run, router `models.yaml`, vault writer, graphify, autorouting, orçamento por equipa/organização e merge queue.

**Review Focus → testes:** (1) referência inválida → `load.test.ts`; (2) rework infinito → `engine.test.ts` "fails the run after max_retries" e `run-e2e.test.ts`; (3) comando pendurado → `code.test.ts` timeout; (4) crash e resume → `engine.test.ts` "resume after a crash" e persistência em `sqlite-store.test.ts`; (5) sem TTY → `TerminalHuman` devolve `deferred` e o run manual sem TTY na Task 11.

**Consistência de nomes:** `readyNodes`, `replay`, `reduce`, `RunEngine.start/resume/respond/state`, `runGate`, `defaultCheckRunners`, `injectTeamGates`, `collectRun`, `runCommand`, `MockAdapter`, `ScriptedDecider`, `AutoApproveHuman`, `DeferHuman`, `TerminalHuman`, `SqliteEventStore`, `scaffoldOrg`, `runWorkflow`, `printState`, `dbPath` são usados com os mesmos nomes em todas as tarefas. O campo do nó gate é `gates` em todo o lado.
