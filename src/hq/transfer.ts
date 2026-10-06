import { appendFileSync, mkdirSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { getUserConfig } from '../user-config.js';
import { defaultSshRunner, localShellRunner, parseLease, sshLeaseStore, type LeaseStore, type SshRunner } from './lease.js';
import { promoteHq, type PromoteResult } from './promote.js';

type Direction = 'promote' | 'handback';
export interface TransferStep { step: string; status: 'done' | 'failed' | 'ready'; measurement: string }
export interface TransferResult { ok: boolean; direction: Direction; from: string; to: string; runId: string; journal: string | null; steps: TransferStep[] }
export interface TransferDeps {
  store: LeaseStore;
  run: SshRunner;
  confirm: (question: string) => boolean;
  promote: (host: string) => PromoteResult;
  journalDir: string;
}

const aliases: Record<string, string[]> = { mbp: ['mbp', 'MacBookProM5'], node-b: ['node-b', 'MacStudioB1'] };
const valid = (alias: string, holder: string) => aliases[alias]?.includes(holder) ?? false;
const leaseCommand = (action: 'release' | 'acquire', expected?: { holder: string; generation: number }) =>
  `elanous hq lease ${action}${expected ? ` --expected-holder '${expected.holder}' --expected-generation ${expected.generation}` : ''} --json`;
const identityCommand = `python3 - <<'PY'
import json, pathlib
home=pathlib.Path.home()
local=home/'.elanous-hq/host'
config=home/'.elanous-hqcfg/config.json'
name=local.read_text().strip() if local.exists() else json.loads(config.read_text())['hq']['hostName']
print(name)
PY`;
const cronCommand = `crontab -l && printf '\\n---HQ-AUDIT---\\n' && elanous hq fence-audit --json`;
const fenceCommand = `elanous hq fence --role cron -- sh -c 'printf "HQ_FENCE_ALLOWED:%s\\n" "$ELANOUS_HQ_GENERATION"'`;

export function defaultTransferDeps(): TransferDeps {
  const arbiter = getUserConfig().hq?.arbiter ?? 'cloud-vm';
  return {
    store: sshLeaseStore(arbiter, arbiter === 'local' ? localShellRunner : defaultSshRunner),
    run: defaultSshRunner,
    confirm: (question) => {
      if (!process.stdin.isTTY) return false;
      process.stderr.write(`${question}\nType TRANSFER to continue: `);
      const buffer = Buffer.alloc(128);
      const count = requireRead(buffer);
      return buffer.toString('utf8', 0, count).trim() === 'TRANSFER';
    },
    promote: (host) => promoteHq(host, true),
    journalDir: join(getElanousConfigDir(), 'hq', 'transfers'),
  };
}

function requireRead(buffer: Buffer): number {
  // Read one terminal line without treating EOF or a non-interactive caller as consent.
  let size = 0;
  while (size < buffer.length) {
    const n = requireReadByte(buffer, size);
    if (n === 0) break;
    size += n;
    if (buffer[size - 1] === 10) break;
  }
  return size;
}

function requireReadByte(buffer: Buffer, offset: number): number {
  return readSync(0, buffer, offset, 1, null);
}

export function transferHq(direction: Direction, apply = false, deps: TransferDeps = defaultTransferDeps()): TransferResult {
  const from = direction === 'promote' ? 'mbp' : 'node-b';
  const to = direction === 'promote' ? 'node-b' : 'mbp';
  const runId = randomUUID();
  const journal = apply ? join(deps.journalDir, `${runId}.jsonl`) : null;
  const steps: TransferStep[] = [];
  const result = (ok: boolean): TransferResult => ({ ok, direction, from, to, runId, journal, steps });
  const record = (step: string, status: TransferStep['status'], measurement: string) => {
    const row = { step, status, measurement };
    steps.push(row);
    if (journal) {
      mkdirSync(deps.journalDir, { recursive: true, mode: 0o700 });
      appendFileSync(journal, `${JSON.stringify({ at: new Date().toISOString(), runId, direction, from, to, ...row })}\n`, { mode: 0o600 });
    }
    return status !== 'failed';
  };
  const lease = () => {
    const { now, raw } = deps.store.read();
    const current = parseLease(raw);
    return { current, now };
  };
  const remote = (host: string, command: string) => {
    const r = deps.run(host, command);
    if (r.status !== 0) throw new Error(`${host}: ${r.stderr.trim() || r.stdout.trim() || `exit=${r.status}`}`);
    return r.stdout.trim();
  };
  try {
    const before = lease();
    if (!before.current || !valid(from, before.current.holder) || before.current.renewedAt + before.current.ttlSeconds < before.now) {
      record('① current lease', 'failed', `holder=${before.current?.holder ?? 'none'} generation=${before.current?.generation ?? 'none'} expired=${before.current ? before.current.renewedAt + before.current.ttlSeconds < before.now : true}`);
      return result(false);
    }
    const source = remote(from, identityCommand);
    const target = remote(to, identityCommand);
    if (source !== before.current.holder || !valid(to, target) || source === target) {
      record('② host identities', 'failed', `source=${source} holder=${before.current.holder} target=${target}`);
      return result(false);
    }
    record('① current lease', 'done', `holder=${source} generation=${before.current.generation}`);
    record('② host identities', 'done', `source=${source} target=${target}`);
    for (const host of [from, to]) {
      const inventory = remote(host, cronCommand);
      const marker = '\n---HQ-AUDIT---\n';
      const index = inventory.lastIndexOf(marker);
      if (index < 0) throw new Error(`${host}: missing cron audit`);
      const cron = inventory.slice(0, index);
      const audit = JSON.parse(inventory.slice(index + marker.length)) as unknown;
      const live = cron.split('\n').filter(line => line.trim() && !line.trimStart().startsWith('#'));
      if (!Array.isArray(audit) || audit.length > 0 || !live.some(line => /hq heartbeat\b/.test(line)) || !live.some(line => /hq fence --role cron\b/.test(line))) {
        record(`③ cron fence ${host}`, 'failed', `unfenced=${Array.isArray(audit) ? audit.length : 'invalid'} heartbeat=${live.some(line => /hq heartbeat\b/.test(line))} fenced=${live.some(line => /hq fence --role cron\b/.test(line))}`);
        return result(false);
      }
      record(`③ cron fence ${host}`, 'done', `unfenced=0 heartbeat=true fenced=true`);
    }
    const oldFence = remote(from, fenceCommand);
    const newFence = remote(to, fenceCommand);
    if (oldFence !== `HQ_FENCE_ALLOWED:${before.current.generation}` || newFence.includes('HQ_FENCE_ALLOWED:')) {
      record('④ pre-transfer fence', 'failed', `source=${oldFence} target=${newFence}`);
      return result(false);
    }
    record('④ pre-transfer fence', 'done', `source=allowed generation=${before.current.generation} target=skipped`);
    if (!apply) {
      record('⑤ human confirmation', 'ready', 'dry-run: no writes; --apply requires interactive TRANSFER confirmation');
      return result(true);
    }
    if (!deps.confirm(`Release ${source} generation ${before.current.generation}, acquire ${target}, and switch cron fence? This cannot undo work already sent.`)) {
      record('⑤ human confirmation', 'failed', 'confirmation declined');
      return result(false);
    }
    record('⑤ human confirmation', 'done', 'operator typed TRANSFER');
    const still = lease().current;
    if (!still || still.holder !== source || still.generation !== before.current.generation || still.renewedAt + still.ttlSeconds < deps.store.read().now) {
      record('⑥ release old lease', 'failed', 'lease changed before release');
      return result(false);
    }
    let released: { ok?: boolean; record?: { holder?: string; generation?: number } };
    try { released = JSON.parse(remote(from, leaseCommand('release', { holder: source, generation: before.current.generation }))); }
    catch (error) {
      record('⑥ release old lease', 'failed', error instanceof Error ? error.message : String(error));
      return result(false);
    }
    if (released.ok !== true || released.record?.holder !== source || released.record.generation !== before.current.generation) {
      record('⑥ release old lease', 'failed', 'release not confirmed');
      return result(false);
    }
    record('⑥ release old lease', 'done', `holder=${source} generation=${released.record.generation} released=true`);
    const acquired = JSON.parse(remote(to, leaseCommand('acquire'))) as { ok?: boolean; record?: { holder?: string; generation?: number } };
    const current = lease().current;
    if (acquired.ok !== true || acquired.record?.holder !== target || acquired.record.generation !== before.current.generation + 1 || current?.holder !== target || current.generation !== acquired.record.generation) {
      record('⑦ acquire new lease', 'failed', `expected=${target} generation=${before.current.generation + 1} observed=${current?.holder ?? 'none'} generation=${current?.generation ?? 'none'}; keep old host fenced, recover manually`);
      return result(false);
    }
    record('⑦ acquire new lease', 'done', `holder=${target} generation=${current.generation}`);
    if (direction === 'promote') {
      const promoted = deps.promote(to);
      for (const line of promoted.lines) record(`⑧ promotion ${line.step}`, line.status, line.measurement);
      if (!promoted.ok) return result(false);
    }
    const sourceAfter = remote(from, fenceCommand);
    const targetAfter = remote(to, fenceCommand);
    const observed = lease().current;
    if (sourceAfter.includes('HQ_FENCE_ALLOWED:') || targetAfter !== `HQ_FENCE_ALLOWED:${current.generation}` || observed?.holder !== target || observed.generation !== current.generation) {
      record('⑨ final fence', 'failed', `source=${sourceAfter} target=${targetAfter} lease=${observed?.holder ?? 'none'} generation=${observed?.generation ?? 'none'}`);
      return result(false);
    }
    record('⑨ final fence', 'done', `source=skipped target=allowed generation=${current.generation}`);
    return result(true);
  } catch (error) {
    record('halt', 'failed', error instanceof Error ? error.message : String(error));
    return result(false);
  }
}

export function formatTransfer(result: TransferResult): string {
  return [`hq ${result.direction}: ${result.ok ? 'ok' : 'failed'} · ${result.from} → ${result.to} · run=${result.runId}`,
    ...result.steps.map(s => `${s.step}: ${s.status} · ${s.measurement}`),
    ...(result.journal ? [`journal=${result.journal}`] : [])].join('\n');
}
