/** A listed, usable service, a confirmed absence, or a probe that could not decide. */
export type CapabilityState = 'ready' | 'unavailable' | 'unknown';

/** One backend's observation of a service; unknown is not evidence of absence. */
export interface CapabilityEntry {
  readonly backend: 'codex' | 'claude' | 'grok';
  readonly service: string;
  readonly state: CapabilityState;
  readonly detail?: string;
}

/** Canonical service key for comparing names reported by different CLIs. */
export function normalizeServiceName(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase().replace(/[\s_-]+/gu, '-');
}
