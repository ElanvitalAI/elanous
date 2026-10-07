import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTasksCommands } from '../cli/tasks-cli.js';
import { debug } from '../debug/log.js';
import { advanceMission, collectPieceEvidence, handMission, landedPieces, openMissionIds, recordPieceRef, type PieceEvidenceReader } from './mission.js';
import { handTask, readTaskCard, TaskCardSupersededError, updateTaskCard, type TaskCard } from './task-hand.js';

function statePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'task-mission-advance-')), 'task-agent-actions.json');
}

async function cli(args: string[], deps: Parameters<typeof registerTasksCommands>[1]): Promise<{ lines: string[]; code: number | string | undefined }> {
  const lines: string[] = [];
  const program = new Command().name('elanous').exitOverride();
  registerTasksCommands(program, { registerSink: async () => true, ...deps, output: (line) => lines.push(line) });
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'elanous', ...args]);
    return { lines, code: process.exitCode };
  } finally { process.exitCode = previous ?? 0; }
}

/** 가짜 PR 조회 — 번호 → 상태. 없는 번호는 «모름»(waiting). */
function fakePrs(states: Record<number, 'merged' | 'open' | 'closed'>): PieceEvidenceReader & { calls: Array<number | string> } {
  const calls: Array<number | string> = [];
  const read = (async (ref: number | string) => {
    calls.push(ref);
    const state = typeof ref === 'number' ? states[ref] : undefined;
    return state === 'merged' ? 'merged' : state === 'closed' ? 'blocked' : 'waiting';
  }) as PieceEvidenceReader & { calls: Array<number | string> };
  read.calls = calls;
  return read;
}

// 1 → 2 → 4, 1 → 3 → 4 (조각 4 는 선행 둘)
const DIAMOND = '- one\n- two (after: 1)\n- three (after: 1)\n- four (after: 2, 3)';

async function diamond(path: string, checklistId = 'CELL-M'): Promise<string> {
  const { mission } = await handMission({ text: DIAMOND, statePath: path, checklistId });
  return mission.id;
}

test('landedPieces — merged 만 착지 · pending·closed·no-ref·근거 없음은 미착지(추측하지 않는다)', () => {
  const mission = { pieces: ['a', 'b', 'c', 'd', 'e'] };
  expect([...landedPieces(mission, { a: 'merged', b: 'pending', c: 'closed', d: 'no-ref' })]).toEqual(['a']);
  expect(landedPieces({}, { a: 'merged' }).size).toBe(0);
});

test('collectPieceEvidence — PR 번호 우선 · 골 id · 둘 다 없으면 no-ref · 읽기 실패는 pending', async () => {
  const cards = [
    { id: 'p1', pr: 11 }, { id: 'p2', goalId: 'abcdef0123456789' }, { id: 'p3' }, { id: 'p4', pr: 99 },
  ] as TaskCard[];
  const seen: Array<number | string> = [];
  const evidence = await collectPieceEvidence(cards, async (ref) => {
    seen.push(ref);
    if (ref === 99) throw new Error('gh down');
    return ref === 11 ? 'merged' : 'waiting';
  });
  expect(evidence).toEqual({ p1: 'merged', p2: 'pending', p3: 'no-ref', p4: 'pending' });
  expect(seen).toEqual([11, 'abcdef0123456789', 99]);
});

test('선행 PR 병합 → 다음 조각을 한 번 넘긴다 · 두 번 불러도 새로 넘기는 것 0', async () => {
  const path = statePath();
  const id = await diamond(path);
  recordPieceRef(`${id}-1`, { pr: 101 }, path);
  const prs = fakePrs({ 101: 'merged' });
  const first = await advanceMission(id, { statePath: path, readEvidence: prs });
  expect(first.landed).toEqual([`${id}-1`]);
  expect(first.ready).toEqual([`${id}-2`, `${id}-3`]);
  expect(first.handed.map((piece) => piece.pieceId)).toEqual([`${id}-2`, `${id}-3`]);
  expect(first.handed.every((piece) => !piece.launched)).toBe(true); // shadow
  expect(readTaskCard(`${id}-2`, path)?.handed?.mode).toBe('shadow');
  const second = await advanceMission(id, { statePath: path, readEvidence: prs });
  expect(second.handed).toEqual([]);
  expect(second.skipped).toEqual([`${id}-2`, `${id}-3`]);
  // 조각 4 는 선행 둘이 다 착지해야 — 아직 기다린다.
  expect(second.ready).not.toContain(`${id}-4`);
});

test('--live — 새로 준비된 조각만 발사기 한 번 · shadow 로 넘겼던 조각도 live 로 한 번 · 그 뒤로는 0', async () => {
  const path = statePath();
  const id = await diamond(path);
  recordPieceRef(`${id}-1`, { pr: 101 }, path);
  const prs = fakePrs({ 101: 'merged' });
  await advanceMission(id, { statePath: path, readEvidence: prs }); // shadow 먼저
  const calls: string[][] = [];
  const live = await advanceMission(id, { statePath: path, readEvidence: prs, live: true, launcher: (args) => { calls.push(args); } });
  expect(calls.map((args) => args.at(-1))).toEqual(['two', 'three']);
  expect(live.handed.every((piece) => piece.launched)).toBe(true);
  expect(readTaskCard(`${id}-2`, path)).toMatchObject({ status: 'launched', handed: { mode: 'live' }, mission: id, after: [`${id}-1`] });
  const again = await advanceMission(id, { statePath: path, readEvidence: prs, live: true, launcher: (args) => { calls.push(args); } });
  expect(again.handed).toEqual([]);
  expect(calls).toHaveLength(2);
});

test('발사 실패 — 그 조각은 launch-failed ⊕ 표지에 사유 · 다시 넘기지 않는다', async () => {
  const path = statePath();
  const id = await diamond(path);
  recordPieceRef(`${id}-1`, { pr: 101 }, path);
  const prs = fakePrs({ 101: 'merged' });
  const failed = await advanceMission(id, { statePath: path, readEvidence: prs, live: true, launcher: (args) => { if (args.at(-1) === 'two') throw new Error('boom'); } });
  expect(failed.handed.find((piece) => piece.pieceId === `${id}-2`)?.error).toContain('boom');
  expect(readTaskCard(`${id}-2`, path)).toMatchObject({ status: 'launch-failed', handed: { mode: 'live', error: expect.stringContaining('boom') } });
  let calls = 0;
  const again = await advanceMission(id, { statePath: path, readEvidence: prs, live: true, launcher: () => { calls++; } });
  expect(again.handed).toEqual([]);
  expect(calls).toBe(0);
});

test('선행 PR 열림·모름·근거 없음 → 아무것도 안 넘긴다', async () => {
  for (const setup of [
    (path: string, id: string) => recordPieceRef(`${id}-1`, { pr: 202 }, path), // open
    (path: string, id: string) => recordPieceRef(`${id}-1`, { pr: 303 }, path), // unknown
    (path: string, id: string) => recordPieceRef(`${id}-1`, { goalId: 'abcdef0123456789' }, path), // ledger has no merged PR
    () => undefined, // no ref at all
  ]) {
    const path = statePath();
    const id = await diamond(path);
    setup(path, id);
    const result = await advanceMission(id, { statePath: path, readEvidence: fakePrs({ 202: 'open' }) });
    expect(result.landed).toEqual([]);
    expect(result.handed).toEqual([]);
    expect(result.green).toBe('not-yet');
  }
});

test('선행 둘 중 하나만 착지 → 기다린다 · 둘 다 착지 → 넘긴다', async () => {
  const path = statePath();
  const id = await diamond(path);
  recordPieceRef(`${id}-1`, { pr: 1 }, path);
  recordPieceRef(`${id}-2`, { pr: 2 }, path);
  // 2 착지 · 3 은 근거 없음 → 4 의 선행 둘 중 하나만 착지
  const half = await advanceMission(id, { statePath: path, readEvidence: fakePrs({ 1: 'merged', 2: 'merged' }) });
  expect(half.ready).toEqual([`${id}-3`]);
  expect(half.handed.map((piece) => piece.pieceId)).toEqual([`${id}-3`]); // 3 은 1 만 기다렸다
  expect(readTaskCard(`${id}-4`, path)?.handed).toBeUndefined();
  recordPieceRef(`${id}-3`, { pr: 3 }, path);
  const stillHalf = await advanceMission(id, { statePath: path, readEvidence: fakePrs({ 1: 'merged', 2: 'merged', 3: 'open' }) });
  expect(stillHalf.handed).toEqual([]);
  const full = await advanceMission(id, { statePath: path, readEvidence: fakePrs({ 1: 'merged', 2: 'merged', 3: 'merged' }) });
  expect(full.handed.map((piece) => piece.pieceId)).toEqual([`${id}-4`]);
});

test('모두 착지 → green 제안을 미션 카드에 한 번 · 체크리스트 명령 0 · 관측 셋', async () => {
  const path = statePath();
  const id = await diamond(path, 'CELL-G');
  for (const n of [1, 2, 3, 4]) recordPieceRef(`${id}-${n}`, { pr: n }, path);
  const events: Array<{ event: string; data?: unknown }> = [];
  const off = debug.registerSink({ name: 'mission-advance-capture', emit: (rec) => { if (rec.category === 'task-agent') events.push(rec); } });
  try {
    const prs = fakePrs({ 1: 'merged', 2: 'merged', 3: 'merged', 4: 'merged' });
    let launches = 0;
    const done = await advanceMission(id, { statePath: path, readEvidence: prs, launcher: () => { launches++; } });
    expect(done.green).toBe('proposed');
    expect(done.handed).toEqual([]); // 이미 착지한 조각은 넘기지 않는다
    expect(launches).toBe(0);
    expect(readTaskCard(id, path)?.greenProposal).toMatchObject({ checklistId: 'CELL-G', evidence: { [`${id}-1`]: '#1', [`${id}-4`]: '#4' } });
    const again = await advanceMission(id, { statePath: path, readEvidence: prs });
    expect(again.green).toBe('already-proposed');
    expect(events.filter((e) => e.event === 'mission-green-proposed')).toHaveLength(1);
    expect(events.filter((e) => e.event === 'mission-green-proposed')[0]!.data).toMatchObject({ missionId: id, checklist: 'CELL-G' });
    const advances = events.filter((e) => e.event === 'mission-advance');
    expect(advances).toHaveLength(2);
    expect(advances[0]!.data).toMatchObject({ missionId: id, landed: [1, 2, 3, 4].map((n) => `${id}-${n}`), ready: [], handed: [] });
    expect(openMissionIds(path)).toEqual([]);
  } finally { off(); }
});

test('mission-piece-handed 관측 — 넘긴 조각마다 한 줄', async () => {
  const path = statePath();
  const id = await diamond(path);
  recordPieceRef(`${id}-1`, { pr: 7 }, path);
  const events: Array<{ event: string; data?: unknown }> = [];
  const off = debug.registerSink({ name: 'mission-handed-capture', emit: (rec) => { if (rec.category === 'task-agent') events.push(rec); } });
  try {
    await advanceMission(id, { statePath: path, readEvidence: fakePrs({ 7: 'merged' }) });
    const handed = events.filter((e) => e.event === 'mission-piece-handed');
    expect(handed.map((e) => (e.data as { pieceId: string }).pieceId)).toEqual([`${id}-2`, `${id}-3`]);
    expect(handed[0]!.data).toMatchObject({ missionId: id, mode: 'shadow', launched: false });
  } finally { off(); }
});

test('recordPieceRef — 미션 조각만 · 번호·골 id 모양 검사', async () => {
  const path = statePath();
  const id = await diamond(path);
  expect(() => recordPieceRef(id, { pr: 1 }, path)).toThrow('미션 조각 카드가 아니다');
  expect(() => recordPieceRef('ta-none', { pr: 1 }, path)).toThrow('미션 조각 카드가 아니다');
  expect(() => recordPieceRef(`${id}-1`, { pr: 0 }, path)).toThrow('PR 번호가 아니다');
  expect(() => recordPieceRef(`${id}-1`, { goalId: 'xyz' }, path)).toThrow('16자 hex');
  expect(recordPieceRef(`${id}-1`, { goalId: 'abcdef0123456789' }, path).goalId).toBe('abcdef0123456789');
});

test('CLI tasks advance — --pr 로 근거를 적고 넘긴다 · 미션 id 와 --all 은 하나만 · --all 은 열린 미션 전부', async () => {
  const path = statePath();
  const id = await diamond(path);
  const prs = fakePrs({ 55: 'merged' });
  const run = await cli(['task', 'advance', id, '--pr', `${id}-1=#55`], { taskStatePath: path, pieceEvidence: prs });
  expect(run.code).toBeFalsy();
  const text = run.lines.join('\n');
  expect(text).toContain(`${id}\tadvance\tshadow\t착지 1 · 준비 2 · 넘김 2 · green not-yet`);
  expect(text).toContain(`  근거: ${id}-1\tmerged\t착지`);
  expect(text).toContain(`  넘김: ${id}-2\tnot launched`);
  expect(text).toContain('(shadow — 띄우지 않았다');
  expect(readTaskCard(`${id}-1`, path)?.pr).toBe(55);

  const both = await cli(['task', 'advance', id, '--all'], { taskStatePath: path, pieceEvidence: prs });
  expect(both.code).toBe(1);
  const none = await cli(['task', 'advance'], { taskStatePath: path, pieceEvidence: prs });
  expect(none.code).toBe(1);
  const badPr = await cli(['task', 'advance', id, '--pr', `${id}-2=abc`], { taskStatePath: path, pieceEvidence: prs });
  expect(badPr.code).toBe(1);
  const notMission = await cli(['task', 'advance', `${id}-1`], { taskStatePath: path, pieceEvidence: prs });
  expect(notMission.code).toBe(1);
  expect(notMission.lines.join('\n')).toContain('미션 카드가 아니다');

  const all = await cli(['task', 'advance', '--all', '--json'], { taskStatePath: path, pieceEvidence: prs });
  expect(all.code).toBeFalsy();
  const results = JSON.parse(all.lines[0]!) as Array<{ missionId: string; handed: unknown[] }>;
  expect(results.map((result) => result.missionId)).toEqual([id]);
  expect(results[0]!.handed).toEqual([]); // 이미 넘겼다

  const state = JSON.parse(readFileSync(path, 'utf8'));
  expect(Object.keys(state.tasks)).toHaveLength(5);
});

test('늦게 끝난 shadow 넘김은 live 표지를 덮지 않는다 — claim 을 잃은 handTask 는 쓰지 않는다', async () => {
  const path = statePath();
  const id = await diamond(path);
  // live 넘김이 이미 가져가 발사했다(디스크 = launched · live claim).
  updateTaskCard(path, `${id}-2`, (current) => ({ ...current!, status: 'launched', handed: { at: 't', mode: 'live', claim: 'live-claim' } }));
  const before = readTaskCard(`${id}-2`, path);
  // 늦은 shadow 의 handTask — 자기 claim 이 아니므로 쓰지 않는다.
  await expect(handTask({
    text: 'two', id: `${id}-2`, mission: id, after: [`${id}-1`], landed: new Set([`${id}-1`]), statePath: path,
    cardFields: { handed: { at: 't0', mode: 'shadow', claim: 'shadow-claim' } },
    writeGuard: (current) => current?.handed?.claim === 'shadow-claim',
  })).rejects.toBeInstanceOf(TaskCardSupersededError);
  expect(readTaskCard(`${id}-2`, path)).toEqual(before);
  // 그 뒤 live advance 는 다시 발사하지 않는다.
  recordPieceRef(`${id}-1`, { pr: 9 }, path);
  let calls = 0;
  const live = await advanceMission(id, { statePath: path, readEvidence: fakePrs({ 9: 'merged' }), live: true, launcher: () => { calls++; } });
  expect(live.handed.map((piece) => piece.pieceId)).toEqual([`${id}-3`]);
  expect(calls).toBe(1);
});

test('green 제안 뒤에는 조각 근거를 바꾸지 않는다', async () => {
  const path = statePath();
  const { mission } = await handMission({ text: '- a\n- b (after: 1)', statePath: path });
  recordPieceRef(`${mission.id}-1`, { pr: 1 }, path);
  recordPieceRef(`${mission.id}-2`, { pr: 2 }, path);
  const done = await advanceMission(mission.id, { statePath: path, readEvidence: fakePrs({ 1: 'merged', 2: 'merged' }) });
  expect(done.green).toBe('proposed');
  expect(() => recordPieceRef(`${mission.id}-2`, { pr: 3 }, path)).toThrow('이미 green 제안됐다');
  expect(readTaskCard(`${mission.id}-2`, path)?.pr).toBe(2);
});

test('조회 도중 근거가 바뀌면 green 을 제안하지 않는다 · claim 뒤 적힌 근거는 넘김이 지우지 않는다', async () => {
  const path = statePath();
  const { mission } = await handMission({ text: '- a\n- b (after: 1)', statePath: path });
  const [a, b] = [`${mission.id}-1`, `${mission.id}-2`];
  recordPieceRef(a, { pr: 1 }, path);
  recordPieceRef(b, { pr: 2 }, path);
  // 조회 중에 b 의 근거가 열린 PR 로 바뀐다.
  const racing: PieceEvidenceReader = async (ref) => {
    if (ref === 2) recordPieceRef(b, { pr: 3 }, path);
    return ref === 1 || ref === 2 ? 'merged' : 'waiting';
  };
  const stale = await advanceMission(mission.id, { statePath: path, readEvidence: racing });
  expect(stale.green).toBe('not-yet');
  expect(readTaskCard(mission.id, path)?.greenProposal).toBeUndefined();

  // claim 뒤(발사 도중) 적힌 근거는 넘김의 카드 쓰기가 지우지 않는다.
  const path2 = statePath();
  const two = await handMission({ text: '- a\n- b (after: 1)', statePath: path2 });
  recordPieceRef(`${two.mission.id}-1`, { pr: 1 }, path2);
  await advanceMission(two.mission.id, {
    statePath: path2, readEvidence: fakePrs({ 1: 'merged' }), live: true,
    launcher: () => { recordPieceRef(`${two.mission.id}-2`, { pr: 77 }, path2); },
  });
  expect(readTaskCard(`${two.mission.id}-2`, path2)).toMatchObject({ status: 'launched', pr: 77, handed: { mode: 'live' } });
});

test('근거 정정 — 골 id 로 바꾸면 옛 PR 이 지워진다(옛 병합 PR 로 착지하지 않는다) · 둘 다/둘 다 없음은 거부', async () => {
  const path = statePath();
  const { mission } = await handMission({ text: '- a\n- b (after: 1)', statePath: path });
  const a = `${mission.id}-1`;
  recordPieceRef(a, { pr: 1 }, path); // 잘못 적은 병합 PR
  const corrected = recordPieceRef(a, { goalId: 'abcdef0123456789' }, path);
  expect(corrected.pr).toBeUndefined();
  expect(corrected.goalId).toBe('abcdef0123456789');
  const result = await advanceMission(mission.id, { statePath: path, readEvidence: fakePrs({ 1: 'merged' }) });
  expect(result.landed).toEqual([]);
  expect(result.handed).toEqual([]);
  expect(recordPieceRef(a, { pr: 5 }, path).goalId).toBeUndefined();
  expect(() => recordPieceRef(a, { pr: 5, goalId: 'abcdef0123456789' }, path)).toThrow('하나다');
  expect(() => recordPieceRef(a, {}, path)).toThrow('하나다');
});

test('발사 중 근거 정정(PR → 골 id) — 넘김 쓰기가 옛 PR 을 되살리지 않는다', async () => {
  const path = statePath();
  const { mission } = await handMission({ text: '- a\n- b (after: 1)', statePath: path });
  const [a, b] = [`${mission.id}-1`, `${mission.id}-2`];
  recordPieceRef(a, { pr: 1 }, path);
  // next 에 옛 PR(50)이 실린 넘김 — 발사 중 디스크 근거가 골 id 로 정정된다.
  await handTask({
    text: 'b', id: b, mission: mission.id, after: [a], landed: new Set([a]), statePath: path, live: true,
    cardFields: { pr: 50, handed: { at: 't', mode: 'live', claim: 'c1' } },
    writeGuard: () => true,
    launcher: () => { updateTaskCard(path, b, (current) => { const { pr: _p, ...rest } = current!; return { ...rest, goalId: 'abcdef0123456789' }; }); },
  });
  const card = readTaskCard(b, path)!;
  expect(card.status).toBe('launched');
  expect(card.pr).toBeUndefined();
  expect(card.goalId).toBe('abcdef0123456789');
});

test('green 제안 뒤 재조회 실패에도 넘김 0 · 자기 근거가 있는 조각은 pending 이어도 넘기지 않는다', async () => {
  const path = statePath();
  const { mission } = await handMission({ text: '- a\n- b (after: 1)', statePath: path });
  const [a, b] = [`${mission.id}-1`, `${mission.id}-2`];
  recordPieceRef(a, { pr: 1 }, path);
  recordPieceRef(b, { pr: 2 }, path);
  expect((await advanceMission(mission.id, { statePath: path, readEvidence: fakePrs({ 1: 'merged', 2: 'merged' }) })).green).toBe('proposed');
  let calls = 0;
  const flaky = fakePrs({ 1: 'merged' }); // 2 는 조회 실패(pending)
  const after = await advanceMission(mission.id, { statePath: path, readEvidence: flaky, live: true, launcher: () => { calls++; } });
  expect(after).toMatchObject({ green: 'already-proposed', handed: [] });
  expect(calls).toBe(0);
  expect(flaky.calls).toEqual([]); // 조회도 안 한다

  // 제안 전이라도 — 조각 b 에 PR 근거가 있으면(런이 있었다) 조회가 pending 이어도 넘기지 않는다.
  const path2 = statePath();
  const two = await handMission({ text: '- a\n- b (after: 1)', statePath: path2 });
  recordPieceRef(`${two.mission.id}-1`, { pr: 1 }, path2);
  recordPieceRef(`${two.mission.id}-2`, { pr: 2 }, path2);
  const pending = await advanceMission(two.mission.id, { statePath: path2, readEvidence: fakePrs({ 1: 'merged' }), live: true, launcher: () => { calls++; } });
  expect(pending.handed).toEqual([]);
  expect(pending.skipped).toContain(`${two.mission.id}-2`);
  expect(calls).toBe(0);
});

test('CLI --all — 한 미션이 깨져도 나머지 미션은 진행한다 · exit 1', async () => {
  const path = statePath();
  const good = await diamond(path);
  const broken = await handMission({ text: '- x\n- y (after: 1)', statePath: path });
  const state = JSON.parse(readFileSync(path, 'utf8'));
  delete state.tasks[`${broken.mission.id}-2`];
  writeFileSync(path, JSON.stringify(state));
  recordPieceRef(`${good}-1`, { pr: 8 }, path);
  const run = await cli(['task', 'advance', '--all'], { taskStatePath: path, pieceEvidence: fakePrs({ 8: 'merged' }) });
  expect(run.code).toBe(1);
  const text = run.lines.join('\n');
  expect(text).toContain(`${broken.mission.id}\tadvance\tfailed\t조각 카드 없음`);
  expect(text).toContain(`${good}\tadvance\tshadow\t착지 1 · 준비 2 · 넘김 2`);
});

test('--live 인데 발사기가 없으면 claim 전에 멈춘다 · --all 의 근거 기록 실패는 그 근거만 · 모양이 틀리면 아무것도 안 적는다', async () => {
  const path = statePath();
  const id = await diamond(path);
  recordPieceRef(`${id}-1`, { pr: 4 }, path);
  await expect(advanceMission(id, { statePath: path, readEvidence: fakePrs({ 4: 'merged' }), live: true })).rejects.toThrow('launcher');
  expect(readTaskCard(`${id}-2`, path)?.handed).toBeUndefined();

  const run = await cli(['task', 'advance', '--all', '--pr', 'ta-none-1=5'], { taskStatePath: path, pieceEvidence: fakePrs({ 4: 'merged' }) });
  expect(run.code).toBe(1);
  expect(run.lines.join('\n')).toContain('근거 기록 실패: 미션 조각 카드가 아니다: ta-none-1');
  expect(run.lines.join('\n')).toContain(`${id}\tadvance\tshadow\t착지 1 · 준비 2 · 넘김 2`);

  const bad = await cli(['task', 'advance', '--all', '--pr', `${id}-3=7`, '--goal', `${id}-4=nothex`], { taskStatePath: path, pieceEvidence: fakePrs({}) });
  expect(bad.code).toBe(1);
  expect(readTaskCard(`${id}-3`, path)?.pr).toBeUndefined(); // 앞의 맞는 근거도 적지 않았다
});

test('mission-advance 는 실패한 호출도 남긴다 (오류 ⊕ ms)', async () => {
  const path = statePath();
  const id = await diamond(path);
  const events: Array<{ event: string; data?: unknown }> = [];
  const off = debug.registerSink({ name: 'mission-advance-fail-capture', emit: (rec) => { if (rec.category === 'task-agent') events.push(rec); } });
  try {
    await expect(advanceMission(`${id}-1`, { statePath: path })).rejects.toThrow('미션 카드가 아니다');
    await expect(advanceMission(id, { statePath: path, live: true })).rejects.toThrow('launcher');
    const advances = events.filter((e) => e.event === 'mission-advance').map((e) => e.data as { missionId: string; error?: string; ms?: number });
    expect(advances).toHaveLength(2);
    expect(advances[0]).toMatchObject({ missionId: `${id}-1`, error: expect.stringContaining('미션 카드가 아니다') });
    expect(advances[1]).toMatchObject({ missionId: id, mode: 'live', error: expect.stringContaining('launcher') });
    expect(typeof advances[0]!.ms).toBe('number');
  } finally { off(); }
});

test('미션 지정 호출의 근거는 그 미션 조각에만 — 없는 미션·남의 조각이면 아무것도 안 적는다', async () => {
  const path = statePath();
  const a = await diamond(path);
  const b = await diamond(path);
  const cross = await cli(['task', 'advance', a, '--pr', `${b}-1=5`], { taskStatePath: path, pieceEvidence: fakePrs({}) });
  expect(cross.code).toBe(1);
  expect(cross.lines.join('\n')).toContain(`미션 ${a} 의 조각이 아니다`);
  expect(readTaskCard(`${b}-1`, path)?.pr).toBeUndefined();
  const ghost = await cli(['task', 'advance', 'ta-ghost', '--pr', `${a}-1=5`], { taskStatePath: path, pieceEvidence: fakePrs({}) });
  expect(ghost.code).toBe(1);
  expect(readTaskCard(`${a}-1`, path)?.pr).toBeUndefined();
  // 제안 끝난 미션은 «착지 0» 이 아니라 따로 보인다
  const c = await handMission({ text: '- a\n- b (after: 1)', statePath: path });
  recordPieceRef(`${c.mission.id}-1`, { pr: 1 }, path);
  recordPieceRef(`${c.mission.id}-2`, { pr: 2 }, path);
  await advanceMission(c.mission.id, { statePath: path, readEvidence: fakePrs({ 1: 'merged', 2: 'merged' }) });
  const done = await cli(['task', 'advance', c.mission.id], { taskStatePath: path, pieceEvidence: fakePrs({}) });
  expect(done.lines).toEqual([`${c.mission.id}\tadvance\tshadow\tgreen already-proposed — 다시 조회·넘기지 않는다`]);
});

test('CLI 사전 검증 실패도 mission-advance 한 줄 · advanceMission 실패는 한 줄만', async () => {
  const path = statePath();
  const a = await diamond(path);
  const b = await diamond(path);
  const events: Array<{ event: string; data?: unknown }> = [];
  const off = debug.registerSink({ name: 'mission-advance-cli-capture', emit: (rec) => { if (rec.category === 'task-agent') events.push(rec); } });
  try {
    await cli(['task', 'advance', a, '--pr', `${b}-1=5`], { taskStatePath: path, pieceEvidence: fakePrs({}) });
    await cli(['task', 'advance', a, '--pr', `${a}-1=abc`], { taskStatePath: path, pieceEvidence: fakePrs({}) });
    await cli(['task', 'advance', `${a}-1`], { taskStatePath: path, pieceEvidence: fakePrs({}) });
    await cli(['task', 'advance', a, '--all'], { taskStatePath: path, pieceEvidence: fakePrs({}) });
    await cli(['task', 'advance'], { taskStatePath: path, pieceEvidence: fakePrs({}) });
    const advances = events.filter((e) => e.event === 'mission-advance').map((e) => e.data as { missionId: string | null; stage?: string; error?: string; ms?: number; all?: boolean });
    expect(advances).toHaveLength(5);
    expect(advances[3]).toMatchObject({ missionId: a, all: true, stage: 'cli-args', error: expect.stringContaining('하나만') });
    expect(advances[4]).toMatchObject({ missionId: null, all: false, stage: 'cli-args', error: expect.stringContaining('하나만') });
    expect(advances.every((advance) => typeof advance.ms === 'number')).toBe(true);
    expect(advances[0]).toMatchObject({ missionId: a, stage: 'cli-args', error: expect.stringContaining('조각이 아니다') });
    expect(advances[1]).toMatchObject({ missionId: a, stage: 'cli-args', error: expect.stringContaining('PR 번호가 아니다') });
    expect(advances[2]).toMatchObject({ missionId: `${a}-1`, error: expect.stringContaining('미션 카드가 아니다') });
    expect(advances[2]!.stage).toBeUndefined();
  } finally { off(); }
});

test('--all 은 대상 0 이어도 요약 한 줄 · 한 조각에 --pr 과 --goal 을 함께 주면 거부', async () => {
  const path = statePath();
  const events: Array<{ event: string; data?: unknown }> = [];
  const off = debug.registerSink({ name: 'mission-advance-all-capture', emit: (rec) => { if (rec.category === 'task-agent') events.push(rec); } });
  try {
    const empty = await cli(['task', 'advance', '--all'], { taskStatePath: path, pieceEvidence: fakePrs({}) });
    expect(empty.code).toBeFalsy();
    const refOnly = await cli(['task', 'advance', '--all', '--pr', 'ta-none-1=5'], { taskStatePath: path, pieceEvidence: fakePrs({}) });
    expect(refOnly.code).toBe(1);
    const summaries = events.filter((e) => e.event === 'mission-advance').map((e) => e.data as { stage?: string; missions?: number; refFailures?: number; ms?: number });
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({ stage: 'all-summary', missions: 0, refFailures: 0 });
    expect(summaries[1]).toMatchObject({ stage: 'all-summary', missions: 0, refFailures: 1 });
    expect(summaries.every((summary) => typeof summary.ms === 'number')).toBe(true);
  } finally { off(); }
  const id = await diamond(path);
  const both = await cli(['task', 'advance', id, '--pr', `${id}-1=5`, '--goal', `${id}-1=abcdef0123456789`], { taskStatePath: path, pieceEvidence: fakePrs({}) });
  expect(both.code).toBe(1);
  expect(both.lines.join('\n')).toContain('두 번 줬다');
  expect(readTaskCard(`${id}-1`, path)?.pr).toBeUndefined();
});
