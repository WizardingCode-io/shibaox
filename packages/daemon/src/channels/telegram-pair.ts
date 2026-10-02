/** What a pairing poll found: the chat, who wrote, and the offset past every update it read. */
export type PairPoll =
  | { found: true; chatId: number; from?: string; offset: number }
  | { found: false; reason: string; offset: number };

interface PairUpdate {
  update_id: number;
  message?: {
    text?: string;
    date?: number;
    chat?: { id?: number; type?: string };
    from?: { username?: string; first_name?: string };
  };
}

/** A message older than this (seconds before the pairing began) was not sent for it. */
const STALE_S = 120;

/**
 * Waits for the first message sent to the bot (a `/start` preferred in a batch) with Bot API
 * long polling (`timeout` ≤ 20 s per call, `timeoutMs` overall). Every update read is consumed:
 * the returned `offset` is where the channel starts, so none is replayed later. Messages sent
 * well before the pairing began are consumed but never paired with.
 */
export async function pollForChat(o: {
  /** `<apiBase><token>`: the bot's method root (never logged). */
  base: string;
  timeoutMs: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}): Promise<PairPoll> {
  const doFetch = o.fetch ?? fetch;
  const began = Date.now();
  const deadline = began + o.timeoutMs;
  const fresh = Math.floor(began / 1000) - STALE_S;
  let offset = 0;
  while (!o.signal?.aborted) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    const t0 = Date.now();
    const timeout = Math.min(20, Math.floor(left / 1000));
    let updates: PairUpdate[];
    try {
      const signals = [AbortSignal.timeout(left + 1_000), ...(o.signal ? [o.signal] : [])];
      const res = await doFetch(`${o.base}/getUpdates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ offset, timeout, allowed_updates: ['message'] }),
        signal: AbortSignal.any(signals),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        result?: PairUpdate[];
        description?: string;
      };
      if (!res.ok || !json.ok)
        return {
          found: false,
          reason: `Telegram refused: ${json.description ?? `HTTP ${res.status}`}`,
          offset,
        };
      updates = json.result ?? [];
    } catch (e) {
      if (o.signal?.aborted) break;
      if (Date.now() >= deadline) break;
      return {
        found: false,
        reason: `Telegram is unreachable: ${e instanceof Error ? e.message : String(e)}`,
        offset,
      };
    }
    for (const u of updates) offset = Math.max(offset, u.update_id + 1);
    const candidates = updates.filter(
      (u) =>
        typeof u.message?.chat?.id === 'number' &&
        (u.message.date === undefined || u.message.date >= fresh),
    );
    const pick =
      candidates.find((u) => (u.message?.text ?? '').trim().startsWith('/start')) ?? candidates[0];
    const m = pick?.message;
    if (m?.chat?.id !== undefined) {
      const from = m.from?.username ?? m.from?.first_name;
      return { found: true, chatId: m.chat.id, ...(from ? { from } : {}), offset };
    }
    // a server that answers at once (a fake, or an error page) is not hammered
    if (Date.now() - t0 < 200)
      await sleep(Math.min(200, Math.max(0, deadline - Date.now())), o.signal);
  }
  return {
    found: false,
    reason: o.signal?.aborted
      ? 'pairing stopped (the daemon is stopping)'
      : `no message received in ${Math.round(o.timeoutMs / 1000)} s: open your bot in Telegram, send /start and try again`,
    offset,
  };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        r();
      },
      { once: true },
    );
  });
