/**
 * Whether `hostname` is covered by a role's `permissions.network` allowlist: `*` allows every
 * host; any other entry allows that host and its subdomains (`github.com` covers
 * `api.github.com`, never `evilgithub.com`).
 */
export function hostAllowed(hostname: string, allow: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return allow.some((entry) => {
    if (entry === '*') return true;
    const e = entry.toLowerCase();
    return host === e || host.endsWith(`.${e}`);
  });
}
