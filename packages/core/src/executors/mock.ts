import type {
  Capability,
  ExecutionContext,
  RuntimeAdapter,
  RuntimeEvent,
  TaskJob,
  TaskResult,
} from './types.js';

export type MockScript = (job: TaskJob, ctx: ExecutionContext) => TaskResult | Promise<TaskResult>;

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
  async *run(job: TaskJob, ctx: ExecutionContext): AsyncIterable<RuntimeEvent> {
    if (ctx.signal.aborted) {
      yield { type: 'error', message: 'aborted' };
      return;
    }
    yield { type: 'started' };
    // a script that never settles still honours cancellation
    const aborted = new Promise<never>((_, reject) =>
      ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
    );
    try {
      const r = await Promise.race([this.script(job, ctx), aborted]);
      yield { type: 'result', output: r.output, summary: r.summary, cost: r.cost };
    } catch (e) {
      yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
    }
  }
}
