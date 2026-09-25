import { createInterface } from 'node:readline/promises';
import type { HumanAnswer, HumanHandler, HumanRequest } from '@shibaox/core';

export class TerminalHuman implements HumanHandler {
  async ask(req: HumanRequest): Promise<HumanAnswer> {
    if (!process.stdin.isTTY) return { deferred: true };
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question(`\n[${req.nodeId}] ${req.prompt} (y/n) `))
        .trim()
        .toLowerCase();
      return { approved: answer === 'y' || answer === 'yes' };
    } finally {
      rl.close();
    }
  }
}
