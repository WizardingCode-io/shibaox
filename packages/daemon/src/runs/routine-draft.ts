import { extractJson, LlmClient, type ProviderRegistry } from '@wizardingcode/shibaox-providers';
import {
  type Org,
  type RoutineApprovals,
  RoutineApprovalsSchema,
  type RoutineTrigger,
  RoutineTriggerSchema,
} from '@wizardingcode/shibaox-schemas';
import { z } from 'zod';
import { triggerWords } from './routine-words.js';

/** What "Create with Shibaox" proposes: a routine not saved yet. */
export interface RoutineDraft {
  name: string;
  description: string;
  trigger: RoutineTrigger;
  workflow: string;
  input: string;
  approvals?: RoutineApprovals;
  /** The trigger in words. */
  words: string;
}

const DraftSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(300).default(''),
  trigger: RoutineTriggerSchema,
  workflow: z.string().min(1),
  input: z.string().min(1),
  approvals: RoutineApprovalsSchema.optional(),
});

export const DRAFT_SYSTEM = `You turn a sentence into a routine for Shibaox, an agent that runs workflows on a schedule or when something it watches changes. Answer with one JSON object and nothing else:
{"name": string (short, sentence case), "description": string (one line), "trigger": one of
  {"type":"cron","cron":"m h dom mon dow"} (5 fields; weekdays = "1-5"),
  {"type":"github","watch":"issues"|"prs"|"checks","label"?:string,"repo"?:"owner/name","branch"?:string},
  {"type":"url","url":"https://…"}, {"type":"file","path":"…"}, {"type":"command","command":"…"}, {"type":"manual"},
 "workflow": one of the workflows offered, "input": the instruction the run gets (second person, what to do and what to report),
 "approvals": "inbox" (default: ask before pushes, deploys, commands) | "auto" | "skip" (only when the sentence clearly wants no questions)}.
Times are local. Prefer "chat" for reports and summaries, a code workflow for changes to a repository. Never invent a repository or a label the sentence does not give.`;

/** The user's sentence plus what the org offers, for the model. */
export function draftPrompt(
  text: string,
  workflows: { name: string; description?: string }[],
): string {
  const offered = workflows.map((w) => `- ${w.name}${w.description ? `: ${w.description}` : ''}`);
  return `Workflows offered:\n${offered.join('\n') || '- chat'}\n\nSentence:\n${text.trim()}`;
}

/** The model's answer as a draft, or an error saying what was wrong with it. */
export function parseDraft(answer: string, workflows: readonly string[]): RoutineDraft {
  const raw = extractJson(answer);
  if (!raw || typeof raw !== 'object')
    throw new Error('the model did not answer with a JSON object');
  const parsed = DraftSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      `the model's draft is not a routine: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    );
  const d = parsed.data;
  if (workflows.length > 0 && !workflows.includes(d.workflow))
    throw new Error(`the model chose a workflow the org does not have: ${d.workflow}`);
  return { ...d, words: triggerWords(d.trigger) };
}

/** A ref this registry can call directly (a key present, not a runtime-only provider). */
function directRef(registry: ProviderRegistry, ref: string | undefined): string | undefined {
  if (!ref?.includes('/')) return undefined;
  try {
    const { provider } = registry.parseRef(ref);
    const entry = registry.get(provider);
    if (entry.via_runtime || !registry.isConfigured(provider).ok) return undefined;
    return ref;
  } catch {
    return undefined;
  }
}

const DRAFT_TIMEOUT_MS = 30_000;

/** The draft writer: the org's cheap tier when callable, else strong; none when nothing is. */
export function routineDraftWriter(
  registry: () => ProviderRegistry,
): (org: Org) => ((prompt: string) => Promise<string>) | undefined {
  return (org) => {
    const reg = registry();
    const ref = directRef(reg, org.models.tiers.cheap) ?? directRef(reg, org.models.tiers.strong);
    if (!ref) return undefined;
    return async (prompt) => {
      const r = await new LlmClient(reg).generate(ref, {
        system: DRAFT_SYSTEM,
        messages: [{ role: 'user', content: prompt }],
        maxSteps: 1,
        maxRetries: 1,
        maxOutputTokens: 600,
        signal: AbortSignal.timeout(DRAFT_TIMEOUT_MS),
      });
      return r.text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    };
  };
}
