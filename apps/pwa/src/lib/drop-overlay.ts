export interface DropOverlayState {
  visible: boolean;
  depth: number;
}

export function nextDropOverlay(
  state: DropOverlayState,
  event: 'enter' | 'leave' | 'drop' | 'end',
  hasFiles: boolean,
): DropOverlayState {
  if (event === 'drop' || event === 'end' || !hasFiles) return { visible: false, depth: 0 };
  const depth = event === 'enter' ? state.depth + 1 : Math.max(0, state.depth - 1);
  return { visible: depth > 0, depth };
}
