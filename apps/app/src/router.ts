import { useEffect, useState } from 'react';
import type { CustomizeTab, CustomizeView } from './screens/customize/types.js';

export type Route =
  | { name: 'home' }
  | { name: 'chats' }
  | { name: 'thread'; id: string }
  | { name: 'settings' }
  | { name: 'section'; section: 'scheduled' | 'memory' }
  | {
      name: 'customize';
      tab: CustomizeTab;
      view: CustomizeView;
      /** `key=NAME`: the Keys tab focuses that row. */
      key?: string;
      /** Set when an old link (`#/skills`, `#/integrations`) was redirected here. */
      redirect?: string;
    }
  | { name: 'soon'; section: string };

const TABS: CustomizeTab[] = ['skills', 'connectors', 'plugins', 'keys', 'models'];

/** `#/customize&tab=keys&view=discover&key=NAME` (a `?` before the first parameter works too). */
export function customizePath(o: {
  tab?: CustomizeTab;
  view?: CustomizeView;
  key?: string;
}): string {
  const p: string[] = [];
  if (o.tab && o.tab !== 'skills') p.push(`tab=${o.tab}`);
  else if (o.tab === 'skills' && (o.view === 'discover' || o.key)) p.push('tab=skills');
  if (o.view === 'discover') p.push('view=discover');
  if (o.key) p.push(`key=${encodeURIComponent(o.key)}`);
  return `#/customize${p.map((x) => `&${x}`).join('')}`;
}

/** `#/`, `#/chats`, `#/t/<rootId>`, `#/scheduled|memory`, `#/customize&tab=…`, `#/settings`, `#/soon/<section>`. */
export function parseRoute(hash: string): Route {
  const [path = '', ...rest] = hash.replace(/^#/, '').split(/[&?]/);
  const m = /^\/t\/([^/]+)$/.exec(path);
  if (m?.[1]) {
    try {
      return { name: 'thread', id: decodeURIComponent(m[1]) };
    } catch {
      return { name: 'home' };
    }
  }
  if (path === '/chats') return { name: 'chats' };
  if (path === '/settings') return { name: 'settings' };
  // the sections Customize replaced: old links land on the right tab
  if (path === '/skills')
    return { name: 'customize', tab: 'skills', view: 'yours', redirect: '#/customize&tab=skills' };
  if (path === '/integrations')
    return {
      name: 'customize',
      tab: 'connectors',
      view: 'yours',
      redirect: '#/customize&tab=connectors',
    };
  if (path === '/customize') {
    const params = new Map<string, string>();
    for (const kv of rest) {
      const i = kv.indexOf('=');
      if (i <= 0) continue;
      try {
        params.set(kv.slice(0, i), decodeURIComponent(kv.slice(i + 1)));
      } catch {
        // a malformed parameter is ignored
      }
    }
    const tab = TABS.find((t) => t === params.get('tab')) ?? 'skills';
    const key = params.get('key');
    return {
      name: 'customize',
      tab,
      view: params.get('view') === 'discover' ? 'discover' : 'yours',
      ...(key ? { key } : {}),
    };
  }
  const section = /^\/(scheduled|memory)$/.exec(path);
  if (section?.[1]) return { name: 'section', section: section[1] as 'scheduled' | 'memory' };
  const soon = /^\/soon\/([a-z]+)$/.exec(path);
  if (soon?.[1]) return { name: 'soon', section: soon[1] };
  return { name: 'home' };
}

export function navigate(path: string): void {
  window.location.hash = path;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  // an old link: the address bar shows where it landed (no new history entry)
  const redirect = route.name === 'customize' ? route.redirect : undefined;
  useEffect(() => {
    if (redirect) window.history.replaceState(null, '', redirect);
  }, [redirect]);
  return route;
}
