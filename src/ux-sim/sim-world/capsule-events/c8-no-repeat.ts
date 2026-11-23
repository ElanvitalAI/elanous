// ELN-CAPSULE-RESULT-NO-REPEAT-REPORT (OP 0.3.34 P1-4) — 캡슐 결과 = 원 일감 흡수 · 닫힌 칸 재보고 0.
// Real queue + knock wiring with synthetic capsule-done injections (sim universe): a capsule result absorbed into
// its original work item (mid-turn drain · next-turn passive carry · carried-with-turn summary) is a closed cell —
// replaying the same capsule-done (re-publish · reconnect) must not re-report it, while a fresh capsule still
// reports exactly once. Queue-level twin of the C1 duplicate window (which measures the still-pending replay).
import { createNextTuiQueue } from '../../../tui/core/queue.js';
import { capsuleDoneNotice, createChildNoticeProducers } from '../../../tui/core/notice-producers.js';
import { wireCapsuleDoneKnock } from '../../../tui/capsule-done-knock.js';
import { PASSIVE_RESULT_CARRY_MAX } from '../../../tui/passive-result-turn.js';
import type { CapsuleDoneEvent, CapsuleEvent } from '../../../turn-capsule/contract.js';
import type { SimWorldScenario } from '../types.js';

const done = (capsuleId: string, summary: string): CapsuleDoneEvent => ({
  type: 'capsule-done', capsuleId, kind: 'agent', sessionId: 'sim-seat',
  startedAt: 1, endedAt: 2, status: 'ok', summary,
});

export const simWorldScenarios: readonly SimWorldScenario[] = [{
  id: 'SEAT-CAPSULE-NO-REPEAT-REPORT',
  title: 'absorbed capsule results stay closed — a replayed capsule-done never re-reports',
  async run(ctx) {
    const queue = createNextTuiQueue({ log: () => {}, turnLifeLog: () => {} });
    const notices = createChildNoticeProducers(queue);
    let listener: ((event: CapsuleEvent) => void) | undefined;
    const stop = wireCapsuleDoneKnock({ sessionId: 'sim-seat',
      subscribe: (_sessionId, onEvent) => { listener = onEvent; return () => { listener = undefined; }; },
      enqueue: (event) => notices.capsuleDone(event, event.endedAt), knock: () => {},
    });
    const capsuleRows = () => queue.items.filter((item) => item.source === 'capsule-done');
    // ① first report — exactly one waiting summary row, literal notice text
    listener?.(done('sim-absorbed', 'first result'));
    const firstReport = capsuleRows().length === 1 && capsuleRows()[0]?.text === capsuleDoneNotice(done('sim-absorbed', 'first result'));
    // ② absorption — the next real turn carries the passive results into itself
    const rows = queue.passiveResultNotices(PASSIVE_RESULT_CARRY_MAX);
    const absorbed = rows.length === 1 && rows[0]?.capsuleIds?.[0] === 'sim-absorbed'
      && queue.consumePassiveResultNotices(rows) === 1 && capsuleRows().length === 0;
    // ③ replay of the absorbed capsule (re-publish · reconnect) — closed cell, no second report
    listener?.(done('sim-absorbed', 'first result'));
    const replaySilent = capsuleRows().length === 0;
    // ④ positive control — a fresh capsule still reports exactly once
    listener?.(done('sim-fresh', 'fresh result'));
    const freshReported = capsuleRows().length === 1 && capsuleRows()[0]?.text === capsuleDoneNotice(done('sim-fresh', 'fresh result'));
    ctx.recorder.event('capsule-no-repeat-report', { firstReport, absorbed, replaySilent, freshReported });
    stop();
    return firstReport && absorbed && replaySilent && freshReported ? { ok: true } : { ok: false,
      diff: `firstReport=${firstReport} absorbed=${absorbed} replaySilent=${replaySilent} freshReported=${freshReported}` };
  },
}];
