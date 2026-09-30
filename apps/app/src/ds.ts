import * as React from 'react';
import * as ReactDOM from 'react-dom';

/** The design system's component namespace (`window.Shibaox` once the bundle has run). */
export type DesignSystem = Window['Shibaox'];

let loading: Promise<DesignSystem> | undefined;

/**
 * Loads the vendored design system bundle (an IIFE that reads `window.React`) with the
 * app's own React, once. The bundle ships in the public dir, so it is fetched from
 * `<base>design-system/components/bundle.js` unless a URL is given (tests).
 */
export function loadDesignSystem(url?: string): Promise<DesignSystem> {
  if (!loading) {
    const w = window as unknown as { React?: unknown; ReactDOM?: unknown };
    w.React = React;
    w.ReactDOM = ReactDOM;
    const target = url ?? `${import.meta.env.BASE_URL}design-system/components/bundle.js`;
    loading = import(/* @vite-ignore */ target).then(() => {
      if (!window.Shibaox) throw new Error(`the design system bundle at ${target} did not load`);
      return window.Shibaox;
    });
  }
  return loading;
}

/** The loaded namespace; only valid after `loadDesignSystem()` resolved (the app waits for it). */
export function ds(): DesignSystem {
  if (!window.Shibaox) throw new Error('the design system is not loaded yet');
  return window.Shibaox;
}
