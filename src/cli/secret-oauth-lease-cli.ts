/**
 * HQ-VAULT V2 — Codex OAuth mirror lease CLI.
 *
 *   eln secret oauth-lease codex --to <host|config-dir> [--account <name>] [--ttl 30m|12h] [--renew] [--until 8h|ISO] [--json]
 *   eln secret oauth-lease revoke [leaseId] [--to <host|config-dir>] [--json]
 *   eln secret oauth-lease list [--json]
 *
 * 🔗 내부 문서 `HQ-CREDENTIAL-VAULT` §3.3. Output carries ids · targets · times only — never a token value.
 *
 * ⚠️ Merge with V3 (#38086 · `src/cli/secret-lease-cli.ts`): V3 owns the one `eln secret lease <id>` command and leaves an
 * `oauthLease(id, options)` seam for OAuth ids. `runCodexOauthLease` below has exactly that shape — whichever PR lands
 * second wires `oauthLease: (id, o) => id === 'codex' ? runCodexOauthLease(o) : Promise.resolve(false)` so
 * `eln secret lease codex --to X` is the canonical spelling; `secret oauth-lease …` stays as the codex-only alias
 * (and the only home of `--account` / codex `revoke` / `list` until V3's revoke/list learn OAuth rows).
 */
import type { Command } from 'commander';
import type { CodexLeaseDeps, CodexLeaseResult } from '../secret/codex-lease.js';

export interface SecretOauthLeaseCliDeps {
  readonly leaseDeps?: () => Promise<CodexLeaseDeps>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
}

/** Options as V3's `LeaseOptions` (`to · ttl · renew · until · json`) plus the codex-only `account`. */
export interface CodexOauthLeaseOptions {
  readonly to: string;
  readonly account?: string;
  readonly ttl?: string;
  readonly renew?: boolean;
  readonly until?: string;
  readonly json?: boolean;
}

/** `30m` · `+12h` · `1d` → ms (same units as V3's parser, `+` optional). */
export function parseOauthLeaseDuration(raw: string): number {
  const m = /^\+?(\d{1,4})\s*([mhd])$/i.exec(raw.trim());
  if (!m) throw new Error('--ttl/--until must be like 30m, 12h, 1d or an ISO time');
  const unit = m[2]!.toLowerCase();
  return Number(m[1]) * (unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : 60_000);
}

/** Duration (`8h`) or ISO time → epoch ms. */
export function parseOauthLeaseUntil(raw: string, now: number): number {
  if (/^\+?\d/.test(raw.trim()) && /[mhd]$/i.test(raw.trim())) return now + parseOauthLeaseDuration(raw);
  const abs = Date.parse(raw);
  if (!Number.isFinite(abs)) throw new Error('--ttl/--until must be like 30m, 12h, 1d or an ISO time');
  return abs;
}

function line(result: CodexLeaseResult): string {
  return `codex lease ${result.action} · leaseId=${result.leaseId} · account=${result.account} · target=${result.target}`
    + ` · owner=${result.owner} · expiresAt=${new Date(result.expiresAt).toISOString()} · renewAfter=${new Date(result.renewAfter).toISOString()} · refresh=미포함`;
}

/** Errors are printed by class name + our own fixed message; never a raw upstream error body. */
function safeMessage(error: unknown): string {
  if (error instanceof Error && /^(CodexLease\w+Error)$/.test(error.name)) return error.message;
  if (error instanceof Error && /^(secret lease refused|--until |--ttl|give exactly )/.test(error.message)) return error.message;
  return 'secret lease failed (unexpected error; see `eln logs --category secret`)';
}

function resolveDeps(deps: SecretOauthLeaseCliDeps) {
  return {
    out: deps.out ?? ((s: string) => console.log(s)),
    err: deps.err ?? ((s: string) => console.error(s)),
    leaseDeps: deps.leaseDeps ?? (async () => (await import('../secret/codex-lease.js')).defaultCodexLeaseDeps()),
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
  };
}

/**
 * V3 seam handler: issue/renew/watch one Codex lease. Prints its own line(s); returns false on refusal/failure.
 * Never throws — the caller maps the boolean to the exit code.
 */
export async function runCodexOauthLease(opts: CodexOauthLeaseOptions, deps: SecretOauthLeaseCliDeps = {}): Promise<boolean> {
  const { out, err, leaseDeps, sleep } = resolveDeps(deps);
  try {
    const { issueCodexLease, watchCodexLease } = await import('../secret/codex-lease.js');
    const d = await leaseDeps();
    const ttlMs = opts.ttl === undefined ? undefined : parseOauthLeaseDuration(opts.ttl);
    if (opts.until !== undefined) {
      if (!opts.renew) throw new Error('--until requires --renew');
      const untilMs = parseOauthLeaseUntil(opts.until, d.now());
      const ticks = await watchCodexLease({ to: opts.to, account: opts.account, untilMs, ttlMs },
        { ...d, sleep, onTick: (r) => { if (!opts.json) out(line(r)); } });
      if (opts.json) out(JSON.stringify({ ok: true, ticks }));
      return true;
    }
    const result = await issueCodexLease({ to: opts.to, account: opts.account, renew: opts.renew, ttlMs }, d);
    out(opts.json ? JSON.stringify({ ok: true, ...result }) : line(result));
    return true;
  } catch (error) {
    err(`secret lease codex 실패: ${safeMessage(error)}`);
    return false;
  }
}

export function registerSecretOauthLeaseCommands(secret: Command, deps: SecretOauthLeaseCliDeps = {}): Command {
  const { out, err, leaseDeps } = resolveDeps(deps);
  const lease = secret.command('oauth-lease')
    .description('Short-lived, refresh-free OAuth access leases from the owner host (values never printed). Codex first.');

  lease.command('codex')
    .description('Lease the owner\'s Codex access token (no refresh token) to an isolated config dir or a mirror host.')
    .requiredOption('--to <target>', 'absolute config dir under a known root, or a mirror host name')
    .option('--account <name>', 'owner Codex account (default: default)')
    .option('--ttl <duration>', 'shorter lease life, 5m..24h (e.g. 30m) — expiry verification')
    .option('--renew', 're-issue only when the current lease is past its renew point')
    .option('--until <time>', 'with --renew: keep renewing in the foreground until 8h / ISO time, then exit (no daemon)')
    .option('--json', 'JSON output')
    .action(async (opts: CodexOauthLeaseOptions) => {
      if (!await runCodexOauthLease(opts, deps)) process.exitCode = 1;
    });

  lease.command('revoke [leaseId]')
    .description('Revoke a lease by id or by --to target: tombstone the target entry, then close the ledger row.')
    .option('--to <target>', 'revoke every live lease on this target')
    .option('--json', 'JSON output')
    .action(async (leaseId: string | undefined, opts: { to?: string; json?: boolean }) => {
      try {
        if (!leaseId === !opts.to) throw new Error('give exactly one of <leaseId> or --to');
        const { revokeCodexLease } = await import('../secret/codex-lease.js');
        const result = revokeCodexLease({ leaseId, to: opts.to }, await leaseDeps());
        out(opts.json ? JSON.stringify({ ok: true, ...result })
          : result.revoked.map((r) => `codex lease revoked · leaseId=${r.leaseId} · target=${r.target}`).join('\n'));
      } catch (error) {
        err(`secret lease revoke 실패: ${safeMessage(error)}`);
        process.exitCode = 1;
      }
    });

  lease.command('list')
    .description('List OAuth lease ledger rows (ids · targets · times; no values).')
    .option('--json', 'JSON output')
    .action(async (opts: { json?: boolean }) => {
      try {
        const [{ readLeaseRecords, secretLeaseStorePath, leaseTargetKey }, d] = await Promise.all([import('../secret/lease-store.js'), leaseDeps()]);
        const rows = readLeaseRecords(secretLeaseStorePath(d.stateRoot()));
        const now = d.now();
        if (opts.json) { out(JSON.stringify({ ok: true, leases: rows })); return; }
        if (!rows.length) { out('lease 없음'); return; }
        for (const r of rows) {
          const state = r.revokedAt !== undefined ? 'revoked' : now >= r.expiresAt ? 'expired' : 'live';
          out(`${r.leaseId} · ${state} · ${r.provider}/${r.account} · ${leaseTargetKey(r.target)} · expiresAt=${new Date(r.expiresAt).toISOString()}`);
        }
      } catch (error) {
        err(`secret lease list 실패: ${safeMessage(error)}`);
        process.exitCode = 1;
      }
    });
  return lease;
}
