import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type HostReadinessState = { host: string; verdict: 'READY' | 'BLOCKED' | 'UNMEASURED'; at: string; failed: string[]; reason?: string };

/** Read the OP join ledger as a guardian projection. Missing or malformed evidence never grants readiness. */
export function readHostReadiness(path = process.env.ELANOUS_HOST_READINESS_LEDGER
  ?? join(homedir(), 'elanous-hq/seat-state/OP/host-readiness.tsv')): HostReadinessState[] {
  if (!existsSync(path)) return [];
  const rows = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
  if (rows.shift() !== 'host\titem\tstatus\trepaired\tat\tdetail') throw new Error('host readiness ledger header invalid');
  const latest = new Map<string, HostReadinessState>();
  for (const row of rows) {
    const fields = row.split('\t');
    if (fields.length !== 6) throw new Error('host readiness ledger row invalid');
    const [host, item, status, , at, detail] = fields;
    if (item !== 'verdict') continue;
    if (!host || (status !== 'READY' && status !== 'BLOCKED' && status !== 'UNMEASURED') || !at || !Number.isFinite(Date.parse(at))) {
      throw new Error('host readiness verdict invalid');
    }
    latest.set(host, { host, verdict: status, at,
      failed: status === 'BLOCKED' && detail ? detail.split(',').filter(Boolean) : [],
      ...(status === 'UNMEASURED' ? { reason: detail.replace(/^reason=/, '') } : {}) });
  }
  return [...latest.values()];
}
