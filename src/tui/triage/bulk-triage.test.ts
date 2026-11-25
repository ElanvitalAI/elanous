// BULK-TRIAGE — expectations are independent literals (never built from the module's own render helpers).
import { describe, expect, test } from 'bun:test';
import { createNextTuiQueue, NEXT_TUI_NOTICE_CAP } from '../core/queue.js';
import { createChildNoticeProducers } from '../core/notice-producers.js';
import { seatMailBundleText } from '../seat-mail-digest.js';
import { seatMailOverflowNotice } from '../seat-mail-arrival.js';
import { BULK_TRIAGE_HUMAN_MAX_ASKS, buildBulkTriageCard, humanTextNeedsTriage, splitHumanAsks, withBulkTriageCard, type BulkTriageMail } from './bulk-triage.js';
import { triageBundleText, triageHumanText } from './bulk-triage-hook.js';

/** 30 synthetic mails: 2 crown · 3 alert · 5 requests with deadlines · 10 info · 5 duplicates · 5 self-wakes. */
function thirtyMails(): BulkTriageMail[] {
  const out: BulkTriageMail[] = [];
  let id = 1000;
  for (let i = 0; i < 10; i += 1) out.push({ msgId: id++, from: i % 2 ? 'UX' : 'TC', to: 'OP', intent: 'info', kind: 'info', body: `진행 보고 ${i}: 칸 정리 끝` });
  for (let i = 0; i < 5; i += 1) out.push({ msgId: id++, from: 'JUD', to: 'OP', intent: 'request', kind: 'request', deadline: `2026-11-25T1${i}:00`, body: `PR #${40100 + i} 착지 판정 요청` });
  out.push({ msgId: id++, from: 'OPC', to: 'OP', intent: 'request', crownDirective: '9001', body: '데모 리허설 먼저' });
  for (let i = 0; i < 3; i += 1) out.push({ msgId: id++, from: 'RES', to: 'OP', intent: 'alert', kind: 'alert', body: `호스트 디스크 9${i}%` });
  out.push({ msgId: id++, from: 'OPC', to: 'OP', intent: 'request', crownDirective: '9002', body: '발행 노트 영어로' });
  for (let i = 0; i < 5; i += 1) out.push({ msgId: id++, from: i % 2 ? 'UX' : 'TC', to: 'OP', intent: 'info', kind: 'info', body: `진행 보고 ${i}: 칸 정리 끝` }); // re-sends
  for (let i = 0; i < 5; i += 1) out.push({ msgId: id++, from: 'OP', to: 'OP', intent: 'info', kind: 'wake', body: `self wake ${i}` });
  return out;
}

describe('buildBulkTriageCard — 30 mixed mails', () => {
  const mails = thirtyMails();
  const card = buildBulkTriageCard({ mails });
  test('counts per class are exact', () => {
    expect(card.received).toBe(30);
    expect(card.counts).toEqual({ p0: 5, p1: 5, p2: 0, p3: 10, noise: 10 });
    expect(card.noise.duplicates).toBe(5);
    expect(card.noise.selfWakes).toBe(5);
    expect(card.groups).toBe(20);
  });
  test('P0 first, then P1, then P3; crown in arrival order', () => {
    expect(card.entries.map((e) => e.priority)).toEqual([...Array(5).fill('P0'), ...Array(5).fill('P1'), ...Array(10).fill('P3')]);
    expect(card.entries[0]!.gist).toBe('데모 리허설 먼저');
    expect(card.entries[4]!.gist).toBe('발행 노트 영어로');
  });
  test('duplicates fold onto the first send of the thread', () => {
    expect(card.entries.filter((e) => e.duplicates === 1).map((e) => e.ids)).toEqual([[1000, 1020], [1001, 1021], [1002, 1022], [1003, 1023], [1004, 1024]]);
  });
  test('card text: header, numbered P0 line, P3 and noise by count, rule line, ≤ 40 lines', () => {
    const lines = card.text.split('\n');
    expect(lines[0]).toBe('<!-- bulk-triage-card -->');
    expect(lines[1]).toBe('📋 받은 것 30 → 처리 묶음 20 (P0 5 · P1 5 · P2 0 · P3 10 · noise 10)');
    expect(lines[2]).toBe('1. [P0] 실행 · OPC · 데모 리허설 먼저 · #1015');
    expect(lines[6]).toBe('5. [P0] 실행 · OPC · 발행 노트 영어로 · #1019');
    expect(lines[7]).toBe('6. [P1] 실행 · JUD · PR #40100 착지 판정 요청 · 기한 2026-11-25T10:00 · #1010');
    expect(lines).toContain('[P3] 정보 10건 · 흡수만 · TC 5 · UX 5 · #1000-#1009');
    expect(lines).toContain('[noise] 10건 · 읽음 처리 · 중복 5 · 자기 깨움 5 · #1020-#1029');
    expect(lines.at(-2)).toBe('처리 규칙: P0·P1 은 이번 턴에 · P3 는 흡수만 · noise 는 읽음 처리');
    expect(lines.at(-1)).toBe('<!-- /bulk-triage-card -->');
    expect(lines.length).toBeLessThanOrEqual(40);
  });
  test('every msgId accounted', () => {
    expect([...card.accountedIds].sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => 1000 + i));
  });
});

describe('compound human text', () => {
  const text = [
    '오늘 정리할 것:',
    '1. [대표] 내일 데모 리허설을 18시 전에 끝까지 돌려서 녹화본을 텔레그램으로 보내 주세요',
    '2. 발행 노트를 영어로 다시 쓰고 내부어(desired·HITL·gate)는 모두 빼 주세요',
    '- 회원 가입 페이지의 «12월 무료 회원 오픈» 안내 문구를 홈과 덱에 똑같이 맞춰 주세요 그리고 덱 마지막 장의 일정표를 11월 기준으로 갱신해 주세요',
    '• 긴급: 빌드 호스트 디스크가 90%를 넘었으니 오래된 Pod 이미지를 정리해 주세요',
    '그리고 버스트 VM 이 놀고 있으면 꺼 주세요',
    '마지막으로 오늘 착지 수를 시간대별로 표로 정리해서 저녁 보고에 넣어 주세요 — 판정국 대기 줄 길이와 리뷰 왕복 횟수도 같은 표에 넣고, 어제와 비교한 증감을 한 줄로 요약해서 맨 위에 적어 주세요. 표는 텔레그램 OP 방에도 이미지로 올려 주시고 원본 숫자는 근거로 남겨 두세요.',
  ].join('\n');
  test('7 asks, list markers stripped, «그리고» split', () => {
    const asks = splitHumanAsks(text);
    expect(asks.length).toBe(7);
    expect(asks[2]).toBe('회원 가입 페이지의 «12월 무료 회원 오픈» 안내 문구를 홈과 덱에 똑같이 맞춰 주세요');
    expect(asks[3]).toBe('덱 마지막 장의 일정표를 11월 기준으로 갱신해 주세요');
    expect(asks[5]).toBe('버스트 VM 이 놀고 있으면 꺼 주세요');
  });
  test('crown-flagged asks are P0 and lead the card; the person\'s text follows, never dropped', () => {
    expect(text.length).toBeGreaterThanOrEqual(400);
    const logs: Array<Record<string, unknown>> = [];
    const out = triageHumanText(text, (event, data) => { logs.push({ event, ...data }); });
    expect(out.card!.counts).toEqual({ p0: 2, p1: 0, p2: 5, p3: 0, noise: 0 });
    expect(out.card!.entries.slice(0, 2).map((e) => e.priority)).toEqual(['P0', 'P0']);
    expect(out.text.endsWith(text)).toBe(true);
    expect(logs).toEqual([{ event: 'bulk-card', door: 'human', items: 7, p0: 2, p1: 0, p2: 5, p3: 0, noise: 0, groups: 7, folded: 0, lines: 11 }]);
  });
  test('short text gets no card', () => {
    expect(triageHumanText('1. a 하기\n2. b 하기\n3. c 하기', () => {}).card).toBeNull();
  });
});

test('stable block id — feeding twice yields one block', () => {
  const card = buildBulkTriageCard({ mails: thirtyMails() }).text;
  const once = withBulkTriageCard('원문', card);
  const twice = withBulkTriageCard(once, card);
  expect(twice).toBe(once);
  expect(twice.split('<!-- bulk-triage-card -->').length).toBe(2);
  expect(withBulkTriageCard(twice, null)).toBe('원문');
});

/** A burst through the REAL queue + producer: n mails arrive, one idle drain = one bundle = one card. */
function burst(n: number, opts: { crownAt?: number } = {}) {
  const queue = createNextTuiQueue({ log: () => {}, turnLifeLog: () => {} });
  const producers = createChildNoticeProducers(queue);
  const ids: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = 5000 + i;
    ids.push(id);
    // first 3 alerts · next 5 requests with deadline · next 5 plain requests · the rest info · optional crown at index
    const crown = opts.crownAt === i;
    const intent = crown ? 'request' : i < 3 ? 'alert' : i < 13 ? 'request' : 'info';
    producers.seatMessageArrived({ id, sender: 'TC', fromSeat: i % 3 === 0 ? 'TC' : i % 3 === 1 ? 'UX' : 'JUD', kind: intent, intent,
      ...(crown ? { crownDirective: '777' } : {}), recipient: 'OP', ...(i >= 3 && i < 8 ? { deadlineAt: '2026-11-25T18:00' } : {}),
      body: `burst ${n} 우편 ${i} 본문` });
  }
  const logs: Array<Record<string, unknown>> = [];
  let turns = 0;
  const drained = queue.drainNotices();
  if (drained.kind !== 'notices') throw new Error('no bundle');
  turns += 1;
  const out = triageBundleText(seatMailBundleText(drained.notices), drained.notices, (event, data) => { logs.push({ event, ...data }); });
  return { turns, remaining: drained.remaining, again: queue.drainNotices().kind, out, logs, ids, notices: drained.notices.length };
}

describe('burst of 10 / 20 / cap+5 mails → ONE bundle turn, ONE card, no mail lost', () => {
  test('10', () => {
    const r = burst(10);
    expect([r.turns, r.remaining, r.again, r.notices]).toEqual([1, 0, 'none', 10]);
    expect(r.out.card!.counts).toEqual({ p0: 3, p1: 5, p2: 2, p3: 0, noise: 0 });
    expect([...r.out.card!.accountedIds].sort()).toEqual(r.ids);
    expect(r.out.card!.lines).toBeLessThanOrEqual(40);
    expect(r.logs).toEqual([{ event: 'bulk-card', door: 'bundle', items: 10, p0: 3, p1: 5, p2: 2, p3: 0, noise: 0, groups: 10, folded: 0, lines: 14 }]);
  });
  test('20', () => {
    const r = burst(20);
    expect([r.turns, r.remaining, r.again, r.notices]).toEqual([1, 0, 'none', 20]);
    expect(r.out.card!.counts).toEqual({ p0: 3, p1: 5, p2: 5, p3: 7, noise: 0 });
    expect([...r.out.card!.accountedIds].sort()).toEqual(r.ids);
    expect(r.out.card!.lines).toBeLessThanOrEqual(40);
    expect(r.out.text.split('\n').filter((l) => /^\d+\. \[P[01]\]/u.test(l)).length).toBe(8);
    expect(r.out.text).toContain('[P3] 정보 7건 · 흡수만');
  });
  test('cap + 5 crosses the notice cap: overflow folds into the same bundle and card (crown in the folded tail still P0)', () => {
    // The cap is the boundary under test (main moved it 20 → 100) — the burst is sized from it so it always crosses.
    const n = NEXT_TUI_NOTICE_CAP + 5;
    const r = burst(n, { crownAt: n - 2 });
    expect([r.turns, r.remaining, r.again, r.notices]).toEqual([1, 0, 'none', NEXT_TUI_NOTICE_CAP + 1]); // cap mails + 1 overflow guide
    expect(r.out.card!.received).toBe(n);
    expect(r.out.card!.counts).toEqual({ p0: 4, p1: 5, p2: 5, p3: n - 14, noise: 0 });
    expect([...r.out.card!.accountedIds].sort()).toEqual(r.ids);
    expect(r.out.card!.lines).toBeLessThanOrEqual(40);
    expect(r.out.text).toContain(`[P0] 실행 · ${['TC', 'UX', 'JUD'][(n - 2) % 3]} · burst ${n} 우편 ${n - 2} 본문 · #${5000 + n - 2}`);
  });
});

test('arrival-level overflow guide (ids #a..#b) becomes a folded range — counted, not lost', () => {
  const notices = [
    { id: 'q1', text: 'x', source: 'seat-mail' as const, msgId: 1, triage: { from: 'TC', intent: 'request', body: 'a' } },
    { id: 'q2', text: 'y', source: 'seat-mail' as const, msgId: 2, triage: { from: 'UX', intent: 'info', kind: 'info', body: 'b' } },
    { id: 'q3', text: seatMailOverflowNotice('OP', 6, 3, 8, false, 8), source: 'seat-mail-guide' as const },
  ];
  const out = triageBundleText('body', notices, () => {});
  expect(out.card!.received).toBe(8);
  expect(out.card!.folded).toEqual([{ first: 3, last: 8, count: 6 }]);
  expect(out.text).toContain('[접힘] #3..#8 6건 · 아직 큐 밖 — 이 턴 끝에 eln msg list 로 이어 읽기');
});

test('P2 overflow keeps the card ≤ 40 lines while every P0/P1 stays listed', () => {
  const mails: BulkTriageMail[] = [];
  for (let i = 0; i < 6; i += 1) mails.push({ msgId: 100 + i, from: 'RES', intent: 'alert', body: `alert ${i}` });
  for (let i = 0; i < 50; i += 1) mails.push({ msgId: 200 + i, from: 'TC', intent: 'request', body: `ask ${i}` });
  const card = buildBulkTriageCard({ mails });
  expect(card.lines).toBe(40);
  expect(card.text.split('\n').filter((l) => /^\d+\. \[P0\]/u.test(l)).length).toBe(6);
  expect(card.text).toContain('[P2] +21건 더 · #229-#249');
});

test('text-only folded line (no kept meta) is read back from the producer header format', async () => {
  const { foldedLineToMail } = await import('./bulk-triage-hook.js');
  expect(foldedLineToMail('- [from OPC · request · crown] msg:42 · 데모 먼저')).toEqual({ msgId: 42, from: 'OPC', intent: 'request', crownDirective: 'folded', body: '데모 먼저' });
  expect(foldedLineToMail('- no id here')).toBeNull();
});

// TUI-LONG-PASTE-SPIN (대표 11-25 «어디선가 경계값이 무너졌다») — the four boundaries the live 48-line paste broke.
describe('boundaries (TUI-LONG-PASTE-SPIN)', () => {
  test('drawing, table and quoted lines are never asks', () => {
    const text = [
      '│ ┌──────────────┐',
      '├──────────────────',
      '│ │ 경로 │ 수리 │',
      '└──────────────────',
      '| 칸 | 상태 |',
      '>>>',
      '> 인용된 지난 답',
      '❯ 턴 압축 사라짐 문제는요?',
      '$ eln msg list --to OP',
      '착지 대기 PR 을 다시 확인해 주세요',
    ].join('\n');
    expect(splitHumanAsks(text)).toEqual(['착지 대기 PR 을 다시 확인해 주세요']);
  });

  test('ask count: 3 → card · 12 → card · 13 → a document, no card', () => {
    const asks = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}. 이번 묶음의 ${i + 1}번째 일을 오늘 안에 정리해서 근거와 함께 보고해 주세요`).join('\n');
    const pad = (text: string) => `${text}\n배경 설명 ${'.'.repeat(400)}:`; // a heading line (ends with «:») is not an ask
    expect(humanTextNeedsTriage(pad(asks(2)))).toBe(false);
    expect(humanTextNeedsTriage(pad(asks(3)))).toBe(true);
    expect(humanTextNeedsTriage(pad(asks(12)))).toBe(true);
    expect(humanTextNeedsTriage(pad(asks(13)))).toBe(false);
    expect(BULK_TRIAGE_HUMAN_MAX_ASKS).toBe(12);
  });

  test('the 40-line cap is absolute: 41 P1 mails fold to a count line', () => {
    const mails: BulkTriageMail[] = [{ msgId: 1, from: 'OPC', crownDirective: 'yes', body: 'crown first' }];
    for (let i = 0; i < 41; i += 1) mails.push({ msgId: 10 + i, from: 'JUD', intent: 'request', deadline: '2026-11-25T18:00', body: `ask ${i}` });
    const card = buildBulkTriageCard({ mails });
    expect(card.lines).toBe(40);
    expect(card.text.split('\n').length).toBe(40);
    const lines = card.text.split('\n');
    expect(lines[2]).toBe('1. [P0] 실행 · OPC · crown first · #1');
    expect(lines.filter((l) => /^\d+\. \[P1\]/u.test(l)).length).toBe(34);
    expect(card.text).toContain('[P1] +7건 더 · #44-#50');
  });

  test('cap holds with P0 over 40 too, and every priority keeps a line', () => {
    const mails: BulkTriageMail[] = [];
    for (let i = 0; i < 45; i += 1) mails.push({ msgId: 100 + i, from: 'RES', intent: 'alert', body: `alert ${i}` });
    mails.push({ msgId: 300, from: 'TC', intent: 'request', body: 'plain ask' });
    const card = buildBulkTriageCard({ mails });
    expect(card.lines).toBe(40);
    expect(card.text).toContain('[P0] +11건 더 · #134-#144');
    expect(card.text).toContain('35. [P2] 실행 · TC · plain ask · #300');
  });

  test('a person\'s plain line is P2; a crown-marked line is P0', () => {
    const card = buildBulkTriageCard({ human: { text: '[대표] 데모 먼저 해 주세요\n발행 노트를 정리해 주세요' } });
    expect(card.entries.map((e) => e.priority)).toEqual(['P0', 'P2']);
    expect(card.counts).toEqual({ p0: 1, p1: 0, p2: 1, p3: 0, noise: 0 });
  });
});
