import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { interpretCasResult, isAbsentSaid, type CasOutcome } from '../roles/lease-cas.js';
import { debug } from '../debug/log.js';
import { getUserConfig } from '../user-config.js';
import { readMachineProfile, seatRank, validSeatRank } from '../roles/machine-profile.js';
import {
  ROLE_LEASE_OBJECT_PATH, nextAccept, nextClaim, nextHandoff, nextRevert, parseRoleLease,
  type RoleLeaseDoc,
} from '../roles/role-lease.js';
import { MACHINE_NAME, resolveMachineName, writeConfiguredMachine } from '../roles/machine-name.js';
import { decideTick, initialWatchState, MIN_TAKEOVER_TICKS, type WatchState } from '../roles/role-watch.js';

export type RoleObjectRead =
  | { readonly kind: 'present'; readonly text: string; readonly gen: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unmeasured'; readonly why: string };

export interface RoleCliDeps {
  read?: (bucket: string) => RoleObjectRead | Promise<RoleObjectRead>;
  write?: (doc: RoleLeaseDoc, ifGen: string, bucket: string) => CasOutcome | Promise<CasOutcome>;
  me?: string;
  root?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  out?: { log: (line: string) => void; error: (line: string) => void };
  setExitCode?: (code: number) => void;
}

const machineName = MACHINE_NAME;
const bucketName = /^gs:\/\/[a-z0-9][a-z0-9._-]{1,220}$/;

export function resolveRoleBucket(option?: string): string {
  const configured = getUserConfig().raw.roles;
  const configBucket = configured && typeof configured === 'object' && !Array.isArray(configured)
    ? (configured as { bucket?: unknown }).bucket : undefined;
  const value = option ?? process.env.ELANOUS_BACKUP_BUCKET ?? configBucket;
  if (value === undefined) throw new Error('roles.bucket 을 설정하라 (--bucket 또는 ELANOUS_BACKUP_BUCKET)');
  if (typeof value !== 'string' || !bucketName.test(value)) throw new Error(`invalid bucket: ${String(value)}`);
  return value;
}

const SYSTEM_GCLOUD_PATHS: readonly string[] = ['/opt/homebrew/bin/gcloud', '/usr/local/bin/gcloud', '/snap/bin/gcloud'];
let systemGcloudPaths: readonly string[] = SYSTEM_GCLOUD_PATHS;
/** 시험 전용 — 시스템 고정 경로를 바꾼다(`null` = 되돌림). 진짜 gcloud 가 깔린 맥에서 가짜 gcloud 시험이 진짜를 부르지 않게. */
export function _setSystemGcloudPathsForTesting(paths: readonly string[] | null): void {
  systemGcloudPaths = paths ?? SYSTEM_GCLOUD_PATHS;
}

export function gcloudSearchPaths(): string[] {
  return [...systemGcloudPaths, `${process.env.HOME}/google-cloud-sdk/bin/gcloud`,
    ...(process.env.PATH ?? '').split(':').filter(Boolean).map(dir => join(dir, 'gcloud'))];
}
const uri = (bucket: string) => `${bucket}/${ROLE_LEASE_OBJECT_PATH}`;

export function gcloud(): string | null {
  for (const path of gcloudSearchPaths()) {
    try { accessSync(path, constants.X_OK); if (statSync(path).isFile()) return path; }
    catch { /* try the next executable */ }
  }
  return null;
}

function runGcloud(args: string[]): { code: number | null; stdout: string; said: string } {
  const binary = gcloud();
  if (!binary) return { code: null, stdout: '', said: 'gcloud not found' };
  const r = spawnSync(binary, args, { encoding: 'utf8', timeout: 120_000 });
  return { code: r.status, stdout: r.stdout ?? '', said: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ?? ''}` };
}

function describe(bucket: string): { kind: 'present'; gen: string } | { kind: 'absent' } | { kind: 'unmeasured'; why: string } {
  const r = runGcloud(['storage', 'objects', 'describe', uri(bucket), '--format=value(generation)']);
  if (r.code !== 0) return r.code !== null && isAbsentSaid(r.said) ? { kind: 'absent' } : { kind: 'unmeasured', why: r.said.trim() };
  const gen = r.stdout.trim();
  return /^\d+$/.test(gen) ? { kind: 'present', gen } : { kind: 'unmeasured', why: 'invalid GCS generation' };
}

function liveRead(bucket: string): RoleObjectRead {
  const before = describe(bucket);
  if (before.kind !== 'present') return before;
  const cat = runGcloud(['storage', 'cat', uri(bucket)]);
  if (cat.code !== 0) return { kind: 'unmeasured', why: cat.said.trim() };
  const after = describe(bucket);
  if (after.kind !== 'present' || before.gen !== after.gen) return { kind: 'unmeasured', why: 'lease changed during read; retry' };
  return { kind: 'present', text: cat.stdout, gen: before.gen };
}

function liveWrite(doc: RoleLeaseDoc, ifGen: string, bucket: string): CasOutcome {
  const dir = mkdtempSync(join(tmpdir(), 'elanous-role-'));
  try {
    const file = join(dir, 'control-primary.json');
    writeFileSync(file, `${JSON.stringify(doc)}\n`);
    const r = runGcloud(['storage', 'cp', file, uri(bucket), `--if-generation-match=${ifGen}`]);
    return interpretCasResult({ code: r.code, said: r.said });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function snapshot(read: RoleObjectRead): { doc: RoleLeaseDoc; gen: string } | { absent: true } {
  if (read.kind === 'unmeasured') throw new Error(read.why);
  if (read.kind === 'absent') return { absent: true };
  const parsed = parseRoleLease(read.text);
  if (parsed.kind !== 'present') throw new Error(parsed.kind === 'unmeasured' ? parsed.why : 'empty lease');
  return { doc: parsed.doc, gen: read.gen };
}

export function registerRoleCommands(program: Command, overrides: RoleCliDeps = {}): void {
  const deps = {
    read: liveRead, write: liveWrite, me: undefined as string | undefined, now: Date.now,
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    out: console, setExitCode: (code: number) => { process.exitCode = code; },
    ...overrides,
  };
  const role = program.command('role').description('관제부 Primary 임대 조회 및 수동 넘김');
  const bucket = resolveRoleBucket;
  const me = () => {
    const name = deps.me ?? resolveMachineName({ root: deps.root }).machine;
    if (!machineName.test(name)) throw new Error(`invalid machine: ${name} — \`elanous role set-machine <식별자>\` 로 정한다`);
    return name;
  };
  role.command('whoami').description('임대에서 이 기계가 쓰는 이름과 그 출처')
    .action(() => execute(async () => {
      const r = deps.me !== undefined ? { machine: deps.me, source: 'option' } : resolveMachineName({ root: deps.root });
      deps.out.log(`${r.machine} · ${r.source}${machineName.test(r.machine) ? '' : ' · invalid'}`);
      return machineName.test(r.machine) ? 0 : 1;
    })());
  role.command('set-machine <name>').description('임대 기계 이름을 명시(control/machine.json)')
    .action((name: string) => execute(async () => {
      writeConfiguredMachine(name, deps.root);
      deps.out.log(`machine · ${name}`);
      return 0;
    })());
  const observe = (event: 'claim' | 'handoff' | 'accept' | 'revert', from: string | undefined, to: string, generation: number, outcome: string) => {
    debug.log('roles.lease', event, { from, to, generation, outcome });
  };
  const execute = (action: () => Promise<number>) => async () => {
    try {
      const code = await action();
      if (code !== 0) deps.setExitCode(code);
    } catch (e) {
      deps.out.error(`role: ${e instanceof Error ? e.message : String(e)}`);
      deps.setExitCode(e instanceof Error && e.message.includes('roles.bucket 을 설정하라') ? 2 : 1);
    }
  };
  role.command('status').option('--json', 'JSON 출력').option('--bucket <bucket>', 'GCS 버킷')
    .action((opts: { json?: boolean; bucket?: string }) => execute(async () => {
      let lease: { doc: RoleLeaseDoc; gen: string } | { absent: true } | { unmeasured: string };
      try {
        const b = bucket(opts.bucket);
        const read = await deps.read(b);
        lease = read.kind === 'unmeasured' ? { unmeasured: read.why } : snapshot(read);
      } catch (e) {
        lease = { unmeasured: e instanceof Error ? e.message : String(e) };
      }
      const status = 'doc' in lease ? {
        holder: lease.doc.holder, generation: lease.doc.generation, state: lease.doc.state,
        ...(lease.doc.from ? { from: lease.doc.from } : {}),
      } : 'absent' in lease ? { absent: true } : lease;
      deps.out.log(opts.json ? JSON.stringify(status) : `role: ${JSON.stringify(status)}`);
      return 'unmeasured' in status ? (status.unmeasured.includes('roles.bucket 을 설정하라') ? 2 : 1) : 'absent' in status ? 2 : 0;
    })());
  role.command('watch').description('부팅 시 Primary 임대를 관찰·갱신·인수')
    // Every machine must use the same cadence: counting faster observer ticks can preempt a live holder.
    .option('--interval <seconds>', '공통 틱 간격(초; 모든 기계에서 60)', '60')
    .option('--takeover-ticks <count>', '변화 없는 관찰 틱 수', '5')
    .option('--rank <n>', '이 기계의 control 자리 후보 순위(프로필 덮어쓰기)')
    .option('--once', '한 틱만 실행')
    .option('--bucket <bucket>', 'GCS 버킷')
    .action((opts: { interval: string; takeoverTicks: string; rank?: string; once?: boolean; bucket?: string }) => execute(async () => {
      const seconds = Number(opts.interval), ticks = Number(opts.takeoverTicks);
      if (!Number.isSafeInteger(seconds) || seconds < 1) throw new Error('interval must be a positive integer (seconds)');
      if (seconds !== 60) throw new Error('interval must be 60 seconds on every machine (shared renewal and takeover cadence)');
      if (!Number.isSafeInteger(ticks) || ticks < MIN_TAKEOVER_TICKS) {
        throw new Error(`takeover-ticks must be at least ${MIN_TAKEOVER_TICKS} (one missed renewal can precede a live holder)`);
      }
      const explicitRank = opts.rank === undefined ? undefined : Number(opts.rank);
      if (opts.rank !== undefined && (!validSeatRank(explicitRank!) || !/^[0-9]+$/.test(opts.rank))) throw new Error('rank must be an integer from 1 to 99');
      const b = bucket(opts.bucket), owner = me();
      const tickRank = () => {
        const profile = readMachineProfile(deps.root);
        const currentId = profile?.id ?? (deps.me ?? resolveMachineName({ root: deps.root }).machine);
        if (currentId !== owner) throw new Error(`machine id changed during watch: ${owner} → ${currentId}`);
        return opts.rank === undefined ? seatRank(profile, 'control') : explicitRank;
      };
      let state: WatchState = initialWatchState;
      do {
        const rank = tickRank();
        const read = await deps.read(b);
        if (tickRank() !== rank) throw new Error('machine rank changed during lease read');
        const decision = decideTick(state, read, { me: owner, rank, takeoverTicks: ticks, now: deps.now() });
        state = decision.state;
        let event: 'claim' | 'renew' | 'takeover' | 'accept' | 'observe' | 'cas-rejected' = decision.action;
        if (decision.doc && decision.ifGen !== undefined) {
          if (tickRank() !== rank) throw new Error('machine rank changed before lease write');
          const result = await deps.write(decision.doc, decision.ifGen, b);
          if (result.kind === 'unmeasured') throw new Error(`watch CAS unmeasured: ${result.why}`);
          if (result.kind === 'lost') {
            event = 'cas-rejected';
            state = initialWatchState;
          } else {
            state = { generation: decision.doc.generation, unchangedTicks: 0, absentTicks: 0 };
          }
        }
        const written = event !== 'cas-rejected' ? decision.doc : undefined;
        const data = { holder: written?.holder ?? decision.holder ?? null, generation: written?.generation ?? decision.generation ?? null, me: owner, rank: rank ?? null, unchangedTicks: decision.state.unchangedTicks, absentTicks: decision.state.absentTicks };
        debug.log('roles.lease', event, data);
        debug.log('roles.watch', event, data);
        deps.out.log(`watch: ${event} · holder ${data.holder ?? 'absent'} · gen ${data.generation ?? 'absent'} · unchangedTicks ${data.unchangedTicks}`);
        if (opts.once) break;
        await deps.sleep(seconds * 1_000);
      } while (true);
      return 0;
    })());
  role.command('claim').option('--bucket <bucket>', 'GCS 버킷')
    .action((opts: { bucket?: string }) => execute(async () => {
      const b = bucket(opts.bucket), owner = me(), current = snapshot(await deps.read(b));
      const doc = nextClaim('absent' in current ? { kind: 'absent' } : { kind: 'present', doc: current.doc }, owner, deps.now());
      const result = await deps.write(doc, 'absent' in current ? '0' : current.gen, b);
      observe('claim', 'absent' in current ? undefined : current.doc.holder, owner, doc.generation, result.kind);
      if (result.kind !== 'won') throw new Error(`claim CAS ${result.kind}`);
      deps.out.log(`claim: ${owner} · gen ${doc.generation} · held`);
      return 0;
    })());
  role.command('accept').option('--bucket <bucket>', 'GCS 버킷')
    .action((opts: { bucket?: string }) => execute(async () => {
      const b = bucket(opts.bucket), owner = me(), current = snapshot(await deps.read(b));
      if ('absent' in current) throw new Error('lease absent');
      const doc = nextAccept(current.doc, owner, deps.now());
      const result = await deps.write(doc, current.gen, b);
      observe('accept', current.doc.from, owner, doc.generation, result.kind);
      if (result.kind !== 'won') throw new Error(`accept CAS ${result.kind}`);
      deps.out.log(`accept: ${owner} · gen ${doc.generation} · held`);
      return 0;
    })());
  role.command('handoff').requiredOption('--to <machine>', '대상 기계')
    .option('--timeout <seconds>', '수락 제한 시간(초)', '120').option('--bucket <bucket>', 'GCS 버킷')
    .action((opts: { to: string; timeout: string; bucket?: string }) => execute(async () => {
      const b = bucket(opts.bucket), owner = me();
      if (!machineName.test(opts.to)) throw new Error(`invalid target: ${opts.to}`);
      const seconds = Number(opts.timeout);
      if (!Number.isSafeInteger(seconds) || seconds < 1) throw new Error('timeout must be a positive integer (seconds)');
      const current = snapshot(await deps.read(b));
      if ('absent' in current) throw new Error('lease absent');
      const pending = nextHandoff(current.doc, owner, opts.to, deps.now());
      const result = await deps.write(pending, current.gen, b);
      observe('handoff', owner, opts.to, pending.generation, result.kind);
      if (result.kind !== 'won') throw new Error(`handoff CAS ${result.kind}`);
      const start = deps.now();
      const line = (outcome: string, gen: number) => deps.out.log(`handoff: ${owner} → ${opts.to} · gen ${gen} · ${outcome}`);
      let lastPending: { doc: RoleLeaseDoc; gen: string } | undefined;
      while (true) {
        let observed: RoleObjectRead;
        try { observed = await deps.read(b); }
        catch (e) { observed = { kind: 'unmeasured', why: e instanceof Error ? e.message : String(e) }; }
        if (observed.kind === 'present') {
          let parsed: ReturnType<typeof snapshot> | undefined;
          try { parsed = snapshot(observed); } catch { /* transient malformed read: retry until deadline */ }
          if (parsed && !('absent' in parsed)) {
            const doc = parsed.doc;
            if (doc.state === 'held' && doc.holder === opts.to && doc.generation === pending.generation + 1) {
              if (deps.now() - start >= seconds * 1_000) {
                observe('revert', owner, opts.to, doc.generation, 'revert-failed');
                line('revert-failed', doc.generation);
                return 1;
              }
              observe('handoff', owner, opts.to, doc.generation, 'accepted');
              line('accepted', doc.generation);
              return 0;
            }
            if (doc.state !== 'handing-off' || doc.holder !== opts.to || doc.from !== owner || doc.generation !== pending.generation) {
              observe('revert', owner, opts.to, doc.generation, 'revert-failed');
              line('revert-failed', pending.generation);
              return 1;
            }
            lastPending = { doc, gen: parsed.gen };
          }
        }
        if (deps.now() - start >= seconds * 1_000) {
          if (observed.kind !== 'present') {
            let refreshed: RoleObjectRead;
            try { refreshed = await deps.read(b); }
            catch { refreshed = { kind: 'unmeasured', why: 'read failed' }; }
            if (refreshed.kind === 'present') {
              try {
                const latest = snapshot(refreshed);
                if (!('absent' in latest)) {
                  const doc = latest.doc;
                  if (doc.state === 'handing-off' && doc.holder === opts.to && doc.from === owner && doc.generation === pending.generation) {
                    lastPending = { doc, gen: latest.gen };
                  } else {
                    observe('revert', owner, opts.to, doc.generation, 'revert-failed');
                    line('revert-failed', pending.generation);
                    return 1;
                  }
                }
              } catch { /* retain the last confirmed generation for a CAS revert */ }
            }
          }
          if (lastPending) {
            const revert = nextRevert(lastPending.doc, deps.now());
            let undone: CasOutcome;
            try { undone = await deps.write(revert, lastPending.gen, b); }
            catch (e) { undone = { kind: 'unmeasured', why: e instanceof Error ? e.message : String(e) }; }
            observe('revert', opts.to, owner, revert.generation, undone.kind === 'won' ? 'timeout-reverted' : 'revert-failed');
            line(undone.kind === 'won' ? 'timeout-reverted' : 'revert-failed', undone.kind === 'won' ? revert.generation : pending.generation);
            return 1;
          }
          observe('revert', opts.to, owner, pending.generation, 'revert-failed');
          line('revert-failed', pending.generation);
          return 1;
        }
        try { await deps.sleep(Math.min(1_000, Math.max(1, seconds * 1_000 - (deps.now() - start)))); }
        catch { /* keep polling or attempt a CAS revert at the deadline */ }
      }
    })());
}
