// ── Tool runtime registry ──
//
// In-process map from tool id / alias → ToolRuntime instance. Lookup
// consults nativeToolCatalog for alias resolution so LLM aliases
// (PtyShellStart, pty_shell_start) all route to the same runtime.

import { debug } from '../debug/log.js';
import { findNativeTool } from '../native-tool-catalog.js';
import { runVerifier, isVerifierDisabled } from '../verifier/hook.js';
import { isGuardianEnabled, runGuardian, summarizeArgs } from '../guardian/check.js';
import { recordIntentMiss } from '../tool-hints/intent-miss.js';
import type { GuardianContext } from '../guardian/types.js';
import type { VerifierContext } from '../verifier/types.js';
import type { ToolRuntime, ToolRuntimeContext, ToolRunResult, ToolSurface } from './types.js';

const registry = new Map<string, ToolRuntime<never, never>>();

/** Register a runtime. Idempotent for the same object; throws on id
 *  collision with a DIFFERENT runtime so a double-init bug surfaces
 *  loudly.
 *
 *  The parameter is the universal ToolRuntime supertype
 *  (`ToolRuntime<never, ToolRunResult>`) rather than a generic
 *  `<Req, Out>`: the registry stores runtimes opaquely (keyed by id)
 *  and never calls `run` with typed args here, so a single generic
 *  `Req` would be wrongly unified against the first element of a
 *  heterogeneous runtime-array (e.g. `ALL_CFT_RCA_RUNTIMES`), rejecting
 *  the other members whose `run(req)` inputs differ. Contravariance
 *  makes `never` accept every runtime's Req; the covariant `Out`
 *  keeps the `ToolRunResult` constraint. */
export function registerToolRuntime(
  rt: ToolRuntime<never, ToolRunResult>,
): void {
  const existing = registry.get(rt.id);
  if (existing && existing !== (rt as unknown)) {
    throw new Error(`ToolRuntime id collision: ${rt.id}`);
  }
  registry.set(rt.id, rt as unknown as ToolRuntime<never, never>);
}

/** Look up a runtime by id, catalog alias, or PascalCase spec name.
 *  Returns undefined when no match — callers decide whether to fall
 *  back to the legacy direct-dispatch map. */
export function getToolRuntime(nameOrAlias: string): ToolRuntime | undefined {
  // Direct hit first (avoids catalog lookup cost for the hot path).
  const direct = registry.get(nameOrAlias);
  if (direct) return direct as unknown as ToolRuntime;
  // Alias resolution via catalog.
  const entry = findNativeTool(nameOrAlias);
  if (!entry) return undefined;
  const viaId = registry.get(entry.id);
  return viaId as unknown as ToolRuntime | undefined;
}

/** Dispatch by LLM-facing name (or alias). Throws when no runtime is
 *  registered — callers can catch and delegate to their legacy
 *  dispatch map if needed.
 *
 *  Arc B — when the resolved catalog entry declares `guardian?:
 *  GuardianSpec` and `HARNESS_GUARDIAN_ENABLED=1`, the policy runs
 *  BEFORE `rt.run()`. A `deny` verdict returns `{ok:false, error:
 *  "guardian: <reason>"}` without invoking the runtime — data, never
 *  exceptions. Default-off so workflow latency is unaffected.
 *
 *  Arc D — when the resolved catalog entry declares `verifier?:
 *  VerifierSpec` and that tool's verifier hasn't been auto-disabled,
 *  the result is post-processed: failing reports prepend
 *  `verifierIssues` so the LLM can self-recover on the next turn.
 *  Verifier failures NEVER throw — data, not exceptions. */
export async function dispatchToolByName(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolRuntimeContext,
): Promise<ToolRunResult> {
  const rt = getToolRuntime(name);
  if (!rt) throw new Error(`No ToolRuntime registered for '${name}'`);
  const entryPre = findNativeTool(name);
  // Arc H follow-up — dispatch-time miss telemetry. Cheap: no-op when
  // discipline env is off, when no active-scope snapshot exists, or
  // when the tool is in an always-active lane ('coding' / 'always').
  if (entryPre?.intentScope) recordIntentMiss(entryPre.id, entryPre.intentScope);
  if (entryPre?.guardian && isGuardianEnabled()) {
    try {
      const summary = summarizeArgs(args);
      // TC #92362 — raw, untruncated `command` for the shell-argv
      // policy. `summary.command` is 200-char truncated; reusing it
      // would break classifyShellArgv's command/argv consistency
      // re-parse (long commands would mis-deny) and skew the audit
      // sha. Only a string counts — anything else stays undefined and
      // the policy fail-closes.
      const shellCommand = typeof args['command'] === 'string' ? args['command'] : undefined;
      const guardianContext: GuardianContext = {
        toolId: entryPre.id,
        surface: ctx.surface,
        argsSummary: summary,
        ...(shellCommand !== undefined ? { shellCommand } : {}),
      };
      const verdict = runGuardian(entryPre.guardian, guardianContext);
      if (verdict.decision === 'deny') {
        return {
          ok: false,
          error: `guardian: ${verdict.reasons.join('; ')}${verdict.approvalRequest !== undefined ? `\n${verdict.approvalRequest}` : ''}`,
          guardianReasons: verdict.reasons,
        };
      }
    } catch {
      // Guardian itself must never break dispatch — swallow and
      // pass-through so a misbehaving policy doesn't take a tool
      // offline.
    }
  }
  // ⭐⭐ 툴 «호출»을 세는 한 자리 — 모든 툴이 이 함수를 지난다.
  //
  // ⛔⭐ **왜 필요한가**(2026-08-20): 「이 툴을 «쓰나»」를 묻는 자가 «없었다».
  //   그래서 은퇴·흡수 판단(RFC-one-door-many-entrances P4·P5)의 근거가 «추정»이었다.
  //   📏 실물: `SelfOrchestrate` 를 세려고 로그를 grep 했더니
  //     `self_orchestrate` → 0행 · `SelfOrchestrate` → 500행(상한). ***두 수가 다른 것을 셌다***
  //     — 앞은 안 쓰는 이름이고 뒤는 «본문 언급»까지 센다.
  //   ⇒ 🔑 ***「안 쓴다」와 「못 쓴다」를 가르려면 «호출»을 세야 하고, 그 자리가 여기다.***
  //
  // ⛔ 인자를 싣지 않는다 — 비밀이 섞이고 payload 가 커진다. 「누가·어디서·얼마나」만 센다.
  // ⛔ fail-open: 관측 실패가 툴 실행을 «막지 않는다».
  try {
    debug.log('tool-runtime.dispatch', 'invoked', { tool: rt.id, requested: name, surface: ctx.surface });
  } catch { /* fail-open */ }
  const result = await rt.run(args as never, ctx);
  const entry = findNativeTool(name);
  if (!entry?.verifier || isVerifierDisabled(entry.id)) {
    return result;
  }
  // Verifier itself must never break the dispatch path — swallow
  // unexpected throws and pass through the original result so a
  // misbehaving builtin doesn't take a tool offline.
  try {
    const verifierContext: VerifierContext = { toolId: entry.id, surface: ctx.surface };
    const report = await runVerifier(
      entry.verifier,
      args,
      result as Record<string, unknown>,
      verifierContext,
    );
    if (report.ok || report.issues.length === 0) {
      return result;
    }
    return {
      ...(result as Record<string, unknown>),
      verifierIssues: report.issues,
    };
  } catch {
    return result;
  }
}

/** Enumerate runtimes, optionally filtered by surface. Filter order:
 *  1. nativeToolCatalog entry `host` (canonical for native tools)
 *  2. runtime.surfaces fallback (for catalog-less runtimes like MCP
 *     proxy tools registered dynamically at NEXUS boot — RFC #2474
 *     Phase 3 relay path)
 *  Returns shallow copies to prevent accidental mutation.
 *
 *  ⛔ The catalog field is `host` (renamed from `surface` in #6928) — reading
 *  `entry.surface` here threw `undefined.includes()` and killed every turn. */
export function listToolRuntimes(surface?: ToolSurface): ToolRuntime[] {
  const all = [...registry.values()] as unknown as ToolRuntime[];
  if (!surface) return all;
  return all.filter(rt => {
    const entry = findNativeTool(rt.id);
    if (entry) return entry.host.includes(surface);
    return rt.surfaces?.includes(surface) ?? false;
  });
}

/** 등록을 «되돌린다». 없던 id 면 `undefined` — 그것은 오류가 아니다.
 *
 *  ⭐ 왜 프로덕션 경로인가 (2026-09-10 실측): `registerToolRuntime` 은 같은 id 의
 *     «다른» 런타임을 **던져서** 막는다. 그래서 이 자리가 없으면 한 번 등록된 프록시
 *     툴은 프로세스가 죽을 때까지 못 갈아 끼운다 — `elanous mcp reload` 가 서버 다섯 개
 *     «전부»를 `ToolRuntime id collision: <server>.<tool>` 로 실패했다.
 *     즉 이것은 테스트 편의가 아니라 ***재장전이 성립하기 위한 전제***다. */
export function unregisterToolRuntime(id: string): ToolRuntime | undefined {
  const existing = registry.get(id);
  registry.delete(id);
  return existing as unknown as ToolRuntime | undefined;
}

/** Test-only 별칭 — 기존 호출부를 깨지 않으려고 남긴다. 새 코드는 위를 쓴다. */
export function _unregisterToolRuntimeForTest(id: string): ToolRuntime | undefined {
  return unregisterToolRuntime(id);
}

/** Test-only — wipe the registry between specs. */
export function _resetToolRuntimeRegistryForTest(): void {
  registry.clear();
}
