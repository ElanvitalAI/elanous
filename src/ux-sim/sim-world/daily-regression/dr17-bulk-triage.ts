// DR17 · DR-BULK — BULK-TRIAGE (CEO 11-25 «여러 메시지를 한번에 · 10개 20개가 몰려도 한번에»): 30 mixed seat mails go
// through the REAL queue + seat-mail producer (the 20-notice cap folds the rest into the same bundle), one idle drain
// opens ONE bundle turn with ONE triage card (P0 first · counts exact · every msgId accounted · ≤ 40 lines); bursts of
// 10 / 20 / 25 do the same; one compound human ask (7 asks · 2 crown-flagged) becomes a P0-first card in front of the
// person's untouched text. Universe-local files only (the card is written under the universe root as a receipt).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DailyRegressionScenario } from './scenarios.js';

interface BurstMail { id: number; from: string; intent: string; kind: string; crown?: string; deadline?: string; replyTo?: number; to: string; body: string }

/** 30 mails: 2 crown · 3 alert · 5 requests with deadlines · 10 info · 5 duplicates (re-sent info) · 5 self-wakes. */
function thirty(): BurstMail[] {
  const out: BurstMail[] = [];
  let id = 7000;
  out.push({ id: id++, from: 'OPC', intent: 'request', kind: 'request', crown: '9101', to: 'OP', body: '데모 리허설 먼저' });
  for (let i = 0; i < 3; i += 1) out.push({ id: id++, from: 'RES', intent: 'alert', kind: 'alert', to: 'OP', body: `호스트 디스크 경보 ${i}` });
  for (let i = 0; i < 5; i += 1) out.push({ id: id++, from: 'JUD', intent: 'request', kind: 'request', deadline: '2026-11-25T18:00', to: 'OP', body: `착지 판정 요청 ${i}` });
  for (let i = 0; i < 10; i += 1) out.push({ id: id++, from: i % 2 ? 'UX' : 'TC', intent: 'info', kind: 'info', to: 'OP', body: `진행 보고 ${i}` });
  out.push({ id: id++, from: 'OPC', intent: 'request', kind: 'request', crown: '9102', to: 'OP', body: '발행 노트 영어로' });
  for (let i = 0; i < 5; i += 1) out.push({ id: id++, from: i % 2 ? 'UX' : 'TC', intent: 'info', kind: 'info', to: 'OP', body: `진행 보고 ${i}` });
  for (let i = 0; i < 5; i += 1) out.push({ id: id++, from: 'OP', intent: 'info', kind: 'wake', to: 'OP', body: `self wake ${i}` });
  return out;
}

function burstOf(n: number): BurstMail[] {
  return Array.from({ length: n }, (_, i) => ({ id: 8000 + n * 100 + i, from: ['TC', 'UX', 'JUD'][i % 3]!,
    intent: i === n - 2 ? 'request' : i < 3 ? 'alert' : i < 13 ? 'request' : 'info', kind: i < 3 ? 'alert' : i < 13 ? 'request' : 'info',
    ...(i === n - 2 ? { crown: '9200' } : {}), ...(i >= 3 && i < 8 ? { deadline: '2026-11-25T20:00' } : {}), to: 'OP', body: `burst ${n} 우편 ${i}` }));
}

export const dr17: DailyRegressionScenario = {
  id: 'DR17', prs: [],
  title: 'DR-BULK: 30 mixed mails + one compound human ask → ONE bundle turn · ONE card · counts exact · P0 first · bursts 10/20/25 lose no mail',
  async run(ctx) {
    const failures: string[] = [];
    const eq = (label: string, actual: unknown, expected: unknown) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(`${label}: expected ${JSON.stringify(expected)} · observed ${JSON.stringify(actual)}`);
    };
    const { createNextTuiQueue } = await import('../../../tui/core/queue.js');
    const { createChildNoticeProducers } = await import('../../../tui/core/notice-producers.js');
    const { seatMailBundleText } = await import('../../../tui/seat-mail-digest.js');
    const { triageBundleText, triageHumanText } = await import('../../../tui/triage/bulk-triage-hook.js');
    const outDir = join(ctx.universeRoot, 'OP', '.triage');
    mkdirSync(outDir, { recursive: true });
    const run = (label: string, mails: BurstMail[]) => {
      const queue = createNextTuiQueue({ log: () => {}, turnLifeLog: () => {} });
      const producers = createChildNoticeProducers(queue);
      for (const m of mails) {
        producers.seatMessageArrived({ id: m.id, sender: m.from, fromSeat: m.from, kind: m.kind, intent: m.intent, recipient: m.to,
          ...(m.crown ? { crownDirective: m.crown } : {}), ...(m.deadline ? { deadlineAt: m.deadline } : {}), body: m.body });
      }
      const logs: Array<Record<string, unknown>> = [];
      let turns = 0;
      const drained = queue.drainNotices();
      if (drained.kind !== 'notices') { failures.push(`${label}: no bundle`); return null; }
      turns += 1; // one idle boundary = one bundle turn
      const out = triageBundleText(seatMailBundleText(drained.notices), drained.notices, (event, data) => { logs.push({ event, ...data }); });
      const card = out.card!;
      const accounted = [...card.accountedIds].sort((a, b) => a - b);
      const missing = mails.map((m) => m.id).filter((id) => !accounted.includes(id));
      eq(`${label}: turns opened`, turns, 1);
      eq(`${label}: queue empty after the one drain`, [drained.remaining, queue.drainNotices().kind], [0, 'none']);
      eq(`${label}: no mail lost`, missing, []);
      eq(`${label}: card ≤ 40 lines`, card.lines <= 40, true);
      eq(`${label}: P0 first`, card.entries[0]?.priority, 'P0');
      eq(`${label}: one log line`, logs.length, 1);
      writeFileSync(join(outDir, `${label}.card.txt`), `${card.text}\n`);
      ctx.note(`dr17-${label}`, { ...logs[0], turns, notices: drained.notices.length, accounted: accounted.length, missing: missing.length });
      return card;
    };
    const c30 = run('mixed30', thirty());
    if (c30) {
      eq('mixed30: counts', c30.counts, { p0: 5, p1: 5, p2: 0, p3: 10, noise: 10 });
      eq('mixed30: received · groups', [c30.received, c30.groups], [30, 20]);
      eq('mixed30: noise split', [c30.noise.duplicates, c30.noise.selfWakes], [5, 5]);
      eq('mixed30: order', c30.entries.map((e) => e.priority).join(''), 'P0P0P0P0P0P1P1P1P1P1' + 'P3'.repeat(10));
    }
    const c10 = run('burst10', burstOf(10));
    if (c10) eq('burst10: counts', c10.counts, { p0: 4, p1: 5, p2: 1, p3: 0, noise: 0 });
    const c20 = run('burst20', burstOf(20));
    if (c20) eq('burst20: counts', c20.counts, { p0: 4, p1: 5, p2: 5, p3: 6, noise: 0 });
    const c25 = run('burst25', burstOf(25));
    if (c25) eq('burst25: counts (5 past the cap folded into the same card)', [c25.received, c25.counts], [25, { p0: 4, p1: 5, p2: 5, p3: 11, noise: 0 }]);
    // One compound human ask: 7 asks, 2 crown-flagged → P0 first; the person's text follows untouched.
    const human = [
      '오늘 정리할 것:',
      '1. [대표] 내일 데모 리허설을 18시 전에 끝까지 돌려서 녹화본을 텔레그램으로 보내 주세요',
      '2. 발행 노트를 영어로 다시 쓰고 내부어(desired·HITL·gate)는 모두 빼 주세요',
      '- 회원 가입 안내 문구를 홈과 덱에 똑같이 맞춰 주세요 그리고 덱 마지막 장의 일정표를 갱신해 주세요',
      '• 긴급: 빌드 호스트 디스크가 90%를 넘었으니 오래된 Pod 이미지를 정리해 주세요',
      '그리고 버스트 VM 이 놀고 있으면 꺼 주세요',
      '마지막으로 오늘 착지 수를 시간대별로 표로 정리해서 저녁 보고에 넣어 주세요 — 판정국 대기 줄 길이와 리뷰 왕복 횟수도 같은 표에 넣고, 어제와 비교한 증감을 한 줄로 요약해서 맨 위에 적어 주세요. 표는 텔레그램 OP 방에도 이미지로 올려 주시고 원본 숫자는 근거로 남겨 두세요.',
    ].join('\n');
    const humanLogs: Array<Record<string, unknown>> = [];
    const h = triageHumanText(human, (event, data) => { humanLogs.push({ event, ...data }); });
    eq('human: 7 asks · 2 P0', h.card ? [h.card.received, h.card.counts.p0, h.card.counts.p1] : null, [7, 2, 5]);
    eq('human: P0 first', h.card?.entries.slice(0, 2).map((e) => e.priority), ['P0', 'P0']);
    eq('human: original text kept', h.text.endsWith(human), true);
    if (h.card) writeFileSync(join(outDir, 'human.card.txt'), `${h.card.text}\n`);
    ctx.note('dr17-human', { ...humanLogs[0] });
    return failures.length === 0 ? { ok: true } : { ok: false, diff: failures.join('\n') };
  },
};
