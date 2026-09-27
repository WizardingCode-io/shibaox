/** `$0.0020` under a dollar, `$1.50` from a dollar up. */
export const money = (usd: number): string =>
  usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;

/** `41 s`, `2m 13s`, `1h 04m`. */
export const duration = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
};

/** How long ago an ISO timestamp was: `12 s`, `3 m`, `2 h`, `4 d`. */
export const age = (iso: string, now = Date.now()): string => {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
};

export const shortId = (id: string): string => id.slice(0, 8);

/** `~/dir` for paths under the home directory. */
export function tilde(p: string, home: string | undefined = process.env.HOME): string {
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** `24.0k` / `1.2M` for token counts. */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
