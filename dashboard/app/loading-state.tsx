'use client';

import { WavePhysicsLoader } from './motion/wave-physics';
import { useTheme } from './theme';

/** A real pending operation, with a label that remains readable without motion. */
export function LoadingState({ label = 'Loading…', compact = false }: { label?: string; compact?: boolean }) {
  const theme = useTheme();
  return <div className={`rt-loading-state${compact ? ' compact' : ''}`} role="status" aria-live="polite">
    <WavePhysicsLoader theme={theme} />
    <span>{label}</span>
  </div>;
}
