import type { Key } from '../tui.js';

export function isClassicSigquitChord(key: Key): boolean {
  return !!key.ctrl && !key.shift && !key.alt
    && (key.name === '\\' || key.name === 'backslash');
}

/** Routes SIGQUIT to the active classic dashboard without terminating it. */
export function registerClassicSigquitHandler(
  onSigquit: () => void,
  signals: Pick<NodeJS.Process, 'on' | 'removeListener'> = process,
): () => void {
  const handler = (): void => { onSigquit(); };
  signals.on('SIGQUIT', handler);
  return () => { signals.removeListener('SIGQUIT', handler); };
}
