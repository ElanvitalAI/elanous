import { test, expect } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPendingQuestion, writePendingQuestion } from '../ask-user-question/pending-questions.js';
import { registerDecisionsCommands } from './decisions-cli.js';

const root = () => mkdtempSync(join(tmpdir(), 'decisions-cli-'));
test('CLI raises, filters, shows and records human/AUTO decisions; validation errors do not append', () => {
  const stateDir = root();
  const lines: string[] = [];
  const program = new Command();
  registerDecisionsCommands(program, { stateDir, releaseRoot: join(stateDir, 'missing'), repoRoot: join(stateDir, 'missing') }, { log: s => lines.push(s) });
  const run = (...args: string[]) => { lines.length = 0; program.parse(['decisions', ...args], { from: 'user' }); return lines[0]!; };
  const raise = ['raise', '--agent', 'codex', '--title', 'Publish?', '--category', 'publish', '--s', 'Draft exists.', '--c', 'Decision needed.', '--option', 'a=Publish:Public', '--option', 'b=Hold:Private', '--skip-recommend', 'Research takes time', '--json'];
  const entry = JSON.parse(run(...raise));
  expect(entry.id).toMatch(/^D-\d{8}-01$/);
  expect(JSON.parse(run('list', '--json'))).toHaveLength(1);
  expect(run('list')).toContain('권고 생략');
  expect(run('show', entry.id)).toContain('선택지 | 결과');
  expect(() => run('decide', entry.id, 'b', '--auto')).toThrow('delegation');
  expect(JSON.parse(run('decide', entry.id, 'b', '--auto', '--agent', 'codex', '--delegation', '대표 S 위임', '--json')).decidedBy).toMatchObject({ kind: 'auto', agent: 'codex' });
  expect(JSON.parse(run('list', '--status', 'decided', '--decided-by', 'auto', '--json'))).toHaveLength(1);
  expect(() => run('raise', ...raise.slice(1, -3), '--skip-recommend', ' ', '--json')).toThrow();
  expect(readFileSync(join(stateDir, 'decisions', 'decisions.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
});

test('CLI resume flags round-trip and decide invokes the injected writer; run alone and unsafe id fail in one line', () => {
  const stateDir = root();
  const lines: string[] = [];
  const calls: unknown[] = [];
  const program = new Command();
  registerDecisionsCommands(program, { stateDir, resolveVersion: () => ({ released: null, dev: null, codename: null }),
    writeAnswer: answer => { calls.push(answer); } }, { log: value => lines.push(value) });
  const run = (...args: string[]) => { lines.length = 0; program.parse(['decisions', ...args], { from: 'user' }); return lines[0]!; };
  const flags = ['raise', '--agent', 'codex', '--title', 'Publish?', '--category', 'publish', '--s', 'Draft.', '--c', 'Decision.',
    '--option', 'a=Publish:Public', '--option', 'b=Hold:Private', '--skip-recommend', 'Unknown', '--json'];
  expect(() => run(...flags, '--run', 'run-x')).toThrow('decisions: --run requires --resume-question');
  expect(() => run(...flags, '--resume-question', '../x')).toThrow('decisions: invalid resume questionId');
  expect(lines).toEqual([]);
  writePendingQuestion(createPendingQuestion('auq:q1:abcde', { questions: [{ id: 'scope_choice', header: 'Scope', question: 'Choose.', options: [
    { label: 'Publish', description: 'Now' }, { label: 'Hold', description: 'Later' },
  ] }] }, undefined, {}, { surface: 'file', delivery: 'file', expiresAt: '2099-10-01T01:00:00.000Z' }), { root: () => stateDir });
  const entry = JSON.parse(run(...flags, '--resume-question', 'auq:q1:abcde', '--run', 'run-x'));
  expect(entry.resume).toEqual({ questionId: 'auq:q1:abcde', runId: 'run-x' });
  expect(JSON.parse(run('show', entry.id, '--json')).resume).toEqual(entry.resume);
  expect(JSON.parse(run('decide', entry.id, 'a', '--json')).status).toBe('decided');
  expect(calls).toEqual([{ id: 'auq:q1:abcde', result: { answers: { scope_choice: 'a) Publish' } } }]);
  expect(readFileSync(join(stateDir, 'decisions', 'decisions.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
});

test('CLI reports durable decision with failed delivery and can retry only the answer after recovery', () => {
  const stateDir = root();
  const lines: string[] = [];
  const calls: unknown[] = [];
  let available = false;
  const program = new Command();
  registerDecisionsCommands(program, { stateDir, resolveVersion: () => ({ released: null, dev: null, codename: null }),
    writeAnswer: answer => { if (!available) throw new Error('temporary'); calls.push(answer); } }, { log: value => lines.push(value) });
  const run = (...args: string[]) => { lines.length = 0; program.parse(['decisions', ...args], { from: 'user' }); return lines[0]!; };
  const entry = JSON.parse(run('raise', '--agent', 'codex', '--title', 'Publish?', '--category', 'publish', '--s', 'Draft.', '--c', 'Decision.',
    '--option', 'a=Publish:Public', '--option', 'b=Hold:Private', '--skip-recommend', 'Unknown', '--resume-question', 'auq:q1:abcde', '--json'));
  writePendingQuestion(createPendingQuestion('auq:q1:abcde', { questions: [{ id: 'scope_choice', header: 'Scope', question: 'Choose.', options: [
    { label: 'Publish', description: 'Now' }, { label: 'Hold', description: 'Later' },
  ] }] }, undefined, {}, { surface: 'file', delivery: 'file', expiresAt: '2099-10-01T01:00:00.000Z' }), { root: () => stateDir });
  const exitBefore = process.exitCode;
  const decided = run('decide', entry.id, 'a', '--note', 'Private memo');
  expect(decided).toContain('결정:');
  expect(decided).toContain('⚠ 답 전달 실패(auq:q1:abcde');
  expect(decided).toContain(`elanous decisions retry-answer ${entry.id}`);
  expect(process.exitCode).toBe(3);
  process.exitCode = exitBefore;
  const events = readFileSync(join(stateDir, 'decisions', 'decisions.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  expect(events.at(-1)).toMatchObject({ type: 'decided', id: entry.id, choice: 'a' });
  expect(JSON.parse(run('show', entry.id, '--json'))).toMatchObject({ status: 'decided', choice: 'a', note: 'Private memo' });
  available = true;
  expect(JSON.parse(run('retry-answer', entry.id, '--json')).status).toBe('decided');
  expect(calls).toEqual([{ id: 'auq:q1:abcde', result: { answers: { scope_choice: 'a) Publish' }, otherText: { scope_choice: 'Private memo' } } }]);
  expect(readFileSync(join(stateDir, 'decisions', 'decisions.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
});

test('unknown actor is never silently attributed to elanous; historical options can be supplied through CLI', () => {
  const stateDir = root();
  const lines: string[] = [];
  const program = new Command();
  registerDecisionsCommands(program, { stateDir, resolveVersion: () => ({ released: '0.2.5', dev: '0.2.6-dev.0', codename: null }) }, { log: s => lines.push(s) });
  const run = (...args: string[]) => { lines.length = 0; program.parse(['decisions', ...args], { from: 'user' }); return lines[0]!; };
  const oldAgent = process.env.AI_AGENT;
  try {
    delete process.env.AI_AGENT;
    expect(() => run('raise', '--title', 'Publish?', '--category', 'publish', '--s', 'Draft.', '--c', 'Decision.', '--option', 'a=Publish:Public', '--option', 'b=Hold:Private', '--skip-recommend', 'Unclear')).toThrow('agent unknown');
    expect(() => readFileSync(join(stateDir, 'decisions', 'decisions.jsonl'))).toThrow();
    const { DecisionLedger } = require('../decisions/decision-ledger.js') as typeof import('../decisions/decision-ledger.js');
    const normal = new DecisionLedger({ stateDir, resolveVersion: () => ({ released: null, dev: null, codename: null }) }).raise({ title: 'Normal', category: 'scope', scqa: { s: 'Draft.', c: 'Choice.' }, options: [{ key: 'a', label: 'Yes', consequence: 'Proceed' }, { key: 'b', label: 'No', consequence: 'Hold' }], recommendation: { skipped: true, reason: 'Unknown' }, raisedBy: { agent: 'codex' } });
    expect(() => run('decide', normal.id, 'a', '--auto', '--delegation', 'Delegated', '--json')).toThrow('agent unknown');
    expect(run('show', normal.id)).toContain('codex');
    const item = new DecisionLedger({ stateDir }).importPending({ title: 'Historical', category: 'scope', scqa: { s: 'Original request.', c: 'No options recorded.' }, options: [], recommendation: { skipped: true, reason: 'Unknown' }, raisedBy: { agent: 'codex' }, refs: ['historical#H1'] });
    expect(() => run('add-options', item.id, '--option', 'a=Approve:Proceed', '--option', 'b=Decline:Stop')).toThrow('agent unknown');
    expect(JSON.parse(run('add-options', item.id, '--agent', 'codex', '--option', 'a=Approve:Proceed', '--option', 'b=Decline:Stop', '--json')).options).toHaveLength(2);
    expect(JSON.parse(run('decide', item.id, 'a', '--json')).choice).toBe('a');
  } finally { if (oldAgent === undefined) delete process.env.AI_AGENT; else process.env.AI_AGENT = oldAgent; }
});

test('actual CLI child reads an item raised in an isolated state directory', () => {
  const stateDir = root();
  const raise = spawnSync('bun', ['bin/elanous.mjs', `--test=${stateDir}`, 'decisions', 'raise', '--agent', 'codex', '--title', 'CLI child decision', '--category', 'scope', '--s', 'Scope requested.', '--c', 'Choice required.', '--option', 'a=Accept:Expands scope', '--option', 'b=Decline:Keeps scope', '--skip-recommend', 'Needs investigation', '--resume-question', 'auq:q1:abcde', '--run', 'run-x', '--json'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 240000,
  });
  expect(raise.status, raise.stderr.slice(0, 500)).toBe(0);
  const id = JSON.parse(raise.stdout.trim()).id;
  writePendingQuestion(createPendingQuestion('auq:q1:abcde', { questions: [{ id: 'scope_choice', header: 'Scope', question: 'Choose.', options: [
    { label: 'Accept', description: 'Expand' }, { label: 'Decline', description: 'Keep' },
  ] }] }, undefined, {}, { surface: 'file', delivery: 'file', expiresAt: '2099-10-01T01:00:00.000Z' }), { root: () => stateDir });
  expect(readFileSync(join(stateDir, 'decisions', 'decisions.jsonl'), 'utf8')).toContain(id);
  const decided = spawnSync('bun', ['bin/elanous.mjs', `--test=${stateDir}`, 'decisions', 'decide', id, 'a', '--json'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 240000,
  });
  expect(decided.status, decided.stderr.slice(0, 500)).toBe(0);
  expect(JSON.parse(readFileSync(join(stateDir, 'ask-user-question', 'answers', `${encodeURIComponent('auq:q1:abcde')}.json`), 'utf8'))).toEqual({
    id: 'auq:q1:abcde', result: { answers: { scope_choice: 'a) Accept' } },
  });
  const result = spawnSync('bun', ['bin/elanous.mjs', `--test=${stateDir}`, 'decisions', 'list', '--status', 'all', '--json'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 240000,
  });
  expect(result.status, result.stderr.slice(0, 500)).toBe(0);
  expect(JSON.parse(result.stdout.trim()).map((entry: { id: string }) => entry.id)).toContain(id);
  const failedRaise = spawnSync('bun', ['bin/elanous.mjs', `--test=${stateDir}`, 'decisions', 'raise', '--agent', 'codex', '--title', 'Late question', '--category', 'scope', '--s', 'Draft.', '--c', 'Choice.', '--option', 'a=Accept:Proceed', '--option', 'b=Decline:Wait', '--skip-recommend', 'Unknown', '--resume-question', 'auq:lateq:abcde', '--json'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 240000,
  });
  expect(failedRaise.status, failedRaise.stderr.slice(0, 500)).toBe(0);
  const lateId = JSON.parse(failedRaise.stdout.trim()).id;
  const failedDecide = spawnSync('bun', ['bin/elanous.mjs', `--test=${stateDir}`, 'decisions', 'decide', lateId, 'b'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 240000,
  });
  // Recorded but not delivered: exit 3 with the failure and the retry command, never a silent success.
  expect(failedDecide.status, failedDecide.stderr.slice(0, 500)).toBe(3);
  expect(failedDecide.stdout).toContain(`elanous decisions retry-answer ${lateId}`);
  expect(readFileSync(join(stateDir, 'decisions', 'decisions.jsonl'), 'utf8')).toContain(`"type":"decided","id":"${lateId}"`);
  writePendingQuestion(createPendingQuestion('auq:lateq:abcde', { questions: [{ id: 'late_choice', header: 'Scope', question: 'Choose.', options: [
    { label: 'Accept', description: 'Proceed' }, { label: 'Decline', description: 'Wait' },
  ] }] }, undefined, {}, { surface: 'file', delivery: 'file', expiresAt: '2099-10-01T01:00:00.000Z' }), { root: () => stateDir });
  const retried = spawnSync('bun', ['bin/elanous.mjs', `--test=${stateDir}`, 'decisions', 'retry-answer', lateId, '--json'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 240000,
  });
  expect(retried.status, retried.stderr.slice(0, 500)).toBe(0);
  expect(JSON.parse(retried.stdout.trim()).choice).toBe('b');
  expect(JSON.parse(readFileSync(join(stateDir, 'ask-user-question', 'answers', `${encodeURIComponent('auq:lateq:abcde')}.json`), 'utf8')).result.answers).toEqual({ late_choice: 'b) Decline' });
}, 500000);

test('CLI decide with no pending question at all reports the failed delivery and the retry command', () => {
  const stateDir = root();
  const lines: string[] = [];
  const program = new Command();
  registerDecisionsCommands(program, { stateDir, resolveVersion: () => ({ released: null, dev: null, codename: null }) }, { log: value => lines.push(value) });
  const run = (...args: string[]) => { lines.length = 0; program.parse(['decisions', ...args], { from: 'user' }); return lines[0]!; };
  const entry = JSON.parse(run('raise', '--agent', 'codex', '--title', 'Scope?', '--category', 'scope', '--s', 'S.', '--c', 'C.',
    '--option', 'a=Small:Less', '--option', 'b=Large:More', '--recommend', 'a', '--why', 'safer', '--resume-question', 'auq:qmissing:abcde', '--run', 'run-x', '--json'));
  const exitBefore = process.exitCode;
  const out = JSON.parse(run('decide', entry.id, 'b', '--json'));
  expect(process.exitCode).toBe(3);
  process.exitCode = exitBefore;
  expect(out).toMatchObject({ status: 'decided', choice: 'b', delivery: { ok: false, questionId: 'auq:qmissing:abcde' } });
  const events = readFileSync(join(stateDir, 'decisions', 'decisions.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  expect(events.filter((event: { type: string }) => event.type === 'decided')).toHaveLength(1);
});
