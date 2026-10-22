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

// SSE·/v1/logs 백필이 합쳐진 배열은 사전순 ts 정렬이라 시각순과 어긋날 수 있어, 최신 판정은 ts 로 한다.
function eventTime(ts: string): number {
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

export function wizardTimeline(events: WizardStepEvent[]): WizardTimelineRow[] {
  if (events.length === 0) return [];
  const ranked = events
    .map((event, order) => ({ event, order, time: eventTime(event.ts) }))
    .sort((a, b) => a.time - b.time || a.order - b.order);
  const wizardId = ranked[ranked.length - 1]!.event.wizardId;
  const current = ranked.filter(item => item.event.wizardId === wizardId);
  const latest = current[current.length - 1]!.event;
  const currentIndex = STEPS.findIndex(row => row.step === latest.step);
  return STEPS.map(({ step, label }, index) => {
    const event = current.filter(item => item.event.step === step).at(-1)?.event;
    const failed = event?.detail != null && typeof event.detail === 'object' && !Array.isArray(event.detail)
      && (event.detail as { ok?: unknown }).ok === false;
    const state = latest.step === 'done' ? 'done' : failed ? 'failed' : index < currentIndex ? 'done' : index === currentIndex ? 'now' : 'todo';
    return { step, label, state, ...(event ? { text: event.text, at: event.ts } : {}) };
  });
}
