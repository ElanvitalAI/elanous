import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { readNexusRuntime } from '../nexus/runtime.js';
import { ensureAuthToken } from '../auth/acp-token.js';
import { parseMachinePoolDeclarations, type MachinePoolDeclaration } from '../resource-ledger/machine-pool-inventory.js';
import { assertResourceLedgerUrl } from '../../scripts/resource-ledger-url.js';
import type { Command } from 'commander';
import { getUserConfig } from '../user-config.js';
import { parsePodPool, resolvePodPoolSpec } from '../task-orchestrator/surfaces/pod-pool.js';
import { activeResourceLeases, parseResourceLedgerEvents, readResourceLedger, reconcileResourceLeases, reassignResourcePools, resourceLedgerPath, resourceMatrix,
  RESOURCE_LANES, type ResourceLane, type ResourceMeasurement } from '../resource-ledger/resource-ledger.js';

export interface ResourceCommandRunner { (command: string, args: string[], host?: string): { status: number | null; stdout: string; stderr: string } }
export interface ResourceLedgerCliDeps {
  events?: () => ReturnType<typeof readResourceLedger>;
  hosts?: () => Array<{ host: string; context?: string; poolMapped?: boolean; stateDir?: string; capacity?: Partial<Record<ResourceLane, number>> }>;
  run?: ResourceCommandRunner;
  now?: () => Date;
}

export function defaultResourceHosts(): Array<{ host: string; context?: string; poolMapped?: boolean; stateDir?: string; capacity?: Partial<Record<ResourceLane, number>> }> {
  const config = getUserConfig();
  const gateRemote = config.gateRemote;
  const gateHost = gateRemote?.host ?? 'node-b';
  const gateCapacity = (host: string) => gateRemote?.hostCaps?.[host] ?? gateRemote?.hostCap ?? 2;
  const rawParent = config.taskAgent?.parentHost;
  const parents = Array.isArray(rawParent) ? rawParent : rawParent ? [rawParent] : [];
  const hosts = new Map<string, { host: string; context?: string; poolMapped?: boolean; stateDir?: string; capacity: Partial<Record<ResourceLane, number>> }>();
  for (const entry of parents) if (entry.host) hosts.set(entry.host, { host: entry.host, poolMapped: false,
    stateDir: entry.configDir ?? '$HOME/.elanous',
    capacity: { ta: entry.approvalCapacity ?? 1, ...(entry.host === gateHost ? { gate: gateCapacity(entry.host), train: gateCapacity(entry.host) } : {}) } });
  if (!hosts.has(gateHost)) hosts.set(gateHost, { host: gateHost, poolMapped: true,
    capacity: { gate: gateCapacity(gateHost), train: gateCapacity(gateHost) } });
  const pool = resolvePodPoolSpec(undefined, process.env, () => {
    const h = config.harness;
    return h && typeof h === 'object' && 'podPool' in h ? String((h as { podPool?: unknown }).podPool ?? '') : undefined;
  });
  if (pool) for (const member of parsePodPool(pool)) {
    const host = member.sshHost ?? 'unknown';
    const current = hosts.get(host) ?? { host, capacity: {} };
    current.context = member.sshHost ? member.context : undefined;
    current.poolMapped = Boolean(member.sshHost);
    current.capacity = { ...current.capacity, gate: gateCapacity(host), train: gateCapacity(host) };
    hosts.set(host, current);
  }
  return [...hosts.values()];
}

export function defaultResourceRun(command: string, args: string[], host?: string): { status: number | null; stdout: string; stderr: string } {
  if (!host) return spawnSync(command, args, { encoding: 'utf8', timeout: 15_000 });
  return spawnSync('ssh', ['-o', 'ControlMaster=no', '-o', 'ControlPath=none', host, command, ...args], { encoding: 'utf8', timeout: 20_000 });
}

function parsePods(stdout: string): ResourceMeasurement['pods'] {
  const body: unknown = JSON.parse(stdout);
  if (!body || typeof body !== 'object' || !Array.isArray((body as { items?: unknown }).items)) throw new Error('kubectl response missing items');
  return ((body as { items: unknown[] }).items).map((value, index) => {
    if (!value || typeof value !== 'object') throw new Error(`kubectl pod ${index} malformed`);
    const pod = value as { metadata?: { namespace?: string; name?: string; labels?: Record<string, string>; annotations?: Record<string, string> }; status?: { phase?: string }; spec?: { nodeName?: string; containers?: Array<{ resources?: { requests?: { cpu?: string; memory?: string } } }> } };
    const labels = pod.metadata?.labels ?? {};
    const annotations = pod.metadata?.annotations ?? {};
    const containers = pod.spec?.containers ?? [];
    const cpu = containers.reduce((sum, container) => sum + parseCpu(container.resources?.requests?.cpu), 0);
    const memoryValues = containers.map(container => parseMemory(container.resources?.requests?.memory));
    const memory = memoryValues.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    return { id: `${pod.metadata?.namespace ?? 'unknown'}/${pod.metadata?.name ?? index}`,
      ...(labels['elanous.ai/fp'] || annotations['elanous.ai/fp'] ? { fp: labels['elanous.ai/fp'] ?? annotations['elanous.ai/fp'] } : {}),
      ...(labels['elanous.ai/lane'] ? { lane: labels['elanous.ai/lane'] } : {}),
      ...(labels['elanous.ai/cell'] || labels['elanous.ai/goal'] ? { mission: labels['elanous.ai/cell'] ?? labels['elanous.ai/goal'] } : {}),
      ...(pod.spec?.nodeName ? { nodeName: pod.spec.nodeName } : {}),
      managed: labels['elanous.substrate'] === 'pod' || Boolean(labels['elanous.job'] || labels['elanous.run'] || labels['elanous.ai/fp'] || annotations['elanous.ai/fp']),
      phase: pod.status?.phase ?? 'unknown', ...(cpu ? { cpu } : {}), ...(memory ? { memoryBytes: memory } : {}),
      ...(memoryValues.some(value => value === undefined) ? { memoryUnknown: true } : {}) };
  });
}

function parseMemory(value?: string): number | undefined {
  if (!value) return 0;
  const match = /^\+?((?:\d+(?:\.\d*)?|\.\d+))(Ei|Pi|Ti|Gi|Mi|Ki|k|K|M|G|T|P|E|m|u|n|[eE][+-]?\d+)?$/.exec(value);
  if (!match) return undefined;
  const multiplier = ({ Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6,
    k: 1000, K: 1000, M: 1000 ** 2, G: 1000 ** 3, T: 1000 ** 4, P: 1000 ** 5, E: 1000 ** 6,
    m: 1e-3, u: 1e-6, n: 1e-9 } as Record<string, number>)[match[2] ?? '']
    ?? (/^[eE]/.test(match[2] ?? '') ? 10 ** Number((match[2] ?? '').slice(1)) : 1);
  return Number(match[1]) * multiplier;
}

function parseCpu(value?: string): number {
  if (!value) return 0;
  const milli = /^(\d+(?:\.\d+)?)m$/.exec(value);
  if (milli) return Number(milli[1]) / 1000;
  const cpu = Number(value);
  return Number.isFinite(cpu) && cpu >= 0 ? cpu : 0;
}

function parseProcesses(stdout: string): ResourceMeasurement['processes'] {
  return stdout.split(/\r?\n/).filter(Boolean).flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match || !/(?:elanous|harness|self-gate|train-batch)/i.test(match[3]!)) return [];
    const fp = /(?:^|\s)(fp_[A-Za-z0-9_-]{6,128})(?:\s|$)/.exec(match[3]!)?.[1];
    return [{ id: `pid:${match[1]}`, ...(fp ? { fp } : {}), command: 'managed-process' }];
  });
}

export function collectResourceMeasurement(host: string, context: string | undefined, run: ResourceCommandRunner = defaultResourceRun,
  now = new Date(), sharedContext = false, poolMapped = true): ResourceMeasurement {
  const pods = !poolMapped ? { status: 1, stdout: '', stderr: 'host mapping unavailable: podPool must declare pool-X@host' }
    : sharedContext ? { status: 1, stdout: '', stderr: 'shared kube context cannot attribute Pods to one host' }
    : run('kubectl', [...(context ? ['--context', context] : []), 'get', 'pods', '-A', '-o', 'json'], context ? undefined : host);
  const processes = host === 'unknown' ? { status: 1, stdout: '', stderr: 'host mapping unavailable' }
    : run('ps', ['-eo', 'pid=,ppid=,args='], host);
  const errors: string[] = [];
  let podRows: ResourceMeasurement['pods'] = [];
  let processRows: ResourceMeasurement['processes'] = [];
  if (pods.status !== 0) errors.push(`kubectl: ${(pods.stderr ?? '').trim() || `exit ${pods.status ?? 'unknown'}`}`);
  else try {
    podRows = parsePods(pods.stdout);
    const nodes = run('kubectl', [...(context ? ['--context', context] : []), 'get', 'nodes', '-o', 'json'], context ? undefined : host);
    if (nodes.status !== 0) {
      errors.push(`kubectl nodes: ${(nodes.stderr ?? '').trim() || `exit ${nodes.status ?? 'unknown'}`}`);
      podRows = podRows.map(pod => ({ ...pod, host: 'unknown', managed: false }));
    } else {
      const nodeBody: unknown = JSON.parse(nodes.stdout);
      const nodeItems = nodeBody && typeof nodeBody === 'object' && Array.isArray((nodeBody as { items?: unknown }).items)
        ? (nodeBody as { items: Array<{ metadata?: { name?: string } }> }).items : [];
      const nodeNames = new Set(nodeItems.map(node => node.metadata?.name).filter((name): name is string => Boolean(name)));
      if (nodeNames.size !== 1) {
        errors.push(`kubectl nodes: ${nodeNames.size === 0 ? 'node inventory unavailable' : `context spans ${nodeNames.size} nodes; host=unknown`}`);
        podRows = podRows.map(pod => ({ ...pod, host: 'unknown', managed: false }));
      } else {
        const [onlyNode] = nodeNames;
        const unmapped = podRows.filter(pod => pod.nodeName !== onlyNode);
        if (unmapped.length) errors.push(`kubectl pods: ${unmapped.length} Pod(s) lack node mapping; host=unknown`);
        const unmappedIds = new Set(unmapped.map(pod => pod.id));
        podRows = podRows.map(pod => unmappedIds.has(pod.id)
          ? { ...pod, host: 'unknown', managed: false }
          : { ...pod, host });
      }
    }
    if (podRows.some(pod => pod.memoryUnknown)) errors.push('kubectl: unsupported memory quantity preserved as unknown');
  } catch (error) { errors.push(`kubectl: ${error instanceof Error ? error.message : String(error)}`); }
  if (processes.status !== 0) errors.push(`ps: ${(processes.stderr ?? '').trim() || `exit ${processes.status ?? 'unknown'}`}`);
  else processRows = parseProcesses(processes.stdout);
  return { host, observedAt: now.toISOString(), pods: podRows, processes: processRows, errors };
}

export function buildResourceLedgerSnapshot(deps: Required<Pick<ResourceLedgerCliDeps, 'events' | 'hosts' | 'run' | 'now'>>,
  filters: { host?: string; lane?: ResourceLane; mission?: string } = {}) {
  const hosts = deps.hosts();
  const events = [...deps.events()];
  const remoteLedgerErrors: Array<{ host: string; detail: string }> = [];
  for (const host of hosts) {
    if (!host.stateDir || (filters.host && filters.host !== host.host)) continue;
    if (!/^(?:\$HOME|~)?\/[A-Za-z0-9_./-]+$/.test(host.stateDir)
      || host.stateDir.split('/').includes('..')) {
      remoteLedgerErrors.push({ host: host.host, detail: 'remote resource ledger path is not shell-safe' });
      continue;
    }
    const ledgerFile = `${host.stateDir.replace(/\/$/, '')}/resource-ledger/events.jsonl`;
    const result = deps.run('cat', [ledgerFile], host.host);
    if (result.status === 0) {
      try { events.push(...parseResourceLedgerEvents(result.stdout)); }
      catch (error) { remoteLedgerErrors.push({ host: host.host, detail: error instanceof Error ? error.message : String(error) }); }
    } else if (!/No such file or directory/i.test(result.stderr)) {
      remoteLedgerErrors.push({ host: host.host, detail: `remote resource ledger unavailable: ${(result.stderr || `exit ${result.status ?? 'unknown'}`).trim()}` });
    }
  }
  const leases = activeResourceLeases(events);
  const leaseById = new Map(events.flatMap(event => event.event === 'lease-created' ? [[event.lease.id, event.lease] as const] : []));
  const recentReclaims = events.flatMap(event => {
    if (event.event !== 'lease-ended' && event.event !== 'lease-reaped') return [];
    const lease = leaseById.get(event.id);
    if (!lease || (filters.host && lease.host !== filters.host) || (filters.lane && lease.lane !== filters.lane)
      || (filters.mission && lease.mission.cell !== filters.mission && lease.mission.goalId !== filters.mission
        && (lease.mission.pr === undefined || String(lease.mission.pr) !== filters.mission))) return [];
    return [{ id: event.id, fp: lease.fp, host: lease.host, lane: lease.lane, at: event.at,
      kind: event.event, reason: event.reason, stoppedBy: event.event === 'lease-reaped' ? 'guardian-reconcile' : event.stoppedBy }];
  }).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 20);
  for (const lease of leases) if (!hosts.some(row => row.host === lease.host)) hosts.push({ host: lease.host, poolMapped: true });
  const selectedHosts = hosts.filter(row => !filters.host || row.host === filters.host);
  const contextCounts = new Map<string, number>();
  for (const host of hosts) if (host.context) contextCounts.set(host.context, (contextCounts.get(host.context) ?? 0) + 1);
  const measurements = selectedHosts.map(host => collectResourceMeasurement(host.host, host.context, deps.run, deps.now(),
    Boolean(host.context && (contextCounts.get(host.context) ?? 0) > 1), host.poolMapped ?? Boolean(host.context)));
  const selectedLeases = leases.filter(lease => (!filters.host || lease.host === filters.host)
    && (!filters.lane || lease.lane === filters.lane)
    && (!filters.mission || lease.mission.cell === filters.mission || lease.mission.goalId === filters.mission
      || (lease.mission.pr !== undefined && String(lease.mission.pr) === filters.mission)));
  const selectedMeasurements = measurements.filter(row => !filters.host || row.host === filters.host);
  const selectedFps = new Set(selectedLeases.map(lease => lease.fp));
  const scopedMeasurements = selectedMeasurements.map(measurement => ({ ...measurement,
    pods: measurement.pods.flatMap(pod => {
      const laneKnownMismatch = Boolean(filters.lane && pod.lane !== undefined && pod.lane !== filters.lane);
      const missionKnownMismatch = Boolean(filters.mission && pod.mission !== undefined && pod.mission !== filters.mission);
      if (laneKnownMismatch || missionKnownMismatch) return [];
      const scopeUnknown = Boolean((filters.lane && pod.lane === undefined) || (filters.mission && pod.mission === undefined));
      return [{ ...pod, ...(scopeUnknown ? { scopeUnknown: true, managed: false } : {}) }];
    }),
    processes: measurement.processes.filter(process => (!filters.lane && !filters.mission)
      || !process.fp || selectedFps.has(process.fp)),
  }));
  const matrix = resourceMatrix({ hosts: selectedHosts, leases: selectedLeases, measurements: scopedMeasurements })
    .filter(row => !filters.lane || row.lane === filters.lane);
  const findings = [...reconcileResourceLeases({ leases: selectedLeases, measurements: scopedMeasurements, now: deps.now() }),
    ...remoteLedgerErrors.map(error => ({ kind: 'measurement-unavailable' as const, host: error.host, id: `${error.host}:resource-ledger`, detail: error.detail, action: 'report-only' as const }))];
  return { ledgerPath: resourceLedgerPath(), observedAt: deps.now().toISOString(), readStatus: 'ok' as const, matrix, leases: selectedLeases, recentReclaims, measurements: selectedMeasurements, findings };
}

export async function postResourcePoolDeclaration(pool: MachinePoolDeclaration, options: {
  baseUrl: string; bearerToken: string; fetch?: typeof fetch;
}): Promise<boolean> {
  if (!options.bearerToken) throw new Error('owner bearer unavailable');
  let endpoint: URL;
  try {
    const base = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash)
      throw new Error();
    endpoint = new URL('/v1/resource-ledger/pools', base);
    assertResourceLedgerUrl(endpoint.toString());
  } catch { throw new Error('invalid Nexus base URL'); }
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(endpoint, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + options.bearerToken, 'content-type': 'application/json' },
      body: JSON.stringify({ pool }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { throw new Error('resource pool declaration endpoint unavailable'); }
  if (response.status === 201) return true;
  if (response.status === 200) return false;
  throw new Error('resource pool declaration rejected (HTTP ' + response.status + ')');
}

export function registerResourceLedgerCommands(resources: Command, overrides: ResourceLedgerCliDeps = {}): void {
  const deps = { events: overrides.events ?? readResourceLedger, hosts: overrides.hosts ?? defaultResourceHosts,
    run: overrides.run ?? defaultResourceRun, now: overrides.now ?? (() => new Date()) };
  resources.command('declare-pool').description('owner-auth Nexus 원장에 기계 풀 선언을 추가 (YAML/JSON pools 입력)')
    .requiredOption('--file <path>', 'pools 배열이 있는 YAML/JSON 선언 파일')
    .option('--url <url>', 'Nexus base URL (기본: ELANOUS_NEXUS_URL 또는 실행 중인 로컬 Nexus)')
    .option('--json', 'JSON 출력')
    .action(async (opts: { file: string; url?: string; json?: boolean }) => {
      try {
        const parsed = parse(readFileSync(opts.file, 'utf8')) as unknown;
        const pools = parseMachinePoolDeclarations(parsed);
        if (pools.length === 0) throw new Error('pool declarations are empty');
        const runtime = readNexusRuntime();
        const baseUrl = opts.url ?? process.env.ELANOUS_NEXUS_URL
          ?? (runtime?.httpPort ? 'http://127.0.0.1:' + runtime.httpPort : undefined);
        if (!baseUrl) throw new Error('Nexus URL unavailable');
        const bearerToken = ensureAuthToken().token;
        const results: Array<{ purpose: string; fanoutGroupId: string; created: boolean }> = [];
        for (const pool of pools) {
          const created = await postResourcePoolDeclaration(pool, { baseUrl, bearerToken });
          results.push({ purpose: pool.purpose, fanoutGroupId: pool.fanoutGroupId, created });
        }
        if (opts.json) console.log(JSON.stringify({ ok: true, declarations: results }));
        else console.log('resource pools declared=' + results.filter(row => row.created).length
          + ' existing=' + results.filter(row => !row.created).length);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        console.error('resource pool declaration failed: ' + message);
        process.exitCode = 1;
      }
    });
  resources.command('reassign-pools').description('현재 호스트의 활성 풀 선언을 이전 대상 호스트로 원장에 재지정')
    .requiredOption('--from-host <host>', '이전 호스트').requiredOption('--to-host <host>', '대상 호스트').option('--json', 'JSON 출력')
    .action((opts: { fromHost: string; toHost: string; json?: boolean }) => {
      try {
        const reassigned = reassignResourcePools(opts.fromHost, opts.toHost, deps.now());
        if (opts.json) console.log(JSON.stringify({ ok: true, reassigned }));
        else console.log(`resource pools reassigned=${reassigned} ${opts.fromHost}→${opts.toHost}`);
      } catch (error) { console.error(`resource pool reassignment failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
    });
  resources.command('ledger').description('실행 자원 임대 원장 호스트×차선 조회 (읽기 전용)')
    .option('--host <host>', '호스트 필터')
    .option('--lane <lane>', '차선 필터').option('--mission <mission>', '칸·골 id·PR 필터')
    .option('--json', 'JSON 출력')
    .action((opts: { host?: string; lane?: string; mission?: string; json?: boolean }) => {
      try {
        if (opts.lane && !RESOURCE_LANES.includes(opts.lane as ResourceLane)) { console.error(`알 수 없는 차선: ${opts.lane}`); process.exitCode = 2; return; }
        const result = buildResourceLedgerSnapshot(deps, { host: opts.host, lane: opts.lane as ResourceLane | undefined, mission: opts.mission });
        if (opts.json) console.log(JSON.stringify(result));
        else {
          console.log('호스트\t차선\t용량\t임대\t임대 CPU/메모리(B)\tPod 요청 CPU/메모리(B)\tPod 수\tFP 연계 프로세스\t미귀속 프로세스(unknown)\t임대−Pod');
          for (const row of result.matrix) console.log(`${row.host}\t${row.lane}\t${row.capacity ?? 'unknown'}\t${row.leases}\t${row.leasedCpu}/${row.leasedMemoryBytes}\t${row.observedPodCpuRequests ?? 'unknown'}/${row.observedPodMemoryRequestsBytes ?? 'unknown'}\t${row.measuredPods ?? 'unknown'}\t${row.measuredProcesses ?? 'unknown'}\t${row.unknownProcesses ?? 'unknown'}\t${row.deltaLeasesVsPods ?? 'unknown'}`);
          for (const finding of result.findings) console.log(`사건\t${finding.kind}\t${finding.host}\t${finding.id}\t${finding.detail}`);
        }
      } catch (error) { console.error(`resource ledger unavailable: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
    });
  resources.command('reconcile').description('원장과 kubectl/ps 실측 대조 (보고 전용 dry-run)')
    .requiredOption('--dry-run', '반드시 보고만 하고 아무것도 정리하지 않음')
    .option('--host <host>', '호스트 필터').option('--json', 'JSON 출력')
    .action((opts: { host?: string; json?: boolean }) => {
      try {
        const result = buildResourceLedgerSnapshot(deps, { host: opts.host });
        const psUnmeasured = result.measurements.some(measurement => measurement.errors.some(error => error.startsWith('ps:')));
        const report = { ...result, mode: 'dry-run', unknownProcessCount: psUnmeasured ? null
          : result.measurements.reduce((sum, measurement) => sum + measurement.processes.filter(process => !process.fp).length, 0),
          unknownProcessStatus: psUnmeasured ? 'unmeasured' as const : 'measured' as const, mutations: [] as string[] };
        if (opts.json) console.log(JSON.stringify(report));
        else {
          for (const finding of result.findings) console.log(`${finding.kind}\t${finding.host}\t${finding.id}\t${finding.detail}\t정리 안 함`);
          for (const measurement of result.measurements) {
            if (measurement.errors.some(error => error.startsWith('ps:'))) {
              console.log(`unknown-processes\t${measurement.host}\tunmeasured\tps 조회 실패\t정리 안 함`);
              continue;
            }
            const unknown = measurement.processes.filter(process => !process.fp).length;
            if (unknown) console.log(`unknown-processes\t${measurement.host}\t${unknown}\tFP 미귀속 수만 보고\t정리 안 함`);
          }
        }
        if (!result.findings.length && !opts.json) console.log('차이 없음 (dry-run · 정리 안 함)');
      } catch (error) { console.error(`resource reconcile unavailable: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
    });
}
