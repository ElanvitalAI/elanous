/**
 * `eln secret supply <금고 항목 이름> --to <pod:Job|ta:카드|host:이름|config-dir>` · `--list` · `--revoke <leaseId>`.
 * 본체 = src/secret/supply.ts (허용 목록 · 원장 · 대상 파서). 임대 자체는 기존 길에 위임. 출력에 값 0.
 */
import type { Command } from 'commander';
import {
  listLiveLeases, revokeSupply, supply, type SupplyDeps, type SupplyDelegates,
} from '../secret/supply.js';
import { parseLeaseDuration } from './secret-lease-cli.js';

export interface SecretSupplyCliDeps {
  readonly output?: { log: (line: string) => void; error: (line: string) => void };
  readonly setExitCode?: (code: number) => void;
  readonly supplyDeps?: () => Promise<SupplyDeps>;
  readonly now?: () => number;
}

export async function defaultSupplyDeps(): Promise<SupplyDeps> {
  const { getElanousConfigDir } = await import('../elanous-config-dir.js');
  const configDir = getElanousConfigDir();
  const delegates: SupplyDelegates = {
    oauthIssue: async (to, ttlMs) => {
      const { issueCodexLease, defaultCodexLeaseDeps } = await import('../secret/codex-lease.js');
      const r = await issueCodexLease({ to, ...(ttlMs !== undefined ? { ttlMs } : {}) }, await defaultCodexLeaseDeps());
      return { leaseId: r.leaseId, expiresAt: r.expiresAt };
    },
    staticIssue: async (item, to, ttlMs) => {
      const { issueStaticLease } = await import('../secret/static-lease.js');
      const r = await issueStaticLease({ id: item, to, ...(ttlMs !== undefined ? { ttlMs } : {}) });
      return r.ok ? { ok: true, leaseId: r.record.leaseId, expiresAt: Date.parse(r.record.expiresAt) } : { ok: false, reason: r.reason };
    },
    oauthRevoke: async (leaseId) => {
      try {
        const { revokeCodexLease, defaultCodexLeaseDeps } = await import('../secret/codex-lease.js');
        return revokeCodexLease({ leaseId }, await defaultCodexLeaseDeps()).revoked.length > 0;
      } catch { return false; }
    },
    staticRevoke: async (leaseId) => {
      const { revokeStaticLeases } = await import('../secret/static-lease.js');
      const r = await revokeStaticLeases({ leaseId });
      return Array.isArray(r) && r.length > 0;
    },
  };
  return { configDir, delegates };
}

function fmtRemaining(ms: number): string {
  const m = Math.floor(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

export function registerSecretSupplyCommand(secret: Command, deps: SecretSupplyCliDeps = {}): Command {
  const out = deps.output ?? console;
  const exit = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  const now = deps.now ?? Date.now;
  const build = deps.supplyDeps ?? defaultSupplyDeps;
  return secret.command('supply')
    .description('One path to supply a vault credential to a Pod / TA child / remote host / config-dir: lease with TTL, ledger, revoke, per-target allow-list (default deny). Values never printed.')
    .argument('[item]', 'vault item name (e.g. codex, a static key id)')
    .option('--to <target>', 'pod:<Job> | ta:<card> | host:<name> | absolute config-dir path')
    .option('--ttl <duration>', 'lease lifetime (e.g. 30m, 12h)')
    .option('--list', 'live leases: target · remaining TTL · credential name (no values)')
    .option('--revoke <leaseId>', 'revoke a lease by id')
    .option('--json', 'machine-readable result')
    .allowExcessArguments(false)
    .action(async (item: string | undefined, o: { to?: string; ttl?: string; list?: boolean; revoke?: string; json?: boolean }) => {
      try {
        const d = await build();
        if (o.list) {
          const [{ readLeaseRecords, secretLeaseStorePath, leaseTargetKey }, { readStaticLeaseRecords }] = await Promise.all([import('../secret/lease-store.js'), import('../secret/static-lease.js')]);
          let oauth: Parameters<typeof listLiveLeases>[0]['oauth'] = [];
          try { oauth = readLeaseRecords(secretLeaseStorePath(d.configDir)).map((r) => ({ leaseId: r.leaseId, account: r.account, target: leaseTargetKey(r.target), expiresAt: r.expiresAt, ...(r.revokedAt !== undefined ? { revokedAt: r.revokedAt } : {}) })); } catch { /* 깨진 원장은 목록에서 빠질 뿐 — 쓰기 길은 따로 fail-closed */ }
          const rows = listLiveLeases({ oauth, statics: readStaticLeaseRecords(d.configDir) }, now());
          if (o.json) out.log(JSON.stringify(rows));
          else if (!rows.length) out.log('live lease 없음');
          else for (const r of rows) out.log(`${r.leaseId}\t${r.item}\t${r.target}\tremaining=${fmtRemaining(r.remainingMs)}`);
          exit(0); return;
        }
        if (o.revoke) {
          const r = await revokeSupply(o.revoke, d);
          (r.ok ? out.log : out.error)(`supply revoke · ${o.revoke} · ${r.ok ? 'revoked' : 'not-found'}`);
          exit(r.ok ? 0 : 1); return;
        }
        if (!item || !o.to) { out.error('usage: eln secret supply <item> --to <pod:Job|ta:card|host:name|config-dir> [--ttl 12h] | --list | --revoke <leaseId>'); exit(2); return; }
        const ttlMs = o.ttl === undefined ? undefined : parseLeaseDuration(o.ttl);
        if (o.ttl !== undefined && ttlMs === undefined) { out.error('invalid --ttl (e.g. 30m, 12h, 1d)'); exit(2); return; }
        const r = await supply({ item, to: o.to, ...(ttlMs !== undefined ? { ttlMs } : {}) }, d);
        if (o.json) out.log(JSON.stringify(r));
        else if (r.ok) out.log(`supply ok · ${r.item} → ${r.target} · leaseId=${r.leaseId} · via=${r.via} · expiresAt=${new Date(r.expiresAt).toISOString()}`);
        else out.error(`supply refused · ${r.item} → ${r.target} · ${r.reason} · ${r.detail}`);
        exit(r.ok ? 0 : 1);
      } catch {
        out.error('secret supply failed');
        exit(1);
      }
    });
}
