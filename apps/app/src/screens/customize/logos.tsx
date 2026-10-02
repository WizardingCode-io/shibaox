import {
  siBrave,
  siCloudflare,
  siFigma,
  siGithub,
  siLinear,
  siModelcontextprotocol,
  siNotion,
  siSentry,
  siStripe,
  siSupabase,
  siTelegram,
  siUpstash,
  siVercel,
} from 'simple-icons';

/** A brand mark (simple-icons, CC0): the slug and the 24×24 path, drawn in the current colour. */
export interface Brand {
  slug: string;
  path: string;
}

const MARKS: Record<string, Brand> = Object.fromEntries(
  [
    siGithub,
    siNotion,
    siLinear,
    siSentry,
    siStripe,
    siSupabase,
    siCloudflare,
    siFigma,
    siVercel,
    siBrave,
    siUpstash,
    siTelegram,
    siModelcontextprotocol,
  ].map((i) => [i.slug, { slug: i.slug, path: i.path }]),
);

/** Connector/plugin ids (and vendor names) that carry a known mark. */
const BY_ID: Record<string, string> = {
  github: 'github',
  notion: 'notion',
  linear: 'linear',
  sentry: 'sentry',
  stripe: 'stripe',
  supabase: 'supabase',
  'cloudflare-docs': 'cloudflare',
  figma: 'figma',
  vercel: 'vercel',
  'brave-search': 'brave',
  context7: 'upstash',
  telegram: 'telegram',
  fetch: 'modelcontextprotocol',
  filesystem: 'modelcontextprotocol',
  memory: 'modelcontextprotocol',
  'sequential-thinking': 'modelcontextprotocol',
};
const BY_VENDOR: Record<string, string> = {
  github: 'github',
  notion: 'notion',
  linear: 'linear',
  sentry: 'sentry',
  stripe: 'stripe',
  supabase: 'supabase',
  cloudflare: 'cloudflare',
  figma: 'figma',
  vercel: 'vercel',
  brave: 'brave',
  upstash: 'upstash',
  telegram: 'telegram',
  'model context protocol': 'modelcontextprotocol',
};

/** The mark of a service by its id, else by its vendor; undefined when we have none (a monogram then). */
export function brandOf(id: string, vendor?: string): Brand | undefined {
  const slug = BY_ID[id.toLowerCase()] ?? (vendor ? BY_VENDOR[vendor.toLowerCase()] : undefined);
  return slug ? MARKS[slug] : undefined;
}

/** The logo tile content: an inline svg of the mark, or the first letter of the name. */
export function BrandLogo(props: { id: string; name: string; vendor?: string }): JSX.Element {
  const b = brandOf(props.id, props.vendor);
  if (!b)
    return (
      <span className="logo-mono" data-monogram={props.id} aria-hidden="true">
        {(props.name.trim()[0] ?? '?').toUpperCase()}
      </span>
    );
  return (
    <svg
      className="logo-mark"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      role="img"
      aria-label={props.name}
      data-logo={b.slug}
    >
      <path d={b.path} fill="currentColor" />
    </svg>
  );
}
