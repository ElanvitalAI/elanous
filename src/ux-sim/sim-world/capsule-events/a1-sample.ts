// A1 sample replay — CAPSULE-A1-POLICY remaining boundary (release checklist 0.3.32 P0 yellow · OP #121580).
// Provenance (JUD-B #127282 정정): this is a STRUCTURAL SYNTHESIS sample built on the audit counts of the 11-18
// 46-minute «Responding» turn (TURN-EVENT-ARCHITECTURE-AUDIT-1118) — NOT a verbatim replay of four observed axes.
// The audit (§2.2 D3) could NOT confirm direct harness·MCP events in that turn, and the §2 timing counts come from a
// separate session; only the Bash·Agent axes rest on direct audit observation. The harness·MCP axes below are
// structural-synthesis axes: probes synthesized from the audit's capsule-family structure, dispatched here to measure
// the junction. This replay compresses the wall clock but preserves the sample's isolation shape — ONE core turn
// carrying all four detach axes — and measures the judgment log: every axis must land a `turn-life:capsule-policy`
// decision row (tool·kind·mode·syncCapMs·reason) at the dispatch junction. Judgment-only (배선 0): the coverage row
// never detaches anything by itself; shell keeps its behavioral A2 decision inside its own dispatch. Real core turn;
// the LLM is the external fake device.
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { debug } from '../../../debug/log.js';
import { runCoreTurn } from '../../../core-turn/run-core-turn.js';
import type { LLMProvider } from '../../../llm.js';
import type { LLMToolSpec } from '../../../llm/tool-spec.js';
import type { SimWorldScenario, SimWorldScenarioOutcome } from '../types.js';

/** The sample's isolation axes (§C detach targets; Bash·Agent audit-observed · harness·MCP structural synthesis — §2.2 D3 감사 미확인): tool name → contract CapsuleKind. */
const AXES: ReadonlyArray<{ readonly name: string; readonly kind: string }> = [
  { name: 'Bash', kind: 'shell' },
  { name: 'Agent', kind: 'agent' },
  // terra r8 mustFix[0]: the axis is the REAL caller's harness tool — RunDevHarness itself — dispatched through the
  // same runCoreTurn path, never a virtual harness-form name that bypasses the cold-turn deferred-tier skip
  // (RunDevHarness is one of the 8 native deferred tools; a cold-turn call is skipped as deferred-tool-tier BEFORE
  // the dispatch junction, so the judgment log cannot see it there). The run() below ACTIVATES the real tool the
  // way a real caller gets it — the tier-flip warm-preload 'coding' intent scope — so the canonical name's
  // judgment row is captured.
  { name: 'RunDevHarness', kind: 'harness' },
  { name: 'mcp__a1_sample__probe', kind: 'mcp' },
];

const tools: LLMToolSpec[] = AXES.map(axis => ({
  name: axis.name,
  description: `A1 sample axis probe (${axis.kind})`,
  parameters: { type: 'object', properties: {}, required: [] },
}));

/** One captured `turn-life` row (event + payload; the payload may be a JSON string). */
export interface A1PolicyRow { readonly event: string; readonly data: unknown }

/** Binding verdict — the judgment rows bound to this scenario's session and dispatched tools. */
export interface A1PolicyBindVerdict {
  readonly ok: boolean;
  readonly missing: ReadonlyArray<{ readonly kind: string; readonly name: string }>;
  readonly thin: A1PolicyRow | null;
  /** JUD-B #127289: first bound row whose mode·reason·syncCapMs diverge from the expected decision, if any. */
  readonly mismatch: A1PolicyRow | null;
  readonly policyRows: number;
  readonly boundRows: number;
  readonly boundKinds: readonly string[];
}

const rowField = (data: unknown, key: string): unknown => {
  if (data !== null && typeof data === 'object') return (data as Record<string, unknown>)[key];
  if (typeof data === 'string') {
    try { return (JSON.parse(data) as Record<string, unknown>)[key]; } catch { return undefined; }
  }
  return undefined;
};

/**
 * Bind the process-global judgment rows to THIS scenario (HOLD #122689 위양성 차단): the captured log is
 * process-global, so a foreign turn's rows could otherwise satisfy a missing axis. A row counts only when
 * its sessionId is this scenario's session AND its tool is one of the dispatched tools; each axis must then
 * land a row with that axis's tool ⊕ kind. Foreign-session rows alone ⇒ every axis missing ⇒ not ok.
 *
 * JUD-B #127289 단언 결속 + #127560 독립 기대: a bound row is only acceptable when its decision
 * fields match the scenario's expected verdict exactly — mode 'sync' · reason 'capsule-sync-cap' ·
 * syncCapMs === 10000. The expected cap is an INDEPENDENT literal, deliberately NOT imported from
 * CAPSULE_SYNC_CAP_MS: if the product default constant itself drifted (e.g. to 5000), this binding
 * must catch the drift as a mismatch instead of silently re-basing the expectation (JUD-B #127560).
 * String-presence is not enough: a mis-configured cap (e.g. 5000) or a divergent mode/reason makes
 * the row `mismatch` ⇒ not ok.
 */
const EXPECTED_SYNC_CAP_MS = 10000;
const EXPECTED_DECISION = { mode: 'sync', reason: 'capsule-sync-cap', syncCapMs: EXPECTED_SYNC_CAP_MS } as const;

export function bindSamplePolicyRows(input: {
  readonly rows: readonly A1PolicyRow[];
  readonly sessionId: string;
  readonly dispatched: readonly string[];
}): A1PolicyBindVerdict {
  const policyRows = input.rows.filter(row => row.event === 'turn-life:capsule-policy');
  const dispatchedTools = new Set(input.dispatched);
  const bound = policyRows.filter(row => {
    if (rowField(row.data, 'sessionId') !== input.sessionId) return false;
    const tool = rowField(row.data, 'tool');
    return typeof tool === 'string' && dispatchedTools.has(tool);
  });
  const boundKinds = [...new Set(bound
    .map(row => rowField(row.data, 'kind'))
    .filter((kind): kind is string => typeof kind === 'string'))];
  const missing = AXES
    .filter(axis => !bound.some(row =>
      rowField(row.data, 'tool') === axis.name && rowField(row.data, 'kind') === axis.kind))
    .map(axis => ({ kind: axis.kind, name: axis.name }));
  const mismatch = bound.find(row =>
    rowField(row.data, 'mode') !== EXPECTED_DECISION.mode
    || rowField(row.data, 'reason') !== EXPECTED_DECISION.reason
    || rowField(row.data, 'syncCapMs') !== EXPECTED_DECISION.syncCapMs) ?? null;
  const thin = bound.find(row =>
    typeof rowField(row.data, 'mode') !== 'string' || typeof rowField(row.data, 'reason') !== 'string') ?? null;
  return {
    ok: missing.length === 0 && thin === null && mismatch === null,
    missing, thin, mismatch,
    policyRows: policyRows.length,
    boundRows: bound.length,
    boundKinds,
  };
}

/**
 * JUD-B #127605: the scenario's decision tail, extracted so a negative control can exercise the
 * END-TO-END judgment path (not just bindSamplePolicyRows) — a bound verdict with ONLY a mismatched
 * row (no missing, no thin) must come back ok:false with the divergence reason, never ok:true.
 */
export function a1SampleDecision(bound: A1PolicyBindVerdict, dispatched: readonly string[]): SimWorldScenarioOutcome {
  if (dispatched.length !== AXES.length) {
    return {
      ok: false,
      reason: 'the sample turn did not dispatch all four isolation axes',
      diff: `dispatched [${dispatched.join(', ')}] of [${AXES.map(a => a.name).join(', ')}]`,
    };
  }
  if (bound.missing.length > 0) {
    return {
      ok: false,
      reason: 'the capsule policy judgment log misses sample isolation axes bound to this session',
      diff: `missing ${bound.missing.map(a => `${a.kind}(${a.name})`).join(', ')}; bound kinds [${bound.boundKinds.join(', ') || 'none'}] of [${AXES.map(a => a.kind).join(', ')}] (policyRows ${bound.policyRows}, bound ${bound.boundRows})`,
    };
  }
  if (bound.thin) return { ok: false, reason: 'a judgment row lacks decision fields', diff: JSON.stringify(bound.thin) };
  if (bound.mismatch) {
    return {
      ok: false,
      reason: 'a judgment row diverges from the expected decision (mode·reason·syncCapMs exact match)',
      diff: JSON.stringify(bound.mismatch),
    };
  }
  return { ok: true };
}

const a1Sample: SimWorldScenario = {
  id: 'A1',
  title: 'the 11-18 46-minute turn sample (structural synthesis, not a verbatim replay) runs and the capsule policy judgment log captures every isolation axis',
  async run(ctx) {
    const sessionId = `a1-sample-${randomUUID().replaceAll('-', '')}`;
    const rows: Array<{ event: string; data: unknown }> = [];
    const dispatched: string[] = [];
    // Capture the in-process judgment log without depending on the debug ledger file location (inline isolate).
    const originalLog = debug.log;
    let patched = false;
    // terra r9 mustFix[0]: the boundary is SCENARIO-SCOPED injection (capsulePolicyTurnConfig per
    // runCoreTurn call) — the process-global config dir is NEVER swapped during the scenario, so a
    // concurrently running real turn keeps reading its own user config. The main turn below pins the
    // sample's own cap (10000 — an independent literal, JUD-B #127560 doctrine: never imported from the
    // product constant) instead of borrowing the host's dir, and the separate reflection turn below
    // pins a valid user cap (5000) to prove a configured setting IS honored in its own row
    // (terra r8 mustFix[2] kept: a host user turn.syncCapMs cannot leak into the sample's main-turn rows).
    let configReflection = { ok: false, row: null as A1PolicyRow | null };
    // terra r12 mustFix[1]/[2]: the reflection turn verifies the REAL operational settings path in an
    // ISOLATED CHILD PROCESS — a fixture user-config file (JUD #123019: fixture-only, never a copy of
    // an operational config) sits at that process's actual config location, the turn takes NO injection
    // (neither capsulePolicyTurnConfig nor capsulePolicyTurnConfigPath), and the judgment row must come
    // back through readUserConfigObject(userConfigPath()) → getElanousConfigDir(). Cleanup is the finally
    // below; the parent's process-global config dir is never touched (terra r9 mustFix[0]).
    let fixtureDir: string | null = null;
    // 반영 러너 진단(실패 diff용 — 러너 미실행/비정상 종료 원문을 판정 diff에 남긴다).
    let reflectDiag = 'reflection runner not run';
    try {
      try {
        (debug as { log: (category: string, event: string, data?: unknown) => void }).log =
          (category, event, data) => {
            if (category === 'turn-life') rows.push({ event, data });
            try { originalLog.call(debug, category, event, data); } catch { /* mirror must not break the seat */ }
          };
        patched = true;
      } catch { patched = false; /* rows stay empty; the verdict reports the capture failure */ }
      let round = 0;
      const provider: LLMProvider = {
        name: 'a1-fake', defaultModel: 'a1-fake', available: () => true,
        async *chat() { yield 'unused'; },
        async *streamChat() {
          if (++round === 1) {
            for (const axis of AXES) {
              yield { type: 'tool_call' as const, id: `a1_${axis.kind}`, name: axis.name, args: { probe: axis.kind } };
            }
          } else {
            yield { type: 'text' as const, delta: 'A1 sample turn done' };
          }
        },
      };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      try {
        // terra r8 mustFix[0]: coding-intent user text warms tier-flip's 'coding' preload scope, so the
        // REAL harness tool RunDevHarness — a native deferred tool — is ACTIVE the way a real caller
        // gets it and its dispatch crosses the junction (the judgment row for the canonical name is
        // captured; no virtual harness-form name bypassing the cold-turn deferred-tier skip).
        await runCoreTurn({
          sessionId,
          messages: [{ role: 'user', content: 'Implement the four sample axis probes and run the tests.' }],
          tools,
          initialProvider: provider,
          signal: controller.signal,
          // terra r9 mustFix[0]: scenario-scoped boundary — this main turn is judged at the sample's
          // own cap (10000 literal) whatever the host/process user config holds; no global dir swap.
          capsulePolicyTurnConfig: { syncCapMs: EXPECTED_SYNC_CAP_MS },
          dispatchTool: async (name: string) => {
            dispatched.push(name);
            return { content: [{ type: 'text', text: `A1 ${name} axis done` }] };
          },
        });
      } finally { clearTimeout(timer); }
      // 사용자 설정 반영(별도 검증 · terra r12 mustFix[1]/[2]): 격리된 자식 프로세스(a1-reflect-runner.ts)
      // 안에서 실제 설정 위치에 fixture를 두고 주입 경로 없이 runCoreTurn을 실행한다. 핀 경로
      // (capsulePolicyTurnConfigPath)는 파일은 읽지만 운영 userConfigPath() 호출을 건너뛰어 설정 파일
      // 경로 해석 회귀를 놓친다(terra r12 mustFix[1]) — 판정 턴은 이제 어떤 주입(capsulePolicyTurnConfig·
      // capsulePolicyTurnConfigPath)도 받지 않고 실제 readUserConfigObject(userConfigPath()) →
      // getElanousConfigDir() 경로로 fixture를 읽는다. setElanousConfigDir은 격리된 자식 프로세스
      // 안에서만 걸린다(terra r12 mustFix[2]) — 부모의 전역 config dir은 그대로다(terra r9 mustFix[0]).
      // 5000은 독립 리터럴(JUD-B #127560 교리 — 제품 상수 미수입).
      fixtureDir = mkdtempSync(join(tmpdir(), 'a1-sample-cfg-'));
      const fixtureCfgDir = join(fixtureDir, 'config');
      mkdirSync(fixtureCfgDir, { recursive: true });
      writeFileSync(join(fixtureCfgDir, 'config.json'), JSON.stringify({ turn: { syncCapMs: 5000 } }), 'utf-8');
      const reflectOut = join(fixtureDir, 'reflect-rows.json');
      const reflectRunner = fileURLToPath(new URL('./a1-reflect-runner.ts', import.meta.url));
      const reflectChild = Bun.spawn([process.execPath, reflectRunner, fixtureCfgDir, reflectOut], { stdout: 'pipe', stderr: 'pipe' });
      const [, reflectStderr, reflectExit] = await Promise.all([
        new Response(reflectChild.stdout).text(),
        new Response(reflectChild.stderr).text(),
        reflectChild.exited,
      ]);
      reflectDiag = `runner exit ${reflectExit}: ${reflectStderr.slice(0, 400)}`;
      let reflectRow: A1PolicyRow | null = null;
      if (reflectExit === 0) {
        try {
          const parsed = JSON.parse(readFileSync(reflectOut, 'utf-8')) as { sessionId: string; rows: readonly A1PolicyRow[] };
          reflectRow = parsed.rows.find(row =>
            row.event === 'turn-life:capsule-policy'
            && rowField(row.data, 'sessionId') === parsed.sessionId
            && rowField(row.data, 'tool') === 'Bash') ?? null;
        } catch { reflectRow = null; /* malformed runner output → the reflection check fails below */ }
      }
      configReflection = {
        ok: reflectRow !== null
          && rowField(reflectRow.data, 'mode') === 'sync'
          && rowField(reflectRow.data, 'reason') === 'capsule-sync-cap'
          && rowField(reflectRow.data, 'syncCapMs') === 5000, // 독립 기대(JUD-B #127560 교리 — 제품 상수 미수입)
        row: reflectRow,
      };
    } finally {
      if (fixtureDir !== null) { try { rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* cleanup must not fail the scenario */ } }
      try { (debug as { log: unknown }).log = originalLog; } catch { /* already immutable */ }
    }
    const bound = bindSamplePolicyRows({ rows, sessionId, dispatched });
    ctx.recorder.event('a1-policy-rows', {
      patched,
      dispatched: dispatched.length,
      policyRows: bound.policyRows,
      boundRows: bound.boundRows,
      kindsLogged: bound.boundKinds,
      configReflection: {
        ok: configReflection.ok,
        syncCapMs: configReflection.row ? rowField(configReflection.row.data, 'syncCapMs') : null,
      },
    });
    const decision = a1SampleDecision(bound, dispatched);
    if (decision.ok && !configReflection.ok) {
      return {
        ok: false,
        reason: 'a valid user turn.syncCapMs (5000) must be honored in the reflection turn judgment row (sync/capsule-sync-cap·5000)',
        diff: configReflection.row ? JSON.stringify(configReflection.row.data) : `no reflection row captured (${reflectDiag})`,
      };
    }
    return decision;
  },
};

export const simWorldScenarios: readonly SimWorldScenario[] = [a1Sample];
