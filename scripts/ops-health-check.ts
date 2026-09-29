#!/usr/bin/env bun
// ── Ops 셀프교정 health 크론 (Ops Observability P3 · 2026-07-10) ─────────────
//
// elanous 가 스스로 자기 자율 시스템(미션·태스크·계약 루프·오케스트레이터)의 상태를
// 점검하고, 이상(blocked 태스크·errored 루프·오케스트레이터/스케줄 미발화)을 감지하면:
//   ① autonomy-log 에 기록(self_recall 로 자기 회상 가능·"내가 이상을 인지했다")
//   ② 텔레그램 알림(대표에게 보고)
// 까지 자율로 한다. 단 **실제 개입(재큐·재시작)은 관측+알림만 — 대표 결정(HITL)**.
//   자동 개입 seam(attemptSelfHeal)은 남기되 ops.selfHeal.armed(user-config·기본 false)
//   게이트로 disarmed. 매매 집행·데몬 재부팅은 armed 여도 항상 제외(안전 다층).
//
// 중복 알림 방지: 직전 알림한 이상 시그니처를 상태 파일에 저장 → 동일 이상 반복 무음.
//   bun scripts/ops-health-check.ts          # 점검 + 이상 시 알림
//   bun scripts/ops-health-check.ts --json    # 구조화 출력(알림 skip)
//   bun scripts/ops-health-check.ts --force    # 시그니처 무시하고 알림

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensureCronNodePath } from '../src/domains/cron-path.js';
ensureCronNodePath();

import { opsHealth, type OpsAnomaly } from '../src/domains/ops-status.js';
import { recordAutonomousActionSafe } from '../src/domains/autonomy-log.js';
import { sendOutbound } from '../src/domains/outbound-alert.js';
import { getUserConfig } from '../src/user-config.js';
import { elanousStateRoot } from '../src/autopilot/state-paths.js';

const LOG = join(homedir(), '.elanous/conatus/ops_health.log');
// `--only <kind,...>` narrows what is judged and alerted (🅢 2026-09-28: only repeated_failure — the other kinds are noise today).
// A narrowed run keeps its own dedup signature so it never overwrites the full run's memory, and both follow the
// same state root as the log store (ELANOUS_STATE_DIR) — a test universe must not touch the operator's signature.
const onlyArg = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? process.argv[i + 1] : undefined; })();
if (process.argv.includes('--only') && (!onlyArg || onlyArg.startsWith('--'))) { console.error('ops-health-check: --only needs <kind,...>'); process.exit(2); }
const ONLY_KINDS: ReadonlySet<string> | null = onlyArg ? new Set(onlyArg.split(',').map((k) => k.trim()).filter(Boolean)) : null;
const STATE = join(elanousStateRoot(), ONLY_KINDS ? `ops_health_state.only-${[...ONLY_KINDS].sort().join('+')}.json` : 'ops_health_state.json');

function logLine(s: string): void {
  const line = `${new Date().toISOString()} ${s}`;
  console.log(s);
  try { mkdirSync(join(homedir(), '.elanous/conatus'), { recursive: true }); appendFileSync(LOG, `${line}\n`); } catch { /* fail-soft */ }
}

/** 이상 집합의 안정 시그니처(kind:entity 정렬) — 동일하면 중복 알림 무음. */
function signature(anomalies: OpsAnomaly[]): string {
  return anomalies.map((a) => `${a.kind}:${a.entity}`).sort().join('|');
}

function lastSignature(): string {
  try { return existsSync(STATE) ? String(JSON.parse(readFileSync(STATE, 'utf-8')).signature ?? '') : ''; } catch { return ''; }
}

function saveSignature(sig: string): void {
  try { writeFileSync(STATE, JSON.stringify({ signature: sig, at: new Date().toISOString() }, null, 2)); } catch { /* fail-soft */ }
}

/** 자동 개입 seam — DISARMED(기본). 대표가 ops.selfHeal.armed=true 로 명시해야 시도.
 *  매매 집행·데몬 재부팅은 절대 제외(안전). 현재는 개입 로직 미구현(관측+알림만) —
 *  armed 여도 개입할 대상이 안전한 것(놓친 관측 크론 재큐 등)일 때만 향후 추가. */
function attemptSelfHeal(anomalies: OpsAnomaly[]): void {
  const cfg = getUserConfig();
  const armed = cfg.ops?.selfHeal?.armed === true;
  if (!armed) { logLine(`[ops-health] 셀프교정 disarmed — 관측+알림만(개입은 대표 결정 HITL). 이상 ${anomalies.length}건.`); return; }
  // armed 라도 현 단계는 안전한 자동 개입 대상이 정의되기 전이므로 no-op(로그만).
  logLine(`[ops-health] 셀프교정 armed 이나 자동 개입 대상 미정의 — no-op(안전). 대표 검토 필요.`);
}

const asJson = process.argv.includes('--json');
const force = process.argv.includes('--force');

const full = opsHealth();
const anomalies = ONLY_KINDS ? full.anomalies.filter((a) => ONLY_KINDS.has(a.kind)) : full.anomalies;
const report = { ...full, anomalies, healthy: anomalies.length === 0 };

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

if (report.healthy) {
  logLine('[ops-health] 정상 — 이상 없음.');
  saveSignature('');
  process.exit(0);
}

const sig = signature(report.anomalies);
const prev = lastSignature();
const changed = force || sig !== prev;

logLine(`[ops-health] 이상 ${report.anomalies.length}건 감지 (changed=${changed}):`);
for (const a of report.anomalies) logLine(`  [${a.kind}] ${a.entity} — ${a.detail}`);

// ① 자기 인지 기록(self_recall 회상) — 이상 감지 사실을 자율행동 로그에.
recordAutonomousActionSafe({
  loop: 'autopilot',
  action: `운영 이상 ${report.anomalies.length}건 감지 (${report.anomalies.map((a) => a.kind).join(',')})`,
  rationale: 'ops-health 크론 자기 점검 — 자율 시스템(미션·태스크·루프·오케스트레이터) health.',
  outcome: changed ? '대표 알림 발송(관측+알림·HITL)' : '기존 이상 지속(중복 알림 무음)',
  refs: { anomalies: report.anomalies.map((a) => ({ kind: a.kind, entity: a.entity })), signature: sig },
  importance: 7,
});

// ② 대표 알림 — 새 이상(시그니처 변화)일 때만(중복 방지).
if (changed) {
  const lines = report.anomalies.slice(0, 8).map((a) => `• [${a.kind}] ${a.entity}\n   ${a.detail}`);
  const more = report.anomalies.length > 8 ? `\n(외 ${report.anomalies.length - 8}건)` : '';
  const msg = `⚠️ 운영 상태 경보 — 자율 시스템 이상 ${report.anomalies.length}건\n\n${lines.join('\n')}${more}\n\n관측+알림만 자동(개입=대표 결정). 상세: elanous ops health`;
  const ok = sendOutbound(msg, 'ops-health');
  logLine(`[ops-health] 대표 알림 ${ok ? '발송' : '실패'}.`);
  // Remember the signature only once it was delivered — a failed send must retry next run, not go silent forever
  // (measured 2026-09-28: a failed first send saved the signature and the second run went «동일 이상 지속 — 무음»).
  if (ok) saveSignature(sig);
  else logLine('[ops-health] 발송 실패 — 시그니처를 저장하지 않는다(다음 실행이 다시 보낸다).');
} else {
  logLine('[ops-health] 동일 이상 지속 — 중복 알림 무음(시그니처 변화 없음).');
}

// ③ 셀프교정 seam(disarmed 기본·HITL).
attemptSelfHeal(report.anomalies);

process.exit(0);
