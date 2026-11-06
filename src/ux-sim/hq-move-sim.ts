import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hqFenceDecision, hqLease } from '../hq/hq.js';
import { hqMovePlan } from '../hq/move-plan.js';
import { promoteHq, type PromoteRunner } from '../hq/promote.js';
import { reallocatePoolsThroughRunner, transferHq } from '../hq/transfer.js';
import { fileLeaseStore, parseLease, serializeLease, type LeaseStore } from '../hq/lease.js';
import { activeResourcePools, declareResourcePool, readResourceLedger, reassignResourcePools } from '../resource-ledger/resource-ledger.js';
import { openMsgStore } from '../msg/msg-store.js';
import { configuredWorktreeRoot } from '../user-config.js';
import { machinePoolCapacity, parseMachinePoolDeclarations, type MachinePoolDeclaration } from '../resource-ledger/machine-pool-inventory.js';
import { createFakeSsh } from './fake-ssh.js';
import type { SimClock } from './fake-clock.js';

export type HqMoveFault = 'none' | 'target-unavailable' | 'partial-copy' | 'old-host-loss' | 'stale-pool';
export interface HqMoveObservation { event: string; verdict: string }
export interface HqMoveSimulationResult {
  pass: boolean;
  fault: HqMoveFault;
  observations: HqMoveObservation[];
  devices: string[];
}
export interface HqMoveRuntime {
  ssh: ReturnType<typeof createFakeSsh>;
  clock: SimClock;
  /** Executes only extracted Python bodies from the real promotion runbook in the isolated host home. */
  runPython: (source: string, home: string, env: Record<string, string>) => { status: number | null; stdout: string; stderr: string };
}

const SOURCE = 'MacBookProM5';
const TARGET = 'MacStudioB1';
const SOURCE_ALIAS = 'mbp';
const TARGET_ALIAS = 'node-b';
const GENERATION = 'sim-20261109T0600Z';

function leaseDeps(store: LeaseStore, root: string, host: string, clock: SimClock) {
  const hostPath = join(root, `${host}.host`);
  const localPath = join(root, `${host}.local.json`);
  const seenPath = join(root, `${host}.seen-generation`);
  writeFileSync(hostPath, `${host}\n`, { mode: 0o600 });
  return { config: { arbiter: 'local', hostName: host, standby: host === SOURCE ? TARGET_ALIAS : SOURCE_ALIAS }, store,
    hostPath, localPath, seenPath, now: () => clock.now(), log: () => {} };
}

function sourcePools(): MachinePoolDeclaration[] {
  return parseMachinePoolDeclarations({ pools: ['gate', 'sim'].map((purpose) => ({
    purpose,
    members: [{ host: SOURCE_ALIAS, count: 2, digest: `sha256:${'a'.repeat(64)}`, role: 'both' }],
    fanoutGroupId: `hq-move-${purpose}`,
    fanoutGroup: { shard: { kind: purpose === 'gate' ? 'gate' : 'code', input: 'move input', result: 'move result', fingerprint: 'sha256:move' } },
    fingerprint: { runtime: 'bun', environment: 'simulation', skillPacks: [] },
    cleanup: { procedure: 'remove sandbox', verify: 'no active leases' },
  })) });
}

interface TierFixture { generation: string; manifestSha256: string; entries: number }
interface StandbyFixture {
  targetHome: string;
  sourceResourceLedger: string;
  tiers: TierFixture[];
  sourceState: { ledger: string[]; worktree: string[]; mail: string[] };
  partialCopyFile: string;
}

function writeTier(root: string, tier: 'core' | 'big', files: Record<string, string | Buffer>, createdAt: string): TierFixture {
  const generation = GENERATION;
  const directory = join(root, tier, generation);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const entries = Object.entries(files).map(([path, content]) => {
    const absolute = join(directory, path);
    mkdirSync(join(absolute, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(absolute, content, { mode: 0o600 });
    const data = typeof content === 'string' ? Buffer.from(content) : content;
    const sha256 = createHash('sha256').update(data).digest('hex');
    return { path, bytes: data.byteLength, sha256, kind: 'file' };
  });
  const manifest = { generation, tier, createdAt, source: 'simulated-standby-volume', host: SOURCE_ALIAS, entries };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(directory, 'MANIFEST.json'), manifestText, { mode: 0o600 });
  writeFileSync(join(directory, 'SHA256SUMS'), `${entries.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n')}\n`, { mode: 0o600 });
  symlinkSync(generation, join(root, tier, 'latest'));
  return { generation, manifestSha256: createHash('sha256').update(manifestText).digest('hex'), entries: entries.length };
}

function createStandbyFixture(root: string, clock: SimClock): StandbyFixture {
  const targetHome = join(root, 'hosts', TARGET_ALIAS);
  const standby = join(targetHome, '.elanous-standby');
  const sourceResourceLedger = join(root, 'source', 'resource-ledger', 'events.jsonl');
  mkdirSync(join(targetHome, '.elanous-hqcfg'), { recursive: true, mode: 0o700 });
  mkdirSync(standby, { recursive: true, mode: 0o700 });
  writeFileSync(join(targetHome, '.elanous-hqcfg', 'config.json'), `${JSON.stringify({ hq: { hostName: TARGET } })}\n`, { mode: 0o600 });
  for (const pool of sourcePools()) declareResourcePool(pool, new Date(clock.now()), sourceResourceLedger);

  const sourceState = { ledger: ['gate', 'sim'], worktree: ['branch:opt/sim-hq-move'], mail: ['pending-op-reply'] };
  const sourceMail = join(root, 'source', 'msg', 'messages.db');
  const msgStore = openMsgStore(sourceMail);
  msgStore.post({ from: 'OPT', to: 'OP', kind: 'report', body: 'pending-op-reply' });
  msgStore.close();
  const worktreePath = 'worktrees/OPT-SIM-HQ-MOVE/HEAD';
  const files: Record<string, string | Buffer> = {
    'release/features.sqlite': 'simulated-release-features',
    'config.json': `${JSON.stringify({ tools: { selfImplement: { worktreeRoot: join(targetHome, '.elanous-hqstate', 'worktrees') } } })}\n`,
    [worktreePath]: 'branch:opt/sim-hq-move\n',
    'msg/messages.db': readFileSync(sourceMail),
    'resource-ledger/events.jsonl': readFileSync(sourceResourceLedger, 'utf8'),
  };
  const createdAt = new Date(clock.now()).toISOString();
  const core = writeTier(standby, 'core', files, createdAt);
  const big = writeTier(standby, 'big', { 'knowledge.db': 'simulated-knowledge' }, createdAt);
  return { targetHome, sourceResourceLedger, tiers: [core, big], sourceState,
    partialCopyFile: join(standby, 'core', GENERATION, 'worktrees', 'OPT-SIM-HQ-MOVE', 'HEAD') };
}

function pythonBody(command: string): string | null {
  const marker = "python3 - <<'PY'\n";
  const start = command.indexOf(marker);
  if (start < 0) return null;
  const bodyStart = start + marker.length;
  const end = command.lastIndexOf('\nPY');
  if (end < bodyStart) return null;
  return command.slice(bodyStart, end);
}

function pythonEnv(command: string): Record<string, string> {
  const env: Record<string, string> = {};
  const prefix = command.slice(0, command.indexOf("python3 - <<'PY'"));
  for (const match of prefix.matchAll(/\b(HQ_PROMOTE_[A-Z0-9_]+)=([^\s]+)/g)) env[match[1]!] = match[2]!;
  return env;
}

function promotionRunner(store: LeaseStore, fault: HqMoveFault, fixture: StandbyFixture, copied: { ok: boolean }, runtime: HqMoveRuntime): PromoteRunner {
  const tier = (name: 'core' | 'big') => fixture.tiers.find((entry, index) => (index === 0 ? 'core' : 'big') === name)!;
  return {
    lease: () => {
      const now = store.read().now;
      const record = parseLease(store.read().raw);
      return { holder: record?.holder ?? null, generation: record?.generation ?? null,
        expired: !record || now - record.renewedAt > record.ttlSeconds * 1_000 };
    },
    run(host, script) {
      const transport = runtime.ssh.ssh(host, script, 120_000);
      if (transport.rc !== 0) return { status: transport.rc, stdout: '', stderr: transport.output };
      if (script.includes('promote lock held')) return { status: 0, stdout: 'port=31416 available', stderr: '' };
      if (script.includes('index.html present')) return { status: 0, stdout: 'index.html present', stderr: '' };
      if (script.includes('codex mcp list')) return { status: 0, stdout: 'MCP entries=3', stderr: '' };
      if (script.includes('hq promote --help')) return { status: 0, stdout: `host=${TARGET}`, stderr: '' };
      if (script.includes('verifyStandby')) {
        const checks = ['core', 'big'].map((name) => {
          const artifact = tier(name as 'core' | 'big');
          return { tier: name, generation: artifact.generation, manifestSha256: artifact.manifestSha256,
            checked: artifact.entries, entries: artifact.entries };
        });
        return { status: 0, stdout: JSON.stringify({ ok: true, tiers: checks }), stderr: '' };
      }
      if (script.includes('shutil.copy2')) {
        if (fault === 'partial-copy') writeFileSync(fixture.partialCopyFile, '{injected post-verification source change}\n', { mode: 0o600 });
        const body = pythonBody(script);
        if (!body) return { status: 2, stdout: '', stderr: 'promotion copy Python body missing' };
        const result = runtime.runPython(body, fixture.targetHome, pythonEnv(script));
        copied.ok = result.status === 0 && /promotion files=\d+ bytes=\d+B/.test(result.stdout);
        return { status: result.status, stdout: result.stdout, stderr: result.stderr };
      }
      if (script.includes("config['hq'] = hq")) {
        const body = pythonBody(script);
        if (!body) return { status: 2, stdout: '', stderr: 'target config Python body missing' };
        return runtime.runPython(body, fixture.targetHome, pythonEnv(script));
      }
      if (script.includes('nexus run')) return { status: 0, stdout: 'health=200 port=31416 pid=81 listener_pid=81', stderr: '' };
      if (script.includes('steward mode rescue')) return { status: 0, stdout: '{"mode":"rescue"}', stderr: '' };
      if (script.includes('promote.lock')) return { status: 0, stdout: '', stderr: '' };
      return { status: 2, stdout: '', stderr: `unexpected simulated promotion command: ${script.slice(0, 80)}` };
    },
  };
}

function migrationState(home: string) {
  const stateRoot = join(home, '.elanous-hqstate');
  const pools = activeResourcePools(readResourceLedger(join(stateRoot, 'resource-ledger', 'events.jsonl')));
  const store = openMsgStore(join(stateRoot, 'msg', 'messages.db'));
  let mail: string[];
  try { mail = store.list('OP').map((message) => message.body); }
  finally { store.close(); }
  const worktreeRoot = configuredWorktreeRoot(join(stateRoot, 'config.json'));
  const worktreeFile = join(worktreeRoot, 'OPT-SIM-HQ-MOVE', 'HEAD');
  const worktree = existsSync(worktreeFile) ? [readFileSync(worktreeFile, 'utf8').trim()] : [];
  return { ledger: pools.map((pool) => pool.purpose).sort(), worktree, mail };
}

/** Run production HQ transfer/promotion and resource-ledger pool updates through declared fake host/clock boundaries. */
export function runHqMoveSimulation(root: string, fault: HqMoveFault = 'none', runtime: HqMoveRuntime): HqMoveSimulationResult {
  if (!['none', 'target-unavailable', 'partial-copy', 'old-host-loss', 'stale-pool'].includes(fault)) throw new Error(`unsupported HQ move fault: ${fault}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const leasePath = join(root, 'arbiter', 'lease.json');
  const store = fileLeaseStore(leasePath, () => runtime.clock.now());
  const now = runtime.clock.now();
  if (!store.cas(null, serializeLease({ holder: SOURCE, generation: 7, acquiredAt: now - 100, renewedAt: now, ttlSeconds: 1_500 }))) {
    throw new Error('could not seed isolated HQ lease');
  }
  const sourceDeps = leaseDeps(store, root, SOURCE, runtime.clock);
  const targetDeps = leaseDeps(store, root, TARGET, runtime.clock);
  const fixture = createStandbyFixture(root, runtime.clock);
  const targetResourceLedger = join(fixture.targetHome, '.elanous-hqstate', 'resource-ledger', 'events.jsonl');
  const cron = '*/10 * * * * elanous hq heartbeat\n* * * * * elanous hq fence --role cron -- echo ok\n';
  const plan = hqMovePlan('node-b', {
    hostFile: sourceDeps.hostPath, localHost: () => SOURCE,
    crontab: () => ({ status: 0, stdout: cron, stderr: '' }), loops: () => [],
    ssh: (host) => (fault !== 'target-unavailable' && runtime.ssh.ssh(host, 'hq move target preflight').rc === 0)
      ? { status: 0, stdout: `present\n${TARGET_ALIAS}`, stderr: '' }
      : { status: 255, stdout: '', stderr: 'injected target unreachable' },
    launchctl: () => ({ status: 0, stdout: 'com.elanous.nexus', stderr: '' }),
  });
  const copied = { ok: false };
  const calls: Array<{ host: string; command: string }> = [];
  const run = (host: string, command: string) => {
    calls.push({ host, command });
    const transport = runtime.ssh.ssh(host, command, 30_000);
    if (fault === 'target-unavailable' && host === TARGET_ALIAS) return { status: 255, stdout: '', stderr: 'injected target unreachable' };
    if (transport.rc !== 0) return { status: transport.rc, stdout: '', stderr: transport.output };
    const name = host === SOURCE_ALIAS ? SOURCE : TARGET;
    if (fault === 'old-host-loss' && host === SOURCE_ALIAS && command.startsWith('elanous hq fence --role cron --')
      && parseLease(store.read().raw)?.holder === TARGET) return { status: 255, stdout: '', stderr: 'injected old host loss' };
    if (command.includes('python3 -')) return { status: 0, stdout: `${name}\n`, stderr: '' };
    if (command.includes('fence-audit --json')) return { status: 0, stdout: `${cron}---HQ-AUDIT---\n[]\n`, stderr: '' };
    if (command.startsWith('elanous hq fence --role cron --')) {
      const decision = hqFenceDecision('cron', host === SOURCE_ALIAS ? sourceDeps : targetDeps);
      return decision.run
        ? { status: 0, stdout: `HQ_FENCE_ALLOWED:${decision.generation}`, stderr: '' }
        : { status: 0, stdout: '', stderr: `hq fence: skip · ${decision.reason}` };
    }
    if (command.includes('lease release')) {
      const match = command.match(/--expected-holder '([^']+)' --expected-generation (\d+)/);
      if (!match) return { status: 2, stdout: '', stderr: 'missing lease expectation' };
      const result = hqLease('release', host === SOURCE_ALIAS ? sourceDeps : targetDeps,
        { expectedHolder: match[1], expectedGeneration: Number(match[2]) });
      return result.ok ? { status: 0, stdout: JSON.stringify(result), stderr: '' }
        : { status: 2, stdout: '', stderr: result.reason };
    }
    if (command.includes('lease acquire')) {
      const deps = host === SOURCE_ALIAS ? sourceDeps : targetDeps;
      const result = hqLease('acquire', deps, { host: deps.config.hostName });
      return result.ok ? { status: 0, stdout: JSON.stringify(result), stderr: '' }
        : { status: 2, stdout: '', stderr: result.reason };
    }
    return { status: 2, stdout: '', stderr: `unexpected simulated SSH command: ${command.slice(0, 80)}` };
  };
  const transfer = transferHq('promote', true, {
    store, run, confirm: () => true,
    promote: (host) => promoteHq(host, true, promotionRunner(store, fault, fixture, copied, runtime)),
    reallocatePools: (from, to) => fault === 'stale-pool' ? null : reallocatePoolsThroughRunner(from, to, (host, command) => {
      const match = command.match(/--from-host '([^']+)' --to-host '([^']+)'/);
      if (host !== to || !match) return { status: 2, stdout: '', stderr: 'pool reallocation command lost host arguments' };
      try {
        const reassigned = reassignResourcePools(match[1]!, match[2]!, new Date(runtime.clock.now()), targetResourceLedger);
        return { status: 0, stdout: JSON.stringify({ ok: true, reassigned }), stderr: '' };
      } catch (error) { return { status: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }; }
    }),
    journalDir: join(root, 'journal'),
  });
  const finalLease = parseLease(store.read().raw);
  const targetState = migrationState(fixture.targetHome);
  const stateMatches = JSON.stringify(targetState) === JSON.stringify(fixture.sourceState);
  const copiedSuccessfully = copied.ok && stateMatches;
  const activeLedger = finalLease?.holder === TARGET && existsSync(targetResourceLedger)
    ? targetResourceLedger : fixture.sourceResourceLedger;
  const capacity = machinePoolCapacity(activeResourcePools(readResourceLedger(activeLedger)));
  const sourceFence = hqFenceDecision('cron', sourceDeps);
  const targetFence = hqFenceDecision('cron', targetDeps);
  const observations: HqMoveObservation[] = [
    { event: 'move-plan', verdict: [plan.unfencedCron.status, plan.hostLoops.status, plan.targetHost.status, plan.nexusLaunchd.status].join('/') },
    { event: 'transfer', verdict: transfer.ok ? 'complete' : (transfer.steps.find(step => step.status === 'failed')?.step ?? transfer.steps.at(-1)?.step ?? 'failed') },
    { event: 'state-copy', verdict: copiedSuccessfully
      ? `verified:ledger=${targetState.ledger.length},worktree=${targetState.worktree.length},mail=${targetState.mail.length}`
      : `failed:ledger=${targetState.ledger.length},worktree=${targetState.worktree.length},mail=${targetState.mail.length}; ${transfer.steps.find((step) => step.step.includes('promotion ③ copy to promotion universe') && step.status === 'failed')?.measurement ?? 'no copy diagnostic'}` },
    { event: 'lease', verdict: `${finalLease?.holder ?? 'none'}@${finalLease?.generation ?? 'none'}` },
    { event: 'source-fence', verdict: sourceFence.run ? 'allowed' : 'retired' },
    { event: 'target-fence', verdict: targetFence.run ? 'allowed' : 'blocked' },
    { event: 'promotion-safety', verdict: !copiedSuccessfully && targetFence.run
      ? 'failure:new-owner-still-allowed-after-copy-failure' : 'safe:single-fenced-owner' },
    { event: 'pool-reallocation', verdict: Object.keys(capacity).join(',') },
    { event: 'old-host-ssh-commands', verdict: String(calls.filter((call) => call.host === SOURCE_ALIAS).length) },
    { event: 'fake-ssh-configured-hosts', verdict: [...new Set(runtime.ssh.calls.filter((call) => call.activeSessions !== null).map((call) => call.host))].sort().join(',') },
  ];
  const expectedFault = fault === 'target-unavailable' ? !transfer.ok && finalLease?.holder === SOURCE
    : fault === 'partial-copy' ? false
      : fault === 'old-host-loss' ? !transfer.ok && finalLease?.holder === TARGET && copiedSuccessfully
    : fault === 'stale-pool' ? !transfer.ok && finalLease?.holder === TARGET && SOURCE_ALIAS in capacity
          : transfer.ok && copiedSuccessfully && finalLease?.holder === TARGET && finalLease.generation === 8
            && !sourceFence.run && targetFence.run && !(SOURCE_ALIAS in capacity) && TARGET_ALIAS in capacity;
  return { pass: expectedFault, fault, observations,
    devices: [...new Set([...runtime.ssh.calls.map((call) => `fake-ssh:${call.host}`), 'fake-clock'])] };
}
