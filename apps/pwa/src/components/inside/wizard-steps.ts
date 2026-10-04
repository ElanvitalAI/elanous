import type { WizardStepEvent } from '@/lib/inside-events';

const STEPS = [
  { step: 'request', label: '요청' },
  { step: 'research', label: '조사' },
  { step: 'draft', label: '초안' },
  { step: 'validate', label: '검증' },
  { step: 'install', label: '설치' },
  { step: 'done', label: '끝' },
] as const satisfies ReadonlyArray<{ step: WizardStepEvent['step']; label: string }>;

export type WizardTimelineRow = { step: WizardStepEvent['step']; label: string; state: 'done' | 'now' | 'todo' | 'failed'; text?: string; at?: string };

export function wizardTimeline(events: WizardStepEvent[]): WizardTimelineRow[] {
  if (events.length === 0) return [];
  const wizardId = events[events.length - 1]!.wizardId;
  const current = events.filter(event => event.wizardId === wizardId);
  const latest = current[current.length - 1]!;
  const currentIndex = STEPS.findIndex(row => row.step === latest.step);
  return STEPS.map(({ step, label }, index) => {
    const event = current.findLast(item => item.step === step);
    const failed = event?.detail != null && typeof event.detail === 'object' && !Array.isArray(event.detail)
      && (event.detail as { ok?: unknown }).ok === false;
    const state = latest.step === 'done' ? 'done' : failed ? 'failed' : index < currentIndex ? 'done' : index === currentIndex ? 'now' : 'todo';
    return { step, label, state, ...(event ? { text: event.text, at: event.ts } : {}) };
  });
}
