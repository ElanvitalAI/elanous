import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listSshHosts } from '../ssh/ssh-hosts.js';
import { recordHostReadinessHeartbeat, readResourceLedger, type HostReadinessHeartbeat, type ResourceLedgerEvent } from './resource-ledger.js';
export interface HostReadinessCommandResult { status: number | null; stdout: string; stderr: string }
export type HostReadinessCommandRunner = (command: string, args: string[], host: string) => HostReadinessCommandResult | Promise<HostReadinessCommandResult>;
export interface HostReadinessCollectorDeps {
  hosts(): Array<{ name: string; host: string; maintenance?: boolean }>;
  run: HostReadinessCommandRunner;
  events(): ResourceLedgerEvent[];
  record(heartbeat: HostReadinessHeartbeat): void;
  now(): Date;
}
const METRIC_TOOLS = [['bun', 'bun'], ['repoGit', 'git'], ['codex', 'codex'], ['pwsh', 'pwsh'], ['kubectl', 'kubectl']] as const;
const execFileAsync = promisify(execFile);
function quoteRemoteArgument(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }
const SSH_PROBE_TIMEOUT_MS = 15_000;
const REMOTE_PROBE_SCRIPT = [
  "printf '__UPTIME__\n'; uptime 2>&1",
  "printf '__CORES__\n'; getconf _NPROCESSORS_ONLN 2>&1",
  "printf '__FREE__\n'; free -b 2>&1",
  "printf '__VM_STAT__\n'; vm_stat 2>&1",
  "printf '__MEMSIZE__\n'; sysctl -n hw.memsize 2>&1",
  "printf '__DF_ROOT__\n'; df -P / 2>&1",
  "printf '__DF_TMP__\n'; df -P /tmp 2>&1",
  ...METRIC_TOOLS.map(([key, command]) => `printf '__TOOL_${key}__\n'; command -v ${command} 2>/dev/null || true`),
].join('; ');

export async function defaultHostReadinessRun(command: string, args: string[], host: string): Promise<HostReadinessCommandResult> {
  try {
    const result = await execFileAsync('ssh', [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=yes', host, [command, ...args].map(quoteRemoteArgument).join(' '),
    ], { encoding: 'utf8', timeout: SSH_PROBE_TIMEOUT_MS });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string };
    return { status: typeof failure.code === 'number' ? failure.code : null,
      stdout: String(failure.stdout ?? ''), stderr: String(failure.stderr ?? failure.message ?? '') };
  }
}

function section(text: string, key: string): string {
  const markerAt = text.indexOf(`__${key}__`);
  if (markerAt < 0) return '';
  const bodyAt = text.indexOf('\n', markerAt);
  if (bodyAt < 0) return '';
  const endAt = text.indexOf('\n__', bodyAt);
  return text.slice(bodyAt + 1, endAt < 0 ? undefined : endAt).trim();
}

function loadAverages(text: string): [number, number, number] | undefined {
  const match = /load averages?:?\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(text);
  if (!match) return undefined;
  const values = match.slice(1).map(Number);
  return values.every(Number.isFinite) ? values as [number, number, number] : undefined;
}
function linuxMemoryPercent(text: string): number | undefined {
  const line = text.split(/\r?\n/).find(row => /^Mem:\s/.test(row));
  if (!line) return undefined;
  const columns = line.trim().split(/\s+/).slice(1).map(Number);
  const total = columns[0], available = columns[5];
  return total > 0 && Number.isFinite(available) ? available / total * 100 : undefined;
}
function darwinMemoryPercent(vmStat: string, totalText: string): number | undefined {
  const pageSize = /page size of (\d+) bytes/i.exec(vmStat)?.[1];
  const total = Number(totalText.trim());
  if (!pageSize || !Number.isFinite(total) || total <= 0) return undefined;
  const pages = (name: string) => Number(new RegExp(`^Pages ${name}:\\s*(\\d+)`, 'mi').exec(vmStat)?.[1] ?? 0);
  // Darwin reports purgeable pages as a subset of inactive; adding both double-counts reclaimable memory.
  const available = ['free', 'inactive', 'speculative'].reduce((sum, name) => sum + pages(name), 0) * Number(pageSize);
  return available / total * 100;
}
function diskUsedPercent(text: string): number | undefined {
  const row = text.split(/\r?\n/).slice(1).find(line => line.trim().length > 0);
  if (!row) return undefined;
  const columns = row.trim().split(/\s+/);
  const used = Number(columns[4]?.replace('%', ''));
  return Number.isFinite(used) ? used : undefined;
}
function diskAvailableGb(text: string): number | undefined {
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  const header = lines[0]?.toLowerCase() ?? '';
  const row = lines[1];
  if (!row) return undefined;
  // Darwin df uses 512-byte blocks; Linux df -P uses 1024-byte blocks.
  const blockBytes = header.includes('512-blocks') ? 512 : 1024;
  const availableBlocks = Number(row.trim().split(/\s+/)[3]);
  return Number.isFinite(availableBlocks) && availableBlocks >= 0
    ? availableBlocks * blockBytes / (1024 * 1024 * 1024)
    : undefined;
}

async function measure(host: string, run: HostReadinessCommandRunner): Promise<Omit<HostReadinessHeartbeat, 'host' | 'at' | 'maintenance' | 'gateProtected'>> {
  const probe = await run('sh', ['-c', REMOTE_PROBE_SCRIPT], host);
  if (probe.status !== 0) return { sshAvailable: false, tools: Object.fromEntries(METRIC_TOOLS.map(([key]) => [key, false])) };
  const loads = loadAverages(section(probe.stdout, 'UPTIME'));
  const cores = Number(section(probe.stdout, 'CORES'));
  const memoryAvailablePercent = linuxMemoryPercent(section(probe.stdout, 'FREE'))
    ?? darwinMemoryPercent(section(probe.stdout, 'VM_STAT'), section(probe.stdout, 'MEMSIZE'));
  const rootDiskUsedPercent = diskUsedPercent(section(probe.stdout, 'DF_ROOT'));
  const tmpDiskUsedPercent = diskUsedPercent(section(probe.stdout, 'DF_TMP'));
  const rootDiskFreeGb = diskAvailableGb(section(probe.stdout, 'DF_ROOT'));
  const tmpDiskFreeGb = diskAvailableGb(section(probe.stdout, 'DF_TMP'));
  const tools = Object.fromEntries(METRIC_TOOLS.map(([key]) => [key, section(probe.stdout, `TOOL_${key}`).length > 0]));
  const sample = loads && Number.isFinite(cores) && cores > 0 && memoryAvailablePercent !== undefined
    && rootDiskUsedPercent !== undefined && tmpDiskUsedPercent !== undefined
    && rootDiskFreeGb !== undefined && tmpDiskFreeGb !== undefined
    ? { loadPercent: loads[0] / cores * 100, load15Percent: loads[2] / cores * 100,
        memoryAvailablePercent, rootDiskUsedPercent, tmpDiskUsedPercent, rootDiskFreeGb, tmpDiskFreeGb }
    : undefined;
  return { sshAvailable: true, tools, ...(sample ? { sample } : {}) };
}

/** Probe every configured host in one wave (each SSH call has a 15s cap); aws1 stays visible but never becomes a placement candidate. */
export async function collectHostReadinessTick(deps: HostReadinessCollectorDeps): Promise<{ observed: number; unmeasured: string[] }> {
  const previous = new Map<string, HostReadinessHeartbeat>();
  for (const event of deps.events()) if (event.event === 'host-readiness-heartbeat') {
    const prior = previous.get(event.heartbeat.host);
    if (!prior || Date.parse(event.heartbeat.at) >= Date.parse(prior.at)) previous.set(event.heartbeat.host, event.heartbeat);
  }
  const hosts = deps.hosts();
  const unmeasured: string[] = hosts.length === 0 ? ['host-inventory-empty'] : [];
  const now = deps.now().toISOString();
  const results = await Promise.all(hosts.map(async host => {
    try { return await measure(host.host, deps.run); }
    catch { return { sshAvailable: false, tools: Object.fromEntries(METRIC_TOOLS.map(([key]) => [key, false])) }; }
  }));
  hosts.forEach((host, index) => {
    const result = results[index]!, prior = previous.get(host.name);
    const successful = result.sshAvailable && result.sample !== undefined;
    deps.record({ host: host.name, at: now,
      ...(!successful ? { freshnessAt: prior && !prior.sample ? prior.freshnessAt ?? prior.at : now } : {}),
      sshAvailable: result.sshAvailable, maintenance: host.maintenance ?? false,
      gateProtected: host.name.toLowerCase() === 'aws1', tools: result.tools,
      ...(successful ? { sample: result.sample } : {}) });
    if (!successful) unmeasured.push(host.name);
  });
  return { observed: hosts.length, unmeasured };
}
export async function runHostReadinessCollector(): Promise<Awaited<ReturnType<typeof collectHostReadinessTick>>> {
  return collectHostReadinessTick({ hosts: () => listSshHosts().map(host => ({ name: host.name, host: host.host })),
    run: defaultHostReadinessRun, events: () => readResourceLedger(),
    record: heartbeat => recordHostReadinessHeartbeat(heartbeat), now: () => new Date() });
}
if (import.meta.main) {
  try {
    const result = await runHostReadinessCollector();
    console.log(JSON.stringify({ outcome: result.unmeasured.length ? 'partial' : 'ok', ...result }));
  } catch (error) {
    console.error(`host readiness collector: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
