'use client';

import { useSyncExternalStore } from 'react';

// Follow the device by default; a deliberate dashboard choice can opt into
// the reference animation without changing the user's system preferences.
const KEY = 'raytrace-wave-animation';
const CHANGED = 'raytrace-wave-animation-changed';
const QUERY = '(prefers-reduced-motion: reduce)';
let fallback: string | null = null;

function enabled() {
  let choice = fallback;
  try { choice = localStorage.getItem(KEY) ?? fallback; } catch { /* session preference only */ }
  if (choice === 'on' || choice === 'off') return choice === 'on';
  return !window.matchMedia(QUERY).matches;
}

function subscribe(changed: () => void) {
  const media = window.matchMedia(QUERY);
  media.addEventListener('change', changed);
  window.addEventListener('storage', changed);
  window.addEventListener(CHANGED, changed);
  return () => {
    media.removeEventListener('change', changed);
    window.removeEventListener('storage', changed);
    window.removeEventListener(CHANGED, changed);
  };
}

export function useWaveAnimation() {
  return useSyncExternalStore(subscribe, enabled, () => false);
}

export function setWaveAnimation(value: boolean) {
  fallback = value ? 'on' : 'off';
  try { localStorage.setItem(KEY, fallback); } catch { /* still works for this session */ }
  window.dispatchEvent(new Event(CHANGED));
}
