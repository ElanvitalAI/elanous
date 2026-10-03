import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOpsNowProbe, main, type ProbeDeps, type ProbeRow } from './ops-now-probe.js';

let root: string;
const now = new Date('2026-10-02T09:00:00.000Z');
const cut = '2026-10-05T08:30:00.000Z';
const replies = ['0.2.10 컷은 10월 5일 17:30 KST입니다.', '체크리스트 초록은 57개입니다.', '미결 결정은 2개입니다.'];
let sent: Array<{ text: string; kind: string }>;
let printed: string[];
let observed: Array<{ question: string; verdict: string; reason: string | null }>;
let called: string[];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ops-now-probe-')); sent = []; printed = []; observed = []; called = []; });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function deps(answers = replies): ProbeDeps {
  return {
    root, now: () => now, schedules: () => [
      { version: '0.2.11', cutAt: '2026-10-06T00:00:00Z' },
      { version: '0.2.10', cutAt: cut },
    ], published: () => false, cut: () => cut, green: () => 57, open: () => 2,
    memoryUpdatedAt: () => '2026-10-02T08:20:00Z', model: () => 'small-model',
    ask: async (question, model) => { called.push(`${question}|${model}`); return answers[called.length - 1]!; },
    send: ((text: string, kind: string) => { sent.push({ text, kind }); return true; }) as ProbeDeps['send'],
    print: (line) => { printed.push(line); },
    observe: (question, verdict, reason) => { observed.push({ question, verdict, reason }); },
  };
}
function rows(): ProbeRow[] {
  return readFileSync(join(root, 'ops-now-probe', '2026-10-02.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as ProbeRow);
}

test('three standard questions match release schedule, checklist and decisions: three lines, no alert, rc 0', async () => {
  const result = await runOpsNowProbe({}, deps());
  expect(result.exitCode).toBe(0);
  expect(result.rows.map((row) => row.verdict)).toEqual(['match', 'match', 'match']);
  expect(result.rows.map((row) => row.ledgerValue)).toEqual(['2026-10-05T17:30', 57, 2]);
  expect(called).toEqual(['0.2.10 컷 언제야?|small-model', '0.2.10 체크리스트 초록 몇 개야?|small-model', '지금 미결 결정 몇 개야?|small-model']);
  expect(rows()).toEqual(result.rows);
  expect(observed.map((entry) => entry.verdict)).toEqual(['match', 'match', 'match']);
  expect(sent).toHaveLength(0);
});

test('green drift (50 vs 57) gives one mismatch, one ops-alert with memory timestamp, rc 1', async () => {
  const result = await runOpsNowProbe({}, deps([replies[0]!, '초록 50개', replies[2]!]));
  expect(result.exitCode).toBe(1);
  expect(rows().map((r) => r.verdict)).toEqual(['match', 'mismatch', 'match']);
  expect(rows()[1]).toMatchObject({ botValue: 50, ledgerValue: 57, opsNowUpdatedAt: '2026-10-02T08:20:00Z' });
  expect(sent).toHaveLength(1);
  expect(sent[0]!.kind).toBe('ops-alert');
  expect(sent[0]!.text).toContain('봇 50 / 원장 57');
  expect(sent[0]!.text).toContain('2026-10-02T08:20:00Z');
});

test('correction selects asserted count after negation, not the first matching ledger count', async () => {
  const result = await runOpsNowProbe({}, deps([replies[0]!, '초록은 57개가 아니라 50개입니다.', replies[2]!]));
  expect(result.rows[1]).toMatchObject({ verdict: 'mismatch', botValue: 50, ledgerValue: 57 });
  expect(result.exitCode).toBe(1);
  expect(sent).toHaveLength(1);
});

test('open decisions also select the asserted count after correction', async () => {
  const result = await runOpsNowProbe({}, deps([replies[0]!, replies[1]!, '미결 결정은 2건이 아니라 4건입니다.']));
  expect(result.rows[2]).toMatchObject({ verdict: 'mismatch', botValue: 4, ledgerValue: 2 });
  expect(result.exitCode).toBe(1);
  expect(sent).toHaveLength(1);
});

test('correction selects asserted cut datetime after negation', async () => {
  const result = await runOpsNowProbe({}, deps(['컷은 10월 5일 17:30 KST가 아니라 10월 6일 17:30 KST입니다.', replies[1]!, replies[2]!]));
  expect(result.rows[0]).toMatchObject({ verdict: 'mismatch', botValue: '2026-10-06T17:30', ledgerValue: '2026-10-05T17:30' });
  expect(result.exitCode).toBe(1);
  expect(sent).toHaveLength(1);
});

test('a single denied ledger value is unmeasured rather than matched', async () => {
  const result = await runOpsNowProbe({}, deps(['컷은 10월 5일 17:30 KST가 아닙니다.', '초록은 57개가 아닙니다.', replies[2]!]));
  expect(result.rows.slice(0, 2).map((row) => [row.verdict, row.reason, row.botValue])).toEqual([
    ['unmeasured', 'value-ambiguous', null], ['unmeasured', 'value-ambiguous', null],
  ]);
  expect(sent).toHaveLength(0);
});

test('multiple unqualified count or cut candidates are unmeasured, never a false match', async () => {
  const result = await runOpsNowProbe({}, deps(['컷은 10월 5일 17:30 또는 10월 6일 17:30입니다.', '초록은 57개 또는 50개입니다.', replies[2]!]));
  expect(result.rows.slice(0, 2).map((row) => [row.verdict, row.reason, row.botValue])).toEqual([
    ['unmeasured', 'value-ambiguous', null], ['unmeasured', 'value-ambiguous', null],
  ]);
  expect(result.exitCode).toBe(0);
  expect(sent).toHaveLength(0);
});

test('false sender result reports delivery failure, not sent, while preserving mismatch rc and one attempt', async () => {
  const d = deps([replies[0]!, '초록 50개', replies[2]!]);
  let attempts = 0;
  d.send = ((text: string, kind: string) => { attempts++; sent.push({ text, kind }); return false; }) as ProbeDeps['send'];
  const result = await runOpsNowProbe({}, d);
  expect(result.exitCode).toBe(1);
  expect(result.rows.map((row) => row.verdict)).toEqual(['match', 'mismatch', 'match']);
  expect(rows()).toEqual(result.rows);
  expect(attempts).toBe(1);
  expect(sent[0]!.kind).toBe('ops-alert');
  expect(printed.some((line) => line.includes('⚠ ops-alert 전송 실패'))).toBe(true);
  expect(printed.some((line) => line.startsWith('보냈을 것:') || line.startsWith('🚨 ops-now'))).toBe(false);
});

test('throwing sender exposes delivery failure in json without claiming success', async () => {
  const d = deps([replies[0]!, '초록 50개', replies[2]!]);
  let attempts = 0;
  d.send = (() => { attempts++; throw new Error('unavailable'); }) as ProbeDeps['send'];
  const result = await runOpsNowProbe({ json: true }, d);
  const output = JSON.parse(printed[0]!);
  expect(result.exitCode).toBe(1);
  expect(attempts).toBe(1);
  expect(output).toMatchObject({ exitCode: 1, alertDelivery: 'failed', wouldSend: false });
  expect(output.warning).toContain('ops-alert 전송 실패');
  expect(sent).toHaveLength(0);
});

test('even three mismatches send at most one ops-alert', async () => {
  const result = await runOpsNowProbe({}, deps(['10월 6일 17:30 KST', '초록 50개', '미결 결정 4개']));
  expect(result.rows.map((row) => row.verdict)).toEqual(['mismatch', 'mismatch', 'mismatch']);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.text).toContain('미결 결정');
});

test('pending answer is not drift, even when it also contains a number', async () => {
  const result = await runOpsNowProbe({}, deps([replies[0]!, '확인 중입니다. 지금은 50개', replies[2]!]));
  expect(result.rows[1]).toMatchObject({ verdict: 'pending', reason: 'bot-pending', botValue: null });
  expect(result.exitCode).toBe(0);
  expect(sent).toHaveLength(0);
});

test('bot timeout is unmeasured(reason timeout) with warning, no alert', async () => {
  const d = deps(); d.ask = async (q) => { if (q.includes('초록')) throw Error('timeout'); return q.includes('미결') ? replies[2]! : replies[0]!; };
  const result = await runOpsNowProbe({}, d);
  expect(result.rows[1]).toMatchObject({ verdict: 'unmeasured', reason: 'timeout' });
  expect(result.exitCode).toBe(0);
  expect(printed.some((line) => line.startsWith('⚠'))).toBe(true);
  expect(sent).toHaveLength(0);
});

test('unreadable ledger is unmeasured rather than zero; bot is still asked', async () => {
  const d = deps(); d.green = () => { throw Error('unreadable'); };
  const result = await runOpsNowProbe({}, d);
  expect(result.rows[1]).toMatchObject({ verdict: 'unmeasured', reason: 'ledger-unreadable', ledgerValue: null });
  expect(called).toHaveLength(3);
  expect(sent).toHaveLength(0);
});

test('missing schedule version leaves release questions unmeasured, still probes decisions', async () => {
  const d = deps(); d.schedules = () => { throw Error('unreadable'); }; d.ask = async (q) => { called.push(q); return replies[2]!; };
  const result = await runOpsNowProbe({}, d);
  expect(result.rows.map((r) => r.verdict)).toEqual(['unmeasured', 'unmeasured', 'match']);
  expect(result.rows.slice(0, 2).map((r) => r.reason)).toEqual(['ledger-unreadable', 'ledger-unreadable']);
  expect(called).toHaveLength(3);
});

test('dry-run mismatch only prints would-send; json contains wouldSend and rc 1', async () => {
  const result = await runOpsNowProbe({ dryRun: true, json: true, version: '0.2.10' }, deps([replies[0]!, '초록 50개', replies[2]!]));
  expect(result.exitCode).toBe(1);
  expect(sent).toHaveLength(0);
  const output = JSON.parse(printed[0]!);
  expect(output).toMatchObject({ wouldSend: true, exitCode: 1, version: '0.2.10' });
  expect(output.alert).toContain('봇 50 / 원장 57');
  printed = []; called = [];
  await runOpsNowProbe({ dryRun: true, version: '0.2.10' }, deps([replies[0]!, '초록 50개', replies[2]!]));
  expect(printed.some((line) => line.startsWith('보냈을 것:'))).toBe(true);
  expect(sent).toHaveLength(0);
  expect(rows()).toHaveLength(6);
});

test('unparseable reply and empty reply are unmeasured, redacted original truncated to 200', async () => {
  const secret = 'sk-' + 'a'.repeat(35);
  const d = deps([replies[0]!, `숫자는 없습니다. ${secret} ${'x'.repeat(230)}`, '']);
  const result = await runOpsNowProbe({}, d);
  expect(result.rows.map((r) => r.verdict)).toEqual(['match', 'unmeasured', 'unmeasured']);
  expect(result.rows[1]!.reason).toBe('value-unparseable');
  expect(result.rows[2]!.reason).toBe('bot-unresponsive');
  expect(rows()[1]!.botReply).not.toContain(secret);
  expect(result.rows[1]!.botReply!.length).toBeLessThanOrEqual(200);
  expect(sent).toHaveLength(0);
});

test('json warns when only unmeasured answers remain', async () => {
  const d = deps(); d.ask = async (q) => q.includes('초록') ? '' : q.includes('미결') ? replies[2]! : replies[0]!;
  const result = await runOpsNowProbe({ json: true }, d);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(printed[0]!).warning).toContain('⚠');
  expect(sent).toHaveLength(0);
});

test('cut comparison includes date and minute, not merely hour or day', async () => {
  const result = await runOpsNowProbe({}, deps(['컷은 2026년 10월 5일 17시 31분 KST', replies[1]!, replies[2]!]));
  expect(result.rows[0]).toMatchObject({ verdict: 'mismatch', botValue: '2026-10-05T17:31', ledgerValue: '2026-10-05T17:30' });
});

test('hour-only cut never implies minute zero or triggers a drift alert', async () => {
  const result = await runOpsNowProbe({}, deps(['컷은 10월 5일 17시 KST입니다.', replies[1]!, replies[2]!]));
  expect(result.rows[0]).toMatchObject({ verdict: 'unmeasured', reason: 'value-unparseable', botValue: null });
  expect(result.exitCode).toBe(0);
  expect(sent).toHaveLength(0);
});

test('default version selection skips published releases using injected publication status', async () => {
  const d = deps();
  d.published = (version) => version === '0.2.10';
  d.cut = () => '2026-10-06T00:00:00Z';
  d.ask = async (question) => { called.push(question); return question.includes('컷') ? '0.2.11 컷은 10월 6일 09:00 KST입니다.' : question.includes('초록') ? replies[1]! : replies[2]!; };
  const result = await runOpsNowProbe({}, d);
  expect(result.rows.map((row) => row.verdict)).toEqual(['match', 'match', 'match']);
  expect(called.slice(0, 2)).toEqual(['0.2.11 컷 언제야?', '0.2.11 체크리스트 초록 몇 개야?']);
  expect(sent).toHaveLength(0);
});

test('numeric answers and ISO-offset cut are measured without mistaking version for count', async () => {
  const result = await runOpsNowProbe({}, deps(['2026-10-05T17:30:00+09:00', '0.2.10 초록은 57개', '2']));
  expect(result.rows.map((r) => r.verdict)).toEqual(['match', 'match', 'match']);
  expect(sent).toHaveLength(0);
});

test('main refuses non-once and unknown options before any probe effects', async () => {
  expect(main([])).rejects.toThrow('--once 필요');
  expect(main(['--once', '--unknown'])).rejects.toThrow('알 수 없는 옵션');
});

test('green count reads in every word order: «0.2.10 초록 57개» · «57개가 초록» · «초록 57»', async () => {
  for (const reply of ['0.2.10 초록 57개입니다.', '57개가 초록입니다.', '초록 57', '지금 57개 초록이에요.']) {
    called = [];
    const result = await runOpsNowProbe({}, deps([replies[0]!, reply, replies[2]!]));
    expect([reply, result.rows[1]!.verdict, result.rows[1]!.botValue]).toEqual([reply, 'match', 57]);
  }
  expect(sent).toHaveLength(0);
});

test('a number before the label keeps the negation after it: «57개 초록이 아닙니다» is unmeasured, not a match', async () => {
  const result = await runOpsNowProbe({}, deps([replies[0]!, '57개 초록이 아닙니다.', replies[2]!]));
  expect(result.rows[1]).toMatchObject({ verdict: 'unmeasured', botValue: null });
  expect(sent).toHaveLength(0);
});

test('a number that is not a count of the metric (version, no unit) is unmeasured, never a false drift', async () => {
  const result = await runOpsNowProbe({}, deps([replies[0]!, replies[1]!, '미결 결정은 모르겠어요. 버전 10판입니다.']));
  expect(result.rows[2]).toMatchObject({ verdict: 'unmeasured', botValue: null });
  expect(result.exitCode).toBe(0);
  expect(sent).toHaveLength(0);
});

test('«3개, 아니 4개» compares the corrected count 4', async () => {
  const result = await runOpsNowProbe({}, deps([replies[0]!, replies[1]!, '미결 결정 3개, 아니 4개입니다.']));
  expect(result.rows[2]).toMatchObject({ verdict: 'mismatch', botValue: 4, ledgerValue: 2 });
  expect(sent).toHaveLength(1);
});

test('a cut written in UTC is converted to KST; another written zone is not guessed', async () => {
  const utc = await runOpsNowProbe({}, deps(['컷은 10월 5일 08:30 UTC입니다.', replies[1]!, replies[2]!]));
  expect(utc.rows[0]).toMatchObject({ verdict: 'match', botValue: '2026-10-05T17:30' });
  called = [];
  const wrong = await runOpsNowProbe({}, deps(['컷은 10월 5일 17:30 UTC입니다.', replies[1]!, replies[2]!]));
  expect(wrong.rows[0]).toMatchObject({ verdict: 'mismatch', botValue: '2026-10-06T02:30' });
  called = [];
  const pst = await runOpsNowProbe({}, deps(['컷은 10월 5일 17:30 PST입니다.', replies[1]!, replies[2]!]));
  expect(pst.rows[0]).toMatchObject({ verdict: 'unmeasured', botValue: null });
});
