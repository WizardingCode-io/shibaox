import type { DiscoveredSkill, SkillSource } from '@wizardingcode/shibaox-daemon';
import { type AddSkillOutcome, SKIP_WORDS } from './types.js';

/** Each skipped id with why, in words ("pdf: already in the org"). */
export const skippedLines = (r: AddSkillOutcome): string[] =>
  r.skipped.map((s) => `${s.id}: ${SKIP_WORDS[s.reason] ?? s.reason}`);

/** The files left out of the skills added (over 1 MB), one line per skill. */
export const omittedLines = (r: AddSkillOutcome): string[] =>
  r.added
    .filter((a) => a.omitted?.length)
    .map((a) => `${a.id}: ${(a.omitted ?? []).join(', ')} left out (over 1 MB)`);

/** What a toast says after an install that added something: the rest that did not go in. */
export function addedNote(r: AddSkillOutcome): string | undefined {
  const skipped = skippedLines(r);
  const lines = [
    ...(skipped.length ? [`Not added: ${skipped.join('; ')}`] : []),
    ...omittedLines(r),
  ];
  return lines.length ? lines.join('. ') : undefined;
}

/**
 * After an install: nothing added keeps the dialog open with each id and why (the answer is
 * those lines); something added closes it, opens the roles and toasts the rest.
 */
export function settle(
  r: AddSkillOutcome,
  o: {
    close: () => void;
    onAdded: (added: AddSkillOutcome['added']) => void;
    notice: (m: string) => void;
  },
): string[] {
  if (r.added.length === 0) return skippedLines(r);
  o.close();
  o.onAdded(r.added);
  const note = addedNote(r);
  if (note) o.notice(note);
  return [];
}

/** A discovered skill's path under its source (the daemon's paths start at the repository root). */
export function underSource(src: SkillSource, sk: DiscoveredSkill): string {
  const base = (src.path ?? '').replace(/^\.?\/+|\/+$/g, '');
  const p = sk.path.replace(/^\.?\/+|\/+$/g, '');
  return base && (p === base || p.startsWith(`${base}/`)) ? p.slice(base.length + 1) : p;
}

/** The folder a skill sits in under its source (its first segment), or undefined at the top. */
export function folderOf(src: SkillSource, sk: DiscoveredSkill): string | undefined {
  const parts = underSource(src, sk).split('/').filter(Boolean);
  return parts.length > 1 ? parts[0] : undefined;
}
