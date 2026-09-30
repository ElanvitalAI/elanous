export function nextChatScrollOffset(
  current: number,
  key: 'pageup' | 'pagedown',
  pageSize: number,
  maxOffset: number,
): number {
  if (maxOffset <= 0) return -1;
  const offset = current < 0 ? maxOffset : Math.max(0, Math.min(current, maxOffset));
  if (key === 'pageup') return Math.max(0, offset - pageSize);
  const next = offset + pageSize;
  return next >= maxOffset ? -1 : next;
}
