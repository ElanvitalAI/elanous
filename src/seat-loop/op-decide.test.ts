import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { buildUserConfig } from '../user-config.js';
import { DecisionLedger, type RaiseInput } from '../decisions/decision-ledger.js';
import { judgeOpDecision, OP_DECIDE_AGENT, runOpDecide, scopeOutsideFiles, type OpDecideCandidate } from './op-decide.js';
import { runSeatLoopOnce, seatLedgerPath, type SeatDeps } from './seat-loop.js';

const now = new Date('2026-10-08T03:00:00Z');
const version = () => ({ released: '0.2.19', dev: null, codename: null });

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'op-decide-'));
  const ledger = new DecisionLedger({ stateDir: root, now: () => now, resolveVersion: version });
  return { root, ledger, close: () => rmSync(root, { recursive: true, force: true }) };
};

const repeatCard = (cell = 'ABSORB-FEAS'): RaiseInput => ({
  title: `TC: ${cell} 반복 착지 0`, category: 'other',
  scqa: { s: `TC 칸 ${cell} · 흡수 관문`, c: '발행 직전 밑바탕 재측: yellow; 같은 칸 착지 0', q: '이 칸을 계속할까, 멈출까?', a: '중복 발사를 멈추고 사람의 재개 결정을 기다린다' },
  pendingQuestion: `무엇: TC 칸 ${cell}\n권고: b`,
  options: [{ key: 'a', label: '다시 연다', consequence: '한 번 더 시도' }, { key: 'b', label: '멈춘다', consequence: '다시 발사하지 않는다' }],
  recommendation: { option: 'b', why: '착지 없는 4회 재시도보다 멈추는 편이 중복 실행을 피한다' },
  raisedBy: { agent: 'seat-loop' }, refs: [`seat-loop:TC:checklist%3A0.2.20%3A${cell}`], crossCheckSkipped: '반복 정지는 사람 판단',
});

const scopeCard = (files: string[] | null, runId = 'run-cbf7666b-4ad5-473a-8318-cda7db5e434e'): RaiseInput => {
  const question = 'Implementation changed files outside the authored target paths. Keep the original scope or expand it?';
  return {
    title: question, category: 'scope', scqa: { s: question, c: 'The requesting run is waiting for this choice.' },
    pendingQuestion: `${question}\n\nRecommended: Stay in scope. Continuing would expand the requested scope.${files
      ? `\n\nRun ID: ${runId}\nOutside files:\n${files.map((file) => `- ${file} (declared-path sibling test: no)`).join('\n')}` : ''}`,
    options: [{ key: 'a', label: 'Stay in scope', consequence: 'Do not accept out-of-scope changes.' },
      { key: 'b', label: 'Expand scope', consequence: 'Accept the changed files outside the target paths.' }],
    recommendation: { option: 'a', why: '런이 추천' }, raisedBy: { agent: 'harness' },
    resume: { questionId: `execution:${runId}:e8bb69c1-2b0a-49e8-8bae-ebb7baa3c9d3`, runId },
  };
};

const pass = (ledger: DecisionLedger, mode: 'shadow' | 'live', recorded: OpDecideCandidate[] = []) =>
  runOpDecide({ mode, ledger, recorded: (id) => recorded.filter((row) => row.id === id), record: (row) => recorded.push(row) });

test('repeat-stop card: shadow records only, live decides recommended b with auto actor, delegation and reason', () => {
  const f = fixture();
  const spy = spyOn(debug, 'log');
  try {
    const card = f.ledger.raise(repeatCard());
    const recorded: OpDecideCandidate[] = [];
    expect(pass(f.ledger, 'shadow', recorded)).toEqual([expect.objectContaining({ id: card.id, verdict: 'auto', rule: 'repeat-stop', choice: 'b', mode: 'shadow' })]);
    expect(f.ledger.show(card.id).status).toBe('open');
    expect(pass(f.ledger, 'shadow', recorded)).toEqual([]); // dedup across ticks
    const live = pass(f.ledger, 'live', recorded);
    expect(live).toHaveLength(1);
    const decided = f.ledger.show(card.id);
    expect(decided).toMatchObject({ status: 'decided', choice: 'b', decidedBy: { kind: 'auto', agent: OP_DECIDE_AGENT, track: 'OP' } });
    expect(decided.decidedBy!.kind === 'auto' && decided.decidedBy!.delegation).toContain('10-06 COO 카드 거르기');
    expect(decided.note).toContain('반복 착지 0');
    expect(spy.mock.calls.some(([category, event, data]) => category === 'seat.loop' && event === 'op-decide'
      && (data as { mode?: string }).mode === 'live')).toBe(true);
  } finally { spy.mockRestore(); f.close(); }
});

test('scope card with only test-file outside paths → b; secrets path → not auto (routed to CEO)', () => {
  const f = fixture();
  try {
    const safe = f.ledger.raise(scopeCard(['src/seat-loop/seat-report.test.ts', 'src/flow/cards.test.ts']));
    const secret = f.ledger.raise(scopeCard(['src/foo/bar.test.ts', 'src/secrets/vault.ts'], 'run-11111111-2222-3333-4444-555555555555'));
    expect(scopeOutsideFiles(safe)).toEqual(['src/seat-loop/seat-report.test.ts', 'src/flow/cards.test.ts']);
    const out = pass(f.ledger, 'live');
    expect(out.find((row) => row.id === safe.id)).toMatchObject({ verdict: 'auto', rule: 'scope-expand', choice: 'b' });
    expect(out.find((row) => row.id === secret.id)).toMatchObject({ verdict: 'route', rule: 'scope-sensitive', to: 'CEO' });
    expect(f.ledger.show(safe.id)).toMatchObject({ status: 'decided', choice: 'b' });
    expect(f.ledger.show(secret.id).status).toBe('open');
  } finally { f.close(); }
});

test('scope card without a full outside list is not auto-decided; it goes to the run owner seat when known', () => {
  const f = fixture();
  try {
    const card = f.ledger.raise(scopeCard(null));
    expect(judgeOpDecision(card)).toMatchObject({ verdict: 'route', rule: 'scope-unknown', to: 'CEO' });
    expect(judgeOpDecision(card, () => 'TC')).toMatchObject({ verdict: 'route', to: 'TC' });
    const routed: string[] = [];
    runOpDecide({ mode: 'live', ledger: f.ledger, runOwner: () => 'TC', record: () => {},
      routeToSeat: (to, row) => { routed.push(`${to}:${row.id}`); return true; } });
    expect(routed).toEqual([`TC:${card.id}`]);
    expect(f.ledger.show(card.id).status).toBe('open');
    const hidden = { ...card, pendingQuestion: `${card.pendingQuestion}\n\nOutside files:\n- src/a.ts (declared-path sibling test: no)\n- … 3 more outside file(s) not shown — inspect` };
    expect(scopeOutsideFiles(hidden)).toBeUndefined();
    const trailing = { ...card, pendingQuestion: `${card.pendingQuestion}\n\nOutside files:\n- src/a.test.ts (declared-path sibling test: no)\n\n… 2 more outside file(s) not shown` };
    expect(scopeOutsideFiles(trailing)).toBeUndefined();
    const money = f.ledger.raise(scopeCard(['src/money/ledger.ts'], 'run-22222222-2222-3333-4444-555555555555'));
    expect(judgeOpDecision(money)).toMatchObject({ verdict: 'route', rule: 'scope-sensitive', to: 'CEO' });
  } finally { f.close(); }
});

test('forbidden categories (money · security · secret · publish) and patent words are never auto-decided', () => {
  const f = fixture();
  try {
    const money = f.ledger.raise({ ...repeatCard('BILL-1'), category: 'money', title: 'TC: BILL-1 반복 착지 0' });
    const patent = f.ledger.raise({ ...repeatCard('PATENT-HOLD'), refs: ['seat-loop:TC:patent'], scqa: { ...repeatCard().scqa, s: 'TC 칸 PATENT-HOLD · 특허 출원 준비' } });
    const out = pass(f.ledger, 'live');
    expect(out.find((row) => row.id === money.id)).toMatchObject({ verdict: 'route', rule: 'forbidden', to: 'CEO' });
    expect(out.find((row) => row.id === patent.id)).toMatchObject({ verdict: 'route', rule: 'forbidden', to: 'CEO' });
    expect(f.ledger.list({ status: 'open' }).map((row) => row.id).sort()).toEqual([money.id, patent.id].sort());
  } finally { f.close(); }
});

test('cards outside the filter (no seat-loop/harness shape, no run) are left alone', () => {
  const f = fixture();
  try {
    f.ledger.raise({ title: '홈페이지 문구 결정', category: 'other', scqa: { s: '문구 둘', c: '하나를 고른다' },
      options: [{ key: 'a', label: 'A', consequence: 'A' }, { key: 'b', label: 'B', consequence: 'B' }],
      recommendation: { option: 'a', why: '짧다' }, raisedBy: { agent: 'claude' } });
    expect(pass(f.ledger, 'live')).toEqual([]);
  } finally { f.close(); }
});

test('OP seat turn runs the filter: shadow by default, live via loops.seat.opDecide.mode; a stopped cell stays held', async () => {
  const f = fixture();
  try {
    const card = f.ledger.raise(repeatCard());
    const base: SeatDeps = { root: f.root, repo: f.root, now: () => now, versions: () => [], schedules: () => [],
      checklistItems: () => [], pendingDecisions: () => [], resolveDecisionVersion: version, run: async () => { throw Error('must not run'); } };
    await runSeatLoopOnce('OP', { ...base, config: { mode: 'shadow', seats: ['OP'] } });
    const rows = () => readFileSync(seatLedgerPath('OP', f.root, now), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows().filter((row) => row.candidate?.kind === 'decision-filter')).toEqual([
      expect.objectContaining({ status: 'shadow', candidate: expect.objectContaining({ id: card.id, mode: 'shadow', choice: 'b' }) })]);
    expect(f.ledger.show(card.id).status).toBe('open');
    await runSeatLoopOnce('OP', { ...base, config: { mode: 'shadow', seats: ['OP'], opDecide: { mode: 'live' } } });
    expect(f.ledger.show(card.id)).toMatchObject({ status: 'decided', choice: 'b', decidedBy: { kind: 'auto', agent: OP_DECIDE_AGENT } });
    expect(rows().filter((row) => row.candidate?.kind === 'decision-filter').map((row) => row.status)).toEqual(['shadow', 'resolved']);
  } finally { f.close(); }
});

test('loops.seat.opDecide.mode parses shadow|live only; anything else is absent (= shadow)', () => {
  const f = fixture();
  try {
    const path = join(f.root, 'config.json');
    for (const [mode, expected] of [['live', { mode: 'live' }], ['shadow', { mode: 'shadow' }], ['on', undefined]] as const) {
      writeFileSync(path, JSON.stringify({ loops: { seat: { mode: 'live-safe', opDecide: { mode } } } }));
      expect(buildUserConfig(path).loops?.seat?.opDecide).toEqual(expected);
    }
  } finally { f.close(); }
});

test('scope card touching a release/gate path (release-path SSOT) is not auto — routed to TC via seat question', () => {
  const f = fixture();
  try {
    const card = f.ledger.raise(scopeCard(['src/foo/bar.test.ts', 'scripts/release-loop/gate-node.ts']));
    const graph = f.ledger.raise(scopeCard(['graphs/release/release.yaml'], 'run-33333333-2222-3333-4444-555555555555'));
    const routed: string[] = [];
    const out = runOpDecide({ mode: 'live', ledger: f.ledger, record: () => {},
      routeToSeat: (to, row) => { routed.push(`${to}:${row.id}`); return true; } });
    expect(out.find((row) => row.id === card.id)).toMatchObject({ verdict: 'route', rule: 'scope-release-path', to: 'TC' });
    expect(out.find((row) => row.id === graph.id)).toMatchObject({ verdict: 'route', rule: 'scope-release-path', to: 'TC' });
    expect(routed.sort()).toEqual([`TC:${card.id}`, `TC:${graph.id}`].sort());
    expect(f.ledger.list({ status: 'open' })).toHaveLength(2);
  } finally { f.close(); }
});
