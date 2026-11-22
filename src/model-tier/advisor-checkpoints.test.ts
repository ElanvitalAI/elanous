// HARNESS-ADVISOR-CHECKPOINTS — 코어 올림 모듈 런타임. 가짜 강 모델 클라이언트 · 가짜 시계 · 실호출 0.
// 숫자는 모듈 상수에서 유도한다(NUMGUARD).
import { describe, expect, spyOn, test } from 'bun:test';
import { ADVISOR_MAX_CHARS, createCoreAdvisor, type CoreAdvisor } from './advisor-checkpoints.js';
import { createModelOrchestrationCore, DEFAULT_CORE_MODULES } from './model-orchestration.js';
import { classifyWorkRisk } from './work-risk-router.js';
import { STRONG_OUTPUT_MAX_TOKENS, STRONG_SHARE_YELLOW_ABOVE, runWithWorkTierContext, summarizeTierShares, workTierContext } from './work-tier-policy.js';
import { MAX_SAME_ERROR_ESCALATIONS } from './escalation-rules.js';
import type { AdvisorClient, AdvisorMoment, CoreDecisionLedgerRecord, CoreMode } from './orchestration-core.js';
import type { ModelTier } from './types.js';
import { logAgentTurnUsage } from '../llm.js';
import { debug } from '../debug/log.js';

const FAKE_LADDER: Readonly<Record<ModelTier, { model: string }>> = {
  budget: { model: 'fake-weak' }, balanced: { model: 'fake-balanced' }, better: { model: 'fake-mid' },
  best: { model: 'fake-strong' }, loaded: { model: 'fake-loaded' },
};
// SMART-ROUTER-PLUGIN-TIERS — 이 스위트는 ADVISOR 런타임 자체(세 순간·상한·원장)를 본다. 등급 게이트는 무제한 stub:
// 등급별 거부·허용은 src/plugins/smart-router/router-gate-wiring.test.ts 가 맡는다(기본 free 에서 same-error 가 막히지 않게).
const core = createModelOrchestrationCore({
  ...DEFAULT_CORE_MODULES,
  gate: { name: 'test-unrestricted', review: () => ({ allowed: true, reason: null }) },
  ladder: (p) => (p === 'fake' ? FAKE_LADDER : undefined),
});
const RISKY = classifyWorkRisk({ paths: ['src/self-implement/run-ledger.ts'] });
const PLAIN = classifyWorkRisk({ paths: ['src/tui/chat/status-line.ts'] });
const SECRET = 'PROSE-MARKER-hdr';
const FAILED = { ok: false, message: `boom ${SECRET}` };
// 출처: R-TST36 — 완료 판정은 남은 라운드가 있을 때만 돈다(escalation-rules: iteration < maxIterations). 1/3 은 그 조건의 표본일 뿐 상한이 아니다.
const ROUND = { iteration: 1, maxIterations: 3 } as const;

/** 가짜 시계 — 호출마다 한 칸씩 간다. */
function fakeClock() {
  let tick = 0;
  return () => ++tick;
}

interface Harness {
  advisor: CoreAdvisor;
  records: Array<{ record: CoreDecisionLedgerRecord; atMs: number }>;
  calls: Array<{ moment: AdvisorMoment; maxOutputTokens: number; model: string; contextDuringCall: ReturnType<typeof workTierContext> }>;
}

function harness(mode: CoreMode, opts: { work?: typeof RISKY; reply?: string; outputTokens?: number; client?: boolean; once?: Set<string> } = {}): Harness {
  const records: Harness['records'] = [];
  const calls: Harness['calls'] = [];
  const client: AdvisorClient = {
    async advise(request) {
      calls.push({ moment: request.moment, maxOutputTokens: request.maxOutputTokens, model: request.model, contextDuringCall: workTierContext() });
      // 실제 클라이언트처럼 같은 llm-usage 원장 경로로 사용량을 남긴다(문맥 = 강 · advisor:<순간>).
      logAgentTurnUsage(request.model, { inputTokens: STRONG_OUTPUT_MAX_TOKENS, outputTokens: opts.outputTokens ?? STRONG_OUTPUT_MAX_TOKENS } as never, { providerName: 'fake', site: `core-advisor:${request.moment}` });
      return { advice: opts.reply ?? `VERDICT: accept\n${SECRET}`, outputTokens: opts.outputTokens ?? STRONG_OUTPUT_MAX_TOKENS };
    },
  };
  const advisor = createCoreAdvisor({
    core, runId: 'run-hdr-advisor', provider: 'fake', work: opts.work ?? RISKY, mode,
    ...(opts.client === false ? {} : { client }),
    record: (record, atMs) => records.push({ record, atMs }),
    now: fakeClock(),
    onceRegistry: opts.once ?? new Set<string>(),
  });
  return { advisor, records, calls };
}


describe('three moments — each fires once, then de-escalates', () => {
  test('plan · same-error · pre-complete each consult the strong cell once with the cap', async () => {
    const h = harness('on');
    expect(await h.advisor.plan(`goal ${SECRET}`)).toMatchObject({ moment: 'plan' });
    expect(await h.advisor.plan(`goal ${SECRET}`)).toBeUndefined();
    expect(h.advisor.noteToolResult('Bash', FAILED)).toBeUndefined();
    const signature = h.advisor.noteToolResult('Bash', FAILED)!;
    expect(signature).toBeString();
    expect(await h.advisor.sameError('goal', [signature])).toMatchObject({ moment: 'same-error' });
    const done = await h.advisor.beforeComplete('goal', `evidence ${SECRET}`, ROUND);
    expect(done).toMatchObject({ moment: 'pre-complete' });
    expect(await h.advisor.beforeComplete('goal', 'evidence', { ...ROUND, iteration: ROUND.iteration + 1 })).toBeUndefined();
    expect(h.calls.map((call) => call.moment)).toEqual(['plan', 'same-error', 'pre-complete']);
    for (const call of h.calls) {
      expect(call.model).toBe(FAKE_LADDER.best.model);
      expect(call.maxOutputTokens).toBe(STRONG_OUTPUT_MAX_TOKENS);
      expect(call.contextDuringCall).toMatchObject({ tier: 'strong', trigger: `advisor:${call.moment}` });
    }
    // 내림: 상담이 끝나면 문맥이 풀려 손일 호출은 다시 기준 등급으로 적힌다.
    expect(workTierContext()).toBeNull();
    expect(h.records.map((entry) => entry.record.trigger)).toEqual(['advisor:plan', 'advisor:same-error', 'advisor:pre-complete']);
    expect(h.records.map((entry) => entry.atMs)).toEqual([1, 2, 3]);
  });

  test('re-entering the goal loop for the same run does not re-consult plan or pre-complete', async () => {
    const once = new Set<string>();
    const first = harness('on', { once });
    await first.advisor.plan('goal');
    await first.advisor.beforeComplete('goal', 'e', ROUND);
    const again = harness('on', { once });
    expect(await again.advisor.plan('goal')).toBeUndefined();
    expect(await again.advisor.beforeComplete('goal', 'e', ROUND)).toBeUndefined();
    expect(again.calls).toEqual([]);
  });

  test('overlapping consults keep their own context; outside a consult there is none', async () => {
    const seen: Array<string | null> = [];
    const outer = runWithWorkTierContext({ tier: 'strong', trigger: 'advisor:plan' }, async () => {
      await Promise.resolve();
      seen.push(workTierContext()?.trigger ?? null);
    });
    const inner = runWithWorkTierContext({ tier: 'strong', trigger: 'advisor:pre-complete' }, async () => {
      seen.push(workTierContext()?.trigger ?? null);
    });
    seen.push(workTierContext()?.trigger ?? null);
    await Promise.all([outer, inner]);
    expect(seen.sort()).toEqual(['advisor:plan', 'advisor:pre-complete', null].sort());
  });

  test('same-error consults stop after the per-loop cap', () => {
    const h = harness('on');
    const fired: string[] = [];
    for (let kind = 0; kind <= MAX_SAME_ERROR_ESCALATIONS; kind += 1) {
      const failed = { ok: false, message: `distinct failure kind ${'x'.repeat(kind + 1)}` };
      h.advisor.noteToolResult('Bash', failed);
      const second = h.advisor.noteToolResult('Bash', failed);
      if (second) fired.push(second);
    }
    expect(fired).toHaveLength(MAX_SAME_ERROR_ESCALATIONS);
  });

  test('plain (L1–3) work skips the plan and pre-complete consults; same-error still consults', async () => {
    const h = harness('on', { work: PLAIN });
    expect(await h.advisor.plan('goal')).toBeUndefined();
    expect(await h.advisor.beforeComplete('goal', 'evidence', ROUND)).toBeUndefined();
    expect(await h.advisor.sameError('goal', ['Bash:boom'])).toMatchObject({ moment: 'same-error' });
    expect(h.calls.map((call) => call.moment)).toEqual(['same-error']);
  });
});

describe('cap · shadow · ledger', () => {
  test('advice over the cap is clipped and flagged', async () => {
    const h = harness('on', { reply: 'a'.repeat(ADVISOR_MAX_CHARS * 2), outputTokens: STRONG_OUTPUT_MAX_TOKENS + 1 });
    const advice = (await h.advisor.plan('goal'))!;
    expect(advice.clipped).toBe(true);
    expect(Array.from(advice.text.replace(/…$/, ''))).toHaveLength(ADVISOR_MAX_CHARS);
  });

  test('shadow makes no calls and records what it would have consulted', async () => {
    const h = harness('shadow');
    expect(await h.advisor.plan('goal')).toBeUndefined();
    expect(await h.advisor.beforeComplete('goal', 'e', ROUND)).toBeUndefined();
    expect(h.calls).toEqual([]);
    expect(h.records.map((entry) => entry.record)).toEqual([
      expect.objectContaining({ trigger: 'advisor:plan', mode: 'shadow', applied: false, skip: 'shadow', tier: 'strong', model: FAKE_LADDER.best.model }),
      expect.objectContaining({ trigger: 'advisor:pre-complete', mode: 'shadow', applied: false, skip: 'shadow' }),
    ]);
  });

  test('on without a client records no-advisor-client and makes no call', async () => {
    const h = harness('on', { client: false });
    expect(await h.advisor.plan('goal')).toBeUndefined();
    expect(h.records[0]!.record).toMatchObject({ applied: false, skip: 'no-advisor-client' });
  });

  test('ledger entries carry no text and the usage share counts advisor calls as strong', async () => {
    const usage: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: Record<string, unknown>) => {
      if (category === 'llm.usage' && event === 'llm-usage') usage.push(data);
    }) as never);
    try {
      const h = harness('on');
      await h.advisor.plan(`goal ${SECRET}`);
      h.advisor.noteToolResult('Bash', FAILED);
      const signature = h.advisor.noteToolResult('Bash', FAILED)!;
      await h.advisor.sameError(`goal ${SECRET}`, [signature]);
      await h.advisor.beforeComplete('goal', `evidence ${SECRET}`, ROUND);
      expect(JSON.stringify(h.records)).not.toContain(SECRET);
      expect(JSON.stringify(usage)).not.toContain(SECRET);
      expect(usage.map((row) => row.workTierTrigger)).toEqual(['advisor:plan', 'advisor:same-error', 'advisor:pre-complete']);
      // 손일(약) 토큰을 강 상담 토큰의 몇 배로 더하면 몫이 문턱 아래/위로 갈린다.
      const strongTokens = usage.length * 2 * STRONG_OUTPUT_MAX_TOKENS;
      const weakRow = (tokens: number) => ({ workTier: 'weak', inputTokens: tokens });
      const under = summarizeTierShares([...usage as never[], weakRow(strongTokens / STRONG_SHARE_YELLOW_ABOVE)]);
      expect(under.rows.find((row) => row.tier === 'strong')!.calls).toBe(usage.length);
      expect(under.status).toBe('GREEN');
      const over = summarizeTierShares([...usage as never[], weakRow(strongTokens)]);
      expect(over.status).toBe('YELLOW');
    } finally { log.mockRestore(); }
  });
});
