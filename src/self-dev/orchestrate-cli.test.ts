import { describe, it, expect, spyOn } from 'bun:test';
import { debug } from '../debug/log.js';
import {
  appendRepairFragments,
  createLaunchDeclaredDeliverableVerifier,
  MAX_REPAIR_FRAGMENTS_PER_FINGERPRINT,
  MAX_REPAIR_FRAGMENTS_TOTAL,
  formatOrchestrateStartAnnouncement,
  resolveOrchestrateStart,
  runSelfOrchestrateCliCommand,
  type OrchestrateCliDeps,
} from './orchestrate-cli.js';
import type { DevPipelineSpec, OrchestrateRuntime } from './dev-pipeline.js';
import { orchestrateSelfDev, type SelfDevJobResult } from './orchestrate.js';
import { parseSelfImplementJson, type SelfImplementJobSpawn } from '../task-orchestrator/surfaces/self-implement.js';

const jr = (over: Partial<SelfDevJobResult> = {}): SelfDevJobResult =>
  ({ taskId: 't', feature: 'f', status: 'done', ...over } as SelfDevJobResult);

/** executeReroute 를 가로채 전달된 spec/runtime 관찰(실 주입 실행 검증·source-grep Goodhart 회피). */
function capture(exitCode = 0, results: SelfDevJobResult[] = [jr()]) {
  const calls: { spec: DevPipelineSpec; runtime: OrchestrateRuntime }[] = [];
  const executeReroute = (async (spec: DevPipelineSpec, runtime: OrchestrateRuntime) => {
    calls.push({ spec, runtime });
    return { results, exitCode };
  }) as OrchestrateCliDeps['executeReroute'];
  return { calls, executeReroute, last: () => calls[calls.length - 1] };
}

const repairClassification = (errorCode: string, errorMessage?: string) => ({ taskId: 'repair-source', action: 'add-repair-task' as const, errorCode, ...(errorMessage === undefined ? {} : { errorMessage }) });

describe('appendRepairFragments — deterministic additive repair policy', () => {
  it('preserves existing fragments and makes the normalized fingerprint observable in the new fragment', () => {
    const base = [{ id: 'existing', feature: 'keep this fragment' }];
    const out = appendRepairFragments(base, [repairClassification('web|unloaded-image|/app/:id')]);
    expect(out.goals).toHaveLength(2);
    expect(out.goals[0]).toBe(base[0]);
    expect(out.goals[1]).toMatchObject({ id: 'repair:web|unloaded-image|/app/:id', feature: 'Repair deliverable failure: web|unloaded-image|/app/:id' });
    expect(out.added).toEqual([{ fingerprint: 'web|unloaded-image|/app/:id', status: 'added' }]);
  });

  it('deduplicates the same explicit repair fingerprint', () => {
    const repeated = appendRepairFragments([], [
      repairClassification('web|same-failure|/app'),
      repairClassification('web|same-failure|/app'),
    ]);
    expect(repeated.added).toEqual([{ fingerprint: 'web|same-failure|/app', status: 'added' }]);
    expect(repeated.skipped).toEqual([{ fingerprint: 'web|same-failure|/app', status: 'skipped', reason: 'duplicate' }]);
  });

  it('reports duplicate, invalid, per-fingerprint, and total limits as structured skips', () => {
    const duplicate = appendRepairFragments([{ id: 'repair:web|unloaded-image|/app/:id', feature: 'existing repair' }], [repairClassification('web|unloaded-image|/app/:id')]);
    expect(duplicate.skipped).toEqual([{ fingerprint: 'web|unloaded-image|/app/:id', status: 'skipped', reason: 'duplicate' }]);

    const invalid = appendRepairFragments([], [repairClassification('   ')]);
    expect(invalid.skipped).toEqual([{ fingerprint: '   ', status: 'skipped', reason: 'invalid' }]);

    const perFingerprint = appendRepairFragments([], [repairClassification('web|broken-link|/a')], { seenFingerprints: new Map([['web|broken-link|/a', MAX_REPAIR_FRAGMENTS_PER_FINGERPRINT]]) });
    expect(perFingerprint.skipped[0]?.reason).toBe('per-fingerprint-limit');

    const total = appendRepairFragments([], [repairClassification('web|broken-link|/b')], { addedCount: MAX_REPAIR_FRAGMENTS_TOTAL });
    expect(total.skipped[0]?.reason).toBe('total-limit');
  });
});

describe('runSelfOrchestrateCliCommand — parallel 재라우팅 글루 seam', () => {
  it('goals+concurrency → parallel spec · runtime 전달', async () => {
    const cap = capture();
    let checkpointed = false;
    const runtime: OrchestrateRuntime = { teardown: true, checkpoint: () => { checkpointed = true; } };
    const out = await runSelfOrchestrateCliCommand(
      { goals: [{ feature: 'g1', openPr: true }, { feature: 'g2' }], concurrency: 3, runtime },
      { executeReroute: cap.executeReroute },
    );
    expect(out.ok).toBe(true);
    expect(cap.last().spec).toEqual({
      input: { text: 'g1 ;; g2' },
      executor: { kind: 'self' },
      parallel: { goals: [{ feature: 'g1', openPr: true }, { feature: 'g2' }], concurrency: 3 },
    });
    expect(cap.last().runtime).toBe(runtime); // 비분해 실행은 기존 runtime 객체 동일성까지 보존
    expect(Object.hasOwn(cap.last().runtime, 'parentRequest')).toBe(false);
    cap.last().runtime.checkpoint!([]);
    expect(checkpointed).toBe(true);
  });

  it('분해 원문 → 실제 각 shard Shard identity에 기존 parentRequest로 그대로 전달', async () => {
    const parentRequest = '원문 요청: 분석 구현 테스트';
    const received: string[] = [];
    const spawn: SelfImplementJobSpawn = (input) => {
      received.push(input.feature);
      return { address: `self-impl:${input.spaceId}`, done: Promise.resolve({ exitCode: 0, output: '' }) };
    };
    const out = await runSelfOrchestrateCliCommand(
      { goals: [{ feature: '분석' }, { feature: '구현' }, { feature: '테스트' }], parentRequest, runtime: {} },
      { pipelineDeps: { orchestrateSelfDev: (opts) => orchestrateSelfDev({ ...opts, spawn }) } },
    );
    expect(out.ok).toBe(true);
    expect(received).toHaveLength(3);
    const identities = received.map((feature) => JSON.parse(feature.slice(feature.indexOf('\n\n## Shard identity\n') + '\n\n## Shard identity\n'.length)) as { parentRequest?: string });
    expect(identities.map((identity) => identity.parentRequest)).toEqual([parentRequest, parentRequest, parentRequest]);
  });

  it('비분해 실행 → 실제 Shard identity에 parentRequest 키 자체가 없음', async () => {
    const received: string[] = [];
    const spawn: SelfImplementJobSpawn = (input) => {
      received.push(input.feature);
      return { address: `self-impl:${input.spaceId}`, done: Promise.resolve({ exitCode: 0, output: '' }) };
    };
    const out = await runSelfOrchestrateCliCommand(
      { goals: [{ feature: 'g1' }, { feature: 'g2' }], runtime: {} },
      { pipelineDeps: { orchestrateSelfDev: (opts) => orchestrateSelfDev({ ...opts, spawn }) } },
    );
    expect(out.ok).toBe(true);
    expect(received).toHaveLength(2);
    const identities = received.map((feature) => JSON.parse(feature.slice(feature.indexOf('\n\n## Shard identity\n') + '\n\n## Shard identity\n'.length)) as Record<string, unknown>);
    expect(identities.every((identity) => !Object.hasOwn(identity, 'parentRequest'))).toBe(true);
  });

  it('명시 concurrency → seam parallel에 키와 값을 그대로 전달', async () => {
    const cap = capture();
    await runSelfOrchestrateCliCommand({ goals: [{ feature: 'g1' }], concurrency: 3, runtime: {} }, { executeReroute: cap.executeReroute });
    expect(Object.hasOwn(cap.last().spec.parallel!, 'concurrency')).toBe(true);
    expect(cap.last().spec.parallel!.concurrency).toBe(3);
  });

  it('exit-code 는 executeReroute 결과 그대로 전파(done<total→1)', async () => {
    const cap = capture(1, [jr(), jr({ status: 'failed' })]);
    const out = await runSelfOrchestrateCliCommand({ goals: [{ feature: 'g1' }, { feature: 'g2' }], runtime: {} }, { executeReroute: cap.executeReroute });
    expect(out.ok).toBe(true);
    if (out.ok) { expect(out.exitCode).toBe(1); expect(out.results).toHaveLength(2); }
  });

  it('executeReroute throw → ok:false·exit 1·message(원 액션 catch 동형)', async () => {
    const boom = (async () => { throw new Error('오케스트레이터 폭발'); }) as OrchestrateCliDeps['executeReroute'];
    const out = await runSelfOrchestrateCliCommand({ goals: [{ feature: 'g1' }], runtime: {} }, { executeReroute: boom });
    expect(out.ok).toBe(false);
    if (!out.ok) { expect(out.exitCode).toBe(1); expect(out.message).toContain('오케스트레이터 폭발'); }
  });
});

// ⭐⭐⭐ 2026-08-19 (P0) — 「중앙 관통 라인의 «베네핏»」을 여기서 증명한다.
//   대표 2026-08-06: *"능력은 「갈래」가 아니라 「스위치」다 · 슈퍼바이저가 그 스위치를 «소유»한다"*
//   ⛔ 초판은 이 루프를 index.ts(CLI 액션)에 두었다 ⇒ CLI «한 입구»만 능력을 가졌다.
//     이 심으로 내렸으므로 ***이 심을 타는 모든 입구(CLI·NL·앞으로 올 것)가 «같이» 얻는다.***
describe('산출물 관측 타깃 — 골 문서의 «켜기 선언»이 런타임까지 흐른다', () => {
  const withLaunch = [
    '# 골', '', '## 산출물을 어떻게 켜나', '',
    '- Entrypoint: apps/demo/server.ts',
    '- Port: 31415',
    '- Environment: DEMO_TOKEN', '',
  ].join('\n');

  it('선언이 없는 wiring은 adapter를 만들지 않아 기본 observer fallback을 보존한다', () => {
    expect(createLaunchDeclaredDeliverableVerifier(undefined, undefined)).toBeUndefined();
  });

  it('선언이 있는 wiring은 canonical path 없이는 명확히 거부한다', () => {
    const wiring = { wired: true, targets: [{ taskId: 'a', target: 'http://127.0.0.1:31415/' }], port: 31415 } as const;
    expect(() => createLaunchDeclaredDeliverableVerifier(wiring, undefined)).toThrow('Launch-declared deliverable requires a canonical goal path');
  });

  it('⭐ 선언이 있으면 조각 id 로 타깃이 «실려» executeReroute 까지 간다', async () => {
    const cap = capture();
    const runtime: OrchestrateRuntime = { teardown: true };
    const out = await runSelfOrchestrateCliCommand(
      { goals: [{ id: 'a', feature: 'g1' }, { id: 'b', feature: 'g2' }], runtime, deliverable: { document: withLaunch, attribution: 'all', goalPath: '/repo/goals/launch.md' } },
      { executeReroute: cap.executeReroute },
    );
    expect(out.ok).toBe(true);
    // ⛔ 「만들었다」가 아니라 «실행 경로의 다음 층이 받았나»를 문다.
    expect(cap.last().runtime.deliverableTargets).toEqual([
      { taskId: 'a', target: 'http://127.0.0.1:31415/' },
      { taskId: 'b', target: 'http://127.0.0.1:31415/' },
    ]);
  });

  it('id 를 안 준 조각은 «배열 인덱스»를 쓴다 — orchestrate 의 기본 id 규약과 같은 값', async () => {
    const cap = capture();
    const out = await runSelfOrchestrateCliCommand(
      { goals: [{ feature: 'g1' }, { feature: 'g2' }], runtime: {}, deliverable: { document: withLaunch, attribution: 'all', goalPath: '/repo/goals/launch.md' } },
      { executeReroute: cap.executeReroute },
    );
    expect(out.ok).toBe(true);
    expect(cap.last().runtime.deliverableTargets?.map((t) => t.taskId)).toEqual(['0', '1']);
  });

  it("attribution='last' 는 말단 조각 하나에만 붙인다", async () => {
    const cap = capture();
    const out = await runSelfOrchestrateCliCommand(
      {
        goals: [{ id: 'a', feature: 'g1' }, { id: 'b', feature: 'g2' }],
        runtime: {}, deliverable: { document: withLaunch, attribution: 'last', goalPath: '/repo/goals/launch.md' },
      },
      { executeReroute: cap.executeReroute },
    );
    expect(out.ok).toBe(true);
    expect(cap.last().runtime.deliverableTargets?.map((t) => t.taskId)).toEqual(['b']);
  });

  it('⭐⭐ «연속 경로» — CLI → reroute → orchestrateSelfDev → observeDeliverables 가 한 줄로 이어진다', async () => {
    // ⛔ 이 시험이 있는 이유(리뷰 #10550 must-fix): 앞의 시험들은 «심 직전»에서 멈추거나
    //   생산 결과를 직접 소비자에 넣는다. 둘 다 「중간 층이 값을 떨어뜨려도」 초록이다.
    //   ⇒ 여기서는 심을 «하나도 건너뛰지 않고» 진짜 엔진을 통과시킨다.
    const verified: string[] = [];
    const spawn: SelfImplementJobSpawn = (input) => ({
      address: `self-impl:${input.spaceId}`,
      done: Promise.resolve({ exitCode: 0, output: '' }),
    });
    const out = await runSelfOrchestrateCliCommand(
      {
        goals: [{ id: 'a', feature: 'g1' }, { id: 'b', feature: 'g2' }],
        runtime: {},
        deliverable: { document: withLaunch, attribution: 'last', goalPath: '/repo/goals/launch.md' },
      },
      {
        // ⛔ executeReroute 를 «주지 않는다» — 실제 executeOrchestrateReroute 가 돈다.
        pipelineDeps: {
          orchestrateSelfDev: (opts) => orchestrateSelfDev({
            ...opts,
            spawn,
            // 브라우저 대신 심만 갈아끼운다 — 그 위 층은 전부 «진짜»다.
            verifyDeliverable: async (target) => {
              verified.push(target);
              return { ok: true, findings: [] } as never;
            },
          }),
        },
      },
    );
    expect(out.ok).toBe(true);
    // 🎯 골 문서의 「Port: 31415」가 «브라우저 검증 호출»까지 도달했다.
    expect(verified).toEqual(['http://127.0.0.1:31415/']);
  });

  it('⛔ 배선을 «안 주면» 종전과 바이트 동일 — runtime 객체 동일성까지 보존한다', async () => {
    const cap = capture();
    const runtime: OrchestrateRuntime = { teardown: true };
    const out = await runSelfOrchestrateCliCommand(
      { goals: [{ id: 'a', feature: 'g1' }], runtime },
      { executeReroute: cap.executeReroute },
    );
    expect(out.ok).toBe(true);
    expect(cap.last().runtime).toBe(runtime);
    expect(Object.hasOwn(cap.last().runtime, 'deliverableTargets')).toBe(false);
  });

  it('선언이 있으면 self-dev.deliverable-wiring에 wired 값과 함께 기록하고 reroute한다', async () => {
    const cap = capture();
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const out = await runSelfOrchestrateCliCommand(
        { goals: [{ id: 'a', feature: 'g1' }], runtime: {}, deliverable: { document: withLaunch, attribution: 'all', goalPath: '/repo/goals/launch.md' } },
        { executeReroute: cap.executeReroute },
      );
      expect(out.ok).toBe(true);
      expect(log).toHaveBeenCalledWith('self-dev.deliverable-wiring', 'wired', {
        port: 31415,
        attribution: 'all',
        targetCount: 1,
        goalIdCount: 1,
      });
      expect(cap.calls).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });

  it('선언 골은 canonical path·repository root로 launcher verifier를 주입해 실제 parallel dispatch에서 호출한다', async () => {
    const calls: { goalPath: string; repositoryRoot: string }[] = [];
    const out = await runSelfOrchestrateCliCommand(
      {
        goals: [{ id: 'a', feature: 'g1' }],
        runtime: {},
        deliverable: { document: withLaunch, attribution: 'all', goalPath: '/repo/goals/launch.md' },
      },
      {
        repositoryRoot: '/repo',
        launchAndVerifyGoalDeliverable: async (goalPath, repositoryRoot) => {
          calls.push({ goalPath, repositoryRoot });
          return {
            status: 'observed',
            goalPath,
            observation: { deployFindings: new Map([[goalPath, { target: 'http://127.0.0.1:31415/' }]]), unmeasured: [] },
          };
        },
        pipelineDeps: {
          orchestrateSelfDev: (opts) => orchestrateSelfDev({
            ...opts,
            spawn: () => ({ address: 'self-impl:test', done: Promise.resolve({ exitCode: 0, output: '' }) }),
          }),
        },
      },
    );
    expect(out.ok).toBe(true);
    expect(calls).toEqual([{ goalPath: '/repo/goals/launch.md', repositoryRoot: '/repo' }]);
  });

  it('launcher report에 canonical path finding이 없으면 shim이 성공을 합성하지 않고 fail-closed 한다', async () => {
    const cap = capture();
    await runSelfOrchestrateCliCommand(
      { goals: [{ id: 'a', feature: 'g1' }], runtime: {}, deliverable: { document: withLaunch, attribution: 'all', goalPath: '/repo/goals/launch.md' } },
      {
        executeReroute: cap.executeReroute,
        launchAndVerifyGoalDeliverable: async (goalPath) => ({ status: 'observed', goalPath, observation: { deployFindings: new Map(), unmeasured: [] } }),
      },
    );
    await expect(cap.last().runtime.verifyDeliverable!('http://127.0.0.1:31415/')).rejects.toThrow('unmeasured');
  });

  it('launch verifier는 실패 findings를 문자열과 구조화 형식 모두 보존한다', async () => {
    const cap = capture();
    const finding = { kind: 'empty-body' as const, message: '페이지 본문이 비어있음', certainty: 'confirmed' as const };
    await runSelfOrchestrateCliCommand(
      { goals: [{ id: 'a', feature: 'g1' }], runtime: {}, deliverable: { document: withLaunch, attribution: 'all', goalPath: '/repo/goals/launch.md' } },
      {
        executeReroute: cap.executeReroute,
        launchAndVerifyGoalDeliverable: async (goalPath) => ({
          status: 'observed',
          goalPath,
          observation: { deployFindings: new Map([[goalPath, { target: 'http://127.0.0.1:31415/', findings: [finding] }]]), unmeasured: [] },
        }),
      },
    );
    await expect(cap.last().runtime.verifyDeliverable!('http://127.0.0.1:31415/')).resolves.toEqual({
      ok: false,
      url: 'http://127.0.0.1:31415/',
      findings: [finding.message],
      structuredFindings: [finding],
    });
  });

  it('attribution=all 여러 target도 shim이 launcher lifecycle 하나를 공유한다', async () => {
    const cap = capture();
    let launches = 0;
    await runSelfOrchestrateCliCommand(
      { goals: [{ id: 'a', feature: 'g1' }, { id: 'b', feature: 'g2' }], runtime: {}, deliverable: { document: withLaunch, attribution: 'all', goalPath: '/repo/goals/launch.md' } },
      {
        executeReroute: cap.executeReroute,
        launchAndVerifyGoalDeliverable: async (goalPath) => {
          launches++;
          return { status: 'observed', goalPath, observation: { deployFindings: new Map([[goalPath, { target: 'http://127.0.0.1:31415/' }]]), unmeasured: [] } };
        },
      },
    );
    await Promise.all([
      cap.last().runtime.verifyDeliverable!('http://127.0.0.1:31415/'),
      cap.last().runtime.verifyDeliverable!('http://127.0.0.1:31415/'),
    ]);
    expect(launches).toBe(1);
  });

  it('supervised rerun은 새 lifecycle verifier를 만들어 launch를 재실행한다', async () => {
    const cap = capture(1, [jr({
      status: 'failed',
      stage: 'error',
      error: { code: 'SELF_IMPL_FAILED', message: "error: cannot lock ref 'refs/remotes/origin/main': is at abc" },
    })]);
    let launches = 0;
    await runSelfOrchestrateCliCommand(
      { goals: [{ id: 'a', feature: 'g1' }], runtime: {}, supervise: { rounds: 1 }, deliverable: { document: withLaunch, attribution: 'all', goalPath: '/repo/goals/launch.md' } },
      {
        executeReroute: cap.executeReroute,
        launchAndVerifyGoalDeliverable: async (goalPath) => {
          launches++;
          return { status: 'observed', goalPath, observation: { deployFindings: new Map([[goalPath, { target: 'http://127.0.0.1:31415/' }]]), unmeasured: [] } };
        },
      },
    );
    await cap.calls[0].runtime.verifyDeliverable!('http://127.0.0.1:31415/');
    await cap.calls[1].runtime.verifyDeliverable!('http://127.0.0.1:31415/');
    expect(launches).toBe(2);
  });

  it('기동 선언에 canonical goal path가 없으면 기본 verifier로 fallback하지 않고 명확히 실패한다', async () => {
    const cap = capture();
    const out = await runSelfOrchestrateCliCommand(
      { goals: [{ id: 'a', feature: 'g1' }], runtime: {}, deliverable: { document: withLaunch, attribution: 'all' } },
      { executeReroute: cap.executeReroute },
    );
    expect(out).toEqual({ ok: false, message: 'Launch-declared deliverable requires a canonical goal path', exitCode: 1 });
    expect(cap.calls).toHaveLength(0);
  });

  it('⛔ 선언이 «없는» 문서면 verifier shim을 주입하지 않고 종전 실행을 보존한다', async () => {
    const cap = capture();
    const runtime: OrchestrateRuntime = { teardown: true };
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const out = await runSelfOrchestrateCliCommand(
        { goals: [{ id: 'a', feature: 'g1' }], runtime, deliverable: { document: '# 골\n\n본문뿐이다.\n', attribution: 'all', goalPath: '/repo/goals/no-launch.md' } },
        { executeReroute: cap.executeReroute },
      );
      expect(out.ok).toBe(true);
      expect(log).toHaveBeenCalledWith('self-dev.deliverable-wiring', 'skipped', {
        reason: 'no-launch-declaration',
        goalIdCount: 1,
      });
      expect(cap.last().runtime).toBe(runtime);
      expect(Object.hasOwn(cap.last().runtime, 'deliverableTargets')).toBe(false);
      expect(Object.hasOwn(cap.last().runtime, 'verifyDeliverable')).toBe(false);
    } finally {
      log.mockRestore();
    }
  });
});

describe('런 슈퍼바이저 — 중앙 심이 스위치를 «소유»한다', () => {
  const unlanded = { taskId: 'x', feature: 'x', status: 'failed', stage: 'error',
    error: { code: 'SELF_IMPL_FAILED', message: "error: cannot lock ref 'refs/remotes/origin/main': is at abc" } } as SelfDevJobResult;
  const landed = { taskId: 'x', feature: 'x', status: 'done', stage: 'merged', merged: true } as SelfDevJobResult;

  it('supervise 없으면 «한 번»만 돈다 — 기본 동작 무변경', async () => {
    const cap = capture(1, [unlanded]);
    const out = await runSelfOrchestrateCliCommand(
      { goals: [{ feature: 'g' }], runtime: {} },
      { executeReroute: cap.executeReroute },
    );
    expect(out.ok).toBe(true);
    expect(cap.calls.length).toBe(1);
  });

  it('⭐ supervise 를 주면 «다시 건다» — 그리고 resumeFrom 으로 이어간다', async () => {
    const cap = capture(1, [unlanded]);
    const out = await runSelfOrchestrateCliCommand(
      { goals: [{ feature: 'g' }], runtime: {}, supervise: { rounds: 2 } },
      // ⛔ 주변 원장 «상태»에 기대지 않는다 — 「원장이 없다」를 seam 으로 «못 박는다».
      //   그러지 않으면 작업공간에 원장이 생기는 순간 이 시험이 흔들린다(리뷰 should-fix 2026-08-21).
      { executeReroute: cap.executeReroute, readProposals: () => ({
        proposals: new Map(), goalPlanRevisions: new Map(),
        readFailure: { status: 'read-failed', reason: 'directory-missing', scannedFiles: 0, unreadableFiles: 0, ledgerDirectory: '/absent' },
        scannedFiles: 0, unreadableFiles: 0, directoryMissing: true, ledgerDirectory: '/absent',
      }) },
    );
    expect(out.ok).toBe(true);
    expect(cap.calls.length).toBeGreaterThan(1);            // 다시 걸었다
    // ⛔ 엄격 동등이 «아니다» — 이 시험의 계약은 「이전 결과를 «그대로» 넘겼다」이지
    //   「필드가 «정확히 그것뿐»이다」가 아니다. 중앙이 결과에 관측을 «덧붙이는» 것은 설계다
    //   (decomposeProposal 이 같은 자리에서 같은 일을 한다).
    //   📏 2026-08-21: goalPlanRevision 이 추가되며 이 줄이 깨졌고, 깨진 것은 «계약»이 아니라 «자»였다.
    const carried = cap.last().runtime.resumeFrom;
    expect(carried).toHaveLength(1);
    // ⛔ 느슨한 부분 일치가 «아니다» — 새 관측 «하나»를 뺀 나머지는 «정확히» 그대로여야 한다.
    //   ⇒ 다른 필드가 하나라도 더해지거나 바뀌면 이 단언이 깨진다(Goodhart 여지 제거).
    const { goalPlanRevision, ...rest } = carried![0] as typeof unlanded & { goalPlanRevision?: unknown };
    expect(rest).toEqual(unlanded);                        // 이전 결과를 «그대로» 넘겼다
    // ⭐ 그리고 더해진 것은 «그 관측 하나»이고, 원장이 없으니 read-failed 다
    //   (ledgerDirectory 는 임시 경로라 값이 아니라 «형태»를 문다)
    expect(goalPlanRevision).toEqual({ status: 'read-failed', reason: 'directory-missing', scannedFiles: 0, unreadableFiles: 0, ledgerDirectory: '/absent' });
  });

  it('⛔⭐ 판정이 「사람이 볼 것」이라 한 조각(pr-opened)은 재개가 다시 돌리지 않는다 — resumeHold 로 넘긴다', async () => {
    const prOpened = { taskId: 'pr', feature: 'pr', status: 'done', stage: 'pr-opened', merged: false, prUrl: 'https://example.test/pull/1' } as SelfDevJobResult;
    const cap = capture(1, [prOpened, unlanded]);
    await runSelfOrchestrateCliCommand(
      { goals: [{ feature: 'pr' }, { feature: 'x' }], runtime: {}, supervise: { rounds: 2 } },
      { executeReroute: cap.executeReroute, readProposals: () => ({
        proposals: new Map(), goalPlanRevisions: new Map(),
        readFailure: { status: 'read-failed', reason: 'directory-missing', scannedFiles: 0, unreadableFiles: 0, ledgerDirectory: '/absent' },
        scannedFiles: 0, unreadableFiles: 0, directoryMissing: true, ledgerDirectory: '/absent',
      }) },
    );
    expect(cap.calls.length).toBeGreaterThan(1);                 // 다시 걸긴 했다(unlanded 는 재실행 대상)
    expect(cap.calls[0]!.runtime.resumeHold).toBeUndefined();     // 첫 판엔 보류가 없다
    expect(cap.calls[1]!.runtime.resumeHold).toEqual(['pr']);     // 재개 판: 사람 대기 조각을 보류
  });

  it('⭐ 재시도 경로가 골 개정 관측을 «그대로» 이어받는다 (재시도-간 의미)', async () => {
    // 🔑 「전달 보존」만이 아니라 ***다음 라운드 spec 이 그 관측을 값으로 갖는다***는 계약을 문다.
    const cap = capture(1, [unlanded]);
    await runSelfOrchestrateCliCommand(
      { goals: [{ feature: 'g' }], runtime: {}, supervise: { rounds: 2 } },
      { executeReroute: cap.executeReroute, readProposals: () => ({
        proposals: new Map(), goalPlanRevisions: new Map([[unlanded.taskId, { status: 'read', attempted: 2, applied: 1, failureReasons: ['expected-text-not-found'] }]]),
        scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/x',
      }) },
    );
    const carried = cap.last().runtime.resumeFrom;
    expect(carried).toHaveLength(1);
    expect(carried![0]!.goalPlanRevision).toEqual({ status: 'read', attempted: 2, applied: 1, failureReasons: ['expected-text-not-found'] });
  });

  it('DRAFT-TRIAGE — each supervisor rework round supersedes the previous round\'s draft of the same goal; other goals untouched', async () => {
    const pr = (n: number) => `https://github.com/acme/repo/pull/${n}`;
    const rounds: SelfDevJobResult[][] = [
      [{ ...unlanded, prUrl: pr(101) }, { ...unlanded, taskId: 'y', feature: 'y', prUrl: pr(200) }],
      [{ ...unlanded, taskId: 'x2', prUrl: pr(102) }, { ...unlanded, taskId: 'y', feature: 'y', prUrl: pr(200) }],
      [{ ...landed, taskId: 'x3', prUrl: pr(103) }, { ...landed, taskId: 'y', feature: 'y', prUrl: pr(200) }],
    ];
    let call = 0;
    const executeReroute = (async () => ({ results: rounds[Math.min(call++, rounds.length - 1)]!, exitCode: 1 })) as OrchestrateCliDeps['executeReroute'];
    const writes: string[] = [];
    await runSelfOrchestrateCliCommand(
      { goals: [{ feature: 'x' }, { feature: 'y' }], runtime: {}, supervise: { rounds: 3 } },
      { executeReroute, readProposals: () => ({
        proposals: new Map(), goalPlanRevisions: new Map(),
        readFailure: { status: 'read-failed', reason: 'directory-missing', scannedFiles: 0, unreadableFiles: 0, ledgerDirectory: '/absent' },
        scannedFiles: 0, unreadableFiles: 0, directoryMissing: true, ledgerDirectory: '/absent',
      }), roundPrAdapters: {
        view: () => ({ state: 'OPEN', isDraft: true, labels: [], comments: [] }),
        addLabel: (ref, label) => { writes.push(`label#${ref.number}:${label}`); return true; },
        comment: (ref, body) => { writes.push(`comment#${ref.number}:${/#(\d+) \(/.exec(body)?.[1]}`); return true; },
        close: (ref) => { writes.push(`close#${ref.number}`); return true; },
      } },
    );
    expect(call).toBe(3);
    expect(writes).toEqual([
      'label#101:elanous:superseded', 'comment#101:102', 'close#101',
      'label#102:elanous:superseded', 'comment#102:103', 'close#102',
    ]);
  });

  it('⛔ 전부 착지하면 «한 번»에 선다 — 다시 걸 것이 없다', async () => {
    const cap = capture(0, [landed]);
    await runSelfOrchestrateCliCommand(
      { goals: [{ feature: 'g' }], runtime: {}, supervise: { rounds: 3 } },
      { executeReroute: cap.executeReroute },
    );
    expect(cap.calls.length).toBe(1);
  });

  it('⛔ 라운드 상한을 «넘지 않는다» — 무한 재실행 금지', async () => {
    const cap = capture(1, [unlanded]);
    await runSelfOrchestrateCliCommand(
      { goals: [{ feature: 'g' }], runtime: {}, supervise: { rounds: 2, stallRounds: 99 } },
      { executeReroute: cap.executeReroute },
    );
    expect(cap.calls.length).toBe(3);   // 첫 런 + 재개 2회 = 상한 2
  });

  it('⭐ 입구는 판정을 «보기만» 한다 — onDecision 이 사유를 받는다', async () => {
    const cap = capture(0, [landed]);
    const seen: string[] = [];
    await runSelfOrchestrateCliCommand(
      { goals: [{ feature: 'g' }], runtime: {}, supervise: { rounds: 3, onDecision: (d) => { seen.push(d.stopReason ?? d.action); } } },
      { executeReroute: cap.executeReroute },
    );
    expect(seen).toEqual(['converged']);
  });

  it('⛔ 입구의 표시 실패가 루프를 «멈추지 않는다»', async () => {
    const cap = capture(0, [landed]);
    const out = await runSelfOrchestrateCliCommand(
      { goals: [{ feature: 'g' }], runtime: {}, supervise: { onDecision: () => { throw new Error('render boom'); } } },
      { executeReroute: cap.executeReroute },
    );
    expect(out.ok).toBe(true);
  });

  it('재개마다 checkpoint 가 «불린다» — 재개 이력이 남는다', async () => {
    const cap = capture(1, [unlanded]);
    let saves = 0;
    await runSelfOrchestrateCliCommand(
      { goals: [{ feature: 'g' }], runtime: { checkpoint: () => { saves++; } }, supervise: { rounds: 2, stallRounds: 99 } },
      { executeReroute: cap.executeReroute },
    );
    expect(saves).toBe(2);   // 재개 2회분
  });
});

describe('add-repair-task — rerun seam appends instead of replaces', () => {
  const repairable = (errorCode: string) => jr({
    taskId: 'repair-source',
    feature: 'completed original',
    status: 'done',
    goalCauseObserved: true,
    error: { code: errorCode, message: 'repair required' },
  });
  const codeLessRepairable = (message: string) => jr({
    taskId: 'repair-source',
    feature: 'completed original',
    status: 'done',
    goalCauseObserved: true,
    error: { message } as SelfDevJobResult['error'],
  });

  it('keeps the existing goal and appends one fingerprinted repair goal to the next round', async () => {
    const specs: DevPipelineSpec[] = [];
    let call = 0;
    const executeReroute = (async (spec: DevPipelineSpec) => {
      specs.push(spec);
      call++;
      return call === 1
        ? { results: [repairable('web|unloaded-image|/app/:id')], exitCode: 1 }
        : { results: [jr({ stage: 'merged', merged: true })], exitCode: 0 };
    }) as OrchestrateCliDeps['executeReroute'];

    const out = await runSelfOrchestrateCliCommand(
      { goals: [{ id: 'original', feature: 'existing feature' }], runtime: {}, supervise: { rounds: 2 } },
      { executeReroute },
    );
    const nextGoals = specs[1]?.parallel?.goals ?? [];
    expect(nextGoals.map((goal) => goal.feature)).toEqual(['existing feature', 'Repair deliverable failure: web|unloaded-image|/app/:id']);
    if (!out.ok) throw new Error(out.message);
    expect(out.repairAppend).toEqual([{ added: [{ fingerprint: 'web|unloaded-image|/app/:id', status: 'added' }], skipped: [] }]);
  });

  it('uses production code-less classifications to append distinct repairs and skip only the repeated failure', async () => {
    const decisions: string[] = [];
    const specs: DevPipelineSpec[] = [];
    let call = 0;
    const executeReroute = (async (spec: DevPipelineSpec) => {
      specs.push(spec);
      call++;
      if (call === 1) return { results: [codeLessRepairable('first code-less failure')], exitCode: 1 };
      if (call === 2) return { results: [codeLessRepairable('second code-less failure')], exitCode: 1 };
      if (call === 3) return { results: [codeLessRepairable('second code-less failure')], exitCode: 1 };
      return { results: [jr({ stage: 'merged', merged: true })], exitCode: 0 };
    }) as OrchestrateCliDeps['executeReroute'];

    const out = await runSelfOrchestrateCliCommand(
      { goals: [{ feature: 'existing feature' }], runtime: {}, supervise: { rounds: 4, stallRounds: 99, onDecision: (decision) => { decisions.push(decision.why); } } },
      { executeReroute },
    );

    if (!out.ok) throw new Error(out.message);
    const repairRounds = out.repairAppend!;
    expect(repairRounds).toHaveLength(3);
    expect(repairRounds[0]!.added).toEqual([{ fingerprint: expect.stringMatching(/^UNKNOWN:[a-f0-9]{16}$/), status: 'added' }]);
    expect(repairRounds[1]!.added).toEqual([{ fingerprint: expect.stringMatching(/^UNKNOWN:[a-f0-9]{16}$/), status: 'added' }]);
    expect(repairRounds[0]!.added[0]!.fingerprint).not.toBe(repairRounds[1]!.added[0]!.fingerprint);
    expect(repairRounds[2]).toEqual({
      added: [],
      skipped: [{ fingerprint: repairRounds[1]!.added[0]!.fingerprint, status: 'skipped', reason: 'duplicate' }],
    });
    expect(specs[2]?.parallel?.goals.map((goal) => goal.id)).toEqual([
      undefined,
      `repair:${repairRounds[0]!.added[0]!.fingerprint}`,
      `repair:${repairRounds[1]!.added[0]!.fingerprint}`,
    ]);
    expect(decisions.filter((why) => why.includes('수리 조각 추가 없음'))).toEqual([
      '수리 조각을 붙인다 — 수리 1 · 그대로 재실행 0 · 재작업 0 · 분해 0 · 라운드 3/4 — 수리 조각 추가 없음 (1건 건너뜀)',
    ]);
  });

  it('reports no repair addition in the decision verdict when a duplicate is skipped', async () => {
    let call = 0;
    const decisions: string[] = [];
    const executeReroute = (async () => {
      call++;
      return call === 1 || call === 2
        ? { results: [repairable('same')], exitCode: 1 }
        : { results: [jr({ stage: 'merged', merged: true })], exitCode: 0 };
    }) as OrchestrateCliDeps['executeReroute'];

    const out = await runSelfOrchestrateCliCommand(
      { goals: [{ feature: 'existing feature' }], runtime: {}, supervise: { rounds: 2, stallRounds: 99, onDecision: (decision) => { decisions.push(decision.why); } } },
      { executeReroute },
    );
    if (!out.ok) throw new Error(out.message);
    expect(out.repairAppend?.[1]).toEqual({ added: [], skipped: [{ fingerprint: 'same', status: 'skipped', reason: 'duplicate' }] });
    expect(decisions).toEqual([
      '수리 조각을 붙인다 — 수리 1 · 그대로 재실행 0 · 재작업 0 · 분해 0 · 라운드 1/2',
      '수리 조각을 붙인다 — 수리 1 · 그대로 재실행 0 · 재작업 0 · 분해 0 · 라운드 2/2 — 수리 조각 추가 없음 (1건 건너뜀)',
      '완주 — 미해결 조각 0 · 이번 라운드 착지 1',
    ]);
  });

  it('observes an empty added list and duplicate skip when repair application is a no-op', async () => {
    let call = 0;
    const observations: Record<string, unknown>[] = [];
    const off = debug.registerSink({
      name: 'repair-append-no-op-observation-capture',
      emit: (record) => {
        if (record.category === 'self-dev.supervisor' && record.event === 'add-repair-task.applied') observations.push(record.data as Record<string, unknown>);
      },
    });
    const executeReroute = (async () => {
      call++;
      return call === 1 || call === 2
        ? { results: [repairable('same')], exitCode: 1 }
        : { results: [jr({ stage: 'merged', merged: true })], exitCode: 0 };
    }) as OrchestrateCliDeps['executeReroute'];

    try {
      await runSelfOrchestrateCliCommand(
        { goals: [{ feature: 'existing feature' }], runtime: {}, supervise: { rounds: 2, stallRounds: 99 } },
        { executeReroute },
      );
      expect(observations[1]).toMatchObject({ added: [], skipped: [{ fingerprint: 'same', reason: 'duplicate' }] });
    } finally {
      off();
    }
  });

  it('suppresses duplicate repair fingerprints and preserves a non-repair rerun spec', async () => {
    const specs: DevPipelineSpec[] = [];
    let call = 0;
    const executeReroute = (async (spec: DevPipelineSpec) => {
      specs.push(spec);
      call++;
      if (call === 1) return { results: [repairable('first')], exitCode: 1 };
      if (call === 2) return { results: [repairable('first')], exitCode: 1 };
      return { results: [jr({ stage: 'merged', merged: true })], exitCode: 0 };
    }) as OrchestrateCliDeps['executeReroute'];

    const out = await runSelfOrchestrateCliCommand(
      { goals: [{ feature: 'existing feature' }], runtime: {}, supervise: { rounds: 2, stallRounds: 99 } },
      { executeReroute },
    );
    expect(specs[2]?.parallel?.goals).toHaveLength(2);
    if (!out.ok) throw new Error(out.message);
    expect(out.repairAppend?.[1]?.skipped).toEqual([{ fingerprint: 'first', status: 'skipped', reason: 'duplicate' }]);
  });
});

// ⭐⭐⭐ 2026-08-19 — 「쪼개서 다시 건다」가 «실제로 도는가»(배선 검증).
//   대표: 복합 미션이 단일 골로 들어와도 하니스가 스스로 쪼개야 한다.
//   ⛔ 순수 함수 테스트는 「판정이 옳은가」만 답한다 — 이 절은 «그 답이 실행 경로에 있는가»를 묻는다.
describe('decompose-and-retry — 단일이 «연합으로 승격»된다', () => {
  const withProposal = (feature: string) => ({
    taskId: 't1', feature, status: 'done', stage: 'pr-opened',
    decomposeProposal: { pieces: [
      { id: 'p1', feature: 'part one', dependsOn: [] },
      { id: 'p2', feature: 'part two', dependsOn: [] },
    ] },
  }) as SelfDevJobResult;

  it('⭐ shardId 없는 단일 런 제안도 runId로 읽어 다음 라운드 조각으로 승격한다', async () => {
    const specs: unknown[] = [];
    let call = 0;
    const requests: Array<{ shardIds: readonly string[]; runIds?: readonly string[] }> = [];
    const executeReroute = (async (spec: DevPipelineSpec) => {
      specs.push(spec);
      call++;
      return call === 1
        ? { results: [{ ...jr({ stage: 'pr-opened' }), taskId: 'task-single', feature: 'big goal', runId: 'run-single' }], exitCode: 1 }
        : { results: [jr({ stage: 'merged', merged: true })], exitCode: 0 };
    }) as OrchestrateCliDeps['executeReroute'];
    await runSelfOrchestrateCliCommand(
      { goals: [{ feature: 'big goal' }], runtime: {}, supervise: { rounds: 2 } },
      { executeReroute, readProposals: (input) => {
        requests.push({ shardIds: input!.shardIds, ...(input!.runIds ? { runIds: input!.runIds } : {}) });
        return { proposals: new Map([['run-single', { shardId: 'run-single', pieces: [
          { id: 'p1', feature: 'part one', dependsOn: [] },
          { id: 'p2', feature: 'part two', dependsOn: [] },
        ] }]]), goalPlanRevisions: new Map(), scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/x' };
      } },
    );
    expect(requests[0]).toEqual({ shardIds: ['task-single'], runIds: ['run-single'] });
    const second = specs[1] as { parallel?: { goals?: { feature: string }[] } };
    expect(second.parallel?.goals?.map((g) => g.feature)).toEqual(['part one', 'part two']);
  });

  it('⭐ 실제 orchestration 결과의 child JSON runId가 원장 제안을 다음 라운드 조각으로 승격한다', async () => {
    const specs: unknown[] = [];
    let call = 0;
    const spawn: SelfImplementJobSpawn = () => {
      const output = '{"stage":"pr-opened","ok":true,"runId":"run-produced"}\n';
      const disposition = parseSelfImplementJson(output);
      if (!disposition) throw new Error('child output did not contain a disposition');
      return {
        address: 'self-impl:test',
        done: Promise.resolve({ exitCode: 0, output, disposition }),
      };
    };
    const executeReroute = (async (spec: DevPipelineSpec, runtime: OrchestrateRuntime) => {
      specs.push(spec);
      call++;
      if (call === 1) {
        const results = await orchestrateSelfDev({ goals: [{ feature: 'big goal' }], spawn });
        expect(results[0]?.runId).toBe('run-produced');
        return { results, exitCode: 1 };
      }
      return { results: [jr({ stage: 'merged', merged: true })], exitCode: 0 };
    }) as OrchestrateCliDeps['executeReroute'];

    const out = await runSelfOrchestrateCliCommand(
      { goals: [{ feature: 'big goal' }], runtime: {}, supervise: { rounds: 2 } },
      { executeReroute, pipelineDeps: { orchestrateSelfDev }, readProposals: (input) => {
        expect(input?.runIds).toEqual(['run-produced']);
        return { proposals: new Map([['run-produced', { shardId: 'run-produced', pieces: [
          { id: 'p1', feature: 'part one', dependsOn: [] },
          { id: 'p2', feature: 'part two', dependsOn: [] },
        ] }]]), goalPlanRevisions: new Map(), scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/x' };
      } },
    );
    if (!out.ok) throw new Error(out.message);
    const second = specs[1] as { parallel?: { goals?: { feature: string }[] } };
    expect(second.parallel?.goals?.map((g) => g.feature)).toEqual(['part one', 'part two']);
  });

  it('⭐ CONTRACT-CONFLICT 골 개정 관측을 superviseRun enrich 경로로 결과에 붙인다', async () => {
    const executeReroute = (async () => ({
      results: [{ ...jr({ stage: 'pr-opened' }), taskId: 'task-single', feature: 'big goal', runId: 'run-single' }],
      exitCode: 1,
    })) as OrchestrateCliDeps['executeReroute'];
    const out = await runSelfOrchestrateCliCommand(
      { goals: [{ feature: 'big goal' }], runtime: {}, supervise: { rounds: 1 } },
      { executeReroute, readProposals: () => ({
        proposals: new Map(),
        goalPlanRevisions: new Map([['run-single', { status: 'read', attempted: 1, applied: 0, failureReasons: ['expected-text-not-found'] }]]),
        scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/x',
      }) },
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.results[0]?.goalPlanRevision).toEqual({ status: 'read', attempted: 1, applied: 0, failureReasons: ['expected-text-not-found'] });
  });

  it('⭐ taskId 매칭이 runId보다 우선하며 같은 readProposals 호출에서 붙는다', async () => {
    const executeReroute = (async () => ({ results: [{ ...jr({ stage: 'pr-opened' }), taskId: 'task-single', feature: 'big goal', runId: 'run-single' }], exitCode: 1 })) as OrchestrateCliDeps['executeReroute'];
    const out = await runSelfOrchestrateCliCommand(
      { goals: [{ feature: 'big goal' }], runtime: {}, supervise: { rounds: 1 } },
      { executeReroute, readProposals: () => ({
        proposals: new Map(),
        goalPlanRevisions: new Map([
          ['task-single', { status: 'read', attempted: 1, applied: 1, failureReasons: [] }],
          ['run-single', { status: 'read', attempted: 1, applied: 0, failureReasons: ['wrong-run'] }],
        ]),
        scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/x',
      }) },
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.results[0]?.goalPlanRevision).toEqual({ status: 'read', attempted: 1, applied: 1, failureReasons: [] });
  });

  it('⛔ 무관한 runId 골 개정 관측은 소비하지 않는다', async () => {
    const executeReroute = (async () => ({ results: [{ ...jr({ stage: 'pr-opened' }), taskId: 'task-single', feature: 'big goal', runId: 'run-single' }], exitCode: 1 })) as OrchestrateCliDeps['executeReroute'];
    const out = await runSelfOrchestrateCliCommand(
      { goals: [{ feature: 'big goal' }], runtime: {}, supervise: { rounds: 1 } },
      { executeReroute, readProposals: () => ({
        proposals: new Map(),
        goalPlanRevisions: new Map([['run-other', { status: 'read', attempted: 1, applied: 0, failureReasons: ['unrelated'] }]]),
        scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/x',
      }) },
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.results[0]?.goalPlanRevision).toBeUndefined();
    }
  });

  it('⛔ «완전히 빈» 성공 스캔은 확인되지 않은 revision을 합성하지 않는다', async () => {
    const executeReroute = (async () => ({ results: [{ ...jr({ stage: 'pr-opened' }), taskId: 'task-single', feature: 'big goal', runId: 'run-single' }], exitCode: 1 })) as OrchestrateCliDeps['executeReroute'];
    const out = await runSelfOrchestrateCliCommand(
      { goals: [{ feature: 'big goal' }], runtime: {}, supervise: { rounds: 1 } },
      { executeReroute, readProposals: () => ({
        proposals: new Map(),
        goalPlanRevisions: new Map(),          // ⬅ «아무것도» 없다. 그래도 읽기는 온전했다
        scannedFiles: 2, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/x',
      }) },
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.results[0]?.goalPlanRevision).toBeUndefined();
  });

  it('⛔ «조회하지 않은» 결과에는 관측을 새로 쓰지 않는다', async () => {
    // 착지한 조각은 후보에서 빠진다 ⇒ 물어보지 않았으므로 답을 만들지 않는다.
    const merged = { ...jr({ stage: 'merged' }), taskId: 'task-merged', feature: 'done', merged: true };
    const pending = { ...jr({ stage: 'pr-opened' }), taskId: 'task-single', feature: 'big goal', runId: 'run-single' };
    const executeReroute = (async () => ({ results: [merged, pending], exitCode: 1 })) as OrchestrateCliDeps['executeReroute'];
    const out = await runSelfOrchestrateCliCommand(
      { goals: [{ feature: 'big goal' }], runtime: {}, supervise: { rounds: 1 } },
      { executeReroute, readProposals: () => ({
        proposals: new Map(), goalPlanRevisions: new Map(),
        scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/x',
      }) },
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      const mergedResult = out.results.find((x) => x.taskId === 'task-merged');
      expect(mergedResult && Object.hasOwn(mergedResult, 'goalPlanRevision')).toBe(false);
    }
  });

  it('⛔ 부분 읽기에서도 해당 task/run에서 확인한 revision이 전역 실패보다 우선한다', async () => {
    const executeReroute = (async () => ({ results: [{ ...jr({ stage: 'pr-opened' }), taskId: 'task-single', feature: 'big goal', runId: 'run-single' }], exitCode: 1 })) as OrchestrateCliDeps['executeReroute'];
    const out = await runSelfOrchestrateCliCommand(
      { goals: [{ feature: 'big goal' }], runtime: {}, supervise: { rounds: 1 } },
      { executeReroute, readProposals: () => ({
        proposals: new Map(),
        goalPlanRevisions: new Map([['run-single', { status: 'read', attempted: 1, applied: 0, failureReasons: ['expected-text-not-found'] }]]),
        readFailure: { status: 'read-failed', reason: 'unreadable-files', scannedFiles: 3, unreadableFiles: 1, ledgerDirectory: '/x' },
        scannedFiles: 3, unreadableFiles: 1, directoryMissing: false, ledgerDirectory: '/x',
      }) },
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.results[0]?.goalPlanRevision).toEqual({ status: 'read', attempted: 1, applied: 0, failureReasons: ['expected-text-not-found'] });
    }
  });

  it('⛔ read-failure 는 0으로 접지 않고 결과에 전파한다', async () => {
    const executeReroute = (async () => ({ results: [{ ...jr({ stage: 'pr-opened' }), taskId: 'task-single', feature: 'big goal' }], exitCode: 1 })) as OrchestrateCliDeps['executeReroute'];
    const out = await runSelfOrchestrateCliCommand(
      { goals: [{ feature: 'big goal' }], runtime: {}, supervise: { rounds: 1 } },
      { executeReroute, readProposals: () => ({
        proposals: new Map(), goalPlanRevisions: new Map(),
        readFailure: { status: 'read-failed', reason: 'unreadable-files', scannedFiles: 1, unreadableFiles: 1, ledgerDirectory: '/x' },
        scannedFiles: 1, unreadableFiles: 1, directoryMissing: false, ledgerDirectory: '/x',
      }) },
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.results[0]?.goalPlanRevision).toEqual({ status: 'read-failed', reason: 'unreadable-files', scannedFiles: 1, unreadableFiles: 1, ledgerDirectory: '/x' });
  });

  it('⛔ 읽기 전 결과는 goalPlanRevision 필드가 없다', async () => {
    const cap = capture(1, [jr({ status: 'failed', stage: 'error' })]);
    const out = await runSelfOrchestrateCliCommand({ goals: [{ feature: 'g' }], runtime: {} }, { executeReroute: cap.executeReroute });
    expect(out.ok).toBe(true);
    if (out.ok) expect(Object.hasOwn(out.results[0]!, 'goalPlanRevision')).toBe(false);
  });

  it('⛔ 무관한 runId 제안은 소비하지 않는다', async () => {
    const specs: unknown[] = [];
    let call = 0;
    const executeReroute = (async (spec: DevPipelineSpec) => {
      specs.push(spec);
      call++;
      return call === 1
        ? { results: [{ ...jr({ stage: 'pr-opened' }), taskId: 'task-single', feature: 'big goal', runId: 'run-single' }], exitCode: 1 }
        : { results: [jr({ stage: 'merged', merged: true })], exitCode: 0 };
    }) as OrchestrateCliDeps['executeReroute'];
    await runSelfOrchestrateCliCommand(
      { goals: [{ feature: 'big goal' }], runtime: {}, supervise: { rounds: 2 } },
      { executeReroute, readProposals: () => ({ proposals: new Map([['run-other', { shardId: 'run-other', pieces: [
        { id: 'p1', feature: 'part one', dependsOn: [] },
        { id: 'p2', feature: 'part two', dependsOn: [] },
      ] }]]), goalPlanRevisions: new Map(), scannedFiles: 1, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/x' }) },
    );
    const second = specs[1] as { parallel?: { goals?: { feature: string }[] } };
    expect(second.parallel?.goals?.map((g) => g.feature)).toEqual(['big goal']);
  });

  it('⭐ 제안이 있으면 «다음 라운드 spec 이 쪼개진 goals»로 간다', async () => {
    const specs: unknown[] = [];
    let call = 0;
    const executeReroute = (async (spec: DevPipelineSpec) => {
      specs.push(spec);
      call++;
      // 1라운드: 제안이 붙은 미착지 결과 · 2라운드부터: 착지
      return call === 1
        ? { results: [withProposal('big goal')], exitCode: 1 }
        : { results: [jr({ stage: 'merged', merged: true })], exitCode: 0 };
    }) as OrchestrateCliDeps['executeReroute'];

    const out = await runSelfOrchestrateCliCommand(
      { goals: [{ feature: 'big goal', openPr: true }], runtime: {}, supervise: { rounds: 2 } },
      { executeReroute, readProposals: () => ({ proposals: new Map(), goalPlanRevisions: new Map(), scannedFiles: 0, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/x' }) },
    );

    expect(out.ok).toBe(true);
    expect(specs.length).toBe(2);
    // ⭐ 2라운드 spec 의 goals 가 «조각 둘»로 바뀌었다
    const second = specs[1] as { parallel?: { goals?: { feature: string; dependsOn?: string[] }[] } };
    const goals = second.parallel?.goals ?? [];
    expect(goals.map((g) => g.feature)).toEqual(['part one', 'part two']);
    // ⛔ 의존성이 «없으므로» 위상 병렬로 동시에 돈다(대표 2026-08-19 기본 동작)
    expect(goals.every((g) => !g.dependsOn?.length)).toBe(true);
    // 승격 플래그는 원래 goal 에서 물려받는다
    expect((goals[0] as { openPr?: boolean }).openPr).toBe(true);
  });

  it('⛔ 같은 goal 을 «두 번» 쪼개지 않는다 — 조각이 무한히 안 불어난다', async () => {
    const specs: unknown[] = [];
    const executeReroute = (async (spec: DevPipelineSpec) => {
      specs.push(spec);
      return { results: [withProposal(specs.length === 1 ? 'big goal' : 'part one')], exitCode: 1 };
    }) as OrchestrateCliDeps['executeReroute'];

    await runSelfOrchestrateCliCommand(
      { goals: [{ feature: 'big goal' }], runtime: {}, supervise: { rounds: 3, stallRounds: 99 } },
      { executeReroute, readProposals: () => ({ proposals: new Map(), goalPlanRevisions: new Map(), scannedFiles: 0, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/x' }) },
    );
    // 라운드마다 조각이 곱으로 늘지 않는다
    const last = specs[specs.length - 1] as { parallel?: { goals?: unknown[] } };
    expect((last.parallel?.goals ?? []).length).toBeLessThanOrEqual(4);
  });

  it('제안이 없으면 spec 이 «그대로»', async () => {
    const specs: unknown[] = [];
    let call = 0;
    const executeReroute = (async (spec: DevPipelineSpec) => {
      specs.push(spec);
      call++;
      return call === 1
        ? { results: [jr({ status: 'failed', stage: 'error', error: { code: 'X', message: "cannot lock ref 'refs/remotes/origin/main'" } })], exitCode: 1 }
        : { results: [jr({ stage: 'merged', merged: true })], exitCode: 0 };
    }) as OrchestrateCliDeps['executeReroute'];

    await runSelfOrchestrateCliCommand(
      { goals: [{ feature: 'g' }], runtime: {}, supervise: { rounds: 2 } },
      { executeReroute, readProposals: () => ({ proposals: new Map(), goalPlanRevisions: new Map(), scannedFiles: 0, unreadableFiles: 0, directoryMissing: false, ledgerDirectory: '/x' }) },
    );
    expect(specs.length).toBe(2);
    expect(JSON.stringify(specs[0])).toBe(JSON.stringify(specs[1]));   // 락 경합은 «그대로» 다시 건다
  });
});

describe('formatOrchestrateStartAnnouncement — 시작 안내는 동시성을 «추측하지 않는다»', () => {
  const base = { goalCount: 3, promoteMode: ' · PR 없음(worktree만)', runId: 'run-abc' } as const;

  it('해석에 실패한 동시성을 «임의의 수»로 바꾸지 않는다', () => {
    const line = formatOrchestrateStartAnnouncement({ ...base, concurrency: undefined });
    expect(line).toContain('동시 알 수 없음');
    // ⛔ 종전 문면은 여기서 «2» 를 찍었다. 어떤 수도 나와서는 안 된다.
    expect(line).not.toMatch(/동시 \d+/);
  });

  it('해석된 동시성을 그대로 싣는다', () => {
    expect(formatOrchestrateStartAnnouncement({ ...base, concurrency: 14 })).toContain('동시 14');
    expect(formatOrchestrateStartAnnouncement({ ...base, concurrency: 1 })).toContain('동시 1');
  });

  it('나머지 시작 텔레메트리를 «전부» 보존한다', () => {
    const line = formatOrchestrateStartAnnouncement({
      goalCount: 5,
      concurrency: 8,
      promoteMode: ' · auto-merge(리뷰노드)',
      teardown: true,
      runId: 'run-xyz',
      resume: { skipped: 2, rerun: 3 },
    });
    for (const part of ['5 goal', '동시 8', 'auto-merge(리뷰노드)', 'teardown', 'run run-xyz', '2 스킵', '3 재실행']) {
      expect(line).toContain(part);
    }
  });

  it('resume 이 없으면 resume 문면을 «만들지 않는다»', () => {
    expect(formatOrchestrateStartAnnouncement({ ...base, concurrency: 4 })).not.toContain('resume');
  });
});

describe('resolveOrchestrateStart — 안내와 실행값이 «갈릴 수 없다»', () => {
  const base = { goalCount: 3, promoteMode: ' · PR 없음(worktree만)', runId: 'run-abc' } as const;

  it('찍은 수와 넘기는 수가 «같은 값»이다', () => {
    for (const resolved of [1, 2, 7, 14]) {
      const start = resolveOrchestrateStart({ ...base, explicit: undefined, resolveConcurrency: () => resolved });
      expect(start.concurrency).toBe(resolved);
      expect(start.announcement).toContain(`동시 ${resolved}`);
    }
  });

  it('해석이 「모른다」면 «넘기는 값도» 「모른다」이고 안내가 그 사실을 말한다', () => {
    const start = resolveOrchestrateStart({ ...base, explicit: undefined, resolveConcurrency: () => undefined });
    expect(start.concurrency).toBeUndefined();
    expect(start.announcement).toContain('동시 알 수 없음');
    expect(start.announcement).not.toMatch(/동시 \d+/);
  });

  it('해석을 ***한 번만*** 부르고, 명시값을 그대로 전달한다', () => {
    const seen: (number | undefined)[] = [];
    const start = resolveOrchestrateStart({
      ...base,
      explicit: 5,
      resolveConcurrency: (explicit) => { seen.push(explicit); return explicit ?? 99; },
    });
    expect(seen).toEqual([5]);            // ⛔ 두 번 부르면 여기서 깨진다
    expect(start.concurrency).toBe(5);
    expect(start.announcement).toContain('동시 5');
  });

  it('실제 해석기를 쓰면 명시값이 이긴다 (seam 없이도 계약이 같다)', () => {
    const start = resolveOrchestrateStart({ ...base, explicit: 3 });
    expect(start.concurrency).toBe(3);
    expect(start.announcement).toContain('동시 3');
  });
});
