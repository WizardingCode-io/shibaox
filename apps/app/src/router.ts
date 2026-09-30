import { useEffect, useState } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'chats' }
  | { name: 'thread'; id: string }
  | { name: 'settings' }
  | { name: 'soon'; section: string };

/** `#/`, `#/chats`, `#/t/<rootId>`, `#/settings`, `#/soon/<section>`. */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '').split('&')[0] ?? '';
  const m = /^\/t\/([^/]+)$/.exec(path);
  if (m?.[1]) return { name: 'thread', id: decodeURIComponent(m[1]) };
  if (path === '/chats') return { name: 'chats' };
  if (path === '/settings') return { name: 'settings' };
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
