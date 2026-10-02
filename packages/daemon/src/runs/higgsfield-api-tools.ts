import type { AgentTool } from '@wizardingcode/shibaox-core';
import { z } from 'zod';
import { HIGGSFIELD_API } from '../higgsfield.js';
import { uploadableFile, uploadTimeoutMs } from './higgsfield-tools.js';

/**
 * Higgsfield's REST API as daemon tools (API mode): submit → poll → cancel, and signed uploads.
 * The key stays here, read from the vault at each call: it never reaches a subprocess, a
 * message, a log or a result.
 */
export interface HiggsfieldApiDeps {
  /** `HIGGSFIELD_API_KEY` from the vault, read at each call (a replaced key is used at once). */
  key(): string | undefined;
  fetch: typeof fetch;
  workspace: string;
  protectedGlobs: string[];
  /** The API base (tests point it elsewhere). */
  base?: string;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  /** The run's abort signal: a cancelled run cancels its Higgsfield request too. */
  signal?: () => AbortSignal | undefined;
  log?: (line: string) => void;
  /**
   * Saves a result URL into the workspace as `outputs/<name>` and answers the path written: the
   * tools then list the files themselves, so no model has to download (or pretend it did).
   */
  save?: (url: string, name: string) => Promise<string>;
}

export const KEY_MISSING =
  'HIGGSFIELD_API_KEY is not set: Customize → Plugins → Higgsfield → Connect API key';
const KEY_REFUSED =
  'Higgsfield refused the API key: replace it in Customize → Plugins → Higgsfield (Manage API key)';
const TERMINAL = new Set(['completed', 'failed', 'nsfw', 'canceled']);
const MODEL_PATH = /^[a-z0-9][\w.-]*(\/[a-z0-9][\w.-]*)+$/;
const REQUEST_ID = /^[\w-]{1,100}$/;
/** Status answers in a row that may fail (non-2xx, network) before the poll gives up as `unknown`. */
const STATUS_FAILURES = 5;

/** The poll steps without jitter: 2 s, then ×1.5 up to 10 s. */
export function delayStep(prev?: number): number {
  return prev === undefined ? 2000 : Math.min(10_000, prev * 1.5);
}
/** The next poll delay after the step `prev`, with ±20 % jitter from `random` (0.5 = none). */
export function nextDelay(prev?: number, random: () => number = () => 0.5): number {
  return Math.round(delayStep(prev) * (0.8 + 0.4 * random()));
}

/** The key, its secret half and every URL with a query (signed URLs) become `[redacted]`. */
export function scrub(text: string, key: string | undefined): string {
  let out = text;
  if (key) {
    out = out.split(key).join('[redacted]');
    const secret = key.slice(key.indexOf(':') + 1);
    if (secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  return out.replace(/https?:\/\/[^\s"'<>]*\?[^\s"'<>]*/g, '[redacted]');
}

/** Normalises `/a/b/` and an absolute API URL to `a/b`; throws when it is not a model path. */
function modelPath(raw: string, base: string): string {
  let p = raw.trim();
  for (const prefix of [`${base}/`, `${HIGGSFIELD_API}/`])
    if (p.startsWith(prefix)) p = p.slice(prefix.length);
  p = p.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!MODEL_PATH.test(p) || p.includes('..') || /^(requests|files)\//.test(p))
    throw new Error(
      `model_path "${raw.slice(0, 120)}" is not a Higgsfield model path (like higgsfield-ai/soul/standard; see https://docs.higgsfield.ai/docs/llms.txt)`,
    );
  return p;
}

function requestId(raw: unknown): string {
  const id = String(raw ?? '').trim();
  if (!REQUEST_ID.test(id)) throw new Error(`request_id "${id.slice(0, 120)}" is not a request id`);
  return id;
}

interface StatusBody {
  status?: string;
  images?: { url?: string }[];
  video?: { url?: string };
  audio?: { url?: string };
  audios?: { url?: string }[];
  error?: unknown;
}

/** `hf-<request id>-<n>.<ext>`, the extension from the URL's path (else by kind). */
export function resultName(
  request_id: string,
  n: number,
  url: string,
  kind: 'image' | 'video' | 'audio',
): string {
  let ext = '';
  try {
    const m = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname);
    if (m?.[1]) ext = m[1].toLowerCase();
  } catch {
    ext = '';
  }
  if (!ext) ext = kind === 'video' ? 'mp4' : kind === 'audio' ? 'mp3' : 'png';
  const id = request_id.replace(/[^A-Za-z0-9-]/g, '').slice(0, 12) || 'result';
  return `hf-${id}-${n}.${ext}`;
}

/** Saves every URL of a completed result through `save`; the files written and a note for failures. */
async function saveResults(
  r: ReturnType<typeof resultOf>,
  save: HiggsfieldApiDeps['save'],
  key: string | undefined,
): Promise<{ files?: string[]; note?: string }> {
  if (!save || r.status !== 'completed') return {};
  const all: { url: string; kind: 'image' | 'video' | 'audio' }[] = [
    ...r.images.map((url) => ({ url, kind: 'image' as const })),
    ...(r.video ? [{ url: r.video, kind: 'video' as const }] : []),
    ...r.audio.map((url) => ({ url, kind: 'audio' as const })),
  ];
  const files: string[] = [];
  const failed: string[] = [];
  for (const [i, x] of all.entries()) {
    const name = resultName(r.request_id, i + 1, x.url, x.kind);
    try {
      files.push(await save(x.url, name));
    } catch (e) {
      failed.push(
        `${name} (${scrub(e instanceof Error ? e.message : String(e), key).slice(0, 120)})`,
      );
    }
  }
  return {
    ...(files.length ? { files } : {}),
    ...(failed.length
      ? { note: `${failed.join(', ')} could not be saved: the URL is still in the answer` }
      : files.length
        ? {
            note: 'saved into outputs/ of the workspace: report these files, nothing else to download',
          }
        : {}),
  };
}

/** The parts of a status answer a model needs: the state, the result URLs, the error. */
function resultOf(request_id: string, j: StatusBody) {
  const urls = (l: unknown) =>
    Array.isArray(l)
      ? l
          .map((x) => (x as { url?: unknown })?.url)
          .filter((u): u is string => typeof u === 'string')
      : [];
  const audio = [...(typeof j.audio?.url === 'string' ? [j.audio.url] : []), ...urls(j.audios)];
  return {
    request_id,
    status: String(j.status ?? 'unknown'),
    images: urls(j.images),
    ...(typeof j.video?.url === 'string' ? { video: j.video.url } : {}),
    audio,
    ...(j.error !== undefined && j.error !== null
      ? { error: typeof j.error === 'string' ? j.error : JSON.stringify(j.error) }
      : {}),
  };
}

/** Waits `ms`, or less when `signal` aborts; the abort listener never outlives the wait. */
export const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export function higgsfieldApiTools(d: HiggsfieldApiDeps): AgentTool[] {
  const base = (d.base ?? HIGGSFIELD_API).replace(/\/+$/, '');
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? defaultSleep;
  const random = d.random ?? Math.random;
  const runSignal = () => d.signal?.();
  const fail = (message: string): never => {
    throw new Error(scrub(message, d.key()));
  };
  const log = (line: string) => d.log?.(scrub(`higgsfield api: ${line}`, d.key()));
  const keyOrThrow = (): string => {
    const k = d.key();
    if (!k) throw new Error(KEY_MISSING);
    return k;
  };
  const signalFor = (ms: number): AbortSignal => {
    const run = runSignal();
    return run ? AbortSignal.any([AbortSignal.timeout(ms), run]) : AbortSignal.timeout(ms);
  };

  /** One authenticated API call; the body read as JSON when it is JSON. Network errors throw. */
  async function api(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    signal: AbortSignal = signalFor(30_000),
  ): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
    const key = keyOrThrow();
    const r = await d.fetch(`${base}/${path}`, {
      method,
      redirect: 'manual',
      signal,
      headers: {
        authorization: `Key ${key}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text().catch(() => '');
    let json: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object') json = parsed as Record<string, unknown>;
    } catch {
      // not JSON
    }
    return { status: r.status, json, text };
  }

  const refusedOr = (status: number) => {
    if (status === 401 || status === 403) fail(KEY_REFUSED);
  };

  /** Best effort: a cancel that fails is logged, never thrown (its own short timeout). */
  async function cancelQuietly(id: string): Promise<boolean> {
    try {
      const r = await api('POST', `requests/${id}/cancel`, undefined, AbortSignal.timeout(10_000));
      log(`cancel ${id}: ${r.status}`);
      return r.status >= 200 && r.status < 300;
    } catch (e) {
      log(`cancel ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  const generateInput = z.object({
    model_path: z
      .string()
      .describe(
        'The model path from the docs (llms.txt), e.g. higgsfield-ai/soul/standard or kling-video/v2.5-turbo/pro/text-to-video',
      ),
    input: z
      .record(z.string(), z.unknown())
      .describe("The JSON body the model's Input JSON Schema describes (prompt, image_url, …)"),
    wait: z
      .boolean()
      .optional()
      .describe('Wait for the result (default true); false returns the request_id at once'),
    timeout_s: z
      .number()
      .min(10)
      .max(900)
      .optional()
      .describe('How long to wait, 10–900 s (default 600); past it the request is cancelled'),
  });

  return [
    {
      name: 'higgsfield_api_generate',
      description:
        'Generate with the Higgsfield API (the developer key): submits ONE request to model_path with input, then waits for it and returns {request_id, status, images[], video, audio[], error}. Never call it again for the same result after an error or an unknown status: check with higgsfield_api_status.',
      input: generateInput,
      async execute(raw) {
        const i = generateInput.parse(raw);
        const path = modelPath(i.model_path, base);
        keyOrThrow();
        let submit: Awaited<ReturnType<typeof api>>;
        try {
          submit = await api('POST', path, i.input);
        } catch (e) {
          if (runSignal()?.aborted)
            fail(
              'the run was cancelled before Higgsfield answered the submission: the request may or may not exist. Do not submit it again; ask the user (they can see it at https://higgsfield.ai).',
            );
          return fail(
            `Higgsfield did not answer the submission (${e instanceof Error ? e.message : String(e)}): the request may or may not exist. Do not submit it again; ask the user (they can see it at https://higgsfield.ai).`,
          );
        }
        refusedOr(submit.status);
        if (submit.status >= 500)
          fail(
            `Higgsfield answered ${submit.status} to the submission: the request may or may not exist. Do not submit it again; ask the user (they can see it at https://higgsfield.ai).`,
          );
        if (submit.status < 200 || submit.status >= 300)
          fail(`Higgsfield refused the request (${submit.status}): ${submit.text.slice(0, 400)}`);
        const id = typeof submit.json.request_id === 'string' ? submit.json.request_id : '';
        if (!REQUEST_ID.test(id)) fail('Higgsfield accepted the request but gave no request_id');
        log(`submitted ${path} → ${id}`);
        if (i.wait === false)
          return { request_id: id, status: String(submit.json.status ?? 'queued') };

        const deadline = now() + (i.timeout_s ?? 600) * 1000;
        let step: number | undefined;
        let failures = 0;
        for (;;) {
          if (runSignal()?.aborted) {
            await cancelQuietly(id);
            fail(`the run was cancelled: Higgsfield request ${id} was cancelled too`);
          }
          if (now() >= deadline) {
            const canceled = await cancelQuietly(id);
            return {
              request_id: id,
              status: 'canceled_by_timeout',
              note: canceled
                ? 'not finished in time: the request was cancelled'
                : 'not finished in time: the cancel was not confirmed; check it with higgsfield_api_status',
            };
          }
          const delay = nextDelay(step, random);
          step = delayStep(step);
          await sleep(Math.min(delay, Math.max(0, deadline - now())), runSignal());
          if (runSignal()?.aborted) continue;
          let r: Awaited<ReturnType<typeof api>> | undefined;
          try {
            r = await api('GET', `requests/${id}/status`);
          } catch {
            r = undefined;
          }
          if (r !== undefined) {
            if (r.status === 401 || r.status === 403)
              fail(
                `${KEY_REFUSED}; request ${id} may still be running; check it with higgsfield_api_status after replacing the key (do not submit again)`,
              );
            if (r.status === 404) fail(`unknown request id ${id}: Higgsfield does not know it`);
          }
          // a network error or any non-2xx answer (5xx, 429, …): retried, then `unknown`
          if (r === undefined || r.status < 200 || r.status >= 300) {
            if (++failures >= STATUS_FAILURES)
              return {
                request_id: id,
                status: 'unknown',
                note: `Higgsfield did not answer the status ${STATUS_FAILURES} times in a row${r ? ` (last: ${r.status})` : ''}: check later with higgsfield_api_status (request_id ${id}); do not submit again`,
              };
            continue;
          }
          failures = 0;
          const status = String((r.json as StatusBody).status ?? '');
          if (TERMINAL.has(status)) {
            log(`${id} ${status}`);
            const res = resultOf(id, r.json as StatusBody);
            return { ...res, ...(await saveResults(res, d.save, d.key())) };
          }
        }
      },
    },
    {
      name: 'higgsfield_api_status',
      description:
        'The state of a Higgsfield API request (queued, in_progress, completed, failed, nsfw, canceled) and its result URLs.',
      input: z.object({ request_id: z.string() }),
      async execute(raw) {
        const id = requestId(raw.request_id);
        let r: Awaited<ReturnType<typeof api>>;
        try {
          r = await api('GET', `requests/${id}/status`);
        } catch (e) {
          return fail(
            `Higgsfield did not answer (${e instanceof Error ? e.message : String(e)}): try again later`,
          );
        }
        refusedOr(r.status);
        if (r.status === 404) fail(`unknown request id ${id}: Higgsfield does not know it`);
        if (r.status < 200 || r.status >= 300)
          fail(`Higgsfield answered ${r.status}: try again later`);
        const res = resultOf(id, r.json as StatusBody);
        return { ...res, ...(await saveResults(res, d.save, d.key())) };
      },
    },
    {
      name: 'higgsfield_api_cancel',
      description:
        'Cancel a Higgsfield API request (stopping to wait does not cancel it). Finished requests cannot be cancelled.',
      input: z.object({ request_id: z.string() }),
      async execute(raw) {
        const id = requestId(raw.request_id);
        let r: Awaited<ReturnType<typeof api>>;
        try {
          r = await api('POST', `requests/${id}/cancel`);
        } catch (e) {
          return fail(
            `Higgsfield did not answer (${e instanceof Error ? e.message : String(e)}): check with higgsfield_api_status`,
          );
        }
        refusedOr(r.status);
        if (r.status === 404) fail(`unknown request id ${id}: Higgsfield does not know it`);
        const ok = r.status >= 200 && r.status < 300;
        log(`cancel ${id}: ${r.status}`);
        return {
          request_id: id,
          canceled: ok,
          ...(ok ? {} : { detail: scrub(`${r.status} ${r.text.slice(0, 200)}`, d.key()) }),
        };
      },
    },
    {
      name: 'higgsfield_api_upload',
      description:
        'Upload an image, video or audio file from attachments/ (what the user sent) or outputs/ (what you made) for the Higgsfield API; returns a public_url to pass as a reference (image_url, …) in higgsfield_api_generate input.',
      input: z.object({ path: z.string().describe('The file, relative to the workspace') }),
      async execute(raw) {
        const f = uploadableFile(d.workspace, String(raw.path ?? ''), d.protectedGlobs);
        keyOrThrow();
        let r: Awaited<ReturnType<typeof api>>;
        try {
          r = await api('POST', 'files/generate-upload-url', { content_type: f.contentType });
        } catch (e) {
          return fail(
            `Higgsfield did not answer the upload request (${e instanceof Error ? e.message : String(e)})`,
          );
        }
        refusedOr(r.status);
        if (r.status < 200 || r.status >= 300)
          fail(`Higgsfield refused the upload request (${r.status}): ${r.text.slice(0, 300)}`);
        const uploadUrl = r.json.upload_url;
        const publicUrl = r.json.public_url;
        const rawHeaders = r.json.upload_headers;
        if (typeof uploadUrl !== 'string' || typeof publicUrl !== 'string')
          fail('Higgsfield gave no upload URL for the file');
        // exactly the headers Higgsfield returned, and never a credential: the URL is signed
        const headers: Record<string, string> = {};
        if (rawHeaders && typeof rawHeaders === 'object')
          for (const [k, v] of Object.entries(rawHeaders as Record<string, unknown>))
            if (typeof v === 'string' && k.toLowerCase() !== 'authorization') headers[k] = v;
        if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type'))
          headers['content-type'] = f.contentType;
        let put: Response;
        try {
          put = await d.fetch(uploadUrl as string, {
            method: 'PUT',
            headers,
            body: new Uint8Array(f.bytes),
            credentials: 'omit',
            redirect: 'manual',
            signal: signalFor(uploadTimeoutMs(f.bytes.length)),
          });
        } catch (e) {
          return fail(`upload failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        const body = await put.text().catch(() => '');
        if (put.status < 200 || put.status >= 300) {
          const code = /<Code>([^<]{1,100})<\/Code>/.exec(body)?.[1];
          fail(`upload failed (${put.status})${code ? `: ${code}` : ''}`);
        }
        log(`uploaded ${f.rel} (${f.bytes.length} bytes)`);
        return {
          public_url: publicUrl as string,
          content_type: f.contentType,
          path: f.rel,
          bytes: f.bytes.length,
        };
      },
    },
  ];
}
