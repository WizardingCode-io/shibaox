export interface Connection {
  base: string;
  token: string;
}

const KEY = 'shibaox.connection';

interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}
interface LocationLike {
  origin: string;
  pathname: string;
  search: string;
  hash: string;
}

/**
 * Where the daemon is and how to talk to it. The CLI opens the app with the token in the
 * URL fragment (`#token=…`, never sent to any server): it is read once, kept in storage and
 * removed from the address bar; later loads use the stored connection.
 */
export function readConnection(o: {
  location: LocationLike;
  storage: StorageLike;
  replaceUrl: (url: string) => void;
}): Connection | undefined {
  const hash = o.location.hash.replace(/^#/, '');
  const m = /(?:^|&)token=([^&]+)/.exec(hash);
  if (m?.[1]) {
    let token: string;
    try {
      token = decodeURIComponent(m[1]);
    } catch {
      token = m[1];
    }
    const conn = { base: o.location.origin, token };
    saveConnection(o.storage, conn);
    const rest = hash.replace(/(?:^|&)token=[^&]+/, '');
    o.replaceUrl(`${o.location.pathname}${o.location.search}${rest ? `#${rest}` : ''}`);
    return conn;
  }
  const raw = o.storage.getItem(KEY);
  if (!raw) return undefined;
  try {
    const c = JSON.parse(raw) as Partial<Connection>;
    return typeof c.base === 'string' && typeof c.token === 'string'
      ? { base: c.base, token: c.token }
      : undefined;
  } catch {
    return undefined;
  }
}

export function saveConnection(storage: StorageLike, conn: Connection): void {
  storage.setItem(KEY, JSON.stringify(conn));
}

export function clearConnection(storage: StorageLike): void {
  storage.removeItem(KEY);
}
