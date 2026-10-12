import { describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { writeTaskCards, type TaskCard } from './task-hand.js';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { superviseRun, type SupervisorJobResult, type SupervisorStopReason } from '../self-dev/run-supervisor.js';
import { executeNextAction } from './actions.js';
import { recordTaskAgentShadowMove, replayRemoteCardMoves, REMOTE_CARD_MOVE_PENDING, selectDeliveryCandidates, shadowJudgeInput } from './shadow.js';
import type { RunLedgerEntry } from '../self-implement/run-ledger.js';

const job = (over: Partial<SupervisorJobResult> = {}): SupervisorJobResult =>
  ({ taskId: 't', feature: 'feature ask', status: 'done', ...over }) as SupervisorJobResult;

const SAMPLES: Array<[SupervisorStopReason, SupervisorJobResult[], string, string | null, string | null]> = [
  ['converged', [job({ prNumber: 7, merged: true })], 'propose-green', 'green', null],
  ['needs-human', [job({ prNumber: 8 })], 'review', 'review', null],
  ['harvestable-awaiting-human', [job({ harvestable: true, branch: 'self-impl/x' })], 'review', 'review', null],
  ['no-progress', [job()], 'narrow-relaunch', 'retry', 'narrow'],
  ['provider-exhausted', [job()], 'wait-retry', 'retry', 'wait'],
  ['step-timeout', [job()], 'wait-retry', 'retry', 'wait'],
  ['handed-off-to-salvage', [job({ salvage: 'launched' })], 'salvage-relaunch', 'retry', 'salvage'],
  ['max-rounds', [job()], 'decision-card', 'decision', null],
];

const noSweep = async () => ({ pending: 0, merged: 0 }) as never;

function deliveryFixture() {
  const root = mkdtempSync(join(tmpdir(), 'task-delivery-'));
  const worktree = join(root, 'worktree');
  const target = join(root, 'target');
  mkdirSync(worktree);
  execFileSync('git', ['init', '-q', worktree]);
  writeFileSync(join(worktree, 'report.md'), '# 조사\n출처 https://one.example/report https://two.example/report\n## 반대 근거\n다른 해석');
  writeFileSync(join(worktree, 'image.png'), 'png');
  const card = { id: 't', text: 'research', createdAt: '', status: 'launched' as const, history: [], completion: 'research-report' as const, project: { target } };
  return { worktree, target, card };
}

describe('TASK-AGENT-SHADOW — 멈춤 확정 → 판단부 → 실행부(shadow)', () => {
  test('새 파일만 종류별로 선택하고 caller 는 shadow 에서 복사 없이 경로를 남긴다', async () => {
    const { worktree, target, card } = deliveryFixture();
    expect(selectDeliveryCandidates(worktree, 'research-report')).toEqual(['report.md']);
    expect(selectDeliveryCandidates(worktree, 'artifact')).toEqual(['image.png', 'report.md']);
    for (const extension of ['html', 'pdf', 'pptx']) writeFileSync(join(worktree, `output.${extension}`), 'output');
    writeFileSync(join(worktree, 'unsupported.txt'), 'not deliverable');
    expect(selectDeliveryCandidates(worktree, 'content')).toEqual([
      'image.png', 'output.html', 'output.pdf', 'output.pptx', 'report.md',
    ]);
    writeFileSync(join(worktree, '.gitignore'), 'ignored/\n');
    mkdirSync(join(worktree, 'ignored'));
    writeFileSync(join(worktree, 'ignored', 'private.md'), 'not an output');
    mkdirSync(join(worktree, 'reports'));
    writeFileSync(join(worktree, 'reports', 'extra.md'), 'additional output');
    writeFileSync(join(worktree, 'tracked.md'), 'old');
    writeFileSync(join(worktree, 'tracked2.md'), 'old');
    execFileSync('git', ['-C', worktree, 'add', 'tracked.md', 'tracked2.md']);
    writeFileSync(join(worktree, 'tracked.md'), 'modified');
    expect(selectDeliveryCandidates(worktree, 'research-report')).toEqual(['report.md', join('reports', 'extra.md')]);
    let commands = 0;
    const out = await recordTaskAgentShadowMove({ runId: 'run-delivery', stopReason: 'converged', results: [job({ ok: true, worktreePath: worktree })] }, {
      readCard: () => card, log: () => {}, command: async () => { commands++; throw new Error('command called'); },
    });
    expect(out).toMatchObject({ move: 'wait', executorKind: 'deliver', executorResult: 'shadow', pr: null });
    expect(out.wouldDo).toContain(join(target, 'elanous-out', 't'));
    expect(commands).toBe(0);
    expect(existsSync(target)).toBe(false);
    const code = await recordTaskAgentShadowMove({ runId: 'run-delivery', stopReason: 'converged', results: [job({ ok: true, worktreePath: worktree })] }, {
      readCard: () => ({ ...card, completion: 'code-pr' }), log: () => {},
    });
    expect(code.move).toBe('wait');
    expect(code.executorResult).toBeNull();
    expect(code.wouldDo).toBeNull();
    expect(commands).toBe(0);
  });

  test('plain temporary folder is eligible as a new-output worktree', () => {
    const folder = mkdtempSync(join(tmpdir(), 'plain-report-'));
    writeFileSync(join(folder, 'report.md'), 'research report');
    expect(selectDeliveryCandidates(folder, 'research-report')).toEqual(['report.md']);
  });

  test('supervisor taskId differs from card id: unique launched feature resolves card without custom lookup', async () => {
    const { worktree, card, target } = deliveryFixture();
    // 운영 상태 파일(taskAgentStatePath)을 덮어쓰지 않는다 — 임시 statePath 를 주입한다.
    const statePath = join(mkdtempSync(join(tmpdir(), 'shadow-state-')), 'task-agent-actions.json');
    const unique = `research-${Date.now()}-${Math.random()}`;
    writeFileSync(statePath, JSON.stringify({ tasks: { 'ta-real': { ...card, id: 'ta-real', text: unique } } }));
    const out = await recordTaskAgentShadowMove({ runId: 'run-shadow', stopReason: 'converged', results: [job({ taskId: 'self-dev-other', feature: unique, ok: true, worktreePath: worktree })] }, { log: () => {}, statePath });
    expect(out.executorKind).toBe('deliver');
    expect(out.wouldDo).toContain(join(target, 'elanous-out', 'ta-real'));
    expect(existsSync(target)).toBe(false);
  });

  test('card lookup order: taskId → unique runId (TA-LIVE-LAND-2) → unique feature; ambiguous runId does not guess', async () => {
    // 운영 상태 파일(taskAgentStatePath)을 덮어쓰지 않는다 — 임시 statePath 를 주입한다 · 상속 env 도 비운다(결정적).
    const path = join(mkdtempSync(join(tmpdir(), 'shadow-run-card-')), 'task-agent-actions.json');
    const card = (id: string, runId: string, text: string): TaskCard => ({ id, runId, text, createdAt: '', status: 'launched', history: [] });
    const observations: Array<Record<string, unknown>> = [];
    const log = (_category: string, _event: string, data: Record<string, unknown>) => observations.push(data);
    const deps = { log, statePath: path, env: {} };
    writeFileSync(path, JSON.stringify({ tasks: { 'ta-run': card('ta-run', 'run-target', 'a different goal') } }));
    const input = { runId: 'run-target', stopReason: 'needs-human' as const, results: [job({ taskId: 'unknown', feature: 'unmatched', prNumber: 12 })] };
    await recordTaskAgentShadowMove(input, deps);
    expect(observations.at(-1)?.card).toBe('ta-run');
    writeTaskCards(path, [card('ta-direct', 'other', 'direct'), card('ta-feature', 'other2', 'unmatched')]);
    // 런 id 에 유일하게 묶인 카드가 발사 문장 일치보다 앞선다(main TA-LIVE-LAND-2 순서).
    await recordTaskAgentShadowMove(input, deps);
    expect(observations.at(-1)?.card).toBe('ta-run');
    await recordTaskAgentShadowMove({ ...input, results: [job({ taskId: 'ta-direct', feature: 'unmatched', prNumber: 12 })] }, deps);
    expect(observations.at(-1)?.card).toBe('ta-direct');
    writeTaskCards(path, [card('ta-run-two', 'run-target', 'different')]);
    // 런 id 가 둘에 묶이면 추측하지 않고 유일한 발사 문장으로 간다.
    await recordTaskAgentShadowMove(input, deps);
    expect(observations.at(-1)?.card).toBe('ta-feature');
    await recordTaskAgentShadowMove({ ...input, results: [job({ taskId: 'unknown', feature: 'no match', prNumber: 12 })] }, deps);
    expect(observations.at(-1)?.card).toBeNull();
  });

  test('Pod child run: judge fallback finds the run-owned card only through an exactly equal inherited ELANOUS_RUN_ID; a different value misses with a reason', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'shadow-env-run-')), 'task-agent-actions.json');
    const card: TaskCard = { id: 'ta-run-parent', runId: 'run-parent', text: 'adopted goal', createdAt: '', status: 'launched', history: [] };
    writeFileSync(path, JSON.stringify({ tasks: { [card.id]: card } }));
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = (_c: string, event: string, data: Record<string, unknown>) => events.push({ event, data });
    // 결과의 taskId·문장은 카드와 다르고 입력 runId 는 Pod 자식 것 — 성공한 결과(작업 트리)라 판단부 조회를 탄다.
    const input = { runId: 'run-child', stopReason: 'needs-human' as const, results: [job({ taskId: 'self-dev-x', feature: 'authored goal', ok: true, worktreePath: '/tmp/wt-env', prNumber: 12 })] };
    await recordTaskAgentShadowMove(input, { log, statePath: path, env: { ELANOUS_RUN_ID: 'run-parent' } });
    expect(events.find((entry) => entry.event === 'shadow-move')?.data).toMatchObject({ card: 'ta-run-parent', completion: 'code-pr' });
    expect(events.some((entry) => entry.event === 'run-card-fallback-missed')).toBe(false);
    events.length = 0;
    await recordTaskAgentShadowMove(input, { log, statePath: path, env: { ELANOUS_RUN_ID: 'run-parent-2' } });
    expect(events.find((entry) => entry.event === 'shadow-move')?.data).toMatchObject({ card: null, completion: null });
    const missed = events.filter((entry) => entry.event === 'run-card-fallback-missed');
    expect(missed).toHaveLength(1);
    expect(missed[0]!.data).toMatchObject({ runId: 'run-child', inheritedRunId: 'run-parent-2' });
    expect(String(missed[0]!.data.reason)).toContain('ELANOUS_RUN_ID run-parent-2: no card has this runId');
  });

  test('원격 Pod 카드 파일이 없어도 전달된 카드 id 로 미결 수를 런 원장에 보존하고 live 실행은 보류한다', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'remote-card-child-')), 'task-agent-actions.json');
    const queued: RunLedgerEntry[] = [];
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const out = await recordTaskAgentShadowMove({ runId: 'run-child-1', stopReason: 'needs-human', results: [job({ taskId: 'orchestrator-task', feature: 'authored goal', prNumber: 26761 })] }, {
      statePath, env: { ELANOUS_POD_NAME: 'pod-a', ELANOUS_PARENT_RUN_ID: 'run-parent-1', ELANOUS_TASK_CARD_ID: 'ta-real-card' },
      liveMoves: new Set(['review']), queueMove: (entry) => queued.push(entry),
      log: (_c, event, data) => events.push({ event, data }),
    });
    expect(out.move).toBe('review');
    expect(out.liveMove).toBeUndefined();
    expect(events.find((event) => event.event === 'shadow-move')?.data).toMatchObject({ card: 'ta-real-card', cardBinding: 'pending', live: false });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ runId: 'run-child-1', event: REMOTE_CARD_MOVE_PENDING,
      data: { card: 'ta-real-card', parentRunId: 'run-parent-1', kind: 'review', pr: 26761, executorResult: 'shadow' } });
  });

  test('원격 Pod 의 카드 id 가 같아도 부모 runId 가 다른 현지 카드는 결선하지 않는다', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'remote-card-wrong-')), 'task-agent-actions.json');
    writeTaskCards(statePath, [{ id: 'ta-real-card', runId: 'run-other-parent', text: 'same goal', createdAt: '', status: 'launched', history: [] }]);
    const queued: RunLedgerEntry[] = [];
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    await recordTaskAgentShadowMove({ runId: 'run-child-1', stopReason: 'needs-human', results: [job({ feature: 'same goal', prNumber: 26761 })] }, {
      statePath, env: { ELANOUS_POD_NAME: 'pod-a', ELANOUS_PARENT_RUN_ID: 'run-parent-1', ELANOUS_TASK_CARD_ID: 'ta-real-card' },
      liveMoves: new Set(['review']), queueMove: (entry) => queued.push(entry),
      log: (_c, event, data) => events.push({ event, data }),
    });
    expect(events.find((entry) => entry.event === 'shadow-move')?.data).toMatchObject({ card: 'ta-real-card', cardBinding: 'pending', live: false });
    expect(queued).toHaveLength(1);
    expect(JSON.parse(await Bun.file(statePath).text()).tasks['ta-real-card'].history).toEqual([]);
  });

  test('원격 Pod 에 부모 runId 가 없으면 같은 id 의 현지 카드도 live 결선하지 않는다', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'remote-card-no-parent-')), 'task-agent-actions.json');
    writeTaskCards(statePath, [{ id: 'ta-real-card', runId: 'run-parent-1', text: 'same goal', createdAt: '', status: 'launched', history: [] }]);
    const queued: RunLedgerEntry[] = [];
    const out = await recordTaskAgentShadowMove({ runId: 'run-child-1', stopReason: 'needs-human', results: [job({ feature: 'same goal', prNumber: 26761 })] }, {
      statePath, env: { ELANOUS_POD_NAME: 'pod-a', ELANOUS_TASK_CARD_ID: 'ta-real-card' },
      liveMoves: new Set(['review']), queueMove: (entry) => queued.push(entry), log: () => {},
    });
    expect(out.liveMove).toBeUndefined();
    expect(out.cardBinding).toBe('pending');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.data).toMatchObject({ card: 'ta-real-card', parentRunId: null });
    expect(JSON.parse(await Bun.file(statePath).text()).tasks['ta-real-card'].history).toEqual([]);
  });

  test('원격 카드 미결 수의 원장 기록 실패를 호출자에게 돌려준다', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'remote-card-queue-failed-')), 'task-agent-actions.json');
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const out = await recordTaskAgentShadowMove({ runId: 'run-child-1', stopReason: 'needs-human', results: [job({ prNumber: 26761 })] }, {
      statePath, env: { ELANOUS_POD_NAME: 'pod-a', ELANOUS_PARENT_RUN_ID: 'run-parent-1' },
      liveMoves: new Set(['review']), queueMove: () => { throw new Error('ledger unavailable'); },
      log: (_category, event, data) => events.push({ event, data }),
    });
    expect(out.cardBinding).toBe('queue-failed');
    expect(out.liveMove).toBeUndefined();
    expect(events.map(({ event }) => event)).toContain('card-binding-queue-failed');
    expect(events.find(({ event }) => event === 'shadow-move')?.data.cardBinding).toBe('queue-failed');
  });

  test('카드 ID 없는 원격 Pod 는 현지 문장·taskId 카드를 추정하지 않고 HQ 역조회 대기열로 보낸다', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'remote-card-no-id-')), 'task-agent-actions.json');
    writeTaskCards(statePath, [{ id: 'ta-stale-local', runId: 'run-child-1', text: 'same goal', createdAt: '', status: 'launched', history: [] }]);
    const queued: RunLedgerEntry[] = [];
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const input = { runId: 'run-child-1', stopReason: 'needs-human' as const,
      results: [job({ taskId: 'ta-stale-local', feature: 'same goal', prNumber: 26761 })] };
    const remote = await recordTaskAgentShadowMove(input, {
      statePath, env: { ELANOUS_POD_NAME: 'pod-a', ELANOUS_PARENT_RUN_ID: 'run-parent-1' },
      liveMoves: new Set(['review']), queueMove: (entry) => queued.push(entry),
      log: (_c, event, data) => events.push({ event, data }),
    });
    expect(remote.liveMove).toBeUndefined();
    expect(events.find((entry) => entry.event === 'shadow-move')?.data).toMatchObject({ card: null, cardBinding: 'pending', live: false });
    expect(queued[0]?.data).toMatchObject({ card: null, parentRunId: 'run-parent-1' });
    expect(JSON.parse(await Bun.file(statePath).text()).tasks['ta-stale-local'].history).toEqual([]);
    const local = await recordTaskAgentShadowMove(input, {
      statePath: join(mkdtempSync(join(tmpdir(), 'local-card-no-id-')), 'task-agent-actions.json'), env: {},
      liveMoves: new Set(['review']), log: () => {},
    });
    expect(local.liveMove).toMatchObject({ kind: 'review', executed: false, card: null, ok: false });
  });

  test('HQ 는 원격 자식 미결 수를 부모 runId 간선으로 회수하며 중복 조회·다른 카드 id 를 거부한다', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'remote-card-hq-')), 'task-agent-actions.json');
    const card: TaskCard = { id: 'ta-hq-card', runId: 'run-parent-1', parentHost: { host: 'wsl' },
      text: 'handed sentence', createdAt: new Date().toISOString(), status: 'launched', history: [] };
    writeTaskCards(statePath, [card]);
    const parent: RunLedgerEntry[] = [{ runId: card.runId!, event: 'pod-child-run', data: { childRunId: 'run-child-1' } }];
    const child: RunLedgerEntry[] = [
      { timestamp: '2026-10-12T12:00:00.000Z', runId: 'run-child-1', event: REMOTE_CARD_MOVE_PENDING,
        data: { id: '00000000-0000-4000-8000-000000000001', card: card.id, parentRunId: card.runId, kind: 'review', pr: 26761, detail: 'review needed' } },
      { timestamp: '2026-10-12T12:01:00.000Z', runId: 'run-child-1', event: REMOTE_CARD_MOVE_PENDING,
        data: { id: '00000000-0000-4000-8000-000000000002', card: 'ta-other-card', parentRunId: card.runId, kind: 'review', pr: 26762, detail: 'wrong card' } },
      { timestamp: '2026-10-12T12:02:00.000Z', runId: 'run-child-1', event: REMOTE_CARD_MOVE_PENDING,
        data: { id: '00000000-0000-4000-8000-000000000003', card: null, parentRunId: card.runId, kind: 'propose-land', pr: 26761, detail: 'runId fallback' } },
    ];
    const evidence = { loadLedger: (id: string) => id === card.runId ? parent : id === 'run-child-1' ? child : null,
      podFinishes: () => [] };
    expect(await replayRemoteCardMoves(card.id, statePath, evidence)).toBe(2);
    expect(await replayRemoteCardMoves(card.id, statePath, evidence)).toBe(0);
    const written = JSON.parse(await Bun.file(statePath).text()).tasks[card.id].history;
    expect(written.map((entry: { sourceId?: string }) => entry.sourceId)).toEqual([
      '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003',
    ]);
    expect(written[1]).toMatchObject({ event: 'live-move', kind: 'propose-land', executorResult: 'shadow', pr: 26761, runId: 'run-child-1' });
  });

  test('live caller delivers verified report with no PR', async () => {
    const { worktree, target, card } = deliveryFixture();
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const out = await recordTaskAgentShadowMove({ runId: 'run-live', stopReason: 'converged', results: [job({ ok: true, worktreePath: worktree })] }, {
        mode: 'live', readCard: () => card, log: () => {}, command: async () => { throw new Error('commands forbidden'); },
      });
      const report = join(target, 'elanous-out', 't', 'report.md');
      expect(existsSync(report)).toBe(true);
      expect(out).toMatchObject({ move: 'propose-green', executorResult: 'done', pr: null, wouldDo: null });
      expect(log.mock.calls.some(call => call[0] === 'task-agent' && call[1] === 'deliver' &&
        (call[2] as { taskId: string; kind: string; files: string[]; evidenceOk: boolean }).taskId === 't' &&
        (call[2] as { files: string[]; evidenceOk: boolean }).files.includes(report) &&
        (call[2] as { evidenceOk: boolean }).evidenceOk === true)).toBe(true);
    } finally { log.mockRestore(); }
  });

  test('후보 0이면 wait 전달 후보 없음', async () => {
    const { worktree, card, target } = deliveryFixture();
    execFileSync('git', ['-C', worktree, 'add', 'report.md']);
    const out = await recordTaskAgentShadowMove({ runId: 'run', stopReason: 'converged', results: [job({ ok: true, worktreePath: worktree })] }, {
      readCard: () => card, log: () => {}, mode: 'live',
    });
    expect(out.move).toBe('wait');
    expect(out.reason).toBe('전달 후보 없음');
    expect(out.executorKind).toBeNull();
    expect(existsSync(target)).toBe(false);
  });

  test('completion absent or ok false preserves legacy judgement and never delivers', async () => {
    const { worktree, card, target } = deliveryFixture();
    for (const [overrides, completion] of [
      [{ ok: true, worktreePath: worktree }, undefined],
      [{ ok: false, worktreePath: worktree }, card.completion],
      [{ ok: true }, card.completion],
    ] as const) {
      const out = await recordTaskAgentShadowMove({ runId: 'run', stopReason: 'converged', results: [job(overrides)] }, {
        readCard: () => ({ ...card, completion }), log: () => {}, mode: 'live',
      });
      expect(out.move).toBe('wait');
      expect(out.executorKind).toBeNull();
      expect(existsSync(target)).toBe(false);
    }
  });

  test('종료 어휘 8표본 → shadow-move 하나씩 · 실제 명령 0', async () => {
    const events: Array<Record<string, unknown>> = [];
    let commands = 0;
    for (const [stopReason, results, move, kind, variant] of SAMPLES) {
      const out = await recordTaskAgentShadowMove({ runId: `run-${stopReason}`, stopReason, results }, {
        log: (category, event, data) => { expect([category, event]).toEqual(['task-agent', 'shadow-move']); events.push(data); },
        command: async () => { commands++; return { status: 0, stdout: '' }; },
      });
      expect(out.move).toBe(move as never);
      expect(out.executorKind).toBe(kind as never);
      expect(out.variant).toBe(variant as never);
      expect(out.executorResult).toBe('shadow');
      expect(out.wouldDo).toStartWith(`would ${kind}${variant ? `:${variant}` : ''}`);
    }
    expect(events).toHaveLength(8);
    expect(events.map((e) => e.stopReason)).toEqual(SAMPLES.map(([s]) => s));
    expect(events.every((e) => typeof e.runId === 'string' && typeof e.reason === 'string')).toBe(true);
    expect(commands).toBe(0);
  });

  test('PR 상태는 결과에 실린 값만 쓴다 — 병합이 아니면 OPEN · PR 없으면 비운다', () => {
    expect(shadowJudgeInput('converged', [job({ prNumber: 3, merged: true })])).toEqual({ stopReason: 'converged', pr: 3, prState: 'MERGED' });
    expect(shadowJudgeInput('converged', [job({ prNumber: 3 })])).toEqual({ stopReason: 'converged', pr: 3, prState: 'OPEN' });
    expect(shadowJudgeInput('no-progress', [job()])).toEqual({ stopReason: 'no-progress' });
  });

  test('G1 — must-fix 없는 no-progress 는 live 에서도 결정 카드가 아니라 좁힌 재발사 · wait-retry 는 대기 표지', async () => {
    const calls: string[][] = [];
    const deps = { mode: 'live', command: async (args: string[]) => { calls.push(args); return { status: 0, stdout: '' }; }, observe: () => {} };
    const base = { taskId: 'T', rationale: 'r', pr: 0, runId: 'run-9', original: 'verbatim ask', checklistId: '' };
    expect(await executeNextAction({ ...base, kind: 'retry', variant: 'narrow' }, deps)).toBe('done');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 2)).toEqual(['harness', 'say']);
    expect(calls[0]![2]).toStartWith('verbatim ask');
    expect(calls[0]![2]).toContain('Narrow relaunch');
    expect(calls.some((c) => c[0] === 'decisions')).toBe(false);
    expect(await executeNextAction({ ...base, kind: 'retry', variant: 'wait' }, deps)).toBe('waiting');
    expect(calls).toHaveLength(1);
  });

  test('G2 — 갈래마다 재발사 문면과 실패 칸이 다르다', async () => {
    const calls: string[][] = [];
    const failureCounts: Record<string, number> = {};
    const deps = { mode: 'live', failureCounts, command: async (args: string[]) => { calls.push(args); return { status: 1, stdout: '', stderr: 'x' }; }, observe: () => {} };
    const base = { taskId: 'T', rationale: 'r', pr: 0, runId: 'run-9', original: 'ask', checklistId: '', kind: 'retry' as const };
    for (const variant of ['narrow', 'salvage', 'alternative'] as const) await executeNextAction({ ...base, variant, salvageBranch: 'salvage/x' }, deps);
    expect(new Set(calls.map((c) => c[2])).size).toBe(3);
    expect(calls[1]![2]).toContain('salvage/x');
    expect(Object.keys(failureCounts).sort()).toEqual([
      JSON.stringify(['T', 'retry', 'alternative']),
      JSON.stringify(['T', 'retry', 'narrow']),
      JSON.stringify(['T', 'retry', 'salvage']),
    ].sort());
  });

  test('슈퍼바이저가 멈춤을 확정하면 기본 훅이 shadow-move 를 남긴다', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      await superviseRun({
        initial: [job({ stage: 'review-blocked', status: 'failed', salvage: 'launched' })],
        rerun: async (p) => p,
        sweepPendingMerges: noSweep,
        runStore: { runId: 'run-hook', dir: mkdtempSync(join(tmpdir(), 'task-agent-shadow-')) },
      });
      const shadow = log.mock.calls.filter((c) => c[0] === 'task-agent' && c[1] === 'shadow-move');
      expect(shadow).toHaveLength(1);
      expect(shadow[0]![2]).toMatchObject({ runId: 'run-hook', stopReason: 'handed-off-to-salvage', move: 'salvage-relaunch', executorKind: 'retry', executorResult: 'shadow' });
    } finally { log.mockRestore(); }
  });

  test('훅이 던져도 런의 결말은 같다', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const initial = [job({ stage: 'review-blocked', status: 'failed', salvage: 'launched' })];
      const opts = { initial, rerun: async (p: readonly SupervisorJobResult[]) => p, sweepPendingMerges: noSweep };
      const quiet = await superviseRun({ ...opts, taskAgentShadow: false });
      const sync = await superviseRun({ ...opts, taskAgentShadow: () => { throw new Error('boom'); } });
      const asyncThrow = await superviseRun({ ...opts, taskAgentShadow: async () => { throw new Error('boom'); } });
      expect(sync).toEqual(quiet);
      expect(asyncThrow).toEqual(quiet);
      expect(log.mock.calls.filter((c) => c[0] === 'task-agent' && c[1] === 'shadow-move-failed')).toHaveLength(2);
    } finally { log.mockRestore(); }
  });
});

describe('종결 종류를 판단부 입력·shadow-move 관측에 싣는다 (RFC-loop-agent-map §A4b③)', () => {
  test('shadowJudgeInput 은 completion 을 주면 싣고 안 주면 종전 입력 그대로', () => {
    expect(shadowJudgeInput('converged', [job()], 'ops-action')).toEqual({ stopReason: 'converged', completion: 'ops-action' });
    expect(shadowJudgeInput('converged', [job()], undefined)).toEqual({ stopReason: 'converged' });
  });

  test('파일 전달 밖 종류(ops-action)는 확인 증거를 기다리고 shadow-move 에 completion 을 남긴다 · code-pr 은 종전 문면', async () => {
    const { worktree, card } = deliveryFixture();
    const logged: Array<Record<string, unknown>> = [];
    const log = (_c: string, _e: string, data: Record<string, unknown>) => { logged.push(data); };
    const ops = await recordTaskAgentShadowMove({ runId: 'run', stopReason: 'converged', results: [job({ ok: true, worktreePath: worktree })] }, {
      readCard: () => ({ ...card, completion: 'ops-action' }), log,
    });
    expect(ops.move).toBe('wait');
    expect(ops.reason).toBe('확인 증거 대기 — ops-action');
    expect(ops.executorKind).toBeNull();
    expect(logged.at(-1)).toMatchObject({ completion: 'ops-action' });
    const pr = await recordTaskAgentShadowMove({ runId: 'run', stopReason: 'converged', results: [job({ ok: true, worktreePath: worktree })] }, {
      readCard: () => ({ ...card, completion: 'code-pr' }), log,
    });
    expect(pr.reason).toBe('완주했으나 PR 병합 근거 대기');
    expect(logged.at(-1)).toMatchObject({ completion: 'code-pr' });
    // 카드를 안 본 경우 — 상속 ELANOUS_RUN_ID·기본 상태 파일(같은 프로세스의 다른 시험이 남긴 카드)에 기대지 않게 비운다.
    const emptyState = join(mkdtempSync(join(tmpdir(), 'shadow-no-card-')), 'task-agent-actions.json');
    await recordTaskAgentShadowMove({ runId: 'run', stopReason: 'no-progress', results: [job()] }, { log, env: {}, statePath: emptyState });
    expect(logged.at(-1)).toMatchObject({ completion: null });
    const legacy = await recordTaskAgentShadowMove({ runId: 'run', stopReason: 'converged', results: [job({ ok: true, worktreePath: worktree })] }, {
      readCard: () => ({ ...card, completion: undefined }), log,
    });
    expect(legacy.reason).toBe('완주했으나 PR 병합 근거 대기');
    expect(logged.at(-1)).toMatchObject({ completion: 'code-pr' });
  });

  test('카드 조회 실패는 종결 종류 «미확인» — 관측에 unmeasured · reason 에 표지(수는 종전 판단 그대로)', async () => {
    const { worktree } = deliveryFixture();
    const logged: Array<Record<string, unknown>> = [];
    const out = await recordTaskAgentShadowMove({ runId: 'run', stopReason: 'converged', results: [job({ ok: true, worktreePath: worktree })] }, {
      readCard: () => { throw new Error('state unreadable'); }, log: (_c, _e, data) => { logged.push(data); },
    });
    expect(out.move).toBe('wait');
    expect(out.reason).toBe('완주했으나 PR 병합 근거 대기 · 종결 종류 미확인(카드 조회 실패)');
    expect(logged.at(-1)).toMatchObject({ completion: 'unmeasured' });
  });

  test('decision-card live 배선은 실제 실패 근거를 받은 카드에 한 번 올린다', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'shadow-decision-live-')), 'task-agent-actions.json');
    const card: TaskCard = { id: 'ta-decision', text: 'feature ask', createdAt: '', status: 'launched', runId: 'run-decision', history: [] };
    writeTaskCards(path, [card]);
    const raised: string[][] = [];
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const out = await recordTaskAgentShadowMove({ runId: 'run-decision', stopReason: 'max-rounds', results: [job({
      status: 'failed', error: { code: 'implement-abort', message: 'child stopped after budget' }, reviewMustFix: ['missing contract'],
    })] }, {
      statePath: path, liveMoves: new Set(['decision-card']),
      live: { statePath: path, raiseDecision: async (args) => { raised.push(args); return { status: 0, stdout: '' }; } },
      log: (_category, event, data) => { events.push({ event, data }); },
    });
    expect(out.move).toBe('decision-card');
    expect(out.liveMove).toMatchObject({ kind: 'decision-card', card: 'ta-decision', executed: true, ok: true });
    expect(raised).toHaveLength(1);
    expect(raised[0]!.join(' ')).toContain('child stopped after budget');
    expect(raised[0]!.join(' ')).toContain('missing contract');
    expect(events.find((entry) => entry.event === 'shadow-move')?.data).toMatchObject({ card: 'ta-decision', live: true, liveExecuted: true });
  });

  test('decision-card는 근거가 없으면 발신하지 않고 설정에 없으면 그림자 관측을 유지한다', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'shadow-decision-empty-')), 'task-agent-actions.json');
    writeTaskCards(path, [{ id: 'ta-decision-empty', text: 'feature ask', createdAt: '', status: 'launched', runId: 'run-empty', history: [] }]);
    const raised: string[][] = [];
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const input = { runId: 'run-empty', stopReason: 'max-rounds' as const, results: [job()] };
    const deps = { statePath: path, live: { statePath: path, raiseDecision: async (args: string[]) => { raised.push(args); return { status: 0, stdout: '' }; } },
      log: (_category: string, event: string, data: Record<string, unknown>) => { events.push({ event, data }); } };
    const noEvidence = await recordTaskAgentShadowMove(input, { ...deps, liveMoves: new Set(['decision-card']) });
    expect(noEvidence.liveMove).toMatchObject({ kind: 'decision-card', executed: false, ok: false });
    expect(raised).toHaveLength(0);
    events.length = 0;
    const shadow = await recordTaskAgentShadowMove(input, { ...deps, liveMoves: new Set() });
    expect(shadow.move).toBe('decision-card');
    expect(shadow.liveMove).toBeUndefined();
    expect(events.find((entry) => entry.event === 'shadow-move')?.data).toMatchObject({ live: false, liveExecuted: false });
    expect(raised).toHaveLength(0);
  });
});
