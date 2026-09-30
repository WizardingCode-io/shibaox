import { useEffect, useState } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'chats' }
  | { name: 'thread'; id: string }
  | { name: 'settings' }
  | { name: 'section'; section: 'scheduled' | 'skills' | 'memory' | 'integrations' }
  | { name: 'soon'; section: string };

/** `#/`, `#/chats`, `#/t/<rootId>`, `#/scheduled|skills|memory|integrations`, `#/settings`, `#/soon/<section>`. */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '').split('&')[0] ?? '';
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
  const section = /^\/(scheduled|skills|memory|integrations)$/.exec(path);
  if (section?.[1])
    return {
      name: 'section',
      section: section[1] as 'scheduled' | 'skills' | 'memory' | 'integrations',
    };
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
  return route;
}
