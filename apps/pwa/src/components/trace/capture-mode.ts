export function tracePublicCapture(capture: string | null, present: 'stage' | 'research' | null): boolean {
  return capture === 'public' || (present === 'stage' && capture !== 'private');
}
