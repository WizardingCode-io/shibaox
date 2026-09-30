import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrg } from '@wizardingcode/shibaox-schemas';
import { describe, expect, it } from 'vitest';
import {
  AutoApproveHuman,
  MemoryEventStore,
  MockAdapter,
  RunEngine,
  ScriptedDecider,
  type TaskJob,
  validateJson,
} from '../src/index.js';

describe('validateJson (the JSON Schema subset a workflow output can ask for)', () => {
  const schema = {
    type: 'object',
    required: ['title', 'risk'],
    properties: {
      title: { type: 'string', minLength: 1 },
      risk: { type: 'string', enum: ['low', 'high'] },
      files: { type: 'array', items: { type: 'string' } },
      score: { type: 'number' },
    },
  };
  it('accepts what matches and names what does not', () => {
    expect(validateJson({ title: 'x', risk: 'low', files: ['a'] }, schema)).toEqual([]);
    expect(validateJson({ title: 'x', risk: 'medium' }, schema)).toEqual([
      'risk: must be one of low, high',
    ]);
    expect(validateJson({ risk: 'low' }, schema)).toEqual(['title: required']);
    expect(validateJson({ title: '', risk: 'low', files: [1] }, schema)).toEqual([
      'title: shorter than 1',
      'files[0]: expected string, got number',
    ]);
    expect(validateJson('nope', schema)).toEqual(['expected object, got string']);
    expect(validateJson({ title: 'x', risk: 'low', score: '1' }, schema)).toEqual([
      'score: expected number, got string',
    ]);
  });
});

describe('a workflow asked for a structured output', () => {
  function org() {
    const dir = mkdtempSync(join(tmpdir(), 'oschema-'));
    const files: Record<string, string> = {
      'org.yaml': 'organization: wc\nteams: [eng]\n',
      'teams/eng.yaml': 'team: eng\nlead: tl\nroles: [tl, a, b]\ngates: []\nworkflows: [two]\n',
      'roles/tl.yaml': 'role: tl\n',
      'roles/a.yaml': 'role: a\nruntime: mock\n',
      'roles/b.yaml': 'role: b\nruntime: mock\n',
      'workflows/two.yaml':
        'workflow: two\nteam: eng\nstart: first\nnodes:\n  first: { type: task, role: a, instruction: look, next: last }\n  last: { type: task, role: b, instruction: answer }\n',
    };
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    return dir;
  }
  const schema = {
    type: 'object',
    required: ['verdict'],
    properties: { verdict: { type: 'string', enum: ['ship', 'hold'] } },
  };
  it('hands the schema to the last task only, and fails the run when the output does not match', async () => {
    const jobs: TaskJob[] = [];
    const engine = (answer: unknown) =>
      new RunEngine({
        store: new MemoryEventStore(),
        org: loadOrg(org()),
        adapters: {
          mock: new MockAdapter((j) => {
            jobs.push(j);
            return { output: j.nodeId === 'last' ? answer : { looked: true }, summary: j.nodeId };
          }),
        },
        decider: new ScriptedDecider({}),
        human: new AutoApproveHuman(),
      });
    const good = await engine({ verdict: 'ship' }).start({
      workflow: 'two',
      input: { spec: 'x', output_schema: schema },
      workspace: process.cwd(),
    });
    expect(good.status).toBe('completed');
    expect(jobs.find((j) => j.nodeId === 'first')?.outputSchema).toBeUndefined();
    expect(jobs.find((j) => j.nodeId === 'last')?.outputSchema).toEqual(schema);
    const bad = await engine({ verdict: 'maybe' }).start({
      workflow: 'two',
      input: { spec: 'x', output_schema: schema },
      workspace: process.cwd(),
    });
    expect(bad.status).toBe('failed');
    expect(bad.nodes.last?.error).toMatch(/does not match.*verdict/s);
    const none = await engine({ anything: 1 }).start({
      workflow: 'two',
      input: { spec: 'x' },
      workspace: process.cwd(),
    });
    expect(none.status).toBe('completed');
  });
});
