import { expect, setDefaultTimeout, test } from 'bun:test';
import { Command } from 'commander';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatherSeatInputs, runSeatLoopOnce, seatLedgerPath, type SeatDeps } from '../seat-loop/seat-loop.js';
import { answerCrossCheck, askCrossCheck, askSeat, crossCheckAnswer, hasSeatAnswer, seatCrossChecks, seatQuestions } from './seat-questions.js';
import { openMsgStore } from '../msg/msg-store.js';
import { getUserConfig, reloadUserConfig, saveUserConfig } from '../user-config.js';
import { registerDecisionsCommands } from '../cli/decisions-cli.js';
import { DecisionLedger } from '../decisions/decision-ledger.js';

// Several cases spawn the real `decisions raise` CLI — slower than bun's 5 s default on a loaded host.
setDefaultTimeout(60_000);

const now = new Date('2026-10-03T02:00:00Z');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'seat-questions-'));
  mkdirSync(join(root, 'seat-requests'));
  const deps: SeatDeps = { root, repo: root, now: () => now, versions: () => ['0.2.9'],
    schedules: () => [{ version: '0.2.9', cutAt: '2099-01-01T00:00:00Z' }],
    checklistItems: () => [{ id: 'K1', title: '체크리스트', status: 'yellow', owner: 'UX' }] };
  const ledger = (seat: string) => readFileSync(seatLedgerPath(seat, root, now), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  return { root, deps, ledger, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('cross-check messages correlate one answer and do not enter the seat-question channel', () => {
  const f = fixture();
  try {
    const question = askCrossCheck(f.root, 'MK', 'OP', '제목 · S · C · 질문 · 근거', 'xcheck:MK:cell:1');
    expect(askCrossCheck(f.root, 'MK', 'OP', '제목 · S · C · 질문 · 근거', 'xcheck:MK:cell:1').id).toBe(question.id);
    expect(seatCrossChecks(f.root, 'OP')).toMatchObject([{ kind: 'seat-xcheck', from: 'MK', body: question.body }]);
    expect(seatQuestions(f.root, 'OP')).toEqual([]);
    expect(crossCheckAnswer(f.root, question)).toBeNull();
    const answer = { agree: false, note: '화면 문구 미정', resolves: false };
    expect(answerCrossCheck(f.root, question, answer).kind).toBe('seat-xcheck-answer');
    expect(answerCrossCheck(f.root, question, answer).id).toBeGreaterThan(question.id);
    expect(crossCheckAnswer(f.root, question)).toEqual(answer);
    expect(hasSeatAnswer(f.root, question)).toBe(false);
    expect(() => askCrossCheck(f.root, 'MK', 'OP', '다른 초안', 'xcheck:MK:cell:1')).toThrow('changed its recorded message');
  } finally { f.close(); }
});

test('seat question configuration defaults to shadow when not explicitly enabled', () => {
  expect(getUserConfig().loops?.seat?.questions).toBe('shadow');
});

test('question delivery mode is parsed and saved independently of the seat loop mode', () => {
  const f = fixture();
  try {
    const path = join(f.root, 'user-config.json');
    const config = getUserConfig(path);
    config.loops!.seat = { mode: 'on', questions: 'on', seats: ['TC', 'UX'] };
    saveUserConfig(config, path);
    expect(getUserConfig(path).loops?.seat).toMatchObject({ mode: 'on', questions: 'on', seats: ['TC', 'UX'] });
    config.loops!.seat = { mode: 'on', seats: ['TC', 'UX'] };
    saveUserConfig(config, path);
    expect(reloadUserConfig(path).loops?.seat?.questions).toBe('shadow');
  } finally { f.close(); }
});

test('a legacy seat configuration without questions stays shadow when parsed', () => {
  const f = fixture();
  try {
    const path = join(f.root, 'legacy-config.json');
    writeFileSync(path, JSON.stringify({ loops: { seat: { mode: 'on', seats: ['TC', 'UX'] } } }));
    expect(reloadUserConfig(path).loops?.seat).toMatchObject({ mode: 'on', questions: 'shadow', seats: ['TC', 'UX'] });
  } finally { f.close(); }
});

test('TC question → UX next tick answers ahead of checklist → TC inbox has correlated answer', async () => {
  const f = fixture();
  try {
    const tc: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'on', seats: ['TC', 'UX'] },
      versions: () => ['0.2.9'], checklistItems: () => [{ id: 'T1', title: '판단 근거 부족', status: 'yellow', owner: 'TC' }],
      inquire: () => ({ to: 'UX', question: 'UX 근거는?' }) };
    expect((await runSeatLoopOnce('TC', tc)).status).toBe('asked');
    const [question] = seatQuestions(f.root, 'UX');
    expect(question).toMatchObject({ from: 'TC', to: 'UX', body: 'UX 근거는?', kind: 'seat-question' });
    const ux: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'on', seats: ['TC', 'UX'] },
      reply: () => ({ answer: 'UX 시험 근거로 승인' }), run: async () => { throw Error('checklist ran first'); } };
    expect((await gatherSeatInputs('UX', ux)).requests[0]).toMatchObject({ source: 'seat-question', from: 'TC', id: String(question!.id) });
    expect((await runSeatLoopOnce('UX', ux)).status).toBe('answered');
    expect(f.ledger('UX').at(-1).item.source).toBe('seat-question');
    expect(hasSeatAnswer(f.root, question!)).toBe(true);
    const store = openMsgStore(join(f.root, 'msg', 'messages.db'));
    try {
      expect(store.listByRecipient('TC').filter((msg) => msg.kind === 'seat-answer')).toMatchObject([
        { from: 'UX', to: 'TC', body: JSON.stringify({ questionId: question!.id, answer: 'UX 시험 근거로 승인' }) },
      ]);
    } finally { store.close(); }
    expect((await gatherSeatInputs('UX', ux)).requests.some((item) => item.source === 'seat-question')).toBe(false);
    const calls: string[][] = [];
    const next = await runSeatLoopOnce('UX', { ...ux, inquire: () => null, run: async (args) => { calls.push(args); return '{"outcome":"wait-reset"}'; } });
    expect(next.status).toBe('skipped-budget');
    expect(calls).toEqual([['harness', 'budget', '--json']]);
    const after = openMsgStore(join(f.root, 'msg', 'messages.db'));
    try { expect(after.listByRecipient('TC').filter((msg) => msg.kind === 'seat-answer')).toHaveLength(1); }
    finally { after.close(); }
  } finally { f.close(); }
});

test('questions default to shadow: record request and answer but deliver zero messages and zero actions', async () => {
  const f = fixture();
  try {
    const calls: string[][] = [];
    const tc: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['TC', 'UX'] },
      checklistItems: () => [{ id: 'T1', title: '근거 부족', status: 'yellow', owner: 'TC' }],
      inquire: () => ({ to: 'UX', question: '판단 근거?' }), run: async (args) => { calls.push(args); return ''; } };
    expect((await runSeatLoopOnce('TC', tc)).status).toBe('shadow');
    expect(f.ledger('TC')[0]).toMatchObject({ action: 'seat-question', inquiry: { to: 'UX', question: '판단 근거?' } });
    expect(seatQuestions(f.root, 'UX')).toHaveLength(0);
    const incoming = askSeat(f.root, 'TC', 'UX', '기존 질문');
    const ux: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['TC', 'UX'] },
      reply: () => ({ answer: 'UX 검증 결과' }), run: async (args) => { calls.push(args); return ''; } };
    expect((await runSeatLoopOnce('UX', ux)).status).toBe('shadow');
    expect(f.ledger('UX')[0]).toMatchObject({ action: 'seat-answer', answer: 'UX 검증 결과', item: { source: 'seat-question' } });
    expect(hasSeatAnswer(f.root, incoming)).toBe(false);
    expect(calls).toHaveLength(0);
  } finally { f.close(); }
});

test('configured on mode asks from the seat judgment without an injected inquiry', async () => {
  const f = fixture();
  try {
    const calls: string[][] = [];
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'on', seats: ['TC', 'UX'] },
      checklistItems: () => [{ id: 'T1', title: '근거 부족', status: 'yellow', owner: 'TC' }],
      run: async (args) => {
        calls.push(args);
        return JSON.stringify({ reply: JSON.stringify({ to: 'UX', question: '실측 근거?' }) });
      } };
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('asked');
    expect(calls.map((args) => args.slice(0, 3))).toEqual([['agent', '--json', '--no-tools']]);
    expect(seatQuestions(f.root, 'UX')).toMatchObject([{ from: 'TC', body: '실측 근거?' }]);
  } finally { f.close(); }
});

test('the receiving loop answers via its default seat judgment without an injected reply', async () => {
  const f = fixture();
  try {
    const question = askSeat(f.root, 'TC', 'UX', 'UX 근거는?');
    const calls: string[][] = [];
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'on', seats: ['UX'] },
      run: async (args) => {
        calls.push(args);
        return JSON.stringify({ reply: JSON.stringify({ answer: 'UX 검증 기록' }) });
      } };
    expect((await runSeatLoopOnce('UX', deps)).status).toBe('answered');
    expect(calls.map((args) => args.slice(0, 3))).toEqual([['agent', '--json', '--no-tools']]);
    expect(hasSeatAnswer(f.root, question)).toBe(true);
  } finally { f.close(); }
});

test('default UX reply uses UX-owned release evidence to answer TC before acting on its checklist', async () => {
  const f = fixture();
  try {
    const evidence = 'UX 실측: 모달 대비 7.4:1, 스크린리더 순서 확인';
    const tc: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'on', seats: ['TC', 'UX'] },
      checklistItems: () => [{ id: 'TC-A11Y', title: '접근성 판단 근거 부족', status: 'yellow', owner: 'TC' }],
      inquire: () => ({ to: 'UX', question: '접근성 판단 근거를 알려줘' }) };
    expect((await runSeatLoopOnce('TC', tc)).status).toBe('asked');
    const [question] = seatQuestions(f.root, 'UX');
    expect(question).toMatchObject({ from: 'TC', to: 'UX', body: '접근성 판단 근거를 알려줘' });
    const calls: string[][] = [];
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'on', seats: ['UX'] },
      checklistItems: () => [{ id: 'UX-A11Y', title: evidence, status: 'yellow', owner: 'UX' }],
      run: async (args) => {
        calls.push(args);
        if (args.slice(0, 3).join(' ') !== 'agent --json --no-tools') throw Error('checklist acted before reply');
        const match = args[3]?.match(/UX-A11Y[^\n]*UX 실측: 모달 대비 7\.4:1, 스크린리더 순서 확인/);
        if (!match) throw Error('UX-owned release evidence missing from default reply context');
        return JSON.stringify({ reply: JSON.stringify({ answer: match[0] }) });
      } };
    const result = await runSeatLoopOnce('UX', deps);
    expect(result.status).toBe('answered');
    expect(calls).toHaveLength(1);
    const store = openMsgStore(join(f.root, 'msg', 'messages.db'));
    try {
      const answers = store.listByRecipient('TC').filter((message) => message.kind === 'seat-answer');
      expect(answers).toHaveLength(1);
      expect(JSON.parse(answers[0]!.body)).toEqual({ questionId: question!.id, answer: `UX-A11Y · ${evidence}` });
    } finally { store.close(); }
  } finally { f.close(); }
});

test('a shadowed question is delivered once after enabling question delivery', async () => {
  const f = fixture();
  try {
    const base: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['TC', 'UX'] },
      checklistItems: () => [{ id: 'T1', title: '근거 부족', status: 'yellow', owner: 'TC' }],
      inquire: () => ({ to: 'UX', question: '확인 근거?' }) };
    expect((await runSeatLoopOnce('TC', base)).status).toBe('shadow');
    expect(seatQuestions(f.root, 'UX')).toHaveLength(0);
    const live = { ...base, config: { mode: 'on' as const, questions: 'on' as const, seats: ['TC', 'UX'] } };
    expect((await runSeatLoopOnce('TC', live)).status).toBe('asked');
    expect(seatQuestions(f.root, 'UX')).toHaveLength(1);
    expect((await runSeatLoopOnce('TC', live)).status).toBe('skipped-empty');
    expect(seatQuestions(f.root, 'UX')).toHaveLength(1);
  } finally { f.close(); }
});

test('seat-loop shadow remains read-only even if question delivery is configured on', async () => {
  const f = fixture();
  try {
    const deps: SeatDeps = { ...f.deps, config: { mode: 'shadow', questions: 'on', seats: ['TC'] },
      checklistItems: () => [{ id: 'T1', title: '근거 부족', status: 'yellow', owner: 'TC' }],
      inquire: () => ({ to: 'UX', question: '근거?' }), run: async () => { throw Error('shadow ran an action'); } };
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('shadow');
    expect(seatQuestions(f.root, 'UX')).toHaveLength(0);
  } finally { f.close(); }
});

test('configured shadow asks and answers through the seat judgment call without dispatching messages', async () => {
  const f = fixture();
  try {
    const calls: string[][] = [];
    const tc: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'shadow', seats: ['TC', 'UX'] },
      checklistItems: () => [{ id: 'T1', title: '근거 부족', status: 'yellow', owner: 'TC' }],
      run: async (args) => { calls.push(args); return JSON.stringify({ reply: JSON.stringify({ to: 'UX', question: '근거를 알려줘' }) }); } };
    expect((await runSeatLoopOnce('TC', tc)).status).toBe('shadow');
    expect(calls.map((args) => args.slice(0, 3))).toEqual([['agent', '--json', '--no-tools']]);
    expect(f.ledger('TC')[0]).toMatchObject({ action: 'seat-question', inquiry: { to: 'UX', question: '근거를 알려줘' } });
    expect(seatQuestions(f.root, 'UX')).toEqual([]);
    const question = askSeat(f.root, 'TC', 'UX', '어떤 근거?');
    const ux: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'shadow', seats: ['TC', 'UX'] },
      run: async (args) => { calls.push(args); return JSON.stringify({ reply: JSON.stringify({ answer: '검증된 UX 근거' }) }); } };
    expect((await runSeatLoopOnce('UX', ux)).status).toBe('shadow');
    expect(f.ledger('UX')[0]).toMatchObject({ action: 'seat-answer', answer: '검증된 UX 근거' });
    expect(hasSeatAnswer(f.root, question)).toBe(false);
    expect(calls.map((args) => args[0])).toEqual(['agent', 'agent']);
  } finally { f.close(); }
});

test('an OP inbox question precedes OP checklist judgments without changing their shadow-only behavior', async () => {
  const f = fixture();
  try {
    const question = askSeat(f.root, 'TC', 'OP', '판올림 근거?');
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'on', seats: ['OP'] },
      reply: () => ({ answer: 'OP 원장 근거' }), run: async () => { throw Error('unexpected launch'); } };
    expect((await runSeatLoopOnce('OP', deps)).status).toBe('answered');
    expect(hasSeatAnswer(f.root, question)).toBe(true);
    expect(f.ledger('OP').map((entry: { status: string }) => entry.status)).toEqual(['attempting', 'answered']);
    expect((await runSeatLoopOnce('OP', deps)).status).toBe('shadow');
    expect(f.ledger('OP').filter((entry: { status: string }) => entry.status === 'answered')).toHaveLength(1);
  } finally { f.close(); }
});

test('unanswered inbox question stays ahead of checklist and can be answered on a later tick', async () => {
  const f = fixture();
  try {
    const question = askSeat(f.root, 'TC', 'UX', '확인 부탁');
    let answer: string | null = null;
    const calls: string[][] = [];
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'on', seats: ['UX'] },
      reply: () => answer === null ? null : { answer }, run: async (args) => { calls.push(args); throw Error('checklist ran while answer pending'); } };
    expect((await runSeatLoopOnce('UX', deps)).status).toBe('awaiting-answer');
    expect(hasSeatAnswer(f.root, question)).toBe(false);
    expect(calls).toEqual([]);
    answer = '확인 완료';
    expect((await runSeatLoopOnce('UX', deps)).status).toBe('answered');
    expect(hasSeatAnswer(f.root, question)).toBe(true);
    expect(f.ledger('UX').map((row: { status: string }) => row.status)).toEqual(['awaiting-answer', 'attempting', 'answered']);
  } finally { f.close(); }
});

test('an evidence-free receiving seat cannot escalate an unanswered question to the CEO', async () => {
  const f = fixture();
  try {
    const message = askSeat(f.root, 'TC', 'UX', '승인 기준?');
    const calls: string[][] = [];
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'on', seats: ['UX'] },
      reply: () => ({ to: 'CEO', question: '승인 기준을 결정해 주세요' }),
      run: async (args) => { calls.push(args); throw Error('no card without evidence'); } };
    expect((await runSeatLoopOnce('UX', deps)).status).toBe('rejected-no-evidence');
    expect(calls).toEqual([]);
    expect(f.ledger('UX').at(-1)).toMatchObject({ action: 'decision', inquiry: { to: 'CEO' }, item: { id: String(message.id) } });
    expect(hasSeatAnswer(f.root, message)).toBe(false);
    expect((await gatherSeatInputs('UX', deps)).requests.some((item) => item.source === 'seat-question')).toBe(true);
  } finally { f.close(); }
});

test('rejected seat question is retried when the receiving checklist gains evidence', async () => {
  const f = fixture();
  try {
    const question = askSeat(f.root, 'TC', 'UX', '승인 기준?');
    let evidence = '';
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'on', seats: ['UX'] },
      checklistItems: () => [{ id: 'K1', title: '체크리스트', status: 'yellow', owner: 'UX', evidence }],
      reply: () => evidence ? { answer: `검토 근거: ${evidence}` } : { to: 'CEO', question: '승인 기준을 결정해 주세요' },
      run: async () => { throw Error('a rejected question cannot raise a card'); } };
    expect((await runSeatLoopOnce('UX', deps)).status).toBe('rejected-no-evidence');
    expect((await runSeatLoopOnce('UX', deps)).status).toBe('skipped-budget');
    evidence = '체크리스트 검토 기록';
    expect((await runSeatLoopOnce('UX', deps)).status).toBe('answered');
    expect(hasSeatAnswer(f.root, question)).toBe(true);
    expect(f.ledger('UX').at(-1)).toMatchObject({ status: 'answered', answer: '검토 근거: 체크리스트 검토 기록' });
  } finally { f.close(); }
});

test('default receiving judgment sees evidence added after an evidence-free CEO escalation was rejected', async () => {
  const f = fixture();
  try {
    const question = askSeat(f.root, 'TC', 'UX', '승인 기준?');
    let evidence = '';
    const prompts: string[] = [];
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'on', seats: ['UX'] },
      checklistItems: () => [{ id: 'K1', title: '체크리스트', status: 'yellow', owner: 'UX', evidence }],
      run: async (args) => {
        expect(args.slice(0, 3)).toEqual(['agent', '--json', '--no-tools']);
        prompts.push(args[3]!);
        return JSON.stringify({ reply: JSON.stringify(evidence
          ? { answer: `UX 확인: ${evidence}` }
          : { to: 'CEO', question: '승인 근거를 결정해 주세요' }) });
      } };
    expect((await runSeatLoopOnce('UX', deps)).status).toBe('rejected-no-evidence');
    expect(hasSeatAnswer(f.root, question)).toBe(false);
    evidence = '검토 원장 #K1';
    expect((await runSeatLoopOnce('UX', deps)).status).toBe('answered');
    expect(prompts[1]).toContain('근거: 검토 원장 #K1');
    expect(hasSeatAnswer(f.root, question)).toBe(true);
  } finally { f.close(); }
});

test('neighbor resolution proposal for a seat question stays open until its recipient answers from new evidence', async () => {
  const f = fixture();
  try {
    const question = askSeat(f.root, 'TC', 'UX', '승인 기준?');
    let evidence = '초기 검토 기록';
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'on', seats: ['UX'] },
      checklistItems: () => [{ id: 'K1', title: '검토', status: 'yellow', owner: 'UX', evidence }],
      reply: () => evidence === '확정된 검토 기록' ? { answer: evidence } : { to: 'CEO', question: '승인 기준?' },
      run: async () => { throw Error('unresolved question must not raise a card'); } };
    expect((await runSeatLoopOnce('UX', deps)).status).toBe('awaiting-xcheck');
    const request = seatCrossChecks(f.root, 'OP')[0]!;
    answerCrossCheck(f.root, request, { agree: true, note: 'UX가 확인 가능', resolves: true });
    expect((await runSeatLoopOnce('UX', deps)).status).toBe('awaiting-resolution');
    expect(hasSeatAnswer(f.root, question)).toBe(false);
    expect((await runSeatLoopOnce('UX', deps)).status).toBe('skipped-budget');
    evidence = '확정된 검토 기록';
    expect((await runSeatLoopOnce('UX', deps)).status).toBe('answered');
    expect(hasSeatAnswer(f.root, question)).toBe(true);
  } finally { f.close(); }
});

test('a human question in default shadow records a card intent without raising one', async () => {
  const f = fixture();
  try {
    const calls: string[][] = [];
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['TC'] },
      checklistItems: () => [{ id: 'T1', title: '사람 판단', status: 'yellow', owner: 'TC' }],
      inquire: () => ({ to: 'CEO', question: '누가 승인하나요?' }),
      run: async (args) => { calls.push(args); throw Error('shadow raised a decision'); } };
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('shadow');
    expect(f.ledger('TC')[0]).toMatchObject({ action: 'decision', inquiry: { to: 'CEO', question: '누가 승인하나요?' } });
    expect(calls).toEqual([]);
  } finally { f.close(); }
});

test('human escalation command is accepted by the real decisions raise CLI and writes an open card', async () => {
  const f = fixture();
  try {
    const program = new Command();
    const output: string[] = [];
    registerDecisionsCommands(program, { stateDir: f.root }, { log: (line) => { output.push(String(line)); } });
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'on', seats: ['TC'] },
      checklistItems: () => [{ id: 'T1', title: '근거 부족', status: 'yellow', owner: 'TC', evidence: '검토 원장 기록' }],
      inquire: () => ({ to: 'CEO', question: '사람 판단은?' }),
      run: async (args) => {
        output.length = 0;
        program.parse(args, { from: 'user' });
        return output[0]!;
      } };
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('awaiting-xcheck');
    const request = seatCrossChecks(f.root, 'OP')[0]!;
    answerCrossCheck(f.root, request, { agree: true, note: '검토 원장 확인', resolves: false });
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('hitl');
    const raised = JSON.parse(output[0]!) as { status: string; title: string; options: unknown[] };
    expect(raised).toMatchObject({ status: 'open', title: 'TC: 사람 판단은?' });
    expect(raised.options).toHaveLength(2);
    expect(seatQuestions(f.root, 'UX')).toEqual([]);
  } finally { f.close(); }
});

test('failed decisions raise leaves no card and retries the same human question', async () => {
  const f = fixture();
  try {
    const program = new Command();
    const output: string[] = [];
    registerDecisionsCommands(program, { stateDir: f.root }, { log: (line) => { output.push(String(line)); } });
    let fail = true;
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'on', seats: ['TC'] },
      checklistItems: () => [{ id: 'T1', title: '판단 부족', status: 'yellow', owner: 'TC', evidence: '검토 원장 기록' }],
      inquire: () => ({ to: 'CEO', question: '사람 승인?' }),
      run: async (args) => {
        if (fail) { fail = false; throw Error('decisions raise unavailable'); }
        output.length = 0;
        program.parse(args, { from: 'user' });
        return output[0]!;
      } };
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('awaiting-xcheck');
    answerCrossCheck(f.root, seatCrossChecks(f.root, 'OP')[0]!, { agree: true, note: '확인', resolves: false });
    await expect(runSeatLoopOnce('TC', deps)).rejects.toThrow('decisions raise unavailable');
    expect(f.ledger('TC').at(-1).status).toBe('outcome-unknown');
    expect(new DecisionLedger({ stateDir: f.root }).list({ status: 'all' })).toHaveLength(0);
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('hitl');
    expect(new DecisionLedger({ stateDir: f.root }).list({ status: 'all' })).toHaveLength(1);
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('skipped-empty');
  } finally { f.close(); }
});

test('pre-send attempting human decision is retried when no card exists', async () => {
  const f = fixture();
  try {
    const program = new Command();
    const output: string[] = [];
    registerDecisionsCommands(program, { stateDir: f.root }, { log: (line) => { output.push(String(line)); } });
    let interrupt = true;
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'on', seats: ['TC'] },
      checklistItems: () => [{ id: 'T1', title: '사람 검토', status: 'yellow', owner: 'TC', evidence: '검토 원장 기록' }],
      inquire: () => ({ to: 'CEO', question: '승인 근거?' }),
      append: (path, entry) => {
        appendFileSync(path, `${JSON.stringify(entry)}\n`);
        if (interrupt && entry.status === 'attempting') { interrupt = false; throw Error('interrupted before cross-check'); }
      },
      run: async (args) => { output.length = 0; program.parse(args, { from: 'user' }); return output[0]!; } };
    await expect(runSeatLoopOnce('TC', deps)).rejects.toThrow('interrupted before cross-check');
    expect(f.ledger('TC').at(-1).status).toBe('attempting');
    expect(new DecisionLedger({ stateDir: f.root }).list({ status: 'all' })).toHaveLength(0);
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('awaiting-xcheck');
    answerCrossCheck(f.root, seatCrossChecks(f.root, 'OP')[0]!, { agree: true, note: '확인', resolves: false });
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('hitl');
    expect(new DecisionLedger({ stateDir: f.root }).list({ status: 'all' })).toHaveLength(1);
  } finally { f.close(); }
});

test('an evidence-free receiving seat does not launch a decision even on retry', async () => {
  const f = fixture();
  try {
    const question = askSeat(f.root, 'TC', 'UX', '사람 결정 필요?');
    const calls: string[][] = [];
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'on', seats: ['UX'] },
      reply: () => ({ to: 'CEO', question: '사람 승인?' }), inquire: () => null,
      run: async (args) => { calls.push(args); throw Error('no card without evidence'); } };
    expect((await runSeatLoopOnce('UX', deps)).status).toBe('rejected-no-evidence');
    expect((await runSeatLoopOnce('UX', deps)).status).toBe('skipped-budget');
    expect(calls.map((args) => args.slice(0, 2))).not.toContainEqual(['decisions', 'raise']);
    expect(new DecisionLedger({ stateDir: f.root }).list({ status: 'all' })).toHaveLength(0);
    expect((await gatherSeatInputs('UX', deps)).requests.some((item) => item.id === String(question.id))).toBe(true);
  } finally { f.close(); }
});

test('interrupted ordinary human card delivery is reconciled without duplicate raise', async () => {
  const f = fixture();
  try {
    const program = new Command();
    const output: string[] = [];
    registerDecisionsCommands(program, { stateDir: f.root }, { log: (line) => { output.push(String(line)); } });
    let calls = 0;
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'on', seats: ['TC'] },
      checklistItems: () => [{ id: 'T1', title: '사람 판단', status: 'yellow', owner: 'TC', evidence: '검토 원장 기록' }],
      inquire: () => ({ to: 'CEO', question: '승인할까요?' }),
      run: async (args) => {
        calls++;
        output.length = 0;
        program.parse(args, { from: 'user' });
        if (calls === 1) throw Error('interrupted after durable card');
        return output[0]!;
      } };
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('awaiting-xcheck');
    answerCrossCheck(f.root, seatCrossChecks(f.root, 'OP')[0]!, { agree: true, note: '확인', resolves: false });
    await expect(runSeatLoopOnce('TC', deps)).rejects.toThrow('interrupted after durable card');
    expect(f.ledger('TC').at(-1).status).toBe('outcome-unknown');
    expect(new DecisionLedger({ stateDir: f.root }).list({ status: 'all' })).toHaveLength(1);
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('skipped-empty');
    expect(calls).toBe(1);
  } finally { f.close(); }
});

test('a reported decision id without a durable card cannot mark the question handled', async () => {
  const f = fixture();
  try {
    let calls = 0;
    const program = new Command();
    const output: string[] = [];
    registerDecisionsCommands(program, { stateDir: f.root }, { log: (line) => { output.push(String(line)); } });
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'on', seats: ['TC'] },
      checklistItems: () => [{ id: 'T1', title: '승인 보류', status: 'yellow', owner: 'TC', evidence: '검토 원장 기록' }],
      inquire: () => ({ to: 'CEO', question: '승인해도 되나요?' }),
      run: async (args) => {
        calls++;
        if (calls === 1) return '{"id":"D-20261003-99"}';
        output.length = 0;
        program.parse(args, { from: 'user' });
        return output[0]!;
      } };
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('awaiting-xcheck');
    answerCrossCheck(f.root, seatCrossChecks(f.root, 'OP')[0]!, { agree: true, note: '확인', resolves: false });
    await expect(runSeatLoopOnce('TC', deps)).rejects.toThrow('decisions raise did not deliver a matching card');
    expect(new DecisionLedger({ stateDir: f.root }).list({ status: 'all' })).toHaveLength(0);
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('hitl');
    expect(calls).toBe(2);
  } finally { f.close(); }
});

test('failed and interrupted question delivery reconciles inbox and retries once', async () => {
  const f = fixture();
  try {
    const base: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'on', seats: ['TC'] },
      checklistItems: () => [{ id: 'T1', title: '근거 부족', status: 'yellow', owner: 'TC' }],
      inquire: () => ({ to: 'UX', question: '재시도 질문' }) };
    let fail = true;
    const deps: SeatDeps = { ...base, append: (path, entry) => {
      if (fail && entry.status === 'asked') { fail = false; throw Error('interrupted after delivery'); }
      appendFileSync(path, `${JSON.stringify(entry)}\n`);
    } };
    await expect(runSeatLoopOnce('TC', deps)).rejects.toThrow('interrupted after delivery');
    expect(f.ledger('TC').at(-1).status).toBe('outcome-unknown');
    expect(seatQuestions(f.root, 'UX')).toHaveLength(1);
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('asked');
    expect(seatQuestions(f.root, 'UX')).toHaveLength(1);
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('skipped-empty');
  } finally { f.close(); }
});

test('a pre-send attempting and failed send do not suppress a later question', async () => {
  const f = fixture();
  try {
    const base: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'on', seats: ['TC'] },
      checklistItems: () => [{ id: 'T1', title: '근거 부족', status: 'yellow', owner: 'TC' }],
      inquire: () => ({ to: 'UX', question: '재시도 질문' }) };
    let fail = true;
    const deps: SeatDeps = { ...base, append: (path, entry) => {
      appendFileSync(path, `${JSON.stringify(entry)}\n`);
      if (fail && entry.status === 'attempting') { fail = false; throw Error('interrupted before delivery'); }
    } };
    await expect(runSeatLoopOnce('TC', deps)).rejects.toThrow('interrupted before delivery');
    expect(seatQuestions(f.root, 'UX')).toHaveLength(0);
    expect((await runSeatLoopOnce('TC', base)).status).toBe('asked');
    expect(seatQuestions(f.root, 'UX')).toHaveLength(1);
  } finally { f.close(); }
});

test('a failed inbox write is retried instead of treating outcome-unknown as delivered', async () => {
  const f = fixture();
  try {
    const store = openMsgStore(join(f.root, 'msg', 'messages.db'));
    try { store.db.exec(`CREATE TRIGGER block_seat_question BEFORE INSERT ON msg_messages
      WHEN NEW.kind = 'seat-question' BEGIN SELECT RAISE(ABORT, 'inbox unavailable'); END`); }
    finally { store.close(); }
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'on', seats: ['TC'] },
      checklistItems: () => [{ id: 'T1', title: '근거 부족', status: 'yellow', owner: 'TC' }],
      inquire: () => ({ to: 'UX', question: '저장 후 재시도?' }) };
    await expect(runSeatLoopOnce('TC', deps)).rejects.toThrow('inbox unavailable');
    expect(f.ledger('TC').at(-1).status).toBe('outcome-unknown');
    expect(seatQuestions(f.root, 'UX')).toHaveLength(0);
    const recovered = openMsgStore(join(f.root, 'msg', 'messages.db'));
    try { recovered.db.exec('DROP TRIGGER block_seat_question'); }
    finally { recovered.close(); }
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('asked');
    expect(seatQuestions(f.root, 'UX')).toHaveLength(1);
  } finally { f.close(); }
});

test('a failed answer write remains pending and is retried on the next tick', async () => {
  const f = fixture();
  try {
    const question = askSeat(f.root, 'TC', 'UX', '답변 실패 후 재시도?');
    const store = openMsgStore(join(f.root, 'msg', 'messages.db'));
    try { store.db.exec(`CREATE TRIGGER block_seat_answer BEFORE INSERT ON msg_messages
      WHEN NEW.kind = 'seat-answer' BEGIN SELECT RAISE(ABORT, 'answer inbox unavailable'); END`); }
    finally { store.close(); }
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'on', seats: ['UX'] },
      reply: () => ({ answer: '검증 답변' }) };
    await expect(runSeatLoopOnce('UX', deps)).rejects.toThrow('answer inbox unavailable');
    expect(f.ledger('UX').at(-1).status).toBe('outcome-unknown');
    expect(hasSeatAnswer(f.root, question)).toBe(false);
    const recovered = openMsgStore(join(f.root, 'msg', 'messages.db'));
    try { recovered.db.exec('DROP TRIGGER block_seat_answer'); }
    finally { recovered.close(); }
    expect((await runSeatLoopOnce('UX', deps)).status).toBe('answered');
    expect(hasSeatAnswer(f.root, question)).toBe(true);
  } finally { f.close(); }
});

test('interrupted reply reconciles the answer inbox without duplicate delivery', async () => {
  const f = fixture();
  try {
    const question = askSeat(f.root, 'TC', 'UX', '답변 재시도?');
    let fail = true;
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'on', seats: ['UX'] },
      reply: () => ({ answer: '근거 확인' }), append: (path, entry) => {
        if (fail && entry.status === 'answered') { fail = false; throw Error('interrupted after answer'); }
        appendFileSync(path, `${JSON.stringify(entry)}\n`);
      } };
    await expect(runSeatLoopOnce('UX', deps)).rejects.toThrow('interrupted after answer');
    expect(hasSeatAnswer(f.root, question)).toBe(true);
    const next = await gatherSeatInputs('UX', deps);
    expect(next.requests.filter((item) => item.source === 'seat-question')).toHaveLength(0);
    const store = openMsgStore(join(f.root, 'msg', 'messages.db'));
    try { expect(store.listByRecipient('TC').filter((msg) => msg.kind === 'seat-answer')).toHaveLength(1); }
    finally { store.close(); }
  } finally { f.close(); }
});

test('a receiving seat cannot lose the original question by returning another-seat inquiry', async () => {
  const f = fixture();
  try {
    const question = askSeat(f.root, 'TC', 'UX', '원 질문');
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'on', seats: ['UX'] },
      reply: (() => ({ to: 'MK', question: '재질문' })) as unknown as SeatDeps['reply'] };
    await expect(runSeatLoopOnce('UX', deps)).rejects.toThrow('seat reply may only answer or escalate to CEO');
    expect(seatQuestions(f.root, 'MK')).toHaveLength(0);
    expect(hasSeatAnswer(f.root, question)).toBe(false);
    expect((await gatherSeatInputs('UX', deps)).requests[0]?.id).toBe(String(question.id));
  } finally { f.close(); }
});

test('a person question uses the existing decisions raise card, never a seat message', async () => {
  const f = fixture();
  try {
    const calls: string[][] = [];
    const program = new Command();
    const output: string[] = [];
    registerDecisionsCommands(program, { stateDir: f.root }, { log: (line) => { output.push(String(line)); } });
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'on', seats: ['TC'] },
      checklistItems: () => [{ id: 'T1', title: '근거 부족', status: 'yellow', owner: 'TC', evidence: '검토 원장 기록' }],
      inquire: () => ({ to: 'CEO', question: '사람 판단은?' }),
      run: async (args) => { calls.push(args); output.length = 0; program.parse(args, { from: 'user' }); return output[0]!; } };
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('awaiting-xcheck');
    answerCrossCheck(f.root, seatCrossChecks(f.root, 'OP')[0]!, { agree: true, note: '확인', resolves: false });
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('hitl');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 2)).toEqual(['decisions', 'raise']);
    expect(calls[0]![calls[0]!.indexOf('--title') + 1]).toBe('TC: 사람 판단은?');
    expect(new DecisionLedger({ stateDir: f.root }).list({ status: 'all' })).toHaveLength(1);
    expect(seatQuestions(f.root, 'UX')).toHaveLength(0);
  } finally { f.close(); }
});

test('a shadow seat loop with default question settings never calls the model and still records shadow', async () => {
  const f = fixture();
  try {
    let runs = 0;
    const deps: SeatDeps = { ...f.deps, config: { mode: 'shadow', questions: 'shadow', seats: ['TC'] },
      checklistItems: () => [{ id: 'T1', title: '근거 부족', status: 'yellow', owner: 'TC' }],
      run: async () => { runs += 1; throw Error('shadow must not call the model'); } };
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('shadow');
    expect(runs).toBe(0);
    expect(f.ledger('TC')[0]).toMatchObject({ status: 'shadow', item: { id: 'T1' } });
    expect(seatQuestions(f.root, 'UX')).toEqual([]);
  } finally { f.close(); }
});

test('a failing default judgment call falls back to no question instead of breaking the turn', async () => {
  const f = fixture();
  try {
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'shadow', seats: ['TC'] },
      checklistItems: () => [{ id: 'T1', title: '근거 부족', status: 'yellow', owner: 'TC' }],
      run: async (args) => { if (args[0] === 'agent') throw Error('model down'); return JSON.stringify({ runId: 'r1' }); } };
    const result = await runSeatLoopOnce('TC', deps);
    expect(result.status).not.toBe('asked');
    expect(seatQuestions(f.root, 'UX')).toEqual([]);
  } finally { f.close(); }
});
