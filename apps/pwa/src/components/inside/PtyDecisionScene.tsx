'use client';

import { toPublicText } from './public-text';
import type { DecisionsState } from './pty-decisions';

// Answer prose may contain commands and private context: only these leading decision labels are public outcomes.
const OUTCOME = /^\s*(승인|거부|반려|보류|허용|차단|중단|취소)(?=$|[\s.,!?;:])/;

/** Only explicit, sanitized outcomes cross the stage boundary; decision text, keystrokes and terminal screens never do. */
export function PtyDecisionScene({ decisions, now = Date.now() }: { decisions: DecisionsState; now?: number }) {
  const answers = Object.values(decisions.missions).flat()
    .filter((item): item is Extract<typeof item, { step: 'answer' }> => item.step === 'answer')
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts) || b.seq - a.seq);
  const latest = answers[0];
  const minutes = latest ? Math.max(0, Math.floor((now - Date.parse(latest.ts)) / 60_000)) : null;
  const active = answers.flatMap((item) => {
    const outcome = OUTCOME.exec(item.detail.answer)?.[1];
    return outcome && now - Date.parse(item.ts) < 5 * 60_000 ? [{ item, outcome }] : [];
  });
  return (
    <section aria-label="PTY 인텔리전스" className="min-w-0 rounded-xl border border-slate-600 p-5 text-lg leading-relaxed min-[1440px]:text-[22px]">
      <h2 className="mb-5 font-semibold">PTY 판단</h2>
      {active.length === 0 ? (
        <p role="status">지금 PTY 판단이 없습니다 — 마지막 판단 {minutes === null ? '기록 없음' : `${minutes}분 전`}</p>
      ) : (
        <ol aria-label="최근 PTY 판단" className="space-y-4">
          {active.slice(0, 3).map(({ item, outcome }) => (
            <li key={`${item.missionId}:${item.seq}`} className="min-w-0 rounded-lg border border-slate-600 p-4">
              <time dateTime={item.ts}>{toPublicText(item.ts)}</time> · {toPublicText(outcome)}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
