import type {
  Capability,
  ExecutionContext,
  RuntimeAdapter,
  RuntimeEvent,
  TaskJob,
  TaskResult,
} from './types.js';

export type MockScript = (job: TaskJob) => TaskResult | Promise<TaskResult>;

export class MockAdapter implements RuntimeAdapter {
  readonly id = 'mock';
  constructor(
    private readonly script: MockScript = (job) => ({
      output: { instruction: job.instruction },
      summary: `mock ${job.role.role} did: ${job.instruction}`,
    }),
  ) {}
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
