'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, Link, Send } from 'lucide-react';
import { MorphIcon } from './motion/controls';

/** Confirm actual writes, rather than showing "Copied" on hover. */
export function CopyButton({ text, label = 'Copy', noun = 'command', variant = 'copy', title }: {
  text: string | (() => string); label?: string; noun?: string; variant?: 'copy' | 'share'; title?: string;
}) {
  const [state, setState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle');
  const [hovered, setHovered] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setState('idle');
    return () => { generation.current += 1; clearTimeout(timer.current); };
  }, [text]);

  async function copy() {
    const request = generation.current;
    clearTimeout(timer.current);
    setState('copying');
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(typeof text === 'function' ? text() : text);
      if (request !== generation.current) return;
      setState('copied');
      timer.current = setTimeout(() => setState('idle'), 1800);
    } catch {
      if (request === generation.current) setState('error');
    }
  }

  const share = variant === 'share';
  const shownLabel = state === 'copied' ? share ? 'Link copied' : 'Copied' : state === 'copying' ? 'Copying…' : state === 'error' ? 'Retry copy' : label;
  return <span className="rt-copy-control">
    <button type="button" className={`rt-button rt-motion-button rt-copy-button${share ? ' rt-share-button' : ''}`} data-state={state}
      disabled={state === 'copying'} onClick={() => void copy()} aria-label={state === 'copied' ? `${noun} copied` : `${shownLabel} ${noun}`} title={title}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocus={() => setHovered(true)} onBlur={() => setHovered(false)}>
      <MorphIcon first={share ? Link : Copy} second={state === 'copied' ? Check : Send} active={state === 'copied' || (share && hovered)} />
      <span>{shownLabel}</span>
    </button>
    <span className={state === 'error' ? 'rt-copy-error' : 'rt-sr-only'} role="status">
      {state === 'copied' ? `${share ? 'Local dashboard link' : noun[0].toUpperCase() + noun.slice(1)} copied to clipboard.` : state === 'error' ? 'Could not copy. Select the text and copy it manually, or retry.' : ''}
    </span>
  </span>;
}

/** Shares the selected prompt, independent of the view the user came from. */
export function SharePromptButton({ traceId }: { traceId: string }) {
  const link = useCallback(() => {
    const url = new URL(window.location.pathname, window.location.origin);
    url.searchParams.set('trace', traceId);
    return url.href;
  }, [traceId]);
  return <CopyButton text={link} label="Share" noun="prompt link" variant="share"
    title="Copy a link to this prompt. This local address works only on this computer; it does not publish your traces." />;
}
