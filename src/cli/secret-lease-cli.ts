/**
 * HQ-VAULT V3 — `eln secret lease <id[,id…]> --to <host|config-dir>` · `lease revoke` · `lease list`.
 * 🔗 내부 문서 `HQ-CREDENTIAL-VAULT` §3.2 · 구현 = src/secret/static-lease.ts. 출력에 값 0(이름·leaseId·시각·지문 8자만).
 *
 * V2(OAuth mirror lease)와 «한 명령»을 나눠 쓴다: `<id>` 가 정적 키가 아니면(예: codex) `oauthLease` 처리기로 넘긴다.
 * V2 가 착지하면 그 처리기를 여기에 꽂는다 — 같은 `secret lease` 명령을 둘이 따로 등록하지 않는다.
 */
import type { Command } from 'commander';
import {
  issueStaticLease, leaseStaticKeysForCredPush, readStaticLeaseRecords, revokeStaticLeases, runStaticLeaseRenewUntil,
  staticLeaseStatus, STATIC_LEASE_DEFAULT_TTL_MS,
  type StaticLeaseDeps, type StaticLeaseResult,
} from '../secret/static-lease.js';

export interface SecretLeaseCliDeps extends StaticLeaseDeps {
  output?: { log: (line: string) => void; error: (line: string) => void };
  setExitCode?: (code: number) => void;
  /** V2 이음매 — 정적 키가 아닌 `<id>`(OAuth)를 맡는 처리기. 없으면 정적 경로가 `not-static` 으로 거절한다. */
  oauthLease?: (id: string, options: LeaseOptions) => Promise<boolean>;
}

export interface LeaseOptions { to: string; ttl?: string; renew?: boolean; until?: string; json?: boolean }

const DURATION = /^(\d+)\s*(s|m|h|d)$/i;
const UNIT_MS: Readonly<Record<string, number>> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseLeaseDuration(raw: string): number | undefined {
  const m = DURATION.exec(raw.trim());
  if (!m) return undefined;
  const ms = Number(m[1]) * UNIT_MS[m[2]!.toLowerCase()]!;
  return Number.isSafeInteger(ms) && ms > 0 ? ms : undefined;
}

/** `--until` = 기간(`8h`) 또는 ISO 시각. */
export function parseUntil(raw: string, nowMs: number): number | undefined {
  const d = parseLeaseDuration(raw);
  if (d !== undefined) return nowMs + d;
  const t = Date.parse(raw);
  return Number.isFinite(t) && t > nowMs ? t : undefined;
}

function line(res: StaticLeaseResult): string {
  if (!res.ok) return `lease refused · ${res.id} → ${res.target} · ${res.reason} · ${res.detail}`;
  const r = res.record;
  return `lease ${res.action} · ${r.id} → ${r.target} (${r.targetType}) · leaseId=${r.leaseId} · expiresAt=${r.expiresAt} · fp=${r.fingerprint8}`;
}

/** 순서대로 하나씩 — 같은 대상에 ssh 를 겹쳐 열지 않는다. */
async function issueEach(keys: readonly string[], to: string, ttlMs: number | undefined, deps: StaticLeaseDeps): Promise<StaticLeaseResult[]> {
  const results: StaticLeaseResult[] = [];
  for (const id of keys) results.push(await issueStaticLease({ id, to, ...(ttlMs !== undefined ? { ttlMs } : {}) }, deps));
  return results;
}

export function registerSecretLeaseCommands(secret: Command, deps: SecretLeaseCliDeps = {}): Command {
  const out = deps.output ?? console;
  const exit = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  const now = deps.now ?? Date.now;

  const lease = secret.command('lease')
    .description('Lease a static API key as a short-lived 0600 copy to an allow-listed tailnet host or a known config-dir (values never printed).')
    .argument('[ids]', 'catalog id, env name or cred: slot; comma-separated for several (cred-push seam)')
    .option('--to <target>', 'tailnet host name or config-dir path')
    .option('--ttl <duration>', `lease lifetime (e.g. 12h · default ${STATIC_LEASE_DEFAULT_TTL_MS / 3_600_000}h)`)
    .option('--renew', 'renew an active lease past 50% of its lifetime, or issue one if none')
    .option('--until <time>', 'with --renew: keep renewing until this duration/ISO time, then exit (no daemon)')
    .option('--json', 'machine-readable result')
    .allowExcessArguments(false)
    .action(async (ids: string | undefined, options: LeaseOptions) => {
      try {
        if (!ids || !options.to) { out.error('usage: eln secret lease <id[,id…]> --to <host|config-dir> [--ttl 24h] [--renew [--until 8h]]'); exit(2); return; }
        const ttlMs = options.ttl === undefined ? undefined : parseLeaseDuration(options.ttl);
        if (options.ttl !== undefined && ttlMs === undefined) { out.error('invalid --ttl (e.g. 30m, 12h, 1d)'); exit(2); return; }
        if (options.until !== undefined && !options.renew) { out.error('--until requires --renew'); exit(2); return; }
        const keys = ids.split(',').map((s) => s.trim()).filter(Boolean);
        if (keys.length === 1 && deps.oauthLease && ['codex', 'claude-code', 'google-workspace'].includes(keys[0]!)) {
          exit(await deps.oauthLease(keys[0]!, options) ? 0 : 1);
          return;
        }
        let results: StaticLeaseResult[];
        if (options.until !== undefined) {
          const untilMs = parseUntil(options.until, now());
          if (untilMs === undefined || keys.length !== 1) { out.error('--until takes one id and a future duration/ISO time'); exit(2); return; }
          results = [await runStaticLeaseRenewUntil({ id: keys[0]!, to: options.to, untilMs, ...(ttlMs !== undefined ? { ttlMs } : {}) }, deps, (r) => { if (!options.json) out.log(line(r)); })];
          if (options.json) out.log(JSON.stringify(results));
        } else {
          results = options.renew
            ? await leaseStaticKeysForCredPush({ to: options.to, keys, ...(ttlMs !== undefined ? { ttlMs } : {}) }, deps)
            : await issueEach(keys, options.to, ttlMs, deps);
          if (options.json) out.log(JSON.stringify(results));
          else for (const r of results) { if (r.ok) out.log(line(r)); else out.error(line(r)); }
        }
        exit(results.every((r) => r.ok) ? 0 : 1);
      } catch {
        out.error('secret lease failed');
        exit(1);
      }
    });

  lease.command('revoke [leaseId]')
    .description('Remove a leased copy and leave a tombstone (late revokes never delete a newer lease).')
    .option('--to <target>', 'revoke every active lease on this target')
    .option('--id <id>', 'with --to: only this item')
    .option('--json', 'machine-readable result')
    .allowExcessArguments(false)
    .action(async (leaseId: string | undefined, _local: unknown, command: Command) => {
      // `--to`·`--json` 은 부모 `lease` 에도 있다 — commander 는 루트부터 위치 옵션이 아니면 부모가 먼저 가져간다. 합친 값으로 읽는다.
      const options = command.optsWithGlobals() as { to?: string; id?: string; json?: boolean };
      try {
        if (!leaseId && !options.to) { out.error('usage: eln secret lease revoke <leaseId> | --to <target> [--id <id>]'); exit(2); return; }
        const res = await revokeStaticLeases({ ...(leaseId ? { leaseId } : {}), ...(options.to ? { to: options.to } : {}), ...(options.id ? { id: options.id } : {}) }, deps);
        if (!Array.isArray(res)) { out.error(`lease revoke · ${res.reason}`); exit(1); return; }
        if (options.json) out.log(JSON.stringify(res));
        else for (const r of res) out.log(`lease revoke · ${r.id} → ${r.target} · leaseId=${r.leaseId} · ${r.result}`);
        exit(res.every((r) => r.result !== 'pending') ? 0 : 1);
      } catch {
        out.error('secret lease revoke failed');
        exit(1);
      }
    });

  lease.command('list')
    .description('List static lease records (no values): id, target, status, expiry.')
    .option('--json', 'machine-readable result')
    .allowExcessArguments(false)
    .action((_local: unknown, command: Command) => {
      const options = command.optsWithGlobals() as { json?: boolean };
      try {
        const configDir = (deps.configDir ?? (() => (require('../elanous-config-dir.js') as typeof import('../elanous-config-dir.js')).getElanousConfigDir()))();
        const nowMs = now();
        const rows = readStaticLeaseRecords(configDir).map((r) => ({ leaseId: r.leaseId, kind: r.kind, id: r.id, target: r.target, targetType: r.targetType, status: staticLeaseStatus(r, nowMs), issuedAt: r.issuedAt, expiresAt: r.expiresAt, fingerprint8: r.fingerprint8 }));
        if (options.json) out.log(JSON.stringify(rows));
        else {
          out.log('leaseId\tkind\tid\ttarget\tstatus\texpiresAt');
          for (const r of rows) out.log(`${r.leaseId}\t${r.kind}\t${r.id}\t${r.target}\t${r.status}\t${r.expiresAt}`);
        }
        exit(0);
      } catch {
        out.error('secret lease list failed');
        exit(1);
      }
    });
  return lease;
}
