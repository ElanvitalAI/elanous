import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { listCoordEvents, type CoordEvent } from '../context-bus/coord-events.js';
import { DecisionLedger } from '../decisions/decision-ledger.js';
import { LogStore } from '../mss/logging/log-store.js';

export type SecretKind = 'token-prefix' | 'key' | 'bearer' | 'private-key';
export interface SecretCandidate { store: 'logs' | 'decisions' | 'context'; rowId: string; kind: SecretKind; prefix: string; length: number }
export interface SecretScanResult { mode: 'shadow' | 'publish'; candidates: SecretCandidate[]; raised: number }

const PATTERNS: Array<{ kind: SecretKind; pattern: RegExp }> = [
  { kind: 'private-key', pattern: /-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY(?: BLOCK)?-----/g },
  { kind: 'bearer', pattern: /\bBearer\s+([A-Za-z0-9._~+/-]{12,}={0,2})/gi },
  { kind: 'token-prefix', pattern: /\b(?:sk-[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|(?:AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}|AIza[A-Za-z0-9_-]{35})\b/g },
  { kind: 'key', pattern: /\b(?:[A-Za-z][A-Za-z0-9_]*_)?(?:api[_-]?key|secret[_-]?key|access[_-]?key|token)(?:\\?["'])?\s*[=:]\s*(?:\\?["'])?([A-Za-z0-9_./+~-]{16,}={0,2})/gi },
];

function scanText(store: SecretCandidate['store'], rowId: string, text: string): SecretCandidate[] {
  const found: SecretCandidate[] = [];
  const spans: Array<[number, number]> = [];
  for (const { kind, pattern } of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1] ?? match[0];
      const start = match.index! + (match[1] ? match[0].lastIndexOf(value) : 0);
      const end = start + value.length;
      if (spans.some(([a, b]) => start < b && end > a)) continue;
      spans.push([start, end]);
      found.push({ store, rowId, kind, prefix: value.slice(0, 4), length: value.length });
    }
  }
  return found;
}

export interface SecretScanDeps {
  now?: () => Date;
  stateRoot?: string;
  logs?: Pick<LogStore, 'queryAll'>;
  decisions?: Pick<DecisionLedger, 'list' | 'raise'>;
  context?: (since: string) => CoordEvent[];
}

/** Only source coordinates and a four-character prefix leave the scanner. Missing stores are empty; unreadable stores throw. */
export function scanSecretExposures(options: { publish?: boolean } = {}, deps: SecretScanDeps = {}): SecretScanResult {
  const root = deps.stateRoot ?? elanousStateRoot();
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const sinceMs = nowMs - 86_400_000;
  const since = new Date(sinceMs).toISOString();
  const candidates: SecretCandidate[] = [];
  const logPath = join(root, 'logs', 'logs.db');
  const opened = !deps.logs && existsSync(logPath) ? LogStore.openReadOnly(logPath) : undefined;
  const logs = deps.logs ?? opened;
  try {
    for (const row of logs?.queryAll({ sinceMs, untilMs: nowMs }) ?? []) {
      if (!Number.isSafeInteger(row.id) || row.ts_ms < sinceMs || row.ts_ms > nowMs) continue;
      const id = String(row.id);
      candidates.push(...scanText('logs', id, JSON.stringify(row)));
    }
  } finally { opened?.close(); }

  const ledger = deps.decisions ?? new DecisionLedger({ stateDir: root });
  const entries = ledger.list({ status: 'all' });
  for (const entry of entries) {
    if (entry.raisedBy.agent === 'secret-exposure-scan' || !/^D-\d{8}-\d+$/.test(entry.id)) continue;
    candidates.push(...scanText('decisions', entry.id, JSON.stringify(entry)));
  }
  for (const event of (deps.context ?? (s => listCoordEvents({ since: s })))(since)) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.id) || Date.parse(event.at) < sinceMs || Date.parse(event.at) > nowMs) continue;
    candidates.push(...scanText('context', event.id, JSON.stringify(event)));
  }
  // One card per location/kind; do not put any untrusted source text into logs.
  const unique = [...new Map(candidates.map(c => [`${c.store}:${c.rowId}:${c.kind}`, c])).values()];
  let raised = 0;
  if (options.publish) {
    const existing = new Set(entries.flatMap(entry => entry.refs ?? []));
    for (const candidate of unique) {
      const ref = `secret-exposure:${candidate.store}:${candidate.rowId}:${candidate.kind}`;
      if (existing.has(ref)) continue;
      ledger.raise({ title: `비밀 노출 후보 — ${candidate.store} / ${candidate.rowId}`,
        category: 'secret', scqa: { s: `${candidate.store} 행 ${candidate.rowId}에서 ${candidate.kind} 꼴이 발견됐다.`,
          c: `값은 보관하지 않는다. 앞 4자 ${candidate.prefix} · 길이 ${candidate.length}.` },
        options: [{ key: 'a', label: '원장 위치 확인 및 폐기', consequence: '사람이 원장에서 확인 후 폐기한다' },
          { key: 'b', label: '오탐으로 닫기', consequence: '사람이 오탐 여부를 확인한다' }],
        recommendation: { skipped: true, reason: '사람 확인 필요' }, raisedBy: { agent: 'secret-exposure-scan' }, refs: [ref] });
      existing.add(ref);
      raised++;
    }
  }
  return { mode: options.publish ? 'publish' : 'shadow', candidates: unique, raised };
}

if (import.meta.main) {
  // The graph runs without flags: shadow only. Publishing requires an explicit operator opt-in.
  try {
    const result = scanSecretExposures({ publish: process.argv.slice(2).includes('--publish') });
    console.log(JSON.stringify(result));
  } catch {
    console.error('secret-exposure-scan: source unreadable');
    process.exitCode = 1;
  }
}
