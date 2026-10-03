// ── S4 P3 자동 종료 **배선** 런타임 회귀 가드 (2026-07-27) ─────────────────────────
//
// ⚠️ **왜 순수 테스트로 부족한가** — `auto-intervene.test.ts` 는 `decideAutoStop` 만 검증한다.
// 그러니 드라이버가 그 함수를 **아예 안 부르거나**, 잘못된 입력(엉뚱한 rung·config 미전달)으로
// 부르거나, `stop:true` 를 받고도 루프를 안 끊어도 **전부 통과**한다. 이 트랙의 실제 계약은
// *"확증된 stall 에서 done 제안이 부모 대기를 끊는다"* 이므로 **실제 호출로** 잠근다.
//
// ⭐ 이 테스트가 존재하는 경위 — self-dev 하니스로 P3 를 구현할 때 무인 리뷰가 정확히
//   *"드라이버 통합 테스트가 없다"* 를 must-fix 로 냈는데, 반사-기각(`review-reflect`)이
//   *"goal 의 필수 회귀 테스트 범위…"* 라며 **기각**했다. 골 스펙(내가 쓴 것)이 순수 테스트만
//   요구했기 때문이다 — 설계 §9-7 의 *"반사-기각은 골이 옳다고 가정한다"* 가 그대로 재현됐다.
//   리뷰가 옳았으므로 직접 채운다.
//
// 시계: stall 사다리는 15s·60s·**5min** 이라 실시간으로는 검증 불가 ⇒ 드라이버의 **관측 시계 seam**
// (`nowMs`)으로 가상 시간을 준다. 타임아웃 축은 이 시계를 쓰지 않는다(실시간 그대로).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, spyOn } from 'bun:test';
import type { ControlObservation, RunSupervisor } from '../src/autopilot/pty-control-loop.js';
import { runHeadlessGoalLoopPty } from '../src/self-implement/headless-elanous-driver.js';
import { STALL_RUNGS_MS } from '../src/capture/frame-observation.js';
import { debug } from '../src/debug/log.js';
import { runSelfImplement, type SelfImplementSeams } from '../src/self-implement/orchestrator.js';
import { defaultSeams } from '../src/self-implement/seams.js';

/** 화면이 **끝까지 바뀌지 않는** 자식 — stall 을 만들기 위한 대역. 살아 있는 채로 계속 폴린다. */
function stalledHandle(maxPolls: number) {
  let polls = 0;
  let writes = 0;
  const handle = {
    id: 'pty_autostop_test', cmd: 'bun', workdir: '/w', startedAt: 0, lastActivityAt: 0, detach: false,
    exitCode: null as number | null, exitSignal: undefined,
    isAlive: () => handle.exitCode === null,
    appendOutput() {},
    // 상한에 닿으면 종료시켜 테스트가 무한히 돌지 않게(자동 종료가 안 걸리는 경우의 안전망).
    drainDelta() { polls += 1; if (polls >= maxPolls) handle.exitCode = 0; return ''; },
    snapshot: () => '',
    write() { writes += 1; },
    canWrite: () => true,
    kill() { handle.exitCode = 0; }, resize() {},
    renderScreen: async () => 'FROZEN SCREEN',   // ★ 항상 동일 = 화면 정지
    renderScreenPng: async () => null,
  };
  return { handle, spawn: (() => handle) as never, polls: () => polls, writes: () => writes };
}

/** 가상 시계 — 매 호출마다 `stepMs` 만큼 전진(관측 타임스탬프에만 쓰인다). */
function virtualClock(stepMs: number): () => number {
  let t = 1_000_000;
  return () => { t += stepMs; return t; };
}

async function run(o: {
  brain: RunSupervisor;
  autoStop?: { enabled: boolean; minRung: number };
  stepMs?: number;
  maxPolls?: number;
}) {
  const fake = stalledHandle(o.maxPolls ?? 40);
  const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
  const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
    if (category === 'self-implement') events.push({ event, ...(data ? { data } : {}) });
  }) as never);
  try {
    const result = await runHeadlessGoalLoopPty({
      binRoot: '/r', cwd: '/w', featurePrompt: 'x', pollMs: 1, maxWaitSec: 30,
      spawn: fake.spawn, ptyAvailable: () => true, brain: o.brain,
      nowMs: virtualClock(o.stepMs ?? 2_000),
      ...(o.autoStop ? { autoStop: o.autoStop } : {}),
    });
    return { result, events, polls: fake.polls(), writes: fake.writes() };
  } finally {
    spy.mockRestore();
  }
}

const DONE_BRAIN: RunSupervisor = { decide: () => ({ action: 'done', reason: '자식이 멈춰 있다' }) };
const WAIT_BRAIN: RunSupervisor = { decide: () => ({ action: 'wait' }) };
/** rung 2(5min) 를 몇 tick 안에 넘기는 보폭 — 사다리 상수에서 유도한다(하드코딩 금지). */
const BIG_STEP = Math.ceil(STALL_RUNGS_MS[STALL_RUNGS_MS.length - 1]! / 4);

describe('S4 P3 자동 종료 — 드라이버 배선(런타임)', () => {
  it('⭐ 확증된 stall + done 제안이면 부모 대기를 끊고 brain.applied 를 남긴다', async () => {
    const r = await run({ brain: DONE_BRAIN, autoStop: { enabled: true, minRung: 2 }, stepMs: BIG_STEP });
    const applied = r.events.find(e => e.event === 'brain.applied');
    expect(applied).toBeDefined();
    expect(applied!.data).toMatchObject({ action: 'done' });
    expect(Number(applied!.data!.stallRung)).toBeGreaterThanOrEqual(2);
    // ★ 실제로 **일찍** 끝났다 — 개입이 없을 때의 기준선보다 적게 폴했다.
    //   ⚠️ 절대 폴 수로 단정하지 않는다(리뷰 규율) — 루프는 maxPolls 이전에 soft 타임아웃으로도
    //      끝나므로 상한은 계약이 아니다. **개입 유무의 차이**가 계약이다.
    const baseline = (await run({ brain: WAIT_BRAIN, autoStop: { enabled: true, minRung: 2 }, stepMs: BIG_STEP })).polls;
    expect(r.polls).toBeLessThan(baseline);
    expect(r.result.timedOut).toBe(false);
    // 종료 축이지 쓰기 축이 아니다.
    expect(r.writes).toBe(0);
  });

  it('⭐ 노브가 꺼져 있으면(기본) 같은 상황에서 끊지 않는다 — 기본 동작 무회귀', async () => {
    const r = await run({ brain: DONE_BRAIN, stepMs: BIG_STEP });   // autoStop 미지정 = 기본 OFF
    expect(r.events.some(e => e.event === 'brain.applied')).toBe(false);
    expect(r.events.some(e => e.event === 'brain.suggestion')).toBe(true);
    const baseline = (await run({ brain: WAIT_BRAIN, autoStop: { enabled: true, minRung: 2 }, stepMs: BIG_STEP })).polls;
    expect(r.polls).toBe(baseline);   // 기준선과 동일 = 개입 0
    expect(r.writes).toBe(0);
  });

  it('⭐ 확증이 부족하면(문턱 미달) 끊지 않는다 — LLM 단독 판단 금지', async () => {
    // 보폭을 작게 해 rung 2 에 못 닿게 한다. 노브는 켜져 있다.
    const r = await run({ brain: DONE_BRAIN, autoStop: { enabled: true, minRung: 2 }, stepMs: 100 });
    expect(r.events.some(e => e.event === 'brain.applied')).toBe(false);
    const baseline = (await run({ brain: WAIT_BRAIN, autoStop: { enabled: true, minRung: 2 }, stepMs: 100 })).polls;
    expect(r.polls).toBe(baseline);
  });

  it('⭐ input 제안은 확증이 서 있어도 절대 끊지도 쓰지도 않는다 (안전 불변식)', async () => {
    const brain: RunSupervisor = { decide: () => ({ action: 'input', text: 'yes' }) };
    const r = await run({ brain, autoStop: { enabled: true, minRung: 2 }, stepMs: BIG_STEP });
    expect(r.events.some(e => e.event === 'brain.applied')).toBe(false);
    expect(r.writes).toBe(0);
    const baseline = (await run({ brain: WAIT_BRAIN, autoStop: { enabled: true, minRung: 2 }, stepMs: BIG_STEP })).polls;
    expect(r.polls).toBe(baseline);
  });

  it('brain.suggestion 의 applied 가 실제 적용 여부를 말한다 (관측 정직성)', async () => {
    const on = await run({ brain: DONE_BRAIN, autoStop: { enabled: true, minRung: 2 }, stepMs: BIG_STEP });
    const appliedSug = on.events.filter(e => e.event === 'brain.suggestion').pop();
    expect(appliedSug!.data).toMatchObject({ applied: true, novelCompletionSignal: true });

    const off = await run({ brain: DONE_BRAIN, stepMs: BIG_STEP });
    for (const e of off.events.filter(e => e.event === 'brain.suggestion')) {
      expect(e.data).toMatchObject({ applied: false });
    }
  });
});

describe('S4 P3b 정지 맥락 — 드라이버→brain 배선(런타임)', () => {
  it('⭐ 고정 화면의 누적 시간과 stall rung을 실제 brain 관측으로 전달한다', async () => {
    const received: ControlObservation[] = [];
    const brain: RunSupervisor = {
      decide: (observation) => {
        received.push(observation);
        return { action: 'wait' };
      },
    };
    await run({ brain, stepMs: 20_000, maxPolls: 20 });

    const stalled = received.filter((observation) => (observation.stallRung ?? -1) >= 0);
    expect(stalled.length).toBeGreaterThan(1);
    expect(stalled[0]!.sameScreenMs).toBeGreaterThanOrEqual(STALL_RUNGS_MS[0]!);
    expect(stalled.at(-1)!.sameScreenMs).toBeGreaterThan(stalled[0]!.sameScreenMs!);
    expect(stalled.map((observation) => observation.stallRung)).toEqual(expect.arrayContaining([0, 1, 2]));
  });
});

// ⭐ seams → user-config → 드라이버 **전달 경로** 런타임 가드 (리뷰 should-fix · 2026-07-27)
//
// 파서 테스트는 config 를 읽는 것까지, 드라이버 테스트는 옵션을 받은 뒤부터 본다. 그 **사이**
// (`defaultSeams` 가 `getUserConfig().tools.selfImplement.autoStop` 를 실제로 넘기는가)는 둘 다
// 통과하면서 끊길 수 있다. 실 spawn 경로를 태워 `autostop.config` 관측으로 잠근다.
describe('S4 P3 자동 종료 — seams→config→driver 전달 경로', () => {
  it('⭐ defaultSeams 가 user-config 의 노브를 드라이버까지 실어 나른다', async () => {
    const { spawnSync } = await import('node:child_process');
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: j, dirname } = await import('node:path');
    const home = mkdtempSync(j(tmpdir(), 'as-home-'));
    const tree = mkdtempSync(j(tmpdir(), 'as-tree-'));
    const stub = mkdtempSync(j(tmpdir(), 'as-bin-'));
    try {
      mkdirSync(j(home, '.elanous'));
      // ★ 노브를 **기본이 아닌 값**으로 켠다 — 기본값이 흘러도 통과하는 테스트가 되지 않게.
      writeFileSync(j(home, '.elanous', 'config.json'), JSON.stringify({
        onboarding: { completed: true }, llm: { provider: 'openai-codex' },
        tools: { selfImplement: { autoStop: { enabled: true, minRung: 1 } } },
      }));
      writeFileSync(j(home, '.elanous', 'leader.json'), JSON.stringify({ tree: '/other', promotedAt: 'x' }));
      writeFileSync(j(home, '.zshenv'), `export PATH="${dirname(process.execPath)}:$PATH"\n`);
      spawnSync('git', ['init', '-q'], { cwd: tree });
      mkdirSync(j(stub, 'bin'));
      writeFileSync(j(stub, 'bin', 'elanous.mjs'), 'process.exit(0);\n');
      const out = j(stub, 'observed.json');

      const script = `
        const {defaultSeams}=require('${process.cwd()}/src/self-implement/seams.ts');
        let seen=null;
        const seams=defaultSeams({
          elanousBinRoot:'${stub}', implementMaxWaitSec:3, ptyAvailable:()=>true,
          runHeadlessGoalLoopPty:async (opts)=>{
            seen={wired:opts.autoStop!==undefined,enabled:opts.autoStop?.enabled,minRung:opts.autoStop?.minRung,brainWired:opts.brain!==undefined};
            return {ok:false};
          },
        });
        seams.implement({cwd:'${tree}', feature:'noop'}).finally(()=>{
          require('node:fs').writeFileSync('${out}', JSON.stringify(seen||{}));
        });
      `;
      spawnSync('bun', ['-e', script], {
        encoding: 'utf8', timeout: 150_000, cwd: tree,
        env: { ...process.env, HOME: home, ELANOUS_STATE_DIR: '', ELANOUS_CONFIG_DIR: '', ELANOUS_NEXUS_DIR: '', ELANOUS_NEST_DEPTH: '0' },
      });

      expect(existsSync(out)).toBe(true);
      const seen = JSON.parse(readFileSync(out, 'utf-8')) as Record<string, unknown>;
      expect(seen.wired).toBe(true);        // ★ seams 가 노브를 넘겼다(끊기면 false)
      expect(seen.enabled).toBe(true);      // ★ config 값이 그대로 도착했다
      expect(seen.minRung).toBe(1);         //    기본(2)이 아니라 내가 쓴 값
      expect(seen.brainWired).toBe(true);
    } finally {
      for (const d of [home, tree, stub]) rmSync(d, { recursive: true, force: true });
    }
  }, 180_000);
});


// 지켜야 할 것: merged 반환값과 병합되지 않은 경로의 보존 동작은 cleanup 때문에 바뀌지 않는다.
// 어떻게 확인하나: 아래 seam-only 호출은 worktree·branch 제거 순서, 모든 보존 사유와 실패 관측을 검증한다.
// 이 착지가 다루지 않는 것: 과거 worktree 소급 정리, terminal 외 사용 신호, 병렬 실행기 knob, worktree 유래 기록.
function cleanupSeams(over: Partial<SelfImplementSeams['postMergeCleanup']> = {}): SelfImplementSeams {
  return {
    createWorktree: async ({ branch }) => ({ path: `/safe/${branch}`, branch }),
    implement: async () => ({ ok: true, summary: 'done' }),
    gate: async () => ({ passed: true, log: 'ok' }),
    openPr: async () => ({ url: 'https://example.test/pr/1', number: 1 }),
    approvePr: async () => true,
    reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'clean', reviewed: true, diffTruncated: false, diffShownChars: 1, diffTotalChars: 1, diffOmittedFiles: 0 }),
    readPrCommitShas: async () => ({ baseCommit: 'base', headCommit: 'head' }),
    readPrDiff: async () => 'diff --git a/x b/x\n',
    readPrFiles: async () => ['x'],
    mergePr: async () => ({ merged: true }),
    postMergeCleanup: {
      enabled: true,
      listActiveTerminalDirectories: () => ({ ok: true, value: [] }),
      isWorktreeInUse: () => false,
      readWorktreePorcelain: () => '',
      resolveMainRepoRoot: () => '/safe/repo',
      removeWorktree: () => {},
      removeBranch: () => {},
      ...over,
    },
  };
}

describe('post-merge worktree cleanup wiring', () => {
  it('cleans the merged run worktree then its branch without filesystem access', async () => {
    const calls: string[] = [];
    const result = await runSelfImplement({ feature: 'cleanup success', autoMerge: true, seams: cleanupSeams({
      removeWorktree: (repoRoot, path) => { calls.push(`worktree:${repoRoot}:${path}`); },
      removeBranch: (repoRoot, branch) => { calls.push(`branch:${repoRoot}:${branch}`); },
    }) });
    expect(result).toMatchObject({ ok: true, stage: 'merged', merged: true });
    expect(calls).toEqual([`worktree:/safe/repo:${result.worktreePath}`, `branch:/safe/repo:${result.branch}`]);
  });

  it.each([
    ['disabled', { enabled: false }, 'disabled'],
    ['terminal discovery failure result', { listActiveTerminalDirectories: () => ({ ok: false, value: [] }) }, 'terminal-discovery-failed'],
    ['terminal discovery throw', { listActiveTerminalDirectories: () => { throw new Error('terminal discovery'); } }, 'terminal-discovery-failed'],
    ['active terminal', { listActiveTerminalDirectories: () => ({ ok: true, value: ['/safe'] }), isWorktreeInUse: (): boolean => true }, 'worktree-in-use'],
    ['terminal classification throw', { isWorktreeInUse: (): boolean => { throw new Error('terminal classification'); } }, 'terminal-classification-failed'],
    ['change inspection failure', { readWorktreePorcelain: (): string | undefined => undefined }, 'change-inspection-failed'],
    ['change inspection throw', { readWorktreePorcelain: () => { throw new Error('change inspection'); } }, 'change-inspection-failed'],
    ['uncommitted changes', { readWorktreePorcelain: (): string | undefined => ' M src/x.ts' }, 'uncommitted-changes'],
    ['repository root unavailable', { resolveMainRepoRoot: () => null }, 'repository-root-unavailable'],
  ] as const)('preserves merged worktree when %s', async (_name, over, reason) => {
    const calls: string[] = [];
    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const spy = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => { events.push({ event, data }); }) as never);
    try {
      const result = await runSelfImplement({ feature: `cleanup ${_name}`, autoMerge: true, seams: cleanupSeams({
        ...over,
        removeWorktree: () => { calls.push('worktree'); },
        removeBranch: () => { calls.push('branch'); },
      }) });
      expect(result).toMatchObject({ ok: true, stage: 'merged', merged: true });
    } finally { spy.mockRestore(); }
    expect(calls).toEqual([]);
    expect(events.find((event) => event.event === 'post-merge-cleanup-preserved')?.data).toMatchObject({ reason });
  });

  it.each([
    ['worktree removal', 'remove-worktree', ['worktree']],
    ['branch removal', 'remove-branch', ['worktree', 'branch']],
  ] as const)('preserves successful merge and observes %s failure', async (_name, step, expectedCalls) => {
    const calls: string[] = [];
    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const seams = cleanupSeams({
      removeWorktree: () => {
        calls.push('worktree');
        if (step === 'remove-worktree') throw new Error('remove worktree');
      },
      removeBranch: () => {
        calls.push('branch');
        if (step === 'remove-branch') throw new Error('remove branch');
      },
    });
    const spy = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => { events.push({ event, data }); }) as never);
    try {
      const result = await runSelfImplement({ feature: `cleanup ${_name}`, autoMerge: true, seams });
      expect(result).toMatchObject({ ok: true, stage: 'merged', merged: true });
    } finally { spy.mockRestore(); }
    expect(calls).toEqual([...expectedCalls]);
    expect(events.find((event) => event.event === 'post-merge-cleanup-failed')?.data).toMatchObject({ step });
  });

  it.each([
    ['PR-open merge attempt', (seams: SelfImplementSeams) => { seams.mergePr = async () => ({ merged: false, detail: 'left open' }); }],
    ['implementation failure', (seams: SelfImplementSeams) => { seams.implement = async () => ({ ok: false, summary: 'failed' }); }],
    ['gate failure', (seams: SelfImplementSeams) => { seams.gate = async () => ({ passed: false, log: 'failed' }); }],
  ] as const)('does not clean %s paths', async (_name, configure) => {
    const calls: string[] = [];
    const seams = cleanupSeams({
      removeWorktree: () => { calls.push('worktree'); },
      removeBranch: () => { calls.push('branch'); },
    });
    configure(seams);
    const result = await runSelfImplement({ feature: `not cleaned ${_name}`, autoMerge: true, seams });
    expect(result.stage).not.toBe('merged');
    expect(calls).toEqual([]);
  });

  it('defaultSeams wires injected cleanup adapters without filesystem access', () => {
    const calls: string[] = [];
    const cleanup = defaultSeams({
      resolveMainRepoRoot: (worktreePath) => { calls.push(`root:${worktreePath}`); return '/injected/repo'; },
      removeWorktree: (repoRoot, worktreePath) => { calls.push(`worktree:${repoRoot}:${worktreePath}`); },
      runGitCommand: ((cwd: string, argv: string[]) => {
        calls.push(`git:${cwd}:${argv.join(' ')}`);
        return { status: 0, stdout: '', stderr: '' };
      }) as never,
    }).postMergeCleanup!;
    expect(cleanup.resolveMainRepoRoot('/injected/worktree')).toBe('/injected/repo');
    cleanup.removeWorktree('/injected/repo', '/injected/worktree');
    cleanup.removeBranch('/injected/repo', 'dev/injected-cleanup');
    expect(calls).toEqual([
      'root:/injected/worktree',
      'worktree:/injected/repo:/injected/worktree',
      'git:/injected/repo:branch --delete --force dev/injected-cleanup',
    ]);
  });

  it('defaultSeams force-deletes a real squash-merged branch', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'elanous-squash-cleanup-'));
    const branch = 'dev/squash-cleanup';
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
    try {
      git('init', '--initial-branch=main');
      git('config', 'user.email', 'test@example.test');
      git('config', 'user.name', 'test');
      writeFileSync(join(repoRoot, 'base.txt'), 'base\n');
      git('add', 'base.txt');
      git('commit', '-m', 'base');
      git('switch', '-c', branch);
      writeFileSync(join(repoRoot, 'feature.txt'), 'feature\n');
      git('add', 'feature.txt');
      git('commit', '-m', 'feature');
      git('switch', 'main');
      git('merge', '--squash', branch);
      git('commit', '-m', 'squash feature');

      expect(() => git('branch', '--delete', branch)).toThrow();
      expect(git('branch', '--list', branch).trim()).toBe(branch);

      const cleanup = defaultSeams().postMergeCleanup!;
      cleanup.removeBranch(repoRoot, branch);
      expect(git('branch', '--list', branch).trim()).toBe('');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});


describe('S4 P3 정보 추가량 — 드라이버 관측과 개입', () => {
  it('결정론 state=done의 done은 payload에 정보 0으로 남기고 자동 종료하지 않는다', async () => {
    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'self-implement') events.push({ event, ...(data ? { data } : {}) });
    }) as never);
    const handle = stalledHandle(8).handle;
    handle.renderScreen = async () => 'GOAL-COMPLETE';
    try {
      await runHeadlessGoalLoopPty({
        binRoot: '/r', cwd: '/w', featurePrompt: 'x', pollMs: 1, maxWaitSec: 10,
        brain: DONE_BRAIN, autoStop: { enabled: true, minRung: 0 },
        spawn: (() => handle) as never, ptyAvailable: () => true, nowMs: virtualClock(BIG_STEP),
      });
    } finally {
      spy.mockRestore();
    }
    const suggestion = events.find((event) => event.event === 'brain.suggestion');
    expect(suggestion?.data).toMatchObject({ state: 'done', action: 'done', novelCompletionSignal: false, applied: false, why: 'deterministic-state-already-done' });
    expect(events.some((event) => event.event === 'brain.applied')).toBe(false);
  });
});
