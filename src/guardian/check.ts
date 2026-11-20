// Arc B — Guardian beforeCall hook + policy composition.
//
// `runGuardian()` is the single entry point `dispatchToolByName` uses
// before a tool runtime's `run()`. It looks up the spec.kind builtin,
// invokes it, and returns a verdict. `deny` turns into a data-result
// (`{ok:false, error}`) at the dispatch seam — never an exception.
//
// Gate: `HARNESS_GUARDIAN_ENABLED=1` (default-off) — matches Arc G/H
// convention. Latency impact when disabled = one env read. Opt-out
// reverse env (`HARNESS_GUARDIAN_DISABLED=1`) reserved for future
// default-on rollout.
//
// Composition (scope-cut, coding-first): one spec per catalog entry.
// `plugin-capability` and `trust-store` cover the plugin path. Forward-
// compat slots (`hitl-delivery`, `mutating-default`) short-circuit to
// `allow` with a one-shot debug log — landing them is a vision-ready
// follow-up PR (PLAN §2).

import { debug } from '../debug/log.js';
import { appendGuardianAudit } from './audit-sink.js';
import { checkPluginCapability } from './policies/plugin-capability.js';
import { checkShellArgv } from './policies/shell-argv.js';
import { checkTrustStore } from './policies/trust-store.js';
import type { GuardianContext, GuardianSpec, GuardianVerdict } from './types.js';

const warnedSlots = new Set<string>();

/** Returns true when `HARNESS_GUARDIAN_ENABLED=1` and the reverse
 *  opt-out is not set. Both cheap env reads — dispatch calls this
 *  before constructing the guardian context. */
export function isGuardianEnabled(): boolean {
  if (process.env['HARNESS_GUARDIAN_DISABLED'] === '1') return false;
  return process.env['HARNESS_GUARDIAN_ENABLED'] === '1';
}

/** Scope-cut dispatcher. Each spec.kind is a typed union variant so
 *  adding a policy is a compile-time change, not a string lookup. */
export function runGuardian(spec: GuardianSpec, ctx: GuardianContext): GuardianVerdict {
  let verdict: GuardianVerdict;
  let policyName: string = spec.kind;

  switch (spec.kind) {
    case 'plugin-capability':
      verdict = checkPluginCapability(spec, ctx);
      break;
    case 'trust-store':
      verdict = checkTrustStore(ctx);
      break;
    case 'shell-argv':
      // TC #92362 — pre-call gate for the Bash tool. Vocabulary maps
      // 1:1 onto GuardianDecision (allow/deny/needs-approval).
      verdict = checkShellArgv(ctx);
      break;
    case 'hitl-delivery':
    case 'mutating-default':
      // Forward-compat slot — vision-ready lane implements these.
      // One-shot warn so the log doesn't fill up; default to allow so
      // coding-first doesn't break when a catalog entry declares a
      // slot that isn't wired yet.
      if (!warnedSlots.has(spec.kind)) {
        warnedSlots.add(spec.kind);
        debug.log('guardian.slot.unimplemented', spec.kind, { toolId: ctx.toolId });
      }
      verdict = { decision: 'allow', reasons: [`guardian slot '${spec.kind}' not implemented in coding-first lane`] };
      break;
    default: {
      // Exhaustiveness guard — compiler errors if a new kind is
      // added without a case above.
      const _exhaustive: never = spec;
      void _exhaustive;
      verdict = { decision: 'allow', reasons: [] };
    }
  }

  // Scope-cut degrades `needs-approval` to `deny` because the HITL
  // 4-channel delivery slot hasn't landed. The verdict union keeps
  // the 3-variant shape so vision-ready can additively enable HITL
  // without changing the type surface.
  //
  // TC #92362 — `shell-argv` is EXEMPT from this blanket demotion: it
  // takes its own explicit path below so the policy's needs-approval
  // verdict stays observable and testable per-policy.
  if (verdict.decision === 'needs-approval' && spec.kind !== 'shell-argv') {
    verdict = {
      decision: 'deny',
      reasons: [
        ...verdict.reasons,
        'HITL slot not landed in coding-first lane (see PLAN §5.4)',
      ],
      auditPayload: verdict.auditPayload,
    };
    policyName = `${policyName}-hitl-degraded`;
  }

  // TC #92362 — shell-argv ask-op explicitly escaped the blanket
  // demotion above. This PR is still unmanned fail-closed: the
  // guardian pre-call seam has no approver port, so ask-op lands deny.
  // HITL 승인 요청은 후속 칸 (bash-runtime.ts 의 사후 승인 흐름과는
  // 별개 배선).
  if (verdict.decision === 'needs-approval' && spec.kind === 'shell-argv') {
    verdict = {
      decision: 'deny',
      reasons: [
        ...verdict.reasons,
        'shell-argv ask-op demoted to deny — unmanned fail-closed · HITL 승인 요청은 후속 칸 (TC #92362)',
      ],
      auditPayload: verdict.auditPayload,
      // APPROVAL-REQUEST-PLAINTEXT-TARGET — 강등돼도 요청 문면(대상 평문)은 호출자에게 남긴다.
      ...(verdict.approvalRequest !== undefined ? { approvalRequest: verdict.approvalRequest } : {}),
    };
    policyName = `${policyName}-ask-op-denied`;
  }

  if (debug.enabled) {
    debug.log('guardian.verdict', verdict.decision, {
      toolId: ctx.toolId,
      surface: ctx.surface,
      policy: policyName,
      reasons: verdict.reasons,
    });
  }

  appendGuardianAudit({
    ts: new Date().toISOString(),
    toolId: ctx.toolId,
    surface: ctx.surface,
    decision: verdict.decision,
    reasons: verdict.reasons,
    policy: verdict.decision === 'allow' ? null : policyName,
    detail: verdict.auditPayload,
  });

  return verdict;
}

/** Summarise tool args for audit + policy input. Keeps the dispatch
 *  seam cheap and strips anything heavy. Caps string values at 200
 *  chars so a huge payload (e.g. a shell script pasted as `content`)
 *  doesn't bloat the NDJSON log. */
export function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') {
      out[k] = v.length > 200 ? v.slice(0, 200) + '…' : v;
    } else if (typeof v === 'number' || typeof v === 'boolean' || v == null) {
      out[k] = v;
    } else {
      // Object / array — record presence only, not the value.
      out[k] = Array.isArray(v) ? `<array:${v.length}>` : '<object>';
    }
  }
  return out;
}

/** Test seam — clears the one-shot slot-warned tracker between specs. */
export function __resetGuardianForTests(): void {
  warnedSlots.clear();
}
