// HARNESS-DIFFICULTY-ROUTER — 발사 결정점 배선: 그림자는 발사 모델을 바꾸지 않고, `on` 만 적용한다.
// 가짜 spawn · 가짜 원장 seam · LLM/네트워크 0.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHeadlessGoalLoopPty, pickImplementRoleWithRoute, shadowImplementRoute } from './headless-elanous-driver.js';
import { readAccountWindowSnapshot, resolveWindowAccountsMode } from '../model-tier/account-window-snapshot.js';
import { WORK_ROUTE_LEDGER_EVENT, planWorkRoute, recordLaunchRoute, recordWorkRouteDecision, resolveWorkRouteMode, windowAccountChildEnv, workRiskInputFromGoal } from './work-route.js';
import { WINDOW_ACCOUNT_EVENT, WINDOW_SNAPSHOT_TTL_MS, accountIdHash } from '../model-tier/window-account-selector.js';
import type { AccountState } from '../model-tier/orchestration-core.js';
import { classifyWorkRisk } from '../model-tier/work-risk-router.js';
import { CORE_BASE_TIER, modelOrchestrationCore } from '../model-tier/model-orchestration.js';
import { WORK_TIER_LADDER_CELL } from '../model-tier/work-tier-policy.js';
import { lookupLlmTierSpec } from '../model-tier/llm-tier-map.js';
import { buildUserConfig, resolveRoleLlm, setUserConfigOverlay } from '../user-config.js';
import { debug } from '../debug/log.js';
import type { RunLedgerEntry } from './run-ledger.js';
import { coreAdvisorForGoalLoop } from '../core-turn/core-advisor-wiring.js';

const PROVIDER = 'openai-codex' as const;
const PROSE_MARKER = 'PROSE-MARKER-hdr';

const goal = (paths: readonly string[], extra: readonly string[] = []) => [
  `A goal — ${PROSE_MARKER} the prose must never reach the ledger`, '- GoalType: implement', '',
  `대상 경로: ${paths.join(' · ')}`,
  ...extra,
].join('\n');

const RISKY_GOAL = goal(['src/self-implement/run-ledger.ts', 'src/tui/chat/status-line.ts']);
const PLAIN_GOAL = goal(['src/tui/chat/status-line.ts']);

function overlay(mode: 'shadow' | 'on' | undefined): void {
  setUserConfigOverlay((c) => ({
    ...c, llm: { ...c.llm, provider: PROVIDER },
    harness: { ...c.harness, difficultyPlacement: false, difficultyRouter: mode },
    roleLlm: undefined, roleModels: undefined, roleModelTiers: undefined,
  }));
}

beforeAll(() => overlay(undefined));
afterAll(() => setUserConfigOverlay(null));

async function launch(goalDocument: string, childLlm?: { provider: string; model: string; source: 'flag' }) {
  let env: Record<string, string> | undefined;
  const rows: RunLedgerEntry[] = [];
  await runHeadlessGoalLoopPty({
    binRoot: '/tmp/repo', cwd: '/tmp/hdr-child', featurePrompt: `decorated instructions ${PROSE_MARKER}`,
    goalDocument, runId: 'run-hdr-wiring', ...(childLlm ? { childLlm } : {}),
    recordWorkRoute: (entry) => { rows.push(entry); },
    // 출처: R-TST36 — 가짜 spawn 은 isAlive 두 번 뒤 끝나 이 값은 실제 대기가 아니다(src/llm/difficulty.test.ts 의 가짜 발사와 같은 값).
    maxWaitSec: 1, maxHardWaitSec: 1, pollMs: 1, activityGraceSec: 100,
    ptyAvailable: () => true,
    spawn: ((options: { env: Record<string, string> }) => {
      env = options.env;
      let reads = 0;
      return { id: 'self_hdr', write: () => {}, renderScreen: async () => 'working',
        renderScreenPng: async () => null, snapshot: () => 'working', drainDelta: () => '',
        isAlive: () => reads++ < 2, exitCode: 0, kill: () => {}, canWrite: () => true } as never;
    }) as never,
  });
  return { env: env!, rows: rows.filter((row) => row.event === WORK_ROUTE_LEDGER_EVENT) };
}

describe('difficultyRouter flag', () => {
  test('config: absent or invalid = shadow · only literal on applies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hdr-config-'));
    try {
      const path = join(dir, 'config.json');
      for (const [raw, expected] of [['on', 'on'], ['shadow', 'shadow'], ['ON', 'shadow'], [true, 'shadow'], [undefined, 'shadow']] as const) {
        writeFileSync(path, JSON.stringify({ harness: raw === undefined ? {} : { difficultyRouter: raw } }));
        const config = buildUserConfig(path);
        expect(config.harness?.difficultyRouter).toBe(expected);
        expect(resolveWorkRouteMode(config)).toBe(expected);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('goal metadata: target paths ⊕ declared categories ⊕ explicit level; prose is not an input', () => {
    const input = workRiskInputFromGoal(goal(['src/tui/a.ts'], ['위험 범주: locking · vibes', '위험 등급: L5']));
    expect(input).toEqual({ paths: ['src/tui/a.ts'], declaredCategories: ['locking', 'vibes'], explicitLevel: 'L5' });
    // 산문에 «lock»·«session» 이 있어도 경로·칸이 아니면 위험이 아니다(A205 · R-SIG).
    const prose = workRiskInputFromGoal(`lock the session store\n대상 경로: src/tui/a.ts`);
    expect(classifyWorkRisk(prose).riskCategories).toEqual([]);
  });
});

describe('launch decision point', () => {
  test('shadow (default) records the route but launches the unchanged role model', async () => {
    overlay(undefined);
    const inherited = process.env.ELANOUS_LLM_MODEL;
    delete process.env.ELANOUS_LLM_MODEL;
    try {
      const baseline = resolveRoleLlm('implement');
      const { env, rows } = await launch(RISKY_GOAL);
      expect(env.ELANOUS_LLM_MODEL).toBe(baseline.model);
      expect(rows).toHaveLength(1);
      const data = rows[0]!.data;
      expect(rows[0]!.runId).toBe('run-hdr-wiring');
      expect(data).toMatchObject({ kind: 'decision', moment: 'implement', mode: 'shadow', applied: false, skip: 'shadow', level: 'L4', riskCategories: ['persistence'] });
      expect(data.launched).toEqual({ provider: baseline.provider, model: baseline.model });
      expect(data.tier).toBe(CORE_BASE_TIER.risky.implement);
      expect(data.cell).toBe(WORK_TIER_LADDER_CELL[CORE_BASE_TIER.risky.implement]);
      expect(JSON.stringify(rows)).not.toContain(PROSE_MARKER);
      expect(data).not.toHaveProperty('round');
    } finally {
      if (inherited === undefined) delete process.env.ELANOUS_LLM_MODEL; else process.env.ELANOUS_LLM_MODEL = inherited;
    }
  });

  test('on applies the implement cell from the tier ladder: L4+ → middle · L1–3 → budget', async () => {
    overlay('on');
    const inherited = process.env.ELANOUS_LLM_MODEL;
    delete process.env.ELANOUS_LLM_MODEL;
    try {
      const baseline = resolveRoleLlm('implement');
      if (baseline.source !== 'default') return; // 명시 역할은 라우터가 건드리지 않는다(아래 시험).
      const risky = await launch(RISKY_GOAL);
      expect(risky.env.ELANOUS_LLM_MODEL).toBe(lookupLlmTierSpec(baseline.provider, WORK_TIER_LADDER_CELL[CORE_BASE_TIER.risky.implement]).model);
      expect(risky.rows[0]!.data).toMatchObject({ mode: 'on', applied: true, skip: null });
      const plain = await launch(PLAIN_GOAL);
      expect(plain.env.ELANOUS_LLM_MODEL).toBe(lookupLlmTierSpec(baseline.provider, WORK_TIER_LADDER_CELL[CORE_BASE_TIER.plain.implement]).model);
      expect(plain.rows[0]!.data).toMatchObject({ level: 'L1', applied: true });
    } finally {
      overlay(undefined);
      if (inherited === undefined) delete process.env.ELANOUS_LLM_MODEL; else process.env.ELANOUS_LLM_MODEL = inherited;
    }
  });

  test('on never overrides an explicit child LLM or a configured role', async () => {
    overlay('on');
    const inherited = process.env.ELANOUS_LLM_MODEL;
    delete process.env.ELANOUS_LLM_MODEL;
    try {
      const explicit = await launch(RISKY_GOAL, { provider: PROVIDER, model: 'explicit-model', source: 'flag' });
      expect(explicit.env.ELANOUS_LLM_MODEL).toBe('explicit-model');
      expect(explicit.rows[0]!.data).toMatchObject({ applied: false, skip: 'explicit-child-llm', launched: { model: 'explicit-model' } });
      setUserConfigOverlay((c) => ({ ...c, llm: { ...c.llm, provider: PROVIDER },
        harness: { ...c.harness, difficultyRouter: 'on' }, roleLlm: { implement: { model: 'configured-role', provider: PROVIDER } } }));
      const picked = pickImplementRoleWithRoute(RISKY_GOAL);
      expect(picked.role).toMatchObject({ model: 'configured-role' });
      expect(picked.route).toMatchObject({ applied: false, skip: 'non-default-role' });
    } finally {
      overlay(undefined);
      if (inherited === undefined) delete process.env.ELANOUS_LLM_MODEL; else process.env.ELANOUS_LLM_MODEL = inherited;
    }
  });
});

describe('ledger write is fail-soft', () => {
  test('a throwing writer does not throw and is reported without text', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const core = modelOrchestrationCore();
      const input = { runId: 'run-hdr-fail', moment: 'implement' as const, provider: 'no-such-provider', work: classifyWorkRisk({ paths: ['src/db/x.ts'] }) };
      const record = core.decisionRecord(core.decide(input), input,
        { mode: 'shadow', applied: false, skip: 'no-tier-ladder', launched: { provider: null, model: null } });
      const ok = await recordWorkRouteDecision(record, { append: () => { throw new Error(`disk full ${PROSE_MARKER}`); } });
      expect(ok).toBe(false);
      expect(log).toHaveBeenCalledWith(WORK_ROUTE_LEDGER_EVENT, 'ledger-write-failed', { runId: 'run-hdr-fail', error: 'Error' });
      expect(JSON.stringify(log.mock.calls)).not.toContain(PROSE_MARKER);
      expect(await recordWorkRouteDecision({ ...record, runId: ' ' }, { append: () => {} })).toBe(false);
    } finally { log.mockRestore(); }
  });
});

describe('goal-loop ADVISOR wiring', () => {
  test('only harness runs get an advisor; shadow records the plan consult without calling', async () => {
    overlay(undefined);
    expect(coreAdvisorForGoalLoop({ userText: RISKY_GOAL, env: {} })).toBeUndefined();
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const advisor = coreAdvisorForGoalLoop({ userText: RISKY_GOAL, env: { ELANOUS_RUN_ID: 'run-hdr-advisor-wiring' } })!;
      expect(await advisor.plan(RISKY_GOAL)).toBeUndefined();
      const decisions = log.mock.calls.filter(([category, event]) => category === WORK_ROUTE_LEDGER_EVENT && event === 'decision');
      expect(decisions).toHaveLength(1);
      expect(decisions[0]![2]).toMatchObject({ trigger: 'advisor:plan', mode: 'shadow', applied: false, skip: 'shadow' });
      expect(JSON.stringify(decisions)).not.toContain(PROSE_MARKER);
    } finally { log.mockRestore(); }
  });
});

describe('COST-OPTIMIZER-WINDOW-AWARE — launch wiring through the core', () => {
  const READ_AT = WINDOW_SNAPSHOT_TTL_MS * 4;
  const CHOSEN = 'ACCOUNT-NAME-MARKER-soon';
  const snapshot = (selection: 'shadow' | 'on', extra: Partial<AccountState> = {}): AccountState => ({
    active: { provider: PROVIDER, account: 'current' }, readAtMs: READ_AT, observedAtMs: READ_AT, selection,
    candidates: [
      { provider: PROVIDER, account: 'current', billing: 'subscription', window: { remaining: 1, resetsAtMs: READ_AT * 3 } },
      { provider: PROVIDER, account: CHOSEN, billing: 'subscription', window: { remaining: 1, resetsAtMs: READ_AT * 2 } },
    ],
    ...extra,
  });

  test('on: the launch decision switches to the soonest-reset account and the child gets that account; ledger holds the hash only', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const plan = planWorkRoute(RISKY_GOAL, PROVIDER, snapshot('on'), modelOrchestrationCore());
      expect(plan.decision).toMatchObject({ provider: PROVIDER, account: CHOSEN });
      expect(windowAccountChildEnv(plan, PROVIDER)).toEqual({ ELANOUS_CODEX_ACCOUNT: CHOSEN });
      const rows: RunLedgerEntry[] = [];
      recordLaunchRoute({ plan, mode: 'shadow', applied: false, skip: 'shadow' }, 'run-cow-launch', { provider: PROVIDER, model: null }, { append: (e) => { rows.push(e); }, log: () => {} });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.data).toMatchObject({ account: accountIdHash(PROVIDER, CHOSEN) });
      expect(JSON.stringify(rows)).not.toContain(CHOSEN);
      expect(JSON.stringify(log.mock.calls)).not.toContain(CHOSEN);
    } finally { log.mockRestore(); }
  });

  test('shadow: zero behaviour change — active account, no child account env, chosen hash only in the reason', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const plan = planWorkRoute(RISKY_GOAL, PROVIDER, snapshot('shadow'), modelOrchestrationCore());
      const before = planWorkRoute(RISKY_GOAL, PROVIDER, undefined, modelOrchestrationCore());
      expect(plan.decision).toMatchObject({ provider: before.decision.provider, model: before.decision.model, tier: before.decision.tier, cell: before.decision.cell, account: 'current' });
      expect(plan.decision.reason).toContain(`account:window-aware:shadow:subscription:${accountIdHash(PROVIDER, CHOSEN)}:subscription-resets-soonest`);
      expect(windowAccountChildEnv(plan, PROVIDER)).toEqual({});
    } finally { log.mockRestore(); }
  });

  test('explicit account and a different launched provider never switch; the provider skip emits', () => {
    const events: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: Record<string, unknown>) => {
      if (category === WINDOW_ACCOUNT_EVENT) events.push(`${event}:${String(data.reason ?? '')}`);
    }) as never);
    try {
      const explicit = planWorkRoute(RISKY_GOAL, PROVIDER, snapshot('on', { explicit: true }), modelOrchestrationCore());
      expect(explicit.decision.account).toBe('current');
      expect(windowAccountChildEnv(explicit, PROVIDER)).toEqual({});
      const plan = planWorkRoute(RISKY_GOAL, PROVIDER, snapshot('on'), modelOrchestrationCore());
      expect(windowAccountChildEnv(plan, 'anthropic')).toEqual({});
      expect(events).toEqual(['refused:explicit-account', 'picked:', 'apply-skip:provider-mismatch']);
    } finally { log.mockRestore(); }
  });

  /** 실제 발사 한 번 — implement 역할을 openai-codex 로 고정한다(overlay · roleLlm.implement). 역할이 codex 가 아니면 시험이 실패한다. */
  async function windowLaunch(selection: 'shadow' | 'on' | null) {
    const inherited = { model: process.env.ELANOUS_LLM_MODEL, provider: process.env.ELANOUS_LLM_PROVIDER };
    delete process.env.ELANOUS_LLM_MODEL;
    delete process.env.ELANOUS_LLM_PROVIDER;
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      setUserConfigOverlay((c) => ({
        ...c, llm: { ...c.llm, provider: PROVIDER },
        harness: { ...c.harness, difficultyPlacement: false, difficultyRouter: undefined },
        roleLlm: { implement: { provider: PROVIDER, model: lookupLlmTierSpec(PROVIDER, 'balanced').model } },
        roleModels: undefined, roleModelTiers: undefined,
      }));
      const role = resolveRoleLlm('implement');
      expect(role.provider).toBe(PROVIDER);
      const seen: { env?: Record<string, string> } = {};
      const rows: RunLedgerEntry[] = [];
      await runHeadlessGoalLoopPty({
        binRoot: '/tmp/repo', cwd: '/tmp/cow-child', featurePrompt: 'cow', goalDocument: RISKY_GOAL, runId: 'run-cow-launch',
        recordWorkRoute: (entry) => { rows.push(entry); },
        readAccountWindows: (provider) => {
          expect(provider).toBe(PROVIDER);
          return selection === null ? undefined : snapshot(selection);
        },
        // 출처: R-TST36 — 가짜 spawn 은 isAlive 두 번 뒤 끝나 이 값은 실제 대기가 아니다(위 launch 도우미와 같은 값).
        maxWaitSec: 1, maxHardWaitSec: 1, pollMs: 1, activityGraceSec: 100,
        ptyAvailable: () => true,
        spawn: ((options: { env: Record<string, string> }) => {
          seen.env = options.env;
          let reads = 0;
          return { id: 'self_cow', write: () => {}, renderScreen: async () => 'working',
            renderScreenPng: async () => null, snapshot: () => 'working', drainDelta: () => '',
            isAlive: () => reads++ < 2, exitCode: 0, kill: () => {}, canWrite: () => true } as never;
        }) as never,
      });
      const decisions = rows.filter((row) => row.event === WORK_ROUTE_LEDGER_EVENT);
      expect(decisions).toHaveLength(1);
      return { env: seen.env!, row: decisions[0]!.data as { accountApplied: boolean; appliedAccount: unknown; applied: boolean; skip: string | null } };
    } finally {
      log.mockRestore();
      overlay(undefined);
      for (const [key, value] of [['ELANOUS_LLM_MODEL', inherited.model], ['ELANOUS_LLM_PROVIDER', inherited.provider]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }

  test('on (model router shadow): the real launch relays the chosen account and the ledger row says accountApplied', async () => {
    const { env, row } = await windowLaunch('on');
    expect(env.ELANOUS_CODEX_ACCOUNT).toBe(CHOSEN);
    // 모델 라우터는 shadow 라 모델 적용은 false 지만, 계정은 실제로 바뀌었다 — 칸이 따로 말한다.
    expect(row).toMatchObject({ applied: false, accountApplied: true, appliedAccount: { kind: 'subscription', account: accountIdHash(PROVIDER, CHOSEN) } });
    expect(JSON.stringify(row)).not.toContain(CHOSEN);
  });

  test('accountApplied is true exactly when the child got the account env', async () => {
    for (const selection of ['shadow', null] as const) {
      const { env, row } = await windowLaunch(selection);
      expect(env.ELANOUS_CODEX_ACCOUNT).toBeUndefined();
      expect(row).toMatchObject({ accountApplied: false, appliedAccount: null });
    }
  });

  test('shadow launch (default config) adds no account env to the child', async () => {
    overlay(undefined);
    const { env } = await launch(RISKY_GOAL);
    expect(env.ELANOUS_CODEX_ACCOUNT).toBeUndefined();
  });

  test('symmetry: the ADVISOR consult goes through the same window selector', async () => {
    overlay(undefined);
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const advisor = coreAdvisorForGoalLoop({ userText: RISKY_GOAL, env: { ELANOUS_RUN_ID: 'run-cow-advisor' } })!;
      await advisor.plan(RISKY_GOAL);
      const decision = log.mock.calls.find(([category, event]) => category === WORK_ROUTE_LEDGER_EVENT && event === 'decision');
      expect((decision![2] as { reason: string[] }).reason.some((r) => r.startsWith('account:window-aware:'))).toBe(true);
      const selectorEvents = log.mock.calls.filter(([category]) => category === WINDOW_ACCOUNT_EVENT);
      expect(selectorEvents).not.toHaveLength(0);
      expect(selectorEvents.every(([, , data]) => (data as { mode?: string }).mode !== 'on')).toBe(true);
    } finally { log.mockRestore(); }
  });
});

describe('COST-OPTIMIZER-WINDOW-AWARE — read failure is not re-read (OP #38337 mf1)', () => {
  const failingRead = (provider: string, forceShadow = false) => readAccountWindowSnapshot(provider, {
    ...(forceShadow ? { forceShadow: true } : {}),
    config: () => ({ harness: { windowAccounts: 'on' } }),
    inspectCodex: () => { throw new Error('signal store unreadable'); },
  });
  const windowEvents = (calls: unknown[][]) => calls.filter(([category]) => category === WINDOW_ACCOUNT_EVENT)
    .map(([, event, data]) => `${String(event)}:${String((data as { reason?: unknown }).reason ?? '')}`);

  test('seam read failure → refused:no-snapshot, active kept, exactly one read-failed event', () => {
    overlay(undefined);
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const picked = pickImplementRoleWithRoute(RISKY_GOAL, (provider) => failingRead(provider));
      expect(picked.route).toBeDefined();
      const { decision, input } = picked.route!.plan;
      expect(input.accounts).toBeUndefined();
      expect(decision.account).toBeNull();
      expect(decision.reason).toContain('account:window-aware:refused:no-snapshot');
      expect(decision.reason.some((r) => r.includes(':switched:'))).toBe(false);
      expect(windowEvents(log.mock.calls)).toEqual(['snapshot-skip:read-failed', 'refused:no-snapshot']);
    } finally { log.mockRestore(); }
  });

  test('shadowImplementRoute (explicit child LLM) with a forceShadow read failure reads once and never logs switched', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    let reads = 0;
    try {
      const outcome = shadowImplementRoute(RISKY_GOAL, PROVIDER, 'explicit-child-llm', (provider) => { reads += 1; return failingRead(provider, true); });
      expect(reads).toBe(1);
      expect(outcome!.plan.decision.reason).toContain('account:window-aware:refused:no-snapshot');
      expect(outcome!.plan.decision.reason.some((r) => r.includes(':switched:'))).toBe(false);
      expect(windowEvents(log.mock.calls).filter((e) => e === 'snapshot-skip:read-failed')).toHaveLength(1);
    } finally { log.mockRestore(); }
  });
});

describe('harness.windowAccounts config (OP #38337 check 2)', () => {
  test('invalid values (ON, true, live, 1) normalise to shadow through the real config read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-cow-config-'));
    try {
      const path = join(dir, 'config.json');
      for (const [raw, stored, mode] of [['ON', undefined, 'shadow'], [true, undefined, 'shadow'], ['live', undefined, 'shadow'], [1, undefined, 'shadow'],
        ['shadow', undefined, 'shadow'], [undefined, undefined, 'shadow'], ['on', 'on', 'on']] as const) {
        writeFileSync(path, JSON.stringify({ harness: raw === undefined ? {} : { windowAccounts: raw } }));
        const config = buildUserConfig(path);
        expect(config.harness?.windowAccounts).toBe(stored);
        expect(resolveWindowAccountsMode(config)).toBe(mode);
        expect(readAccountWindowSnapshot('anthropic', { config: () => config, emit: () => {} })?.selection).toBe(mode);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('COST-OPTIMIZER-WINDOW-AWARE — unmeasured window signals are marked (OP #38337 ②)', () => {
  const NOW = WINDOW_SNAPSHOT_TTL_MS * 4;
  // 운영 제공자 경로(readAccountWindowSnapshot) 그대로 — 가짜는 디스크 신호 점검 seam 뿐이다.
  const productionSnapshot = (selection: 'shadow' | 'on') => readAccountWindowSnapshot(PROVIDER, {
    now: () => NOW, emit: () => {}, config: () => ({ harness: selection === 'on' ? { windowAccounts: 'on' } : {} }),
    inspectCodex: () => ({
      current: { name: 'default', storeKey: 'openai-codex', home: '/h/default', source: 'default' },
      explicit: false, reason: 'not-reached', to: undefined,
      candidates: [
        { name: 'default', storeKey: 'openai-codex', home: '/h/default', reached: undefined, usedPercent: 90 },
        { name: 'team', storeKey: 'openai-codex:team', home: '/h/team', reached: undefined, usedPercent: 10 },
      ],
      observedAtByHome: { '/h/default': NOW, '/h/team': NOW },
      freshByHome: { '/h/default': true, '/h/team': true },
    }),
  });

  test('the production snapshot path yields a decision row carrying unmeasured [resetsAtMs, costRank, mustLastUntilMs]', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      for (const selection of ['shadow', 'on'] as const) {
        const plan = planWorkRoute(RISKY_GOAL, PROVIDER, productionSnapshot(selection), modelOrchestrationCore());
        expect(plan.decision.unmeasured).toEqual(['resetsAtMs', 'costRank', 'mustLastUntilMs']);
        expect(plan.decision.reason).toContain('unmeasured:resetsAtMs+costRank+mustLastUntilMs');
        const rows: RunLedgerEntry[] = [];
        recordLaunchRoute({ plan, mode: 'shadow', applied: false, skip: 'shadow' }, 'run-cow-unmeasured', { provider: PROVIDER, model: null },
          { append: (entry) => { rows.push(entry); }, log: () => {} });
        expect(rows).toHaveLength(1);
        expect(rows[0]!.data).toMatchObject({ unmeasured: ['resetsAtMs', 'costRank', 'mustLastUntilMs'] });
      }
    } finally { log.mockRestore(); }
  });

  test('a missing snapshot also marks every window signal unmeasured', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const plan = planWorkRoute(RISKY_GOAL, PROVIDER, undefined, modelOrchestrationCore());
      expect(plan.decision.unmeasured).toEqual(['resetsAtMs', 'costRank', 'mustLastUntilMs']);
    } finally { log.mockRestore(); }
  });
});
