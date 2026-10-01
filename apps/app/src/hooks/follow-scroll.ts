import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** How close to the end (px) still counts as "at the bottom". */
const NEAR = 48;

/**
 * Keeps a scrolling element at its bottom while content grows (a reply streaming in), the way
 * chat apps do: scrolling up stops the following, scrolling back near the end resumes it, and
 * `behind` says new content arrived while the user was reading above (show a "jump" control).
 */
export function useFollowScroll(
  ref: RefObject<HTMLElement | null>,
  version: number,
): { following: boolean; behind: boolean; jump: () => void } {
  const [following, setFollowing] = useState(true);
  const [behind, setBehind] = useState(false);
  const seen = useRef(version);
  const toBottom = useCallback(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ref]);
  useLayoutEffect(() => {
    if (following) {
      seen.current = version;
      toBottom();
      // once more after the browser has laid the new content out (images, fonts)
      const t = setTimeout(toBottom, 120);
      return () => clearTimeout(t);
    }
    if (version !== seen.current) setBehind(true);
    return undefined;
  }, [version, following, toBottom]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR;
      setFollowing(near);
      if (near) {
        seen.current = version;
        setBehind(false);
      }
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, [ref, version]);
  const jump = useCallback(() => {
    setFollowing(true);
    setBehind(false);
    toBottom();
  }, [toBottom]);
  return { following, behind, jump };
}
