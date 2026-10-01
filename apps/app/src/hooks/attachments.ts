import { useCallback, useEffect, useRef, useState } from 'react';
import { desktopBridge } from '../desktop.js';
import { dropThumb, thumbOfFile } from '../thumbs.js';

/** Thumbnails of the files picked for the next message, made once per file. */
export function useFileThumbs(files: readonly File[]): Map<File, string> {
  const [thumbs, setThumbs] = useState<Map<File, string>>(new Map());
  const known = useRef<Map<File, string>>(new Map());
  useEffect(() => {
    let live = true;
    void (async () => {
      // files still here keep their thumbnail; new ones get theirs; gone ones are let go
      const next = new Map<File, string>();
      for (const f of files) {
        const had = known.current.get(f);
        if (had) {
          next.set(f, had);
          continue;
        }
        const url = await thumbOfFile(f).catch(() => undefined);
        if (!live) {
          dropThumb(url);
          return;
        }
        if (url) next.set(f, url);
      }
      for (const [f, url] of known.current) if (!next.has(f)) dropThumb(url);
      known.current = next;
      setThumbs(new Map(next));
    })();
    return () => {
      live = false;
    };
  }, [files]);
  useEffect(
    () => () => {
      for (const url of known.current.values()) dropThumb(url);
      known.current = new Map();
    },
    [],
  );
  return thumbs;
}

type Recognizer = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult:
    | ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>>; resultIndex: number }) => void)
    | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
};

/** The browser's speech recognition when it exists (Chrome): words land in the composer. */
export function useVoice(
  onWords: (words: string) => void,
  onError: (reason: string) => void,
): {
  available: boolean;
  listening: boolean;
  toggle: () => void;
} {
  const w = globalThis as {
    SpeechRecognition?: new () => Recognizer;
    webkitSpeechRecognition?: new () => Recognizer;
  };
  // Electron defines the API but has no speech service behind it: no mic in the desktop app
  const Ctor = desktopBridge() ? undefined : (w.SpeechRecognition ?? w.webkitSpeechRecognition);
  const [listening, setListening] = useState(false);
  const rec = useRef<Recognizer | undefined>(undefined);
  useEffect(
    () => () => {
      rec.current?.stop();
      rec.current = undefined;
    },
    [],
  );
  const toggle = useCallback(() => {
    if (!Ctor) return;
    if (rec.current) {
      rec.current.stop();
      rec.current = undefined;
      setListening(false);
      return;
    }
    const r = new Ctor();
    r.lang = navigator.language || 'en';
    r.interimResults = false;
    r.continuous = true;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i]?.[0]?.transcript?.trim();
        if (t) onWords(t);
      }
    };
    r.onend = () => {
      rec.current = undefined;
      setListening(false);
    };
    r.onerror = () => {
      rec.current = undefined;
      setListening(false);
      onError('The microphone could not listen here (no speech service, or no permission).');
    };
    rec.current = r;
    r.start();
    setListening(true);
  }, [Ctor, onWords, onError]);
  return { available: Boolean(Ctor), listening, toggle };
}
