// `eln fed record|kpi|show|backfill` — the one CLI over the fed-state ledger.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { type Fact, isFactType, readFacts, recordFact } from './ledger.js';
import { fedKpi, formatFedKpi, showFed } from './kpi.js';

export function runFedRecordCli(type: string, opts: { seat?: string; cell?: string; state?: string; from?: string; to?: string; kind?: string; ref?: string; workReady?: boolean; at?: string; source?: string }): number {
  if (!isFactType(type)) { console.error(`fed record: unknown type ${type}`); return 2; }
  const ok = recordFact({ type, ...(opts.seat ? { seat: opts.seat.toUpperCase() } : {}), ...(opts.cell ? { cell: opts.cell } : {}), ...(opts.state ? { state: opts.state } : {}),
    ...(opts.from ? { from: opts.from.toUpperCase() } : {}), ...(opts.to ? { to: opts.to.toUpperCase() } : {}), ...(opts.kind ? { kind: opts.kind } : {}),
    ...(opts.ref ? { ref: opts.ref } : {}), ...(opts.workReady !== undefined ? { workReady: opts.workReady } : {}), ...(opts.at ? { ts: new Date(opts.at).toISOString() } : {}),
    source: opts.source ?? 'cli' });
  // fail-open for scripts: a ledger fault prints one line and exits 0.
  if (!ok) console.error('fed record: ledger write failed (fail-open)');
  return 0;
}

export function runFedKpiCli(opts: { window?: string; json?: boolean }): number {
  const k = fedKpi({ window: opts.window ?? '1h' });
  console.log(opts.json ? JSON.stringify(k) : formatFedKpi(k));
  return 0;
}

export function runFedShowCli(id: string, opts: { limit?: string; json?: boolean }): number {
  const rows = showFed(id, { limit: Number(opts.limit ?? 20) });
  if (opts.json) { console.log(JSON.stringify(rows)); return 0; }
  if (!rows.length) { console.log(`fed show ${id}: no facts`); return 0; }
  for (const f of rows) console.log(`${f.ts} ${f.type}${f.state ? `:${f.state}` : ''}${f.seat ? ` seat=${f.seat}` : ''}${f.decidedBy && f.decidedBy !== f.seat ? ` decidedBy=${f.decidedBy}` : ''}${f.doneBy ? ` doneBy=${f.doneBy}` : ''}${f.supervisedBy ? ` supervisedBy=${f.supervisedBy}` : ''}${f.cell ? ` cell=${f.cell}` : ''}${f.from ? ` ${f.from}→${f.to}` : ''}${f.kind ? ` kind=${f.kind}` : ''}${f.ref ? ` #${f.ref}` : ''}`);
  return 0;
}

/** Backfill mail posts (msg store) and lands (main merge commits «(#N)») for the last window. Idempotent by (type,source,ref). */
export async function runFedBackfillCli(opts: { window?: string; repo?: string; dryRun?: boolean }): Promise<number> {
  const { parseWindow } = await import('./kpi.js');
  const since = new Date(Date.now() - parseWindow(opts.window ?? '24h'));
  const have = new Set(readFacts({ since }).facts.map(f => `${f.type}|${f.ref}`));
  const add: Fact[] = [];
  try {
    const { defaultMsgStorePath } = await import('../msg/msg-store.js');
    const p = defaultMsgStorePath();
    if (existsSync(p)) {
      const { Database } = await import('bun:sqlite');
      const db = new Database(p, { readonly: true });
      try {
        const rows = db.query('SELECT id, sender, recipient, kind, created_at FROM msg_messages WHERE created_at >= ? ORDER BY id').all(since.toISOString()) as { id: number; sender: string; recipient: string; kind: string | null; created_at: string }[];
        for (const r of rows) if (!have.has(`mail|${r.id}`)) add.push({ ts: r.created_at, type: 'mail', state: 'post', from: r.sender, to: r.recipient, ...(r.kind ? { kind: r.kind } : {}), ref: String(r.id), source: 'backfill:msg' });
      } finally { db.close(); }
    }
  } catch (e) { console.error(`fed backfill: msg skipped (${e instanceof Error ? e.message : String(e)})`); }
  const git = spawnSync('git', ['-C', opts.repo ?? process.cwd(), 'log', 'origin/main', `--since=${since.toISOString()}`, '--first-parent', '--format=%cI%x09%s'], { encoding: 'utf8' });
  if (git.status === 0) for (const line of git.stdout.split('\n')) {
    const [ts, subj] = line.split('\t'); const m = subj ? /\(#(\d+)\)\s*$/.exec(subj) : null;
    if (ts && m && !have.has(`land|${m[1]}`)) add.push({ ts: new Date(ts).toISOString(), type: 'land', ref: m[1], source: 'backfill:git' });
  } else console.error('fed backfill: git log skipped');
  if (!opts.dryRun) for (const f of add) recordFact(f);
  console.log(`fed backfill: ${add.length} facts ${opts.dryRun ? '(dry-run)' : 'appended'} (mail ${add.filter(f => f.type === 'mail').length} · land ${add.filter(f => f.type === 'land').length})`);
  return 0;
}
