import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { openMsgStore } from '../msg/msg-store.js';
import { registerDecisionsCommands } from '../cli/decisions-cli.js';
import { DecisionLedger, type DecisionLedgerOptions, type RaiseInput } from './decision-ledger.js';

const input: RaiseInput = {
  title: '공개 일정', category: 'scope', scqa: { s: '일정 제안이 올라왔다.', c: '승인 전에는 일정이 확정되지 않는다.' },
  options: [{ key: 'a', label: '오늘 발행', consequence: '오늘 공개' }, { key: 'b', label: '연기', consequence: '다음 판 공개' }],
  recommendation: { option: 'b', why: '검증 시간이 필요하다' }, raisedBy: { agent: 'UX', track: 'F' },
};
const options = (stateDir: string): DecisionLedgerOptions => ({ stateDir, now: () => new Date('2026-10-16T04:00:00Z'),
  resolveVersion: () => ({ released: '0.2.30', dev: '0.2.31-dev.0', codename: null }) });

test('decided sends the raised-by seat one durable choice and rationale; retry stays one message', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'decided-notify-'));
  try {
    const ledger = new DecisionLedger(options(stateDir));
    const raised = ledger.raise(input);
    const { entry, notice } = ledger.decideWithDelivery(raised.id, 'a', { kind: 'human' }, '검증 완료');
    expect(entry.status).toBe('decided');
    expect(notice).toMatchObject({ status: 'sent', seat: 'UX' });
    const store = openMsgStore(join(stateDir, 'msg', 'messages.db'));
    try {
      const messages = store.listByRecipient('UX');
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ from: 'OP', to: 'UX', kind: 'info' });
      expect(messages[0]!.body).toContain(`${raised.id} · 공개 일정 · 선택 a: 오늘 발행 · 근거 검증 완료`);
      expect(ledger.retryNotice(raised.id)).toEqual(notice);
      expect(store.listByRecipient('UX')).toHaveLength(1);
    } finally { store.close(); }
    const second = ledger.raise({ ...input, title: '두 번째 결정', raisedBy: { agent: 'UX', track: 'UX' } });
    ledger.decide(second.id, 'b', { kind: 'human' });
    const reopened = openMsgStore(join(stateDir, 'msg', 'messages.db'));
    try { expect(reopened.listByRecipient('UX')).toHaveLength(2); }
    finally { reopened.close(); }
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('untracked decision sends no notice; failed post preserves decision and retry command delivers once', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'decided-notify-'));
  try {
    const plain = new DecisionLedger(options(stateDir));
    const noTrack = plain.raise({ ...input, raisedBy: { agent: 'OP' } });
    expect(plain.decideWithDelivery(noTrack.id, 'b', { kind: 'human' }).notice).toEqual({ status: 'skipped' });
    const failing = new DecisionLedger({ ...options(stateDir), postDecisionNotice: () => { throw new Error('msg unavailable'); } });
    const raised = failing.raise(input);
    expect(failing.decideWithDelivery(raised.id, 'b', { kind: 'human' }).notice).toMatchObject({ status: 'failed', seat: 'UX', reason: 'msg unavailable' });
    expect(failing.show(raised.id).status).toBe('decided');
    const output: string[] = [];
    const program = new Command();
    registerDecisionsCommands(program, options(stateDir), { log: line => output.push(line) });
    program.parse(['decisions', 'retry-notify', raised.id, '--json'], { from: 'user' });
    expect(JSON.parse(output[0]!)).toMatchObject({ status: 'sent', seat: 'UX' });
    const store = openMsgStore(join(stateDir, 'msg', 'messages.db'));
    try {
      const messages = store.listByRecipient('UX');
      expect(messages).toHaveLength(1);
      expect(messages[0]!.body).toContain('선택 b: 연기 · 근거 검증 시간이 필요하다');
    }
    finally { store.close(); }
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
