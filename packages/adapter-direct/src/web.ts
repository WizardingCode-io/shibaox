import { hostAllowed } from '@wizardingcode/shibaox-core';

export interface FetchTextOptions {
  timeoutMs: number;
  maxBytes: number;
  /** The role's `permissions.network` allowlist (hosts; `*` = any). */
  allow: readonly string[];
}

export interface FetchedText {
  url: string;
  status: number;
  contentType: string;
  text: string;
  truncated: boolean;
}

const MAX_REDIRECTS = 3;

function checkUrl(raw: string, allow: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid url "${raw}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error(`only http(s) urls can be fetched, not ${url.protocol}`);
  if (!hostAllowed(url.hostname, allow))
    throw new Error(
      `host "${url.hostname}" is not allowed (network: ${allow.join(', ') || 'none'})`,
    );
  return url;
}

/** HTML to readable text: scripts and styles dropped, tags removed, whitespace collapsed. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/**
 * GET `raw` and return its body as text (HTML reduced to text), capped at `maxBytes`. Every
 * hop of a redirect is checked against the allowlist; no cookies or credentials are sent.
 */
export async function fetchText(raw: string, o: FetchTextOptions): Promise<FetchedText> {
  let url = checkUrl(raw, o.allow);
  for (let hop = 0; ; hop++) {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(o.timeoutMs),
      headers: { 'user-agent': 'shibaox', accept: 'text/html, text/plain, application/json, */*' },
      credentials: 'omit',
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
      url = checkUrl(new URL(location, url).toString(), o.allow);
      continue;
    }
    const contentType = res.headers.get('content-type') ?? '';
    const buf = Buffer.from(await res.arrayBuffer());
    const truncated = buf.length > o.maxBytes;
    const raw = buf.subarray(0, o.maxBytes).toString('utf8');
    const html = /html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(raw);
    const text = html ? htmlToText(raw) : raw;
    return {
      url: url.toString(),
      status: res.status,
      contentType,
      text: text.length > o.maxBytes ? text.slice(0, o.maxBytes) : text,
      truncated,
    };
  }
}

/**
 * A file over https (http only on loopback) for `download_file`: redirects followed like
 * fetchText, the body refused past `maxBytes` before it is read whole.
 */
export async function fetchBytes(
  raw: string,
  o: { timeoutMs: number; maxBytes: number; allow: readonly string[] },
): Promise<{ bytes: Buffer; mime?: string }> {
  let url = checkUrl(raw, o.allow);
  if (url.protocol !== 'https:' && !/^(127\.0\.0\.1|localhost|\[::1\])$/.test(url.hostname))
    throw new Error('download_file takes https URLs only');
  for (let hop = 0; ; hop++) {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(o.timeoutMs),
      headers: { 'user-agent': 'shibaox', accept: '*/*' },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop >= 5) throw new Error('too many redirects');
      url = checkUrl(new URL(res.headers.get('location') ?? '', url).href, o.allow);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.hostname}`);
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > o.maxBytes)
      throw new Error(`the file is ${declared} bytes; the cap is ${o.maxBytes}`);
    const chunks: Buffer[] = [];
    let size = 0;
    const reader = res.body?.getReader();
    if (!reader) throw new Error('no body');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > o.maxBytes) {
        await reader.cancel();
        throw new Error(`the file is larger than ${o.maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
    const mime = res.headers.get('content-type')?.split(';')[0]?.trim();
    return { bytes: Buffer.concat(chunks), ...(mime ? { mime } : {}) };
  }
}
