import type { Command } from 'commander';
import { desiredSha as readDesiredSha } from '../nexus/host-registry/desired-sha.js';
import { classifyHost, DEFAULT_STALE_MS } from '../nexus/host-registry/classify.js';
import { hostLedgerPath, isHostRecord, readHostLedger, recordHeartbeat } from '../nexus/host-registry/store.js';
import { heartbeatQueuePath, sendHostHeartbeatCentral, type HostHeartbeatEntry } from '../nexus/host-registry/heartbeat-http.js';
import { localNexusBaseUrl } from '../nexus/local-endpoint.js';
import type { HostChannel, HostLedger } from '../nexus/host-registry/types.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface HostsCliDeps {
  readLedger?: () => HostLedger | undefined;
  desired?: () => string | undefined;
  now?: () => number;
  ledgerPath?: () => string;
  write?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  nexusUrl?: (env: NodeJS.ProcessEnv) => string | undefined;
  queuePath?: () => string;
  sendCentral?: typeof sendHostHeartbeatCentral;
  utilSnapshot?: () => { text: string; path: string; modifiedAt: number } | undefined;
  startVm?: (host: string) => Promise<void>;
  probeVm?: (host: string) => Promise<VmProbe>;
}

export interface VmProbe { installedSha: string; load: number; cpus: number; pods: number; reviewUsed: number; reviewCapacity: number }

const startableHosts = new Set(['aws1', 'aws2', 'aws3', 'gcp1', 'gcp2', 'gcp3']);
const execFileAsync = promisify(execFile);
async function startCloudVm(host: string): Promise<void> {
  const command = join(homedir(), 'elanous-hq', 'seat-state', 'OP', 'tools', 'cloud-vm.sh');
  await execFileAsync(command, ['start', host, '--apply', '--reason', 'hosts start', '--source', 'hosts-cli'], { timeout: 20 * 60_000 });
}

// One SSH connection runs only read probes and nonblocking tests of existing review locks.
// Pregate's heavy stages use the review lock class; this is not the Pod pool capacity.
const VM_PROBE = `import os,sys,json,subprocess,pathlib,fcntl,re
def run(cmd):
 p=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=15)
 if p.returncode: raise RuntimeError('probe failed: '+cmd[0])
 return p.stdout
version=run([str(pathlib.Path.home()/'.local/share/elanous/bin/eln'),'--version'])
sha=re.findall(r'\\b[0-9a-fA-F]{40}\\b',version)
if len(sha)!=1: raise RuntimeError('installed SHA unavailable')
pods=json.loads(run(['kubectl','get','pods','-A','--field-selector','status.phase=Running','-o','json']))
if not isinstance(pods.get('items'),list): raise RuntimeError('invalid pod response')
home=pathlib.Path.home(); cap=int((home/'elanous-hq/seat-state/K-EAST/tools/heavy-slot-review-cap.txt').read_text().strip())
if cap<1 or cap>16: raise RuntimeError('invalid review slot capacity')
base=home/'.cache/elanous-heavy-slot-review'
if not base.is_dir(): raise RuntimeError('review slot state unavailable')
used=0
for i in range(cap):
 p=base/('slot-%d.lock'%i)
 if not p.exists(): continue
 with p.open('r') as f:
  try: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB); fcntl.flock(f,fcntl.LOCK_UN)
  except BlockingIOError: used+=1
print(json.dumps(dict(installedSha=sha[0],load=os.getloadavg()[0],cpus=os.cpu_count(),pods=len(pods['items']),reviewUsed=used,reviewCapacity=cap)))`;

async function probeCloudVm(host: string): Promise<VmProbe> {
  const encoded = Buffer.from(VM_PROBE).toString('base64');
  const remoteCommand = `python3 -c 'exec(__import__("base64").b64decode("${encoded}"))'`;
  const { stdout } = await execFileAsync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', host, remoteCommand], { timeout: 60_000 });
  return JSON.parse(stdout) as VmProbe;
}

export function validVmProbe(probe: VmProbe, desired: string | undefined): boolean {
  return !!desired && /^[a-f0-9]{40}$/i.test(desired) && probe.installedSha?.toLowerCase() === desired.toLowerCase()
    && Number.isFinite(probe.load) && probe.load >= 0 && Number.isSafeInteger(probe.cpus) && probe.cpus > 0
    && Number.isSafeInteger(probe.pods) && probe.pods >= 0 && Number.isSafeInteger(probe.reviewUsed)
    && Number.isSafeInteger(probe.reviewCapacity) && probe.reviewCapacity > 0 && probe.reviewUsed >= 0 && probe.reviewUsed <= probe.reviewCapacity;
}

/** The collector owns measurement; absence or stale observations never become zero. */
export function renderUtilSnapshot(snapshot: { text: string; path: string; modifiedAt: number } | undefined, now: number): string {
  if (!snapshot) return 'unmeasured · UTIL snapshot unavailable';
  const [head, ...lines] = snapshot.text.trimEnd().split(/\r?\n/);
  const columns = head?.split('\t') ?? [];
  const wanted = ['host', 'load1', 'ncpu', 'running_pods', 'review_slots_used_cap'];
  const indexes = wanted.map(name => columns.indexOf(name));
  const podStatusIndex = columns.indexOf('pod_probe_status');
  if (indexes.some(i => i < 0)) return `unmeasured · invalid UTIL columns · ${snapshot.path}`;
  const ageMs = Math.max(0, now - snapshot.modifiedAt);
  const rows = lines.filter(Boolean).map(line => line.split('\t'))
    .filter(fields => fields.length === columns.length)
    .map(fields => indexes.map((i, n) => n === 3 && (podStatusIndex < 0 || fields[podStatusIndex] !== 'ok')
      ? 'unmeasured' : fields[i] || 'unmeasured').join('\t'));
  return [`UTIL snapshot=${snapshot.path} age=${age(ageMs)} (snapshot, not live)`, 'HOST\tLOAD1\tNCPU\tPODS\tREVIEW_SLOTS', ...rows].join('\n');
}

function latestUtilSnapshot(): { text: string; path: string; modifiedAt: number } | undefined {
  const dir = join(homedir(), 'elanous-hq', 'seat-state', 'K-EAST');
  try {
    const files = readdirSync(dir).filter(name => /^UTIL-\d{4}\.tsv$/.test(name)).map(name => {
      const path = join(dir, name); return { path, modifiedAt: statSync(path).mtimeMs };
    }).sort((a, b) => b.modifiedAt - a.modifiedAt);
    const latest = files[0];
    return latest ? { ...latest, text: readFileSync(latest.path, 'utf8') } : undefined;
  } catch { return undefined; }
}

function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

export function renderHostsList(ledger: HostLedger | undefined, desired: string | undefined, now: number, json = false): string {
  if (!ledger) return json ? JSON.stringify({ outcome: 'unmeasured', hosts: [] }) : 'unmeasured · 호스트 원장 없음';
  const rows = Object.values(ledger.hosts).filter(isHostRecord).sort((a, b) => a.host.localeCompare(b.host)).map((r) => ({
    host: r.host, seat: r.seat ?? null, channel: r.channel, installed: r.installedSha, desired: desired ?? null,
    state: classifyHost(r, desired, now, DEFAULT_STALE_MS), heartbeatAgeMs: now - r.lastHeartbeatMs,
  }));
  if (json) return JSON.stringify({ outcome: 'measured', hosts: rows });
  const short = (s: string | null): string => (s ? s.slice(0, 10) : '-');
  const lines = [['HOST', 'SEAT', 'INSTALLED', 'DESIRED', 'STATE', 'HEARTBEAT'].join('\t')];
  for (const r of rows) lines.push([r.host, r.seat ?? '-', short(r.installed), short(r.desired), r.state === 'behind' ? 'behind !' : r.state, age(r.heartbeatAgeMs)].join('\t'));
  return lines.join('\n');
}

export function registerHostsCommands(program: Command, deps: HostsCliDeps = {}): void {
  const hosts = program.command('hosts').description('원격 호스트 설치본(installedSha) 원장');
  hosts.command('util').description('최근 UTIL 수집본의 호스트 부하·Pod·리뷰 슬롯 (수집 시각 표시)')
    .action(() => (deps.write ?? console.log)(renderUtilSnapshot((deps.utilSnapshot ?? latestUtilSnapshot)(), (deps.now ?? Date.now)())));
  hosts.command('start <host>').description('지정 클라우드 VM을 비용 원장 경유로 기동하고 관측된 READY를 표시')
    .action(async (host: string) => {
      const write = deps.write ?? console.log;
      if (!startableHosts.has(host)) { write(`start refused · unknown VM ${host}`); process.exitCode = 1; return; }
      // GUARDIAN-FINDINGS-VISIBLE: the operator's start is the actual decision — pair it with the guardian's «would».
      if (!deps.startVm) {
        const { autoRecordDecision } = await import('../res-policy/auto-record.js');
        await autoRecordDecision('vm-start', host, 'allow', 'hosts-cli', { ref: 'hosts start' });
      }
      try { await (deps.startVm ?? startCloudVm)(host); }
      catch (error) { write(`start failed · ${host} · ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; return; }
      try {
        const probe = await (deps.probeVm ?? probeCloudVm)(host);
        const ready = validVmProbe(probe, (deps.desired ?? (() => readDesiredSha()))());
        write('HOST\tSTATE\tLOAD1\tNCPU\tRUNNING_PODS\tPREGATE_REVIEW_SLOTS');
        write(`${host}\t${ready ? 'READY' : 'READY UNMEASURED'}\t${probe.load}\t${probe.cpus}\t${probe.pods}\t${probe.reviewUsed}/${probe.reviewCapacity}`);
      } catch { write(`${host}\tSTARTED · READY UNMEASURED · live probe failed`); }
    });
  hosts.command('list')
    .description('호스트별 설치본·목표(desiredSha)·상태·하트비트 나이')
    .option('--json', '구조화 출력')
    .action((opts: { json?: boolean }) => {
      const write = deps.write ?? ((line: string) => console.log(line));
      write(renderHostsList((deps.readLedger ?? (() => readHostLedger()))(), (deps.desired ?? (() => readDesiredSha()))(), (deps.now ?? Date.now)(), opts.json));
    });
  hosts.command('heartbeat')
    .description('호스트가 자기 설치본(installedSha)을 원장에 보고 (원장 갱신 생산 경로 · --url/--machine-token 지정 시 중앙 Nexus 전송)')
    .requiredOption('--host <name>', '호스트 이름')
    .requiredOption('--installed-sha <sha>', '설치본 40-hex sha')
    .option('--seat <seat>', '자리')
    .option('--channel <channel>', 'dev | release (생략하면 이전 값 유지, 없으면 unknown)')
    .option('--url <url>', '중앙 Nexus base URL (기본: ELANOUS_NEXUS_URL 또는 실행 중인 로컬 Nexus)')
    .option('--machine-token <token>', '중앙 전송용 기계 토큰 (기본: ELANOUS_NEXUS_MACHINE_TOKEN)')
    .action(async (opts: { host: string; installedSha: string; seat?: string; channel?: string; url?: string; machineToken?: string }) => {
      const write = deps.write ?? ((line: string) => console.log(line));
      if (opts.channel !== undefined && opts.channel !== 'dev' && opts.channel !== 'release') {
        write(`--channel 은 dev | release 만: ${opts.channel}`);
        process.exitCode = 1;
        return;
      }
      const path = (deps.ledgerPath ?? hostLedgerPath)();
      const nowMs = (deps.now ?? Date.now)();
      try {
        const r = recordHeartbeat(opts.host, opts.installedSha, nowMs, {
          path, seat: opts.seat, channel: opts.channel as HostChannel | undefined, desiredSha: (deps.desired ?? (() => readDesiredSha()))(),
        });
        write(`${r.host}\t${r.channel}\t${r.installedSha.slice(0, 10)}\t${r.state}`);
      } catch (e) {
        write(`heartbeat 실패 · 원장 보존: ${(e as Error).message}`);
        process.exitCode = 1;
        return;
      }
      // Central send is opt-in: unconfigured stays local-only and silent; partial config prints a notice.
      const env = deps.env ?? process.env;
      const baseUrl = opts.url ?? (deps.nexusUrl ?? localNexusBaseUrl)(env);
      const bearerToken = opts.machineToken ?? env.ELANOUS_NEXUS_MACHINE_TOKEN?.trim();
      if (Boolean(baseUrl) !== Boolean(bearerToken)) {
        write(baseUrl
          ? 'central 미전송 · 기계 토큰 미구성 (--machine-token 또는 ELANOUS_NEXUS_MACHINE_TOKEN)'
          : 'central 미전송 · Nexus base URL 미구성 (--url 또는 ELANOUS_NEXUS_URL)');
        return;
      }
      if (!baseUrl) return;
      const entry: HostHeartbeatEntry = {
        host: opts.host, installedSha: opts.installedSha,
        ...(opts.seat ? { seat: opts.seat } : {}),
        ...(opts.channel ? { channel: opts.channel as HostChannel } : {}),
        at: new Date(nowMs).toISOString(),
      };
      const outcome = await (deps.sendCentral ?? sendHostHeartbeatCentral)(entry, {
        baseUrl, bearerToken, queuePath: (deps.queuePath ?? heartbeatQueuePath)(),
      });
      if (outcome.outcome === 'sent') {
        write(`central-sent\t${outcome.host}\t${outcome.state}`);
        if (outcome.drained.sent || outcome.drained.kept)
          write(`central-queue\t재전송 ${outcome.drained.sent} · 보류 ${outcome.drained.kept}`);
      } else if (outcome.outcome === 'queued') {
        write(`central-send 실패(${outcome.reason}) · 로컬 큐 적체 ${outcome.queued}`);
      }
    });
}
