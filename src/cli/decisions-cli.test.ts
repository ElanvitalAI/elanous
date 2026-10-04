import { test, expect, spyOn } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { resetUserConfig } from '../user-config.js';
import { renderCardText } from '../decisions/decision-cards.js';
import { DecisionLedger } from '../decisions/decision-ledger.js';
import { fileLeaseStore, serializeLease } from '../hq/lease.js';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import type { HqDeps } from '../hq/hq.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPendingQuestion, writePendingQuestion } from '../ask-user-question/pending-questions.js';
import { registerDecisionsCommands } from './decisions-cli.js';

const root = () => mkdtempSync(join(tmpdir(), 'decisions-cli-'));

test('CLI records delegated decisions and the owner reads overnight seat report without cards', () => {
  const stateDir = root();
  const lines: string[] = [];
  const program = new Command();
  registerDecisionsCommands(program, { stateDir, now: () => new Date('2026-10-04T23:00:00Z'), resolveVersion: () => ({ released: null, dev: null, codename: null }) }, { log: line => lines.push(line) });
  const run = (...args: string[]) => { lines.length = 0; program.parse(['decisions', ...args], { from: 'user' }); return lines[0]!; };
  try {
    const first = JSON.parse(run('record-seat', '--seat', 'OP', '--title', '예산 막힘', '--decision', '크레딧으로 풀기',
      '--delegation', '운영 위임', '--ref', 'coord#1', '--json'));
    const second = JSON.parse(run('record-seat', '--seat', 'UX', '--title', '담당표', '--decision', '담당표 적용',
      '--delegation', 'UX 위임', '--at', '2026-10-04T22:00:00Z', '--json'));
    expect(first.reporting).toBe('posthoc');
    expect(first.recordedAt).toBe('2026-10-04T23:00:00.000Z');
    expect(first).not.toHaveProperty('decidedAt');
    expect(first).not.toHaveProperty('versionAtDecision');
    expect(second.seat).toBe('UX');
    expect(second.recordedAt).toBe('2026-10-04T23:00:00.000Z');
    expect(second.decidedAt).toBe('2026-10-04T22:00:00.000Z');
    expect(run('seat-report', '--since', '2026-10-04T21:00:00Z')).toContain('결정: 시각 미상 · 기록:');
    expect(run('seat-report', '--since', '2026-10-04T21:00:00Z')).toContain('OP 결정 · 사후 보고');
    expect(run('seat-report', '--since', '2026-10-04T21:00:00Z')).toContain('결정: 2026-10-05 07:00:00 KST · 기록: 2026-10-05 08:00:00 KST · UX 결정 · 사후 보고');
    expect(JSON.parse(run('seat-report', '--since', '2026-10-04T21:00:00Z', '--seat', 'OP', '--json'))).toEqual([first]);
    expect(JSON.parse(run('seat-report', '--since', '2026-10-04T21:00:00Z', '--seat', 'UX', '--json'))).toEqual([second]);
    expect(run('seat-report', '--since', '2026-10-04T22:30:00Z')).toContain('UX 결정 · 사후 보고');
    expect(run('seat-report', '--since', '2026-10-05T00:00:00Z')).toBe('자리 결정 0건');
    expect(JSON.parse(run('list', '--status', 'all', '--json'))).toEqual([]);
    expect(() => run('show', first.id)).toThrow('decision not found');
    expect(() => run('record-seat', '--seat', 'XX', '--title', 'bad', '--decision', 'bad', '--delegation', 'bad')).toThrow('invalid seat');
    expect(() => run('record-seat', '--seat', 'OP', '--title', '예산 막힘', '--decision', '크레딧으로 풀기', '--delegation', '운영 위임', '--ref', 'coord#1')).toThrow('source already recorded');
    expect(new DecisionLedger({ stateDir }).seatReport()).toHaveLength(2);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('CLI cross-check, shadow warning, strict config and alternative validation', () => {
  const stateDir = root();
  const lines: string[] = [];
  const errors: string[] = [];
  const oldError = console.error;
  console.error = (line: string) => { errors.push(line); };
  setElanousConfigDir(stateDir);
  const program = new Command();
  registerDecisionsCommands(program, { stateDir, resolveVersion: () => ({ released: null, dev: null, codename: null }) }, { log: line => lines.push(line) });
  expect(program.commands.find(command => command.name() === 'decisions')!.commands.find(command => command.name() === 'raise')!
    .options.find(option => option.long === '--no-xcheck')!.negate).toBe(false);
  const flags = ['raise', '--agent', 'MK', '--title', '피치', '--category', 'scope', '--s', '상황', '--c', '문제', '--q', '질문', '--a', '제안',
    '--option', 'a=승인:배포', '--option', 'b=보류:일정 지연', '--recommend', 'a', '--why', '근거', '--json'];
  const run = (...args: string[]) => { lines.length = 0; program.parse(['decisions', ...args], { from: 'user' }); return lines[0]; };
  try {
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ decisions: { requireCrossCheck: false } }));
    resetUserConfig();
    const checked = JSON.parse(run(...flags, '--xcheck', 'TC:키 경로 영향 없음', '--alternative', 'b', '--dissent', 'UX: 화면 문구 미정')!);
    expect(checked).toMatchObject({ alternative: 'b', dissent: 'UX: 화면 문구 미정', crossCheck: [{ seat: 'TC', note: '키 경로 영향 없음' }] });
    expect(checked.crossCheck[0].at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(errors).toEqual([]);
    expect(renderCardText(new DecisionLedger({ stateDir }).show(checked.id))).toContain('교차 확인: TC ✓ 키 경로 영향 없음');
    const missing = JSON.parse(run(...flags)!);
    expect(missing.crossCheckSkipped).toBe('missing');
    expect(errors).toEqual(['교차 확인 없음 — --xcheck SEAT:메모 또는 --no-xcheck 이유']);
    expect(renderCardText(new DecisionLedger({ stateDir }).show(missing.id))).toContain('교차 확인 없음(missing)');
    const explicit = JSON.parse(run(...flags, '--no-xcheck', '자리 루프 · 이웃 교환은 DEC-XCHECK ②')!);
    expect(explicit.crossCheckSkipped).toContain('자리 루프');
    expect(errors).toHaveLength(1);
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ decisions: { requireCrossCheck: true } }));
    resetUserConfig();
    expect(() => run(...flags)).toThrow('교차 확인 없음');
    expect(() => run(...flags, '--alternative', 'a', '--xcheck', 'TC:확인')).toThrow('alternative must differ');
    expect(() => run(...flags, '--xcheck', 'TC:확인', '--no-xcheck', '생략')).toThrow('choose --xcheck or --no-xcheck');
    const multiple = JSON.parse(run(...flags, '--xcheck', 'TC:키 확인', '--xcheck', 'UX:문구 확인')!);
    expect(multiple.crossCheck.map((check: { seat: string }) => check.seat)).toEqual(['TC', 'UX']);
    const strictChild = spawnSync('bun', ['bin/elanous.mjs', `--test=${stateDir}`, 'decisions', ...flags],
      { cwd: join(import.meta.dir, '..', '..'), encoding: 'utf8', timeout: 60_000 });
    expect(strictChild.status).toBe(1);
    expect(strictChild.stderr).toContain('교차 확인 없음 — --xcheck SEAT:메모 또는 --no-xcheck 이유');
    expect(() => run(...flags, '--alternative', 'z', '--xcheck', 'TC:확인')).toThrow('alternative option not found');
    expect(JSON.parse(run(...flags, '--no-xcheck', '근거 부족')!).crossCheckSkipped).toBe('근거 부족');
    expect(readFileSync(join(stateDir, 'decisions', 'decisions.jsonl'), 'utf8').trim().split('\n')).toHaveLength(5);
  } finally { console.error = oldError; resetElanousConfigDir(); resetUserConfig(); rmSync(stateDir, { recursive: true, force: true }); }
});

test('actual CLI parses checked, explicitly skipped, absent and conflicting cross-check flags', () => {
  const stateDir = root();
  const run = (...args: string[]) => spawnSync('bun', ['bin/elanous.mjs', `--test=${stateDir}`, 'decisions', 'raise', '--agent', 'MK',
    '--title', 'Pitch', '--category', 'scope', '--s', 'Situation', '--c', 'Complication', '--option', 'a=Go:Proceed',
    '--option', 'b=Wait:Delay', '--recommend', 'a', '--why', 'Ready', '--json', ...args],
  { cwd: join(import.meta.dir, '..', '..'), encoding: 'utf8', timeout: 60_000 });
  const warning = '교차 확인 없음 — --xcheck SEAT:메모 또는 --no-xcheck 이유';
  try {
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ decisions: { requireCrossCheck: false } }));
    const checked = run('--xcheck', 'TC:키 경로 영향 없음', '--alternative', 'b', '--dissent', 'UX: 화면 문구 미정');
    expect(checked.status, checked.stderr).toBe(0);
    expect(JSON.parse(checked.stdout)).toMatchObject({ crossCheck: [{ seat: 'TC', note: '키 경로 영향 없음' }], alternative: 'b', dissent: 'UX: 화면 문구 미정' });
    expect(checked.stderr).not.toContain(warning);
    const skipped = run('--no-xcheck', '자리 루프 · 이웃 교환은 DEC-XCHECK ②');
    expect(skipped.status, skipped.stderr).toBe(0);
    expect(JSON.parse(skipped.stdout).crossCheckSkipped).toBe('자리 루프 · 이웃 교환은 DEC-XCHECK ②');
    expect(skipped.stderr).not.toContain(warning);
    const absent = run();
    expect(absent.status, absent.stderr).toBe(0);
    expect(JSON.parse(absent.stdout).crossCheckSkipped).toBe('missing');
    expect(absent.stderr.split('\n').filter(line => line === warning)).toHaveLength(1);
    const conflicting = run('--xcheck', 'TC:확인', '--no-xcheck', '생략');
    expect(conflicting.status).toBe(1);
    expect(conflicting.stderr).toContain('choose --xcheck or --no-xcheck');
    const withoutReason = run('--no-xcheck');
    expect(withoutReason.status).toBe(1);
    expect(withoutReason.stderr).toContain("option '--no-xcheck <이유>' argument missing");
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ decisions: { requireCrossCheck: true } }));
    const strict = run();
    expect(strict.status).toBe(1);
    expect(strict.stderr).toContain(warning);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
}, 180_000);

test('isolated decisions CLI skips adjudication and records the write target', () => {
  const stateDir = root();
  const events: Array<{ category: string; event: string; data: unknown }> = [];
  const observation = spyOn(debug, 'log').mockImplementation((category, event, data) => { events.push({ category, event, data }); });
  const lines: string[] = [];
  const hq: HqDeps = { store: { read: () => { throw new Error('HQ adjudicator contacted'); }, cas: () => { throw new Error('HQ adjudicator contacted'); } } };
  const cli = new Command();
  const raise = ['raise', '--agent', 'codex', '--title', 'Isolated?', '--category', 'scope', '--s', 'S.', '--c', 'C.', '--option', 'a=Yes:Proceed', '--option', 'b=No:Wait', '--skip-recommend', 'Unknown', '--json'];
  try {
    setElanousConfigDir(stateDir);
    registerDecisionsCommands(cli, { stateDir, resolveVersion: () => ({ released: null, dev: null, codename: null }) }, { log: s => lines.push(s) }, hq);
    cli.parse(['decisions', ...raise, '--hq-override'], { from: 'user' });
    const entry = JSON.parse(lines.at(-1)!);
    cli.parse(['decisions', 'decide', entry.id, 'a', '--json'], { from: 'user' });
    expect(JSON.parse(lines.at(-1)!).choice).toBe('a');
    expect(events).toContainEqual({ category: 'hq.fence', event: 'skipped-isolated', data: { root: stateDir, command: 'decisions raise' } });
    expect(events).toContainEqual({ category: 'hq.fence', event: 'skipped-isolated', data: { root: stateDir, command: 'decisions decide' } });
    expect(events.filter(({ category, event }) => category === 'hq.fence' && event !== 'skipped-isolated')).toEqual([]);
  } finally { observation.mockRestore(); resetElanousConfigDir(); rmSync(stateDir, { recursive: true, force: true }); }
});

test('decision ledger outside the instance universe retains the HQ fence and observed override', () => {
  const instanceRoot = root();
  const outsideRoot = root();
  const store = fileLeaseStore(join(instanceRoot, 'hq', 'lease.json'), () => 100);
  const events: string[] = [];
  const hq: HqDeps = { store, config: { hostName: 'mbp', standby: 'node-b' }, localPath: join(instanceRoot, 'local.json'), seenPath: join(instanceRoot, 'seen-generation'), now: () => 100,
    log: ((_category: string, event: string) => { events.push(event); }) as HqDeps['log'] };
  const lines: string[] = [];
  const errors: string[] = [];
  const error = spyOn(console, 'error').mockImplementation((line: string) => { errors.push(line); });
  const before = process.exitCode;
  const cli = new Command();
  const raise = ['raise', '--agent', 'codex', '--title', 'Fence?', '--category', 'scope', '--s', 'S.', '--c', 'C.', '--option', 'a=Yes:Proceed', '--option', 'b=No:Wait', '--skip-recommend', 'Unknown', '--json'];
  try {
    setElanousConfigDir(instanceRoot);
    registerDecisionsCommands(cli, { stateDir: outsideRoot, resolveVersion: () => ({ released: null, dev: null, codename: null }) }, { log: s => lines.push(s) }, hq);
    expect(store.cas(null, serializeLease({ holder: 'node-b', generation: 2, acquiredAt: 100, renewedAt: 100, ttlSeconds: 1500 }))).toBe(true);
    process.exitCode = 0;
    cli.parse(['decisions', ...raise], { from: 'user' });
    expect(process.exitCode).toBe(4);
    expect(lines).toEqual([]);
    expect(errors.at(-1)).toContain('본부는 node-b gen 2');
    expect(() => readFileSync(join(outsideRoot, 'decisions', 'decisions.jsonl'))).toThrow();
    cli.parse(['decisions', ...raise, '--hq-override'], { from: 'user' });
    expect(process.exitCode).toBe(4);
    expect(JSON.parse(lines.at(-1)!).status).toBe('open');
    expect(events).toContain('cli-override');
    expect(errors.some(line => line.includes('hq override: decisions raise'))).toBe(true);
    expect(effectiveInstanceRoot()).toBe(instanceRoot);
  } finally { process.exitCode = before ?? 0; error.mockRestore(); resetElanousConfigDir(); rmSync(instanceRoot, { recursive: true, force: true }); rmSync(outsideRoot, { recursive: true, force: true }); }
});

test('decisions CLI fences raise/decide at generation, permits observed override and pre-lease bootstrap without altering reads', () => {
  const stateDir = root();
  const store = fileLeaseStore(join(stateDir, 'lease.json'), () => 100);
  const logs: string[] = [];
  const hq: HqDeps = { store, config: { hostName: 'mbp', standby: 'node-b' }, localPath: join(stateDir, 'hq-local.json'), seenPath: join(stateDir, 'seen-generation'), now: () => 100,
    log: ((_category: string, event: string) => { logs.push(event); }) as HqDeps['log'] };
  const lines: string[] = [];
  const errors: string[] = [];
  const prior = process.exitCode;
  const oldError = console.error;
  console.error = (line: string) => { errors.push(line); };
  const cli = new Command();
  registerDecisionsCommands(cli, { stateDir, releaseRoot: join(stateDir, 'missing'), repoRoot: join(stateDir, 'missing') }, { log: (s) => lines.push(s) }, hq);
  const run = (...args: string[]) => { lines.length = 0; cli.parse(['decisions', ...args], { from: 'user' }); return lines[0]; };
  const raise = ['raise', '--agent', 'codex', '--title', 'Fence?', '--category', 'scope', '--s', 'S.', '--c', 'C.', '--option', 'a=Yes:Proceed', '--option', 'b=No:Wait', '--skip-recommend', 'Unknown', '--json'];
  try {
    process.exitCode = 0;
    const entry = JSON.parse(run(...raise)!);
    const path = join(stateDir, 'decisions', 'decisions.jsonl');
    const before = readFileSync(path, 'utf8');
    expect(store.cas(null, serializeLease({ holder: 'node-b', generation: 2, acquiredAt: 100, renewedAt: 100, ttlSeconds: 1500 }))).toBe(true);
    expect(run(...raise)).toBeUndefined();
    expect(process.exitCode).toBe(4);
    expect(errors.at(-1)).toBe('본부는 node-b gen 2 — 원장 쓰기는 지금 본부로 보내라 (수동 우회: --hq-override, 관측)');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(JSON.parse(run('show', entry.id, '--json')!).status).toBe('open');
    process.exitCode = 0;
    expect(run('decide', entry.id, 'a')).toBeUndefined();
    expect(process.exitCode).toBe(4);
    expect(readFileSync(path, 'utf8')).toBe(before);
    process.exitCode = 0;
    expect(JSON.parse(run('decide', entry.id, 'a', '--hq-override', '--json')!).choice).toBe('a');
    expect(process.exitCode).toBe(0);
    expect(logs).toContain('cli-override');
    expect(errors.some(line => line.includes('hq override: decisions decide'))).toBe(true);
    process.exitCode = 0;
    expect(JSON.parse(run(...raise, '--hq-override')!).status).toBe('open');
    expect(process.exitCode).toBe(0);
    expect(errors.some(line => line.includes('hq override: decisions raise'))).toBe(true);
  } finally { process.exitCode = prior ?? 0; console.error = oldError; rmSync(stateDir, { recursive: true, force: true }); }
});
test('actual isolated decisions CLI writes despite a foreign lease without override', () => {
  const stateDir = root();
  const store = fileLeaseStore(join(stateDir, 'hq', 'lease.json'), () => 100);
  const run = (...args: string[]) => spawnSync('bun', ['bin/elanous.mjs', `--test=${stateDir}`, 'decisions', ...args],
    { cwd: join(import.meta.dir, '..', '..'), encoding: 'utf8', timeout: 60_000 });
  const raise = ['raise', '--agent', 'codex', '--title', 'Fence?', '--category', 'scope', '--s', 'S.', '--c', 'C.',
    '--option', 'a=Yes:Proceed', '--option', 'b=No:Wait', '--skip-recommend', 'Unknown', '--json'];
  try {
    expect(store.cas(null, serializeLease({ holder: 'other-host', generation: 2, acquiredAt: 100, renewedAt: 100, ttlSeconds: 1500 }))).toBe(true);
    const added = run(...raise);
    expect(added.status, added.stderr).toBe(0);
    expect(added.stderr).not.toContain('hq override:');
    const entry = JSON.parse(added.stdout);
    const decided = run('decide', entry.id, 'a', '--json');
    expect(decided.status, decided.stderr).toBe(0);
    expect(JSON.parse(decided.stdout).status).toBe('decided');
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
}, 180_000);

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
