#!/usr/bin/env bun
import { asRecord } from '../src/primitives/guards.js';

export type CycleFiredStatus = 'not-fired' | 'incomplete' | 'fired';

export type CycleFiredDecision = {
  status: CycleFiredStatus;
  kstDate: string;
  decisions: string[];
  openedStores: number | null;
  unopenedStores: number | null;
  seenEventRows: number;
};

export type LogQueryObserver = (args: string[]) => Promise<string>;

type JsonRecord = Record<string, unknown>;

function recordOrUndefined(value: unknown): JsonRecord | undefined {
  return asRecord(value, { fallback: 'undefined', allowArrays: true });
}

function kstDate(timestamp: unknown): string | undefined {
  if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) return undefined;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(timestamp));
}

function dataRecord(value: unknown): JsonRecord {
  if (typeof value === 'string') {
    try { return recordOrUndefined(JSON.parse(value)) ?? {}; } catch { return {}; }
  }
  return recordOrUndefined(value) ?? {};
}

export function judgeCycleFired(jsonl: string, measuredAt = new Date()): CycleFiredDecision {
  const today = kstDate(measuredAt.toISOString())!;
  let openedStores: number | null = null;
  let unopenedStores: number | null = null;
  let seenEventRows = 0;
  const events: Array<{ ts: string; event: string; data: JsonRecord; inputIndex: number }> = [];

  for (const [inputIndex, line] of jsonl.split('\n').entries()) {
    if (!line.trim()) continue;
    let parsed: JsonRecord;
    try { parsed = recordOrUndefined(JSON.parse(line)) ?? {}; } catch { continue; }
    const meta = recordOrUndefined(parsed._meta);
    if (meta) {
      if (meta.type === 'log-query-opened-stores') {
        const stores = meta.stores;
        openedStores = Array.isArray(stores) ? stores.length : null;
        const scope = recordOrUndefined(meta.scope);
        unopenedStores = typeof scope?.unopenedStores === 'number' ? scope.unopenedStores : null;
      }
      continue;
    }
    seenEventRows += 1;
    if (parsed.category === 'mission-loop.composite' && kstDate(parsed.ts) === today && typeof parsed.event === 'string' && typeof parsed.ts === 'string') {
      events.push({ ts: parsed.ts, event: parsed.event, data: dataRecord(parsed.data), inputIndex });
    }
  }

  const ordered = events
    .map((row) => ({ ...row, timestamp: Date.parse(row.ts) }))
    .filter((row) => Number.isFinite(row.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp || left.inputIndex - right.inputIndex);
  const targetStart = ordered.filter((row) => row.event === 'cycle-started').at(-1);
  if (!targetStart) return { status: 'not-fired', kstDate: today, decisions: [], openedStores, unopenedStores, seenEventRows };
  const completed = ordered.find((row) => row.event === 'cycle-completed' && row.timestamp >= targetStart.timestamp);
  const decisions = ordered
    .filter((row) => row.event === 'request-decision' && row.timestamp >= targetStart.timestamp && (!completed || row.timestamp <= completed.timestamp))
    .map((row) => typeof row.data.action === 'string' ? row.data.action : 'unknown');

  return {
    status: completed ? 'fired' : 'incomplete',
    kstDate: today,
    decisions,
    openedStores,
    unopenedStores,
    seenEventRows,
  };
}

export function formatCycleFiredDecision(decision: CycleFiredDecision): string {
  const verdict = decision.status === 'fired' ? '돌았다' : decision.status === 'incomplete' ? '미완료' : '안 돌았다';
  const decisions = decision.decisions.length > 0 ? decision.decisions.join(',') : '없음';
  const opened = decision.openedStores ?? '미측정';
  const unopened = decision.unopenedStores ?? '미측정';
  return `08:05 복합 주기 ${verdict} (KST ${decision.kstDate}; request-decision ${decisions}; 연 스토어 ${opened}; 안 본 스토어 ${unopened}; 본 사건 행 ${decision.seenEventRows})`;
}

export async function defaultLogQueryObserver(args: string[]): Promise<string> {
  const child = Bun.spawn({ cmd: ['bun', 'bin/elanous.mjs', '--test', 'logs', ...args], stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `elanous logs exited with ${exitCode}`);
  return stdout;
}

export async function main(observer: LogQueryObserver = defaultLogQueryObserver, measuredAt = new Date()): Promise<CycleFiredDecision> {
  const decision = judgeCycleFired(await observer(['--all', '--include-test', '--json', '--json-data', '--exact-category', 'mission-loop.composite']), measuredAt);
  console.log(formatCycleFiredDecision(decision));
  return decision;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
