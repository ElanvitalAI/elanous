import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerLessonCommands } from '../cli/lesson-cli.js';
import { FrictionLedger, type FrictionKind } from './friction-ledger.js';
import { LessonLedger } from './lesson-ledger.js';

const root = () => realpathSync(mkdtempSync(join(tmpdir(), 'lessons-friction-')));

test('three occurrences of one hand step are a candidate, two are not', () => {
  const stateDir = root();
  const clock = { at: '2026-10-26T09:00:00Z' };
  const ledger = new FrictionLedger({ stateDir, now: () => new Date(clock.at) });
  try {
    expect(ledger.path).toBe(join(stateDir, 'lessons', 'friction.sqlite'));
    expect(ledger.candidates()).toEqual([]);
    expect(ledger.record({ actor: 'OP', kind: 'hand-step', signature: 'restart the flaky ledger gate', note: 'first', ref: 'PR#1' }))
      .toMatchObject({ actor: 'OP', kind: 'hand-step', signature: 'restart the flaky ledger gate', note: 'first', ref: 'PR#1', recorded_at: '2026-10-26T09:00:00.000Z' });
    clock.at = '2026-10-26T09:30:00Z';
    ledger.record({ actor: 'TC', kind: 'hand-step', signature: 'restart the flaky ledger gate', ref: 'PR#2' });
    expect(ledger.candidates()).toEqual([]);
    clock.at = '2026-10-26T10:00:00Z';
    ledger.record({ actor: 'MK', kind: 'hand-step', signature: 'restart the flaky ledger gate', ref: 'PR#3' });
    expect(ledger.candidates()).toEqual([{ kind: 'hand-step', signature: 'restart the flaky ledger gate', count: 3,
      firstAt: '2026-10-26T09:00:00.000Z', lastAt: '2026-10-26T10:00:00.000Z', refs: ['PR#1', 'PR#2', 'PR#3'] }]);
    expect(ledger.candidates(4)).toEqual([]);
    ledger.record({ actor: 'ceo', kind: 'ceo-correction', signature: 'restart the flaky ledger gate', ref: 'channel/9' });
    expect(ledger.candidates().map(row => [row.kind, row.count])).toEqual([['hand-step', 3]]);
    expect(() => ledger.record({ actor: 'nobody' as 'OP', kind: 'hand-step', signature: 'x', ref: 'y' })).toThrow('actor must be one of');
    expect(() => ledger.record({ actor: 'OP', kind: 'promotion' as FrictionKind, signature: 'x', ref: 'y' })).toThrow('kind must be one of');
    expect(() => ledger.record({ actor: 'OP', kind: 'hand-step', signature: '   ', ref: 'y' })).toThrow('signature is required');
    expect(() => ledger.record({ actor: 'OP', kind: 'hand-step', signature: 'x', ref: ' ' })).toThrow('ref is required');
    expect(() => ledger.candidates(0)).toThrow('min must be a positive integer');
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('signatures that differ only in case or whitespace fold into one candidate', () => {
  const stateDir = root();
  const ledger = new FrictionLedger({ stateDir, now: () => new Date('2026-10-26T11:00:00Z') });
  try {
    ledger.record({ actor: 'UX', kind: 'repeat-question', signature: 'Install  REDIS', ref: 'msg/1' });
    ledger.record({ actor: 'person', kind: 'repeat-question', signature: 'install redis', ref: 'msg/2' });
    ledger.record({ actor: 'OP', kind: 'repeat-question', signature: '  INSTALL\tredis ', ref: 'msg/3' });
    expect(ledger.candidates(3)).toEqual([{ kind: 'repeat-question', signature: 'install redis', count: 3,
      firstAt: '2026-10-26T11:00:00.000Z', lastAt: '2026-10-26T11:00:00.000Z', refs: ['msg/1', 'msg/2', 'msg/3'] }]);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('a secret-shaped note is rejected and never stored', () => {
  const stateDir = root();
  const ledger = new FrictionLedger({ stateDir, now: () => new Date('2026-10-26T12:00:00Z') });
  const secrets = ['sk-liveabcdefghijkl', 'ghp_ABCDEFGH1234', 'AKIAIOSFODNN7EXAMPLE', 'xoxb-1234567890-abcdef',
    '-----BEGIN OPENSSH PRIVATE KEY-----', 'deadbeefdeadbeefdeadbeefdeadbeef', 'api_key=supersecretvalue'];
  try {
    for (const note of secrets) {
      expect(() => ledger.record({ actor: 'person', kind: 'hand-step', signature: 'paste the token', note, ref: 'chat/7' }))
        .toThrow('note looks like a secret');
    }
    expect(ledger.candidates(1)).toEqual([]);
    expect(ledger.record({ actor: 'person', kind: 'hand-step', signature: 'paste the token', note: 'see the ops manual', ref: 'chat/8' }))
      .toMatchObject({ note: 'see the ops manual', ref: 'chat/8' });
    expect(ledger.candidates(1).map(row => row.refs)).toEqual([['chat/8']]);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('two instances alternate writes without losing rows', () => {
  const stateDir = root();
  const a = new FrictionLedger({ stateDir });
  const b = new FrictionLedger({ stateDir });
  try {
    a.record({ actor: 'OP', kind: 'hand-step', signature: 're-run the flaky gate', ref: 'PR#1' });
    b.record({ actor: 'TC', kind: 'hand-step', signature: 're-run the flaky gate', ref: 'PR#2' });
    b.record({ actor: 'UX', kind: 'repeat-question', signature: 'where is the ledger', ref: 'msg/1' });
    a.record({ actor: 'MK', kind: 'hand-step', signature: 're-run the flaky gate', ref: 'PR#3' });
    expect(a.candidates().map(row => [row.kind, row.count, row.refs]))
      .toEqual([['hand-step', 3, ['PR#1', 'PR#2', 'PR#3']]]);
    expect(b.candidates(1).length).toBe(2);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('the production lesson recur command feeds the friction ledger', async () => {
  const stateDir = root();
  const clock = { at: '2026-10-26T13:00:00Z' };
  const now = () => new Date(clock.at);
  const printed: string[] = [];
  const run = async (args: string[]) => {
    const program = new Command();
    program.exitOverride();
    registerLessonCommands(program, { stateDir, now }, { log: (line: string) => printed.push(String(line)) });
    await program.parseAsync(['lesson', ...args], { from: 'user' });
  };
  try {
    new LessonLedger({ stateDir, now }).add({ id: 'L1', incident: 'Worktree state changed unexpectedly',
      cause: 'Shared state', remedy: 'Isolate the state directory', owner: 'TC', source: 'docs/INCIDENT.md' });
    for (const source of ['PR#2', 'PR#3', 'PR#4']) {
      clock.at = `2026-10-26T13:0${source.slice(-1)}:00Z`;
      await run(['recur', 'L1', '--source', source, '--note', 'again', '--by', 'TC']);
    }
    expect(printed).toHaveLength(3);
    expect(new LessonLedger({ stateDir, now }).get('L1').occurrence_count).toBe(4);
    expect(new FrictionLedger({ stateDir, now }).candidates()).toEqual([{ kind: 'hand-step',
      signature: 'worktree state changed unexpectedly', count: 3, firstAt: '2026-10-26T13:02:00.000Z',
      lastAt: '2026-10-26T13:04:00.000Z', refs: ['PR#2', 'PR#3', 'PR#4'] }]);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
