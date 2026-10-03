// 하니스↔막 배선(H2) — deploy confirm(autoDrive)·progress·escalated 표면화 검증.
import { test, expect, describe, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { membraneAuthorizeDeploy, membraneClarify, designToCapsuleSeed, runStagedHarnessOnSurface } from './harness-membrane.js';
import * as harnessSeams from './harness-seams.js';
import { realWorktreeSeams as fakeSeams } from './harness-test-seams.js';
import type { SurfaceUx } from '../agent/surface-ux/types.js';
import type { IntakeClarification } from '../autopilot/mission-intake-clarify.js';
import { debug } from '../debug/log.js';
import * as runLedger from '../self-implement/run-ledger.js';
import { loadRunLedger, runLedgerDir } from '../self-implement/run-ledger.js';

/** 캡처형 fake SurfaceUx. */
function fakeUx(over: Partial<SurfaceUx> & { confirmAnswer?: boolean } = {}): SurfaceUx & { progressLog: string[]; confirmCalls: number } {
  const progressLog: string[] = [];
  let confirmCalls = 0;
  const ux = {
    surface: 'telegram' as const,
    interactive: over.interactive ?? true,
    async confirm() { confirmCalls++; return over.confirmAnswer ?? true; },
    async question() { return null; },
    spillFile() {},
    progress(msg: string) { progressLog.push(msg); },
    ...over,
  } as SurfaceUx & { progressLog: string[]; confirmCalls: number };
  Object.defineProperty(ux, 'progressLog', { get: () => progressLog });
  Object.defineProperty(ux, 'confirmCalls', { get: () => confirmCalls });
  return ux;
}

describe('membraneAuthorizeDeploy — autoDrive 다이얼', () => {
  test('autoDrive on → 자율 true(confirm 안 부름)', async () => {
    const ux = fakeUx();
    const auth = membraneAuthorizeDeploy(ux, 'on');
    expect(await auth({ objective: 'x', branch: 'b' })).toBe(true);
    expect(ux.confirmCalls).toBe(0);
  });
  test('autoDrive safe → ux.confirm 경유(yes)', async () => {
    const ux = fakeUx({ confirmAnswer: true });
    const auth = membraneAuthorizeDeploy(ux, 'safe');
    expect(await auth({ objective: 'x', branch: 'b' })).toBe(true);
    expect(ux.confirmCalls).toBe(1);
  });
  test('autoDrive off + confirm no → false(보류)', async () => {
    const ux = fakeUx({ confirmAnswer: false });
    const auth = membraneAuthorizeDeploy(ux, 'off');
    expect(await auth({ objective: 'x', branch: 'b' })).toBe(false);
  });
});

describe('membraneClarify — 경량 인터뷰(대표 원칙: 명확하면 0질문·최상위 1개만·과잉조사 금지)', () => {
  const clarif = (over: Partial<IntakeClarification> = {}): IntakeClarification => ({
    questionId: 'q1', kind: 'scope', header: '범위', question: '이번 범위는?',
    options: [{ label: 'A만', recommended: true }, { label: '둘 다' }], blocking: true, ...over,
  });
  test('명확한 골(analyze []) → 0질문·objective 불변(경량)', async () => {
    const clarify = membraneClarify(fakeUx(), async () => []);
    const r = await clarify({ objective: '유틸 추가' });
    expect(r.asked).toBe(0);
    expect(r.refinedObjective).toBe('유틸 추가');
  });
  test('모호+interactive 답변 → 1질문·확정설계 메모로 refine(원 objective 유지)', async () => {
    const ux = fakeUx({ async question() { return { answers: { clarify: 'A만' } }; } });
    const clarify = membraneClarify(ux, async () => [clarif()]);
    const r = await clarify({ objective: 'A와 B 개선' });
    expect(r.asked).toBe(1);
    expect(r.refinedObjective).toContain('[Intake 확정 설계');
    expect(r.refinedObjective).toContain('A와 B 개선');
  });
  test('non-interactive → 0질문·추천옵션 auto-resolve(과잉 왕복 금지)', async () => {
    const clarify = membraneClarify(fakeUx({ interactive: false }), async () => [clarif()]);
    const r = await clarify({ objective: 'A와 B 개선' });
    expect(r.asked).toBe(0);
    expect(r.refinedObjective).toContain('[Intake 확정 설계'); // 추천으로도 경량 메모 생성
  });
  test('analyze throw → fail-soft(objective 불변·seed 없음)', async () => {
    const clarify = membraneClarify(fakeUx(), async () => { throw new Error('llm down'); });
    const r = await clarify({ objective: 'x' });
    expect(r).toEqual({ refinedObjective: 'x', asked: 0 });
  });

  test('빈 analyze 결과는 no-questions 관측 한 건을 남긴다', async () => {
    const log = spyOn(debug, 'log');
    try {
      await membraneClarify(fakeUx(), async () => [])({ objective: '명확한 골' });
      const records = log.mock.calls.filter(([category, event]) => category === 'harness.membrane' && event === 'clarify');
      expect(records).toHaveLength(1);
      expect(records[0]?.[2]).toMatchObject({ outcome: 'no-questions', count: 0, asked: 0 });
    } finally { log.mockRestore(); }
  });

  test('analyze 실패는 원문 오류와 fail-soft 반환을 함께 관측한다', async () => {
    const log = spyOn(debug, 'log');
    try {
      const result = await membraneClarify(fakeUx(), async () => { throw new Error('llm down before analysis'); })({ objective: 'x' });
      const records = log.mock.calls.filter(([category, event]) => category === 'harness.membrane' && event === 'clarify');
      expect(result).toEqual({ refinedObjective: 'x', asked: 0 });
      expect(records).toHaveLength(1);
      expect(records[0]?.[2]).toMatchObject({ outcome: 'analyze-failed', error: 'llm down before analysis' });
    } finally { log.mockRestore(); }
  });

  test('질문 응답은 questioned 관측 한 건을 남긴다', async () => {
    const log = spyOn(debug, 'log');
    try {
      await membraneClarify(fakeUx({ async question() { return { answers: { clarify: 'A만' } }; } }), async () => [clarif()])({ objective: 'A와 B 개선' });
      const records = log.mock.calls.filter(([category, event]) => category === 'harness.membrane' && event === 'clarify');
      expect(records).toHaveLength(1);
      expect(records[0]?.[2]).toMatchObject({ outcome: 'questioned', asked: 1 });
    } finally { log.mockRestore(); }
  });

  test('질문 UI 실패도 questioned 관측에 uxFailed로 남기고 계속한다', async () => {
    const log = spyOn(debug, 'log');
    try {
      const result = await membraneClarify(fakeUx({ async question() { throw new Error('surface unavailable'); } }), async () => [clarif()])({ objective: 'A와 B 개선' });
      const records = log.mock.calls.filter(([category, event]) => category === 'harness.membrane' && event === 'clarify');
      expect(result.asked).toBe(0);
      expect(records).toHaveLength(1);
      expect(records[0]?.[2]).toMatchObject({ outcome: 'questioned', uxFailed: true });
    } finally { log.mockRestore(); }
  });

  // ── C2(§8) 인터뷰 → Capsule 씨앗 ──────────────────────────────────────────
  test('C2 — clarify 가 확정설계를 capsuleSeed 로 승격(scope→success·auto-resolve 여도)', async () => {
    const clarify = membraneClarify(fakeUx({ interactive: false }), async () => [clarif()]);
    const r = await clarify({ objective: 'A와 B 개선' });
    expect(r.capsuleSeed).toBeDefined();
    expect(r.capsuleSeed?.successCriteria?.length).toBeGreaterThan(0);   // 추천 scope → 나침반
  });

  test('C2 — 명확한 골(0질문)은 seed 없음', async () => {
    const clarify = membraneClarify(fakeUx(), async () => []);
    const r = await clarify({ objective: '유틸 추가' });
    expect(r.capsuleSeed).toBeUndefined();
  });
});

describe('designToCapsuleSeed — ConfirmedDesign → Capsule 씨앗 매핑(순수·재발명0)', () => {
  test('scope→successCriteria · excluded→outOfScope · notes→riskBoundaries', () => {
    const seed = designToCapsuleSeed({ goal: 'g', scope: ['범위: A'], excluded: ['C 후속'], notes: ['배포 금지'], clarifications: [] });
    expect(seed).toEqual({ successCriteria: ['범위: A'], outOfScope: ['C 후속'], riskBoundaries: ['배포 금지'] });
  });
  test('빈 필드는 omit(plan 휴리스틱 기본으로 폴백)', () => {
    const seed = designToCapsuleSeed({ goal: 'g', scope: [], excluded: [], notes: [], clarifications: [] });
    expect(seed).toEqual({});
  });
});

describe('runStagedHarnessOnSurface — 통합', () => {
  test('명시 runId는 membrane과 sequencer 관측에 동일하게 전달한다', async () => {
    const original = debug.log.bind(debug) as typeof debug.log;
    const logs: Array<{ category: string; event: string; data: { runId?: string } }> = [];
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: { runId?: string }) => {
      logs.push({ category, event, data: data ?? {} });
    }) as typeof debug.log;
    try {
      await runStagedHarnessOnSurface({ objective: '명시 식별자', runId: 'caller-run-9', seams: fakeSeams(), ux: fakeUx({ confirmAnswer: true }), autoDrive: 'safe' });
      expect(logs.find((log) => log.category === 'harness.membrane' && log.event === 'start')?.data.runId).toBe('caller-run-9');
      expect(logs.find((log) => log.category === 'harness.sequencer')?.data.runId).toBe('caller-run-9');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('프론트도어 자연어 런의 종결은 기존 원장에 natural-language-dispatch 출처로 남는다', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'harness-membrane-ledger-'));
    const priorStateDir = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = stateDir;
    try {
      const runId = 'harness-frontdoor-ledger-1';
      await runStagedHarnessOnSurface({
        objective: '원장에 기록할 자연어 하니스 런',
        runId,
        naturalLanguageDispatch: true,
        seams: fakeSeams(),
        ux: fakeUx({ confirmAnswer: true }),
        autoDrive: 'safe',
      });
      expect(runLedgerDir()).toBe(join(stateDir, 'run-ledger'));
      expect(loadRunLedger(runId)).toEqual([
        expect.objectContaining({
          runId,
          event: 'terminal',
          data: expect.objectContaining({ goalSource: 'natural-language-dispatch', terminal: 'pr-opened' }),
        }),
      ]);
    } finally {
      if (priorStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = priorStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test('runId 생략도 sequencer slug 식별자로 원장 종결을 남긴다', async () => {
    const entries: Array<{ runId: string; data: Record<string, unknown> }> = [];
    const result = await runStagedHarnessOnSurface({
      objective: 'Keep Slug Ledger',
      naturalLanguageDispatch: true,
      seams: fakeSeams(),
      ux: fakeUx({ confirmAnswer: true }),
      autoDrive: 'safe',
      writeRunLedger: (entry) => entries.push(entry),
    });
    expect(result.runId).toBe('keep-slug-ledger');
    expect(entries).toEqual([
      expect.objectContaining({
        runId: 'keep-slug-ledger',
        data: expect.objectContaining({ runId: 'keep-slug-ledger', goalSource: 'natural-language-dispatch' }),
      }),
    ]);
  });

  // ⛔⭐ 자의 «충실도» — 이 프론트도어를 «둘»이 지난다(2026-08-06 라이브 실측).
  //   ⑴ 모델이 부른 도구: 사용자 턴 문면이 있어 harnessMention 이 matched/not-matched
  //   ⑵ `elanous harness run` CLI: 사용자 턴이 «없다» ⇒ harnessMention='absent'
  //   종전엔 프론트도어가 naturalLanguageDispatch:true 를 «단정»해 ⑵ 도 자연어 유래로 셌고,
  //   CLI 로 띄운 런의 원장에 goalSource=natural-language-dispatch 가 실제로 찍혔다.
  //   ⇒ v25 ⑷ 의 분자가 부풀어 그 수를 못 믿게 된다.
  test('사용자 문면 없이 뜬 런은 자연어 유래로 «안» 센다', async () => {
    const entries: Array<{ data: Record<string, unknown> }> = [];
    await runStagedHarnessOnSurface({
      objective: 'CLI without user text',
      runId: 'ledger-fidelity-absent',
      harnessMention: 'absent',
      seams: fakeSeams(),
      ux: fakeUx({ confirmAnswer: true }),
      autoDrive: 'safe',
      writeRunLedger: (entry) => entries.push(entry),
    });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]?.data.goalSource).not.toBe('natural-language-dispatch');
  });

  test('사용자 문면이 프론트도어까지 온 런은 자연어 유래로 센다', async () => {
    const entries: Array<{ data: Record<string, unknown> }> = [];
    await runStagedHarnessOnSurface({
      objective: 'TUI with user text',
      runId: 'ledger-fidelity-matched',
      harnessMention: 'matched',
      seams: fakeSeams(),
      ux: fakeUx({ confirmAnswer: true }),
      autoDrive: 'safe',
      writeRunLedger: (entry) => entries.push(entry),
    });
    expect(entries[0]?.data.goalSource).toBe('natural-language-dispatch');
  });

  // ⭐ 73차 — 삼킨 실패를 «보이게». ⛔ 반증 지점: 관측이 없으면 바깥에서 「원장에 안 남긴다」로 «보인다».
  //   📏 실측(2026-08-11): 하니스 런 넷이 전부 terminal 관측을 냈는데 원장 파일은 둘뿐이었다.
  test('원장 쓰기 실패가 terminal-ledger 관측에 «사유와 함께» 남는다', async () => {
    const log = spyOn(debug, 'log');
    try {
      const result = await runStagedHarnessOnSurface({
        objective: '원장 실패를 관측한다',
        runId: 'harness-ledger-observed-fail-1',
        seams: fakeSeams(),
        ux: fakeUx({ confirmAnswer: true }),
        autoDrive: 'safe',
        writeRunLedger: () => { throw new Error('ledger unavailable'); },
      });
      expect(result).toMatchObject({ ok: true, terminal: 'pr-opened' });
      const records = log.mock.calls.filter(([category, event]) => category === 'harness.membrane' && event === 'terminal-ledger');
      expect(records).toHaveLength(1);
      expect(records[0]?.[2]).toMatchObject({
        outcome: 'write-failed',
        error: 'ledger unavailable',
        ledgerDirectory: runLedgerDir(),
      });
    } finally { log.mockRestore(); }
  });

  test('원장 쓰기 성공도 terminal-ledger 관측에 남는다 — 「안 났다」와 「실패했다」를 가른다', async () => {
    const log = spyOn(debug, 'log');
    try {
      await runStagedHarnessOnSurface({
        objective: '원장 성공을 관측한다',
        runId: 'harness-ledger-observed-ok-1',
        seams: fakeSeams(),
        ux: fakeUx({ confirmAnswer: true }),
        autoDrive: 'safe',
        writeRunLedger: () => {},
      });
      const records = log.mock.calls.filter(([category, event]) => category === 'harness.membrane' && event === 'terminal-ledger');
      expect(records).toHaveLength(1);
      expect(records[0]?.[2]).toMatchObject({ outcome: 'written', ledgerDirectory: runLedgerDir() });
    } finally { log.mockRestore(); }
  });

  test('원장 경로 조회 실패도 terminal-ledger 관측과 종결을 막지 않는다', async () => {
    const log = spyOn(debug, 'log');
    const directory = spyOn(runLedger, 'runLedgerDir').mockImplementation(() => { throw new Error('state root unavailable'); });
    try {
      const result = await runStagedHarnessOnSurface({
        objective: '원장 경로 조회 실패를 관측한다',
        runId: 'harness-ledger-directory-fail-1',
        seams: fakeSeams(),
        ux: fakeUx({ confirmAnswer: true }),
        autoDrive: 'safe',
        writeRunLedger: () => { throw new Error('ledger unavailable'); },
      });
      expect(result).toMatchObject({ ok: true, terminal: 'pr-opened' });
      const records = log.mock.calls.filter(([category, event]) => category === 'harness.membrane' && event === 'terminal-ledger');
      expect(records).toHaveLength(1);
      expect(records[0]?.[2]).toMatchObject({ outcome: 'write-failed', error: 'ledger unavailable' });
      expect(records[0]?.[2]).not.toHaveProperty('ledgerDirectory');
    } finally {
      directory.mockRestore();
      log.mockRestore();
    }
  });

  test('원장 writer 실패도 종결 결과를 막지 않는다', async () => {
    const result = await runStagedHarnessOnSurface({
      objective: '원장 실패에도 종결',
      runId: 'harness-ledger-fail-soft-1',
      seams: fakeSeams(),
      ux: fakeUx({ confirmAnswer: true }),
      autoDrive: 'safe',
      writeRunLedger: () => { throw new Error('ledger unavailable'); },
    });
    expect(result).toMatchObject({ ok: true, terminal: 'pr-opened' });
  });

  test('runId가 없으면 sequencer의 slug(objective) 폴백을 유지한다', async () => {
    const original = debug.log.bind(debug) as typeof debug.log;
    const logs: Array<{ category: string; event: string; data: { runId?: string } }> = [];
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: { runId?: string }) => {
      logs.push({ category, event, data: data ?? {} });
    }) as typeof debug.log;
    try {
      await runStagedHarnessOnSurface({ objective: 'Keep Slug Fallback', seams: fakeSeams(), ux: fakeUx({ confirmAnswer: true }), autoDrive: 'safe' });
      expect(logs.find((log) => log.category === 'harness.sequencer')?.data.runId).toBe('keep-slug-fallback');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('safe + confirm yes → 실 PR open(ref=url)·진행 캡처', async () => {
    const ux = fakeUx({ confirmAnswer: true });
    const r = await runStagedHarnessOnSurface({ objective: '기능 X', seams: fakeSeams(), ux, autoDrive: 'safe' });
    expect(r.ok).toBe(true);
    expect(r.terminal).toBe('pr-opened');
    expect(r.deployRef).toBe('https://pr/harness/x');   // confirm yes → PR
    expect(ux.progressLog.some((m) => m.includes('[plan]'))).toBe(true);
    expect(ux.progressLog.some((m) => m.includes('✅ 완료'))).toBe(true);
  });

  test('심사 미실행 warn은 막 종결 관측과 완료 표면에서 구분된다', async () => {
    const original = debug.log;
    const logs: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const ux = fakeUx({ confirmAnswer: true });
    try {
      (debug as { log: typeof debug.log }).log = ((category, event, data) => {
        logs.push({ category, event, data: (data ?? {}) as Record<string, unknown> });
      }) as typeof debug.log;
      const result = await runStagedHarnessOnSurface({
        objective: '심사 미실행 종결',
        seams: fakeSeams(),
        ux,
        autoDrive: 'safe',
        runCritique: async () => ({ verdict: 'warn', findings: ['자율 PR 리뷰 미실행(fail-soft) — 미검토'], reviewed: false }),
      });
      expect(result.ok).toBe(true);
      expect(result.verdict).toMatchObject({ verdict: 'warn', reviewed: false });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
    expect(logs.find((log) => log.category === 'harness.membrane' && log.event === 'terminal')!.data)
      .toMatchObject({ terminal: 'pr-opened', ok: true, reviewed: false });
    expect(ux.progressLog.some((message) => message.includes('심사 미실행'))).toBe(true);
  });

  test('safe + confirm no → deploy fail-closed(ref=branch·PR 안 열림)', async () => {
    let prOpened = false;
    const ux = fakeUx({ confirmAnswer: false });
    const r = await runStagedHarnessOnSurface({ objective: 'my feat', seams: fakeSeams({ async openPr() { prOpened = true; return { url: 'x', number: 1 }; } }), ux, autoDrive: 'safe' });
    expect(r.deployRef).toBe('harness/my-feat');   // 브랜치만
    expect(r.terminal).toBe('branch-prepared');    // ✅ 커밋·준비됨(PR 승인 대기·버그A 정직화)
    expect(prOpened).toBe(false);                   // ★ 무단 PR 안 열림
  });

  test('구현이 변경 0 → no-changes(빈 브랜치에 "deployed" 공수표 제거·버그A)', async () => {
    const ux = fakeUx({ confirmAnswer: true });
    const r = await runStagedHarnessOnSurface({
      objective: 'noop',
      seams: fakeSeams({ async implement() { return { ok: true, summary: '아무것도 안 함' }; } }),
      ux, autoDrive: 'safe',
    });
    expect(r.terminal).toBe('no-changes');   // ⚠️ 정직: 변경 없으면 배포 성공 아님
    expect(r.ok).toBe(false);
  });

  test('게이트 fail → escalated → operator 표면화(진행에 HITL 문구)', async () => {
    const ux = fakeUx();
    const r = await runStagedHarnessOnSurface({ objective: 'x', seams: fakeSeams({ async gate() { return { passed: false }; } }), ux, autoDrive: 'safe', maxReviewRounds: 2 });
    expect(r.terminal).toBe('escalated');
    expect(ux.progressLog.some((m) => m.includes('HITL 필요'))).toBe(true);
  });

  test('autoDrive on → 게이트 fail 시 자율 종료(review-diverged·escalate 안 함)', async () => {
    const ux = fakeUx();
    const r = await runStagedHarnessOnSurface({ objective: 'x', seams: fakeSeams({ async gate() { return { passed: false }; } }), ux, autoDrive: 'on', maxReviewRounds: 2 });
    expect(r.terminal).toBe('review-diverged');
  });

  // ── G9 즉효(2026-07-25) — harness↔무인리뷰 대칭화: deploy 가 저위험 PR 에 auto-review 라벨 부착 ──────
  test('G9 autoReview + 저위험 objective → deploy 가 auto-review 라벨 부착(무인 진입)', async () => {
    let labels: string[] | undefined = ['sentinel'];
    const added: string[] = [];
    const ux = fakeUx({ confirmAnswer: true });
    const r = await runStagedHarnessOnSurface({
      objective: '순수 유틸 함수 하나와 그 단위 테스트를 추가',
      // RELGUARD: the auto-review label goes on after the opened PR's files are checked for release paths.
      seams: fakeSeams({
        async openPr(a: { labels?: string[] }) { labels = a.labels; return { url: 'https://pr/x', number: 7 }; },
        async readPrFiles() { return ['src/util.ts']; },
        async addPrLabel(a: { label: string }) { added.push(a.label); },
      }),
      ux, autoDrive: 'safe', autoReview: true,
    });
    expect(r.terminal).toBe('pr-opened');
    expect(labels).toBeUndefined();
    expect(added).toEqual(['auto-review']);   // G8 eligibility 통과 → 라벨
  });

  test('G9 autoReview + 위험 objective(실주문/배포) → 라벨 없음(G8 자기판단 거부·fail-safe)', async () => {
    let labels: string[] | undefined = ['sentinel'];
    const ux = fakeUx({ confirmAnswer: true });
    await runStagedHarnessOnSurface({
      objective: '프로덕션에 실주문 배포하고 외부로 실집행하라',
      seams: fakeSeams({ async openPr(a: { labels?: string[] }) { labels = a.labels; return { url: 'https://pr/x', number: 8 }; } }),
      ux, autoDrive: 'safe', autoReview: true,
    });
    expect(labels).toBeUndefined();   // 위험 신호 → 라벨 안 붙음
  });

  test('G9 autoReview 미지정 → 라벨 없음(무회귀)', async () => {
    let labels: string[] | undefined = ['sentinel'];
    const ux = fakeUx({ confirmAnswer: true });
    await runStagedHarnessOnSurface({
      objective: '기능 하나 추가',
      seams: fakeSeams({ async openPr(a: { labels?: string[] }) { labels = a.labels; return { url: 'https://pr/x', number: 9 }; } }),
      ux, autoDrive: 'safe',
    });
    expect(labels).toBeUndefined();
  });

  // ── B1(§8/§3k) membrane 관통 — C1~C4 노브가 surface 옵션 → 안쪽 seam/sequencer 까지 도달 ──────
  test('B1 carryCapsule:true → executor 프롬프트에 Capsule 계약 도달(막 관통)', async () => {
    let captured = '';
    const ux = fakeUx({ confirmAnswer: true });
    await runStagedHarnessOnSurface({
      objective: '결제 모듈 구현',
      seams: fakeSeams({ async implement({ feature }) { captured = feature; return { ok: true, summary: 'done' }; } }),
      ux, autoDrive: 'safe', carryCapsule: true,
    });
    expect(captured).toContain('설계 계약(Context Capsule)');   // C1/C2 나침반이 골루프에 실제 도달
  });

  test('B auto(기본)·인터뷰 없음 → 계약 미주입(seed 없음·무회귀)', async () => {
    let captured = '';
    const ux = fakeUx({ confirmAnswer: true });
    await runStagedHarnessOnSurface({
      objective: '결제 모듈 구현',
      seams: fakeSeams({ async implement({ feature }) { captured = feature; return { ok: true, summary: 'done' }; } }),
      ux, autoDrive: 'safe',   // analyzeGoal 미주입 → clarify 스킵 → seed 없음 → auto 미carry
    });
    expect(captured).not.toContain('설계 계약(Context Capsule)');
  });

  test('★ B 조건부 flip — 인터뷰가 nav 채우면 carryCapsule 미지정이어도 자동 carry(잠복 해소)', async () => {
    let captured = '';
    const ux = fakeUx({ confirmAnswer: true });
    await runStagedHarnessOnSurface({
      objective: 'A와 B 개선',
      seams: fakeSeams({ async implement({ feature }) { captured = feature; return { ok: true, summary: 'x' }; } }),
      ux, autoDrive: 'safe',
      // 인터뷰(analyzeGoal) 가 scope 질문 산출 → foldAnswersIntoDesign(추천) → designToCapsuleSeed → nav 채움 → auto carry.
      analyzeGoal: async () => [{ questionId: 'q1', kind: 'scope', header: '범위', question: '이번 범위는?', options: [{ label: 'A만', recommended: true }, { label: '둘 다' }], blocking: true }],
    });
    expect(captured).toContain('설계 계약(Context Capsule)');   // carryCapsule 안 줬는데도 인터뷰 nav 로 자동 carry
  });

  test('B1 ledgerMode 기본(observe) → 실패 시 조사 원장 첨부', async () => {
    const ux = fakeUx();
    const r = await runStagedHarnessOnSurface({ objective: 'x', seams: fakeSeams({ async gate() { return { passed: false }; } }), ux, autoDrive: 'on', maxReviewRounds: 2 });
    expect((r.investigations?.length ?? 0)).toBeGreaterThan(0);
  });

  test('B1 ledgerMode:off 관통 → 원장 안 씀(surface 제어 도달)', async () => {
    const ux = fakeUx();
    const r = await runStagedHarnessOnSurface({ objective: 'x', seams: fakeSeams({ async gate() { return { passed: false }; } }), ux, autoDrive: 'on', maxReviewRounds: 2, ledgerMode: 'off' });
    expect(r.investigations).toBeUndefined();
  });

  test('B1 sizingMode:off 관통 → sizing 계측 안 함(순수 골루프·ACP review #1 대칭)', async () => {
    // 다관심사 스텝(too_large 대상)이라도 sizingMode:off 면 plan-sizing 계측 자체를 건너뛴다.
    const ux = fakeUx({ confirmAnswer: true });
    const r = await runStagedHarnessOnSurface({
      objective: '타입 설계, 로직 구현, 테스트 검증',   // heuristic 1스텝(마커 없음) — 채점 대상
      seams: fakeSeams(), ux, autoDrive: 'safe', sizingMode: 'off',
    });
    expect(r.ok).toBe(true);   // off 여도 정상 완주(제어 흐름 무접촉)
  });
});

// ── C2(2026-07-25·리뷰#5343 반영) — diff-driven PR 제목/본문 (실 diff+summary→Summary/Why/Test plan) ──
//   fakeSeams(realWorktreeSeams)는 feature.ts(`export const x = 1;`)를 쓰고 summary='구현 완료' 반환.
describe('C2 diff-driven PR 메타 (buildPrTitle/buildPrBody)', () => {
  test('llmReview 주입 → 프롬프트에 실 diff·summary 포함(Goodhart 아님)·구조 본문 생성', async () => {
    let body = '', title = '', bodyPrompt = '', titlePrompt = '';
    const ux = fakeUx({ confirmAnswer: true });
    const routingLlm = async (p: string): Promise<string> => {
      if (/pull request description/i.test(p)) { bodyPrompt = p; return '## Summary\n- feature.ts 추가\n\n## Why\n필요\n\n## Test plan\n- [x] 구현 완료'; }
      if (/naming a pull request/i.test(p)) { titlePrompt = p; return 'feat: feature.ts 추가'; }
      return '리뷰 결과: 문제 없음. verdict pass.';   // 리뷰 critique → pass
    };
    const r = await runStagedHarnessOnSurface({
      objective: '기능 추가',
      seams: fakeSeams({ async openPr(a: { title: string; body: string }) { title = a.title; body = a.body; return { url: 'x', number: 1 }; } }),
      ux, autoDrive: 'safe', llmReview: routingLlm,
    });
    expect(r.terminal).toBe('pr-opened');
    // ★ 실 diff 가 프롬프트에 실제 포함됐나(배선 검증·Goodhart 해소) — fakeSeams 는 feature.ts 를 씀
    expect(bodyPrompt).toContain('feature.ts');
    expect(bodyPrompt).toContain('export const x = 1');
    expect(bodyPrompt).toContain('Verification summary');   // ★ 실행 summary 섹션 전달(허위 [x] 방지 근거)
    expect(bodyPrompt).toContain('1라운드 완료');            //   실제 deploy summary(round·verdict) 가 프롬프트에
    expect(titlePrompt).toContain('feature.ts');      // ★ 제목도 diff 반영(파일명뿐 아님)
    expect(body).toContain('## Summary');             // heuristic(## 목표) 아님
    expect(body).toContain('dev-harness');            // footer 보존
    expect(title).toBe('feat: feature.ts 추가');
  });
  test('본문 응답에 필수 구조(## Summary) 없으면 heuristic 폴백(허위 게시 차단)', async () => {
    let body = '';
    const ux = fakeUx({ confirmAnswer: true });
    const badLlm = async (p: string): Promise<string> => {
      if (/pull request description/i.test(p)) return '대충 아무 말 (구조 없음)';   // ## Summary 없음
      if (/naming a pull request/i.test(p)) return 'feat: x';
      return 'verdict pass.';
    };
    await runStagedHarnessOnSurface({
      objective: '기능',
      seams: fakeSeams({ async openPr(a: { body: string }) { body = a.body; return { url: 'x', number: 1 }; } }),
      ux, autoDrive: 'safe', llmReview: badLlm,
    });
    expect(body).toContain('## 목표');                // heuristic 폴백
    expect(body).not.toContain('대충 아무 말');       // 비구조 응답 게시 안 함
  });
  test('llmReview 미주입 → heuristic 본문(무회귀)', async () => {
    let body = '';
    const ux = fakeUx({ confirmAnswer: true });
    await runStagedHarnessOnSurface({
      objective: '기능',
      seams: fakeSeams({ async openPr(a: { body: string }) { body = a.body; return { url: 'x', number: 1 }; } }),
      ux, autoDrive: 'safe',
    });
    expect(body).toContain('## 목표');
    expect(body).toContain('## 변경');
  });
});

describe('runStagedHarnessOnSurface — goalDocument plumbing', () => {
  test('호출자가 준 골 문서를 buildHarnessSeams 로 선택 전달한다', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const orig = harnessSeams.buildHarnessSeams;
    const spy = spyOn(harnessSeams, 'buildHarnessSeams').mockImplementation((deps) => {
      captured.push({ ...deps });
      return orig(deps);
    });
    try {
      await runStagedHarnessOnSurface({
        objective: '기능',
        seams: fakeSeams(),
        ux: fakeUx({ confirmAnswer: true }),
        autoDrive: 'on',
        goalDocument: '## 판정 신호\n조건 = 단위시험; 관측 = goalLoaded; 기대 = true',
      });
      expect(captured).toHaveLength(1);
      expect(String(captured[0]!.goalDocument)).toContain('판정 신호');
    } finally {
      spy.mockRestore();
    }
  });

  test('골 문서가 없으면 buildHarnessSeams deps 에 goalDocument 키가 없다', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const orig = harnessSeams.buildHarnessSeams;
    const spy = spyOn(harnessSeams, 'buildHarnessSeams').mockImplementation((deps) => {
      captured.push({ ...deps });
      return orig(deps);
    });
    try {
      await runStagedHarnessOnSurface({
        objective: '기능',
        seams: fakeSeams(),
        ux: fakeUx({ confirmAnswer: true }),
        autoDrive: 'on',
      });
      expect(captured).toHaveLength(1);
      expect(Object.prototype.hasOwnProperty.call(captured[0], 'goalDocument')).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
