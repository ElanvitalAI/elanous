import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderCardText } from '../../decisions/decision-cards.js';
import { DecisionLedger, type DecisionCategory } from '../../decisions/decision-ledger.js';
import { SLASH_COMMANDS } from '../../chat/index.js';
import { slashMaturity, slashVisibleFor } from '../../maturity/tui-slash-maturity.js';
import { buildEssentialHelpLines } from './help-from-registry.js';
import { buildDashboardSlashRegistry, type DashboardSlashContext } from './dashboard-handlers.js';
import { createDecideSlashHandler } from './decide-slash.js';

function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), 'decide-slash-'));
  const ledger = new DecisionLedger({ stateDir, now: () => new Date('2026-10-06T12:00:00Z'), resolveVersion: () => ({ released: '0.1.0', dev: '0.1.1', codename: 'test' }) });
  const raise = (title: string, category: DecisionCategory = 'scope', raisedAt = '2026-10-06T10:00:00Z') => ledger.raise({
    title, category, raisedAt, scqa: { s: '상황', c: '선택 필요' },
    options: [{ key: 'a', label: '진행', consequence: '시작' }, { key: 'b', label: '보류', consequence: '대기' }],
    recommendation: { option: 'a', why: '준비 완료' }, raisedBy: { agent: 'operator', track: 'OP' },
  });
  return { ledger, raise, cleanup: () => rmSync(stateDir, { recursive: true, force: true }) };
}

test('empty list has exactly one line', () => {
  const f = fixture();
  try { expect(createDecideSlashHandler(f.ledger)([])).toBe('열린 결정 없음'); }
  finally { f.cleanup(); }
});

test('open list uses one-based ordering, seat and age; numbers are stable until reopened', () => {
  const f = fixture();
  try {
    const earlier = f.raise('먼저', 'scope', '2026-10-06T09:00:00Z');
    const later = f.raise('나중', 'scope', '2026-10-06T10:00:00Z');
    const handle = createDecideSlashHandler(f.ledger, () => new Date('2026-10-06T12:00:00Z'));
    expect(handle([])).toBe('1. 나중 [a/b] · OP · 2시간 전\n2. 먼저 [a/b] · OP · 3시간 전\n답하기: /decide <번호> <선택지 키>');
    f.raise('최신', 'scope', '2026-10-06T11:00:00Z');
    expect(handle(['1'])).toBe(renderCardText(f.ledger.show(later.id)));
    expect(handle(['2'])).toBe(renderCardText(f.ledger.show(earlier.id)));
    expect(handle([])).toStartWith('1. 최신 [a/b] · OP · 1시간 전');
    expect(handle(['2'])).toBe(renderCardText(f.ledger.show(later.id)));
  } finally { f.cleanup(); }
});

test('each numbered open-card line shows its own choice keys', () => {
  const f = fixture();
  try {
    f.raise('먼저');
    f.ledger.raise({
      title: '나중', category: 'scope', raisedAt: '2026-10-06T11:00:00Z', scqa: { s: '상황', c: '선택 필요' },
      options: [{ key: 'x', label: '선택', consequence: '진행' }, { key: 'y', label: '보류', consequence: '대기' }],
      recommendation: { option: 'x', why: '준비 완료' }, raisedBy: { agent: 'operator', track: 'OP' },
    });
    const handle = createDecideSlashHandler(f.ledger, () => new Date('2026-10-06T12:00:00Z'));
    expect(handle([]).split('\n').slice(0, 2)).toEqual([
      '1. 나중 [x/y] · OP · 1시간 전',
      '2. 먼저 [a/b] · OP · 2시간 전',
    ]);
  } finally { f.cleanup(); }
});

test('one card displays exactly the canonical card text including choices', () => {
  const f = fixture();
  try {
    const card = f.raise('한 장');
    const handle = createDecideSlashHandler(f.ledger);
    handle([]);
    expect(handle(['1'])).toBe(renderCardText(card));
    expect(handle(['1'])).toContain('A) 진행 — 시작');
  } finally { f.cleanup(); }
});

test('answer writes to the actual ledger as human and returns the chosen label', () => {
  const f = fixture();
  try {
    const card = f.raise('한 장');
    const handle = createDecideSlashHandler(f.ledger);
    handle([]);
    expect(handle(['1', 'b'])).toBe('✓ 한 장 → 보류\n열린 결정 없음');
    expect(new DecisionLedger({ stateDir: join(f.ledger.path, '..', '..') }).list({ status: 'decided' }))
      .toMatchObject([{ id: card.id, choice: 'b', decidedBy: { kind: 'human' } }]);
    expect(handle(['1', 'a'])).toBe('쓸 수 있는 번호: 없음 (/decide 로 목록 열기)');
  } finally { f.cleanup(); }
});

test('successful answer ends with a freshly numbered list of remaining open cards', () => {
  const f = fixture();
  try {
    const oldest = f.raise('맨 뒤', 'scope', '2026-10-06T08:00:00Z');
    f.raise('가운데', 'scope', '2026-10-06T09:00:00Z');
    f.raise('맨 앞', 'scope', '2026-10-06T10:00:00Z');
    const handle = createDecideSlashHandler(f.ledger, () => new Date('2026-10-06T12:00:00Z'));
    handle([]);
    expect(handle(['2', 'b'])).toBe(
      '✓ 가운데 → 보류\n1. 맨 앞 [a/b] · OP · 2시간 전\n2. 맨 뒤 [a/b] · OP · 4시간 전\n답하기: /decide <번호> <선택지 키>',
    );
    expect(handle(['2'])).toBe(renderCardText(f.ledger.show(oldest.id)));
  } finally { f.cleanup(); }
});

test('irreversible answer waits for explicit confirmation and reuses the canonical confirm text', () => {
  const f = fixture();
  try {
    const card = f.raise('게시', 'publish');
    const handle = createDecideSlashHandler(f.ledger);
    handle([]);
    expect(handle(['1', 'a', '확인'])).toBe(`${renderCardText(card, { confirm: 'a' })}\n/decide 1 a 확인`);
    expect(f.ledger.list({ status: 'open' })).toHaveLength(1);
    expect(handle(['1', 'a'])).toBe(`${renderCardText(card, { confirm: 'a' })}\n/decide 1 a 확인`);
    expect(f.ledger.list({ status: 'open' })).toHaveLength(1);
    expect(handle(['1', 'a', '확인'])).toBe('✓ 게시 → 진행\n열린 결정 없음');
    expect(f.ledger.list({ status: 'decided' })).toMatchObject([{ id: card.id, choice: 'a' }]);
  } finally { f.cleanup(); }
});

test('confirmation is tied to the displayed card and choice, and reopening cancels it', () => {
  const f = fixture();
  try {
    const first = f.raise('첫 카드', 'money', '2026-10-06T10:00:00Z');
    const second = f.raise('둘째 카드', 'security', '2026-10-06T09:00:00Z');
    const handle = createDecideSlashHandler(f.ledger);
    handle([]);
    handle(['1', 'a']);
    expect(handle(['2', 'a', '확인'])).toContain('정말 이것으로 정할까요?');
    expect(handle(['1', 'b', '확인'])).toContain('정말 이것으로 정할까요?');
    expect(f.ledger.list({ status: 'decided' })).toHaveLength(0);
    handle([]);
    expect(handle(['1', 'b', '확인'])).toContain('정말 이것으로 정할까요?');
    expect(f.ledger.list({ status: 'open' }).map((card) => card.id)).toEqual([first.id, second.id]);
  } finally { f.cleanup(); }
});

test('bad number and key provide one-line usable guidance without changing the ledger', () => {
  const f = fixture();
  try {
    f.raise('한 장');
    const handle = createDecideSlashHandler(f.ledger);
    expect(handle(['1'])).toBe('쓸 수 있는 번호: 없음 (/decide 로 목록 열기)');
    handle([]);
    for (const num of ['0', '2', 'xyz', '1.5']) expect(handle([num])).toBe('쓸 수 있는 번호: 1~1');
    for (const args of [['1', 'z'], ['1', 'A'], ['1', 'a', '아니오']]) expect(handle(args)).toBe('쓸 수 있는 선택지 키: a, b');
    expect(f.ledger.list({ status: 'open' })).toHaveLength(1);
  } finally { f.cleanup(); }
});

test('registry dispatch delivers the refreshed open-card list to chat after an answer', async () => {
  const f = fixture();
  try {
    f.raise('남길 카드', 'scope', '2026-10-06T09:00:00Z');
    f.raise('답할 카드', 'scope', '2026-10-06T10:00:00Z');
    const registry = buildDashboardSlashRegistry(undefined, f.ledger);
    const chatLines: string[] = [];
    const ctx = { pushChatLine: (s: string) => chatLines.push(s), setChatScrollOffset: () => {} } as unknown as DashboardSlashContext;
    await registry.dispatch('decide', [], ctx);
    chatLines.length = 0;
    await registry.dispatch('decide', ['1', 'a'], ctx);
    expect(chatLines[0]).toBe('✓ 답할 카드 → 진행');
    expect(chatLines[1]).toMatch(/^1\. 남길 카드 \[a\/b\] · OP · \d+(?:분|시간|일) 전$/);
    expect(chatLines[2]).toBe('답하기: /decide <번호> <선택지 키>');
  } finally { f.cleanup(); }
});

test('registry dispatches /decide and /dec to the chat surface and help lists both', async () => {
  const f = fixture();
  try {
    f.raise('연결');
    const registry = buildDashboardSlashRegistry(undefined, f.ledger);
    const chatLines: string[] = [], debugLines: string[] = [];
    const ctx = { chatLines, pushChatLine: (s: string) => chatLines.push(s), pushDebugLine: (s: string) => debugLines.push(s), setChatScrollOffset: () => {} } as unknown as DashboardSlashContext;
    expect(await registry.dispatch('dec', [], ctx)).toEqual({ kind: 'continue' });
    expect(chatLines[0]).toMatch(/^1\. 연결 \[a\/b\] · OP · \d+(?:분|시간|일) 전$/);
    expect(chatLines[1]).toBe('답하기: /decide <번호> <선택지 키>');
    expect(debugLines).toEqual([]);
    chatLines.length = 0;
    expect(await registry.dispatch('decide', ['1', 'a'], ctx)).toEqual({ kind: 'continue' });
    expect(chatLines).toEqual(['✓ 연결 → 진행', '열린 결정 없음']);
    expect(slashMaturity('dec')).toBe('beta');
    expect(slashVisibleFor('decide', 'owner', { showBeta: false })).toBe(true);
    const help = buildEssentialHelpLines({ names: registry.names(), descriptions: SLASH_COMMANDS, width: 100, audience: { role: 'owner', showBeta: false } }).join('\n');
    expect(help).toContain('/decide (dec)');
  } finally { f.cleanup(); }
});
