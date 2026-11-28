// Kit lane-pins — runtime lane pins (SUPERVISORS-EXECUTE-NOT-PROPOSE · 대표 11-28 17:3x «자동으로 돌아가게 = 루프 에이전트들이 본인
// 임무를 문제없이 해내는 것»). The train manager APPLIES a hot-file lane pin itself instead of mailing TC a YAML line nobody applied
// (11-28 L4: hot_file_churn_refusals 2 → 10 / 60 min while the proposals sat). The land-steward policy pack
// (graphs/loop-agents/land-steward/policies.yaml) stays PR-only; a runtime pin lives in <stateRoot>/land-steward/runtime-pins.json
// with its own TTL (`until`). An expired pin reads as absent (auto-release) · a file the pack pins keeps the pack's order ·
// an unreadable / malformed file = no runtime pins (the pack as before) · undo = releaseRuntimePin.
//
// 세 얼굴: 관측 = runtime-pins.json (who · when · until) ⊕ the land-graph ledger / 판단 근거 = the agent.yaml limits
// (pin_ttl_min · pins_active_max) / 수복과 인계 = TTL expiry ⊕ release on a closed lane ⊕ `@loop:train-manager release-pin`.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { landPolicyPath, loadLandPolicy, type LandPolicy, type LanePin } from '../../land-graph/lane-order.js';
export interface RuntimePin extends LanePin { readonly by: string; readonly at: string; readonly until: string }
export const runtimePinsPath = (stateRoot: string): string => join(stateRoot, 'land-steward', 'runtime-pins.json');

export function readRuntimePins(stateRoot: string, nowMs: number): RuntimePin[] {
  let raw: unknown;
  try { const p = runtimePinsPath(stateRoot); if (!existsSync(p)) return []; raw = JSON.parse(readFileSync(p, 'utf8')); } catch { return []; }
  const rows = Array.isArray((raw as { pins?: unknown })?.pins) ? (raw as { pins: unknown[] }).pins : [];
  return rows.flatMap((r: unknown) => {
    const x = r as Partial<RuntimePin>;
    const prs = Array.isArray(x?.prs) ? [...new Set(x.prs.filter((n): n is number => Number.isInteger(n) && n > 0))] : [];
    if (typeof x?.file !== 'string' || !x.file || prs.length < 2 || typeof x.until !== 'string' || !(Date.parse(x.until) > nowMs)) return [];
    return [{ file: x.file, prs, by: String(x.by ?? '?'), at: String(x.at ?? ''), until: x.until }];
  });
}

function writeRuntimePins(stateRoot: string, pins: readonly RuntimePin[]): void {
  const p = runtimePinsPath(stateRoot);
  mkdirSync(join(stateRoot, 'land-steward'), { recursive: true });
  writeFileSync(`${p}.tmp`, `${JSON.stringify({ pins })}\n`);
  renameSync(`${p}.tmp`, p);
}

/** Put (or replace) the pin of `pin.file`; expired pins drop on the same write. Returns the live pins after it. */
export function putRuntimePin(stateRoot: string, pin: RuntimePin, nowMs: number): RuntimePin[] {
  const pins = [...readRuntimePins(stateRoot, nowMs).filter(p => p.file !== pin.file), pin];
  writeRuntimePins(stateRoot, pins);
  return pins;
}

/** Drop the runtime pin of `file` — false when there was none (already expired or released). */
export function releaseRuntimePin(stateRoot: string, file: string, nowMs: number): boolean {
  const cur = readRuntimePins(stateRoot, nowMs);
  if (!cur.some(p => p.file === file)) return false;
  writeRuntimePins(stateRoot, cur.filter(p => p.file !== file));
  return true;
}

/** The pack ⊕ the unexpired runtime pins (a file the pack pins keeps the pack's). No pack and no pins → null (as before). */
export function withRuntimePins(policy: LandPolicy | null, pins: readonly LanePin[]): LandPolicy | null {
  const packed = new Set((policy?.laneOrder.pins ?? []).map(p => p.file));
  const extra = pins.filter(p => !packed.has(p.file)).map(p => ({ file: p.file, prs: [...p.prs] }));
  if (!extra.length) return policy;
  return { laneOrder: { ...(policy?.laneOrder ?? { mode: 'pr-number' as const }), pins: [...(policy?.laneOrder.pins ?? []), ...extra] } };
}

/** What every land run walks: the pack ⊕ this state root's runtime pins. */
export function loadLivePolicy(stateRoot: string, nowMs = Date.now(), path = landPolicyPath()): LandPolicy | null {
  return withRuntimePins(loadLandPolicy(path), readRuntimePins(stateRoot, nowMs));
}
