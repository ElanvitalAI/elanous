import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import { LogStore, logsDbPath } from '../mss/logging/log-store.js';

type RetroFact = { store: string; at: string; category: string; event: string; kind: 'draft-birth' | 'draft-death' | 'stop-reason' | 'ta-outcome'; data: unknown };

const FACT_EVENTS = new Map<string, RetroFact['kind']>([
  ['rework-blocked-draft-pr', 'draft-birth'],
  ['lineage-supersede', 'draft-death'],
  ['resolved', 'stop-reason'],
  ['decision', 'stop-reason'],
  ['action', 'ta-outcome'],
  ['task-agent.action', 'ta-outcome'],
]);

export function parseRetroSince(value: string, now = Date.now()): number {
  const match = /^([1-9]\d*)([smhd])$/.exec(value);
  if (!match) throw new Error('--since requires a positive duration (e.g. 24h)');
  const duration = Number(match[1]) * ({ s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]!] ?? 0);
  if (!Number.isSafeInteger(duration) || !Number.isSafeInteger(now - duration)) throw new Error('--since duration is out of range');
  return now - duration;
}

export function collectRetroFacts(sinceMs: number, targets: readonly { name: string; dbPath: string }[] = [{ name: 'current', dbPath: logsDbPath() }]): { facts: RetroFact[]; unavailable: string[] } {
  const facts: RetroFact[] = [];
  const unavailable: string[] = [];
  const untilMs = Date.now();
  for (const target of targets) {
    if (!existsSync(target.dbPath)) { unavailable.push(target.name); continue; }
    try {
      const store = LogStore.openReadOnly(target.dbPath);
      try {
        let beforeId: number | undefined;
        for (;;) {
          const rows = store.query({ sinceMs, beforeId, limit: 1000 });
          for (const row of rows) {
            if (Date.parse(row.ts) > untilMs) continue;
            const kind = FACT_EVENTS.get(row.event);
            if (!kind || (row.event === 'resolved' && row.category !== 'self-dev.supervisor') || ((row.event === 'task-agent.action' || row.event === 'action') && row.category !== 'task-agent')) continue;
            let data: unknown;
            try { data = row.data === null ? null : JSON.parse(row.data); } catch { data = row.data; }
            const record = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {};
            if (row.event === 'rework-blocked-draft-pr' && (row.category !== 'self-implement' || !Number.isInteger(record.number) || record.skipped || record.error)) continue;
            if (row.event === 'lineage-supersede' && (row.category !== 'self-implement' || !Array.isArray(record.closed) || record.closed.length === 0)) continue;
            if (row.event === 'resolved' && typeof record.stopReason !== 'string') continue;
            if (row.event === 'decision' && (row.category !== 'self-dev.supervisor' || record.action !== 'stop' || typeof record.stopReason !== 'string')) continue;
            if ((row.event === 'task-agent.action' || row.event === 'action') && (row.category !== 'task-agent' || typeof record.result !== 'string' || !record.result.trim())) continue;
            facts.push({ store: target.name, at: row.ts, category: row.category, event: row.event, kind, data });
          }
          if (rows.length < 1000) break;
          beforeId = rows.at(-1)!.id;
        }
      } finally { store.close(); }
    } catch { unavailable.push(target.name); }
  }
  facts.sort((a, b) => b.at.localeCompare(a.at));
  return { facts, unavailable };
}

export function registerRetroCommands(program: Command): void {
  program.command('retro').description('Read-only retrospective facts from existing logs')
    .command('facts').description('Draft births/deaths, stop reasons and task-agent outcomes')
    .option('--since <duration>', 'Lookback duration', '24h')
    .option('--json', 'JSON output')
    .action((opts: { since: string; json?: boolean }) => {
      try {
        const sinceMs = parseRetroSince(opts.since);
        const result = { since: new Date(sinceMs).toISOString(), ...collectRetroFacts(sinceMs) };
        console.log(opts.json ? JSON.stringify(result) : [
          `retro facts since ${result.since} · ${result.facts.length} facts · unavailable: ${result.unavailable.join(', ') || 'none'}`,
          ...result.facts.map((fact) => `${fact.at} ${fact.kind} ${fact.category}.${fact.event} ${JSON.stringify(fact.data)}`),
        ].join('\n'));
      } catch (error) {
        console.error(`retro facts: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
      }
    });
}
