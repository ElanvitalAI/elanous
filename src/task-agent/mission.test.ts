import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTasksCommands } from '../cli/tasks-cli.js';
import { debug } from '../debug/log.js';
import type { SelfDevDecomposition } from '../self-dev/decompose.js';
import { assertAcyclic, handMission, missionLanded, parseListedMission, piecesFromDecomposition, readyPieces, splitMission } from './mission.js';
import { nextMoveFor, readTaskCard } from './task-hand.js';

function statePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'task-mission-')), 'task-agent-actions.json');
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

// 손으로 쪼갠 미션의 모양(조각마다 대상 경로 ⊕ 여러 줄 문면 · 선행 힌트) — 이름은 가상.
const LISTED = [
  'CELL-X — 과제 종결 어휘를 넓힌다',
  '① 대상 경로: src/example/kind.ts — 종결 종류 타입을 더한다',
  '   보존 계약: 기존 카드는 같은 수를 낸다',
  '② 판단부가 종류별 증거를 읽는다 (after: ①)',
  '③ 그림자 입력에 종류를 싣는다',
  '   after: 1',
  '④ 착지 문서를 고친다 (after: 2, 3)',
].join('\n');

const noLlm = async (): Promise<SelfDevDecomposition> => { throw new Error('나열형은 분해기를 부르지 않는다'); };

test('나열형 미션은 LLM 없이 조각 ⊕ 선후로 쪼갠다 (번호·동그라미 번호·다음 줄 after)', async () => {
  const split = await splitMission(LISTED, noLlm);
  expect(split.source).toBe('listed');
  expect(split.pieces.map((piece) => piece.after)).toEqual([[], [0], [0], [1, 2]]);
  expect(split.pieces[0]!.text).toBe('대상 경로: src/example/kind.ts — 종결 종류 타입을 더한다\n보존 계약: 기존 카드는 같은 수를 낸다');
  expect(split.pieces[1]!.text).toBe('판단부가 종류별 증거를 읽는다');
  expect(parseListedMission('- a\n- b (after: 1)\n- c')?.pieces.map((piece) => piece.after)).toEqual([[], [0], []]);
  // 통째로 들여쓴 목록도 첫 조각 수준을 기준으로 — 분해기를 부르지 않는다 · 더 깊은 줄은 그 조각의 하위.
  const indented = await splitMission('미션 머리\n  - a\n      - a 의 하위\n  - b (after: 1)', noLlm);
  expect(indented).toEqual({ source: 'listed', pieces: [{ text: 'a\n- a 의 하위', after: [] }, { text: 'b', after: [0] }] });
});

test('나열이 아니면(조각 <2) 분해기로 — dependsOn id 가 위치로 바뀐다', async () => {
  expect(parseListedMission('그냥 한 줄 미션')).toBeNull();
  expect(parseListedMission('- 하나뿐')).toBeNull();
  let called = '';
  const split = await splitMission('큰 미션 한 줄', async (text) => {
    called = text;
    return {
      goals: [{ id: 'types', feature: 'add types' }, { id: 'wire', feature: 'wire it', dependsOn: ['types'] }, { id: 'doc', feature: 'doc', dependsOn: ['types', 'wire'] }],
      decomposition: { recommendedMaxTasks: 6, actualTaskCount: 3, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'decomposed' },
    };
  });
  expect(called).toBe('큰 미션 한 줄');
  expect(split).toEqual({ source: 'decompose:decomposed', pieces: [{ text: 'add types', after: [] }, { text: 'wire it', after: [0] }, { text: 'doc', after: [0, 1] }] });
  const failed = piecesFromDecomposition({ goals: [{ id: '0', feature: '큰 미션 한 줄' }], decomposition: { recommendedMaxTasks: 6, actualTaskCount: 0, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'llm-failed', error: 'x' } });
  expect(failed).toEqual({ source: 'decompose:llm-failed', pieces: [{ text: '큰 미션 한 줄', after: [] }] });
  const meta = { recommendedMaxTasks: 6, actualTaskCount: 2, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'decomposed' as const };
  expect(() => piecesFromDecomposition({ goals: [{ id: 'a', feature: 'a', dependsOn: ['ghost'] }, { id: 'b', feature: 'b' }], decomposition: meta })).toThrow('없는 조각');
  expect(() => piecesFromDecomposition({ goals: [{ id: 'a', feature: 'a', dependsOn: ['a'] }, { id: 'b', feature: 'b' }], decomposition: meta })).toThrow('자기 자신');
});

test('잘못된 선후는 조용히 버리지 않고 멈춘다 — 없는 조각 · 자기 자신 · 고리', async () => {
  expect(() => parseListedMission('- a (after: 9)\n- b')).toThrow('없는 조각');
  expect(() => parseListedMission('- a (after: 1)\n- b')).toThrow('자기 자신');
  expect(() => parseListedMission('- a\n-\n- b')).toThrow('빈 조각');
  expect(() => parseListedMission('① a\n②  \n③ b')).toThrow('빈 조각');
  await expect(splitMission('- a (after: 2)\n- b (after: 1)', noLlm)).rejects.toThrow('고리');
  const meta = { recommendedMaxTasks: 6, actualTaskCount: 2, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'decomposed' as const };
  await expect(splitMission('한 줄', async () => ({ goals: [{ id: 'a', feature: 'a' }, { id: 'b', feature: '  ', dependsOn: ['a'] }], decomposition: meta }))).rejects.toThrow('문면이 비어');
  expect(() => assertAcyclic([{ text: 'a', after: [] }, { text: 'b', after: [0] }])).not.toThrow();
});

test('readyPieces(②의 자리) — 선행이 모두 착지한 미착지 조각만 · 전부 착지면 missionLanded', () => {
  const pieces = [{ id: 'm-1', after: [] }, { id: 'm-2', after: ['m-1'] }, { id: 'm-3', after: ['m-1'] }, { id: 'm-4', after: ['m-2', 'm-3'] }];
  expect(readyPieces(pieces, new Set())).toEqual(['m-1']);
  expect(readyPieces(pieces, new Set(['m-1']))).toEqual(['m-2', 'm-3']);
  expect(readyPieces(pieces, new Set(['m-1', 'm-2']))).toEqual(['m-3']);
  expect(readyPieces(pieces, new Set(['m-1', 'm-2', 'm-3']))).toEqual(['m-4']);
  const mission = { pieces: pieces.map((piece) => piece.id) };
  expect(missionLanded(mission, new Set(['m-1', 'm-2', 'm-3']))).toBe(false);
  expect(missionLanded(mission, new Set(['m-1', 'm-2', 'm-3', 'm-4']))).toBe(true);
  // 착지 정보가 들어오면 기다리던 조각의 다음 수가 launch 로 바뀐다.
  const card = { id: 'm-2', text: 't', createdAt: '', status: 'handed' as const, history: [], mission: 'm', after: ['m-1'] };
  expect(nextMoveFor(card, new Set())).toEqual({ kind: 'wait', reason: 'after m-1' });
  expect(nextMoveFor(card)).toEqual({ kind: 'wait', reason: 'after m-1 · 착지 미확인' });
  expect(nextMoveFor(card, new Set(['m-1'])).kind).toBe('launch');
  // 발사 실패한 조각도 선행이 먼저다 — 재발사는 선행 착지 뒤.
  expect(nextMoveFor({ ...card, status: 'launch-failed' }, new Set())).toEqual({ kind: 'wait', reason: 'after m-1' });
  expect(nextMoveFor({ ...card, status: 'launch-failed' }, new Set(['m-1'])).kind).toBe('launch');
});

test('shadow --mission → 미션 카드 1 ⊕ 조각 카드 4 · 같은 상태 파일 · 선행 없는 조각만 launch 수 · 나머지 wait after', async () => {
  const path = statePath();
  let launched = 0;
  const { lines, code } = await cli(['task', 'hand', '--mission', LISTED, '--seat', 'OP', '--checklist', 'CELL-X'], { taskStatePath: path, taskLauncher: () => { launched++; }, missionDecompose: noLlm });
  expect(code).toBeFalsy();
  expect(launched).toBe(0);
  const tasks = JSON.parse(readFileSync(path, 'utf8')).tasks as Record<string, Record<string, unknown>>;
  const mission = Object.values(tasks).find((card) => Array.isArray(card.pieces))!;
  const missionId = String(mission.id);
  expect(missionId).toStartWith('ta-');
  expect(mission).toMatchObject({ text: LISTED, seat: 'OP', checklistId: 'CELL-X', splitSource: 'listed', pieces: [1, 2, 3, 4].map((n) => `${missionId}-${n}`) });
  expect(Object.keys(tasks)).toHaveLength(5);
  expect(tasks[`${missionId}-2`]).toMatchObject({ mission: missionId, after: [`${missionId}-1`], status: 'handed', seat: 'OP', checklistId: 'CELL-X' });
  expect(tasks[`${missionId}-4`]!.after).toEqual([`${missionId}-2`, `${missionId}-3`]);
  const text = lines.join('\n');
  expect(text).toContain(`${missionId}-1\tnot launched\tlaunch`);
  expect(text).toContain('--seat OP --substrate pod --merge-by-host');
  expect(text).toContain(`${missionId}-4\tnot launched\twait (after ${missionId}-2, ${missionId}-3)`);
  expect(text).toContain(`간선: ${missionId}-1 -> ${missionId}-2`);

  const show = await cli(['task', 'show', missionId], { taskStatePath: path });
  expect(show.code).toBeFalsy();
  expect(show.lines[0]).toContain('조각 4 · 간선 4 · 출처 listed');
  expect(show.lines[0]).toContain('CELL-X — 과제 종결 어휘를 넓힌다');
  expect(show.lines.filter((line) => line.startsWith('조각: '))).toHaveLength(4);
  expect(show.lines.filter((line) => line.startsWith('간선: '))).toEqual([
    `간선: ${missionId}-1 -> ${missionId}-2`, `간선: ${missionId}-1 -> ${missionId}-3`, `간선: ${missionId}-2 -> ${missionId}-4`, `간선: ${missionId}-3 -> ${missionId}-4`,
  ]);
  const piece = await cli(['task', 'show', `${missionId}-3`], { taskStatePath: path });
  // 조각 카드가 빠지면 정상 출력처럼 보이지 않는다 — exit 1.
  const broken = JSON.parse(readFileSync(path, 'utf8'));
  delete broken.tasks[`${missionId}-4`];
  const brokenPath = statePath();
  writeFileSync(brokenPath, JSON.stringify(broken));
  const partial = await cli(['task', 'show', missionId], { taskStatePath: brokenPath });
  expect(partial.code).toBe(1);
  expect(partial.lines.join('\n')).toContain(`조각 카드 없음: ${missionId}-4`);
  expect(piece.lines.join('\n')).toContain(`미션: ${missionId} · after: ${missionId}-1`);
  expect(piece.lines.join('\n')).toContain(`다음 수: wait (after ${missionId}-1 · 착지 미확인)`);
});

test('--live --mission 은 선행 없는 조각만 발사한다 · 발사 실패는 그 조각만 launch-failed · exit 1', async () => {
  const path = statePath();
  const calls: string[][] = [];
  const ok = await cli(['task', 'hand', '--mission', '- one\n- two\n- three (after: 1, 2)', '--live', '--json'], { taskStatePath: path, taskLauncher: (args) => { calls.push(args); } });
  expect(ok.code).toBeFalsy();
  expect(calls.map((args) => args.at(-1))).toEqual(['one', 'two']);
  const result = JSON.parse(ok.lines[0]!);
  expect(result.pieces.map((piece: { launched: boolean }) => piece.launched)).toEqual([true, true, false]);
  expect(readTaskCard(result.pieces[0].card.id, path)).toMatchObject({ status: 'launched', mission: result.mission.id, after: [] });
  expect(readTaskCard(result.pieces[2].card.id, path)?.status).toBe('handed');

  const failPath = statePath();
  const live = await cli(['task', 'hand', '--mission', '- one\n- two', '--live'], { taskStatePath: failPath, taskLauncher: (args) => { if (args.at(-1) === 'two') throw new Error('boom'); } });
  expect(live.code).toBe(1);
  expect(live.lines.join('\n')).toContain('boom');
  const cards = Object.values(JSON.parse(readFileSync(failPath, 'utf8')).tasks) as Array<{ text: string; status: string; mission?: string }>;
  expect(cards.filter((card) => card.mission && card.text === 'two').map((card) => card.status)).toContain('launch-failed');
  expect(cards.filter((card) => card.mission && card.text === 'one').map((card) => card.status)).toContain('launched');
});

test('과제 한 줄과 --mission 은 하나만 · 미션 카드는 스스로 발사하지 않는다', async () => {
  const both = await cli(['task', 'hand', 'x', '--mission', '- a\n- b'], { taskStatePath: statePath() });
  expect(both.code).toBe(1);
  const none = await cli(['task', 'hand'], { taskStatePath: statePath() });
  expect(none.code).toBe(1);
  const path = statePath();
  const { mission } = await handMission({ text: '- a\n- b', statePath: path, decompose: noLlm });
  expect(nextMoveFor(mission).kind).toBe('wait');
});

test('관측 — mission-split 1 ⊕ mission-piece 조각마다 · task-agent 범주', async () => {
  const events: Array<{ event: string; data?: unknown }> = [];
  const off = debug.registerSink({ name: 'mission-capture', emit: (rec) => { if (rec.category === 'task-agent') events.push(rec); } });
  try {
    const { mission } = await handMission({ text: LISTED, statePath: statePath(), decompose: noLlm });
    const split = events.filter((e) => e.event === 'mission-split');
    expect(split).toHaveLength(1);
    expect(split[0]!.data).toMatchObject({ missionId: mission.id, pieces: 4, source: 'listed', mode: 'shadow' });
    expect((split[0]!.data as { edges: string[] }).edges).toHaveLength(4);
    const pieces = events.filter((e) => e.event === 'mission-piece');
    expect(pieces.map((e) => (e.data as { move: string }).move)).toEqual(['launch', 'wait', 'wait', 'wait']);
    expect(events.filter((e) => e.event === 'handed')).toHaveLength(1);
  } finally { off(); }
});
