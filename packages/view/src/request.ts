/** The request text of a run, off its input (`spec`, `input`, `text` or `prompt`; else the JSON). */
/** The block the daemon appends for the model when files come with the message. */
const ATTACHED_BLOCK = /\n*\[Attached files\]\n(?:- [^\n]*\n?)*$/;

export function requestText(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  for (const key of ['spec', 'input', 'text', 'prompt']) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return v.replace(ATTACHED_BLOCK, '').trim();
  }
  try {
    return JSON.stringify(input);
  } catch {
    return '';
  }
}
