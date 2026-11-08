import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { userConfigPath } from '../src/user-config.js';
import type { WarmWorkerCandidate } from '../src/task-orchestrator/surfaces/pod-warm-worker-provider.js';
import type { RuntimeIdentityInput } from '../src/runtime-identity.js';
import { machinePoolCapacity, parseMachinePoolDeclarations, readMachinePoolDeclarations, type MachinePoolDeclaration } from '../src/resource-ledger/machine-pool-inventory.js';

const TOKEN = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const LOCK_HASH = /^[a-f0-9]{64}$/;
const TIERS = new Set(['lite', 'standard']);

type JsonObject = Record<string, unknown>;

export interface WarmPoolProviderConfig {
  candidates: WarmWorkerCandidate[];
  expandPoolTemplatesToQuota: boolean;
  drainingHosts: string[];
  poolTemplates: Array<{
    host: string;
    tier: 'lite' | 'standard';
    kind: 'gate' | 'implementation';
    slotCount?: number;
    spec: {
      name: string;
      namespace: string;
      kubectlContext: string;
      workerId: string;
      image: string;
      sourceUrl?: string;
      sourceMirrorHostPath?: string;
      nodeName: string;
      cutSha: string;
      key: { context: string; imageDigest: string; lockHash: string; architecture: string };
      runtimeContract?: { baseImageDigest?: string; bunVersion: string; os: 'linux'; architecture: string; requiredTools: string[] };
      memoryLimit: '2Gi' | '16Gi';
      hostProbeUrl: string;
      prodProbeUrl: string;
    };
  }>;
  profileConfig: { pod: { warmPoolProfile: string } };
  /** Cross-architecture reuse is opt-in; omission keeps exact architecture matching. */
  allowedArchitectures?: Array<'amd64' | 'arm64'>;
  runtimeIdentity?: RuntimeIdentityInput;
  /** Canonical SI target identity, independent of any selected worker row. */
  siSelection: { kind: 'implementation'; imageDigest: string;
    runtimeContract: { baseImageDigest?: string; bunVersion: string; os: 'linux'; architecture: string; requiredTools: string[] } };
  controlUrl: string;
  memberToken: string;
  machineTokens: Record<string, string>;
  machinePools?: readonly MachinePoolDeclaration[];
}

export interface AssembleWarmPoolProviderConfigInput {
  config: unknown;
  controlUrl: string;
  memberToken: string;
  machineTokens: Record<string, string>;
  machinePools?: readonly MachinePoolDeclaration[];
}

/** Keep a deployment canary to one explicit worker instead of expanding its profile quota. */
export function selectSingleWarmPoolCandidate(config: WarmPoolProviderConfig, selection: string): WarmPoolProviderConfig {
  const match = /^([a-zA-Z0-9][a-zA-Z0-9._-]*)\/(lite|standard)$/.exec(selection);
  if (!match) throw new Error('--single-candidate must be HOST/lite or HOST/standard');
  const [, host, tier] = match;
  const template = config.poolTemplates.find(candidate => candidate.host === host && candidate.tier === tier);
  if (!template) throw new Error(`warm pool template not found: ${host}/${tier}`);
  const index = 1;
  return {
    ...config,
    candidates: [{ host, tier: tier as 'lite' | 'standard', spec: {
      ...template.spec,
      name: `warm-${host}-${tier}-${index}`,
      workerId: `${template.spec.workerId}-${tier}-${index}`,
    } }],
    poolTemplates: [],
  };
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is required`);
  return value as JsonObject;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function token(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (!TOKEN.test(parsed)) throw new Error(`${label} must be a 64-character hexadecimal token`);
  return parsed;
}

function httpUrl(value: unknown, label: string, hostname?: string): string {
  const parsed = text(value, label);
  try {
    const url = new URL(parsed);
    if (url.protocol !== 'http:' || !url.port || url.username || url.password || url.search || url.hash
      || (hostname !== undefined && url.hostname !== hostname)) throw new Error();
    return url.href;
  } catch { throw new Error(`${label} must be an http URL${hostname ? ` for ${hostname}` : ''}`); }
}

function controlUrl(value: unknown): string {
  const parsed = text(value, 'controlUrl');
  try {
    const url = new URL(parsed);
    const authority = /^(?:http|https):\/\/([^/?#]*)/i.exec(parsed)?.[1] ?? '';
    const explicitPort = !authority.includes('\\') && /^(?:\[[^\]]+\]|[^:]+):\d+$/.test(authority);
    if (!['http:', 'https:'].includes(url.protocol) || !explicitPort || authority.includes('@') || url.username || url.password
      || parsed.includes('?') || parsed.includes('#') || url.search || url.hash)
      throw new Error();
    return url.href;
  } catch { throw new Error('controlUrl must be an http or https URL with an explicit port'); }
}

function privateSource(pool: JsonObject): Pick<WarmPoolProviderConfig['poolTemplates'][number]['spec'], 'sourceUrl' | 'sourceMirrorHostPath'> {
  const mirror = pool.sourceMirrorHostPath;
  const source = pool.sourceUrl;
  if (typeof mirror === 'string' && mirror.trim()) {
    if (!isAbsolute(mirror) || mirror.trim() !== mirror) throw new Error('pod.warmPool.sourceMirrorHostPath must be an absolute normalized path');
    return { sourceMirrorHostPath: mirror };
  }
  if (typeof source === 'string' && source.trim()) {
    try {
      const url = new URL(source);
      if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error();
      return { sourceUrl: url.href };
    } catch { throw new Error('pod.warmPool.sourceUrl must be a public https URL'); }
  }
  throw new Error('pod.warmPool.sourceMirrorHostPath or pod.warmPool.sourceUrl is required');
}

/** Convert canonical user config plus operator-supplied private credentials into the two provider loaders' shared format. */
export function assembleWarmPoolProviderConfig(input: AssembleWarmPoolProviderConfigInput): WarmPoolProviderConfig {
  const root = object(input.config, 'config');
  const pod = object(root.pod, 'pod');
  const harness = object(root.harness, 'harness');
  const profile = text(pod.warmPoolProfile, 'pod.warmPoolProfile');
  const pool = object(pod.warmPool, 'pod.warmPool');
  const cutSha = text(harness.imageCommit, 'harness.imageCommit');
  if (!SHA.test(cutSha)) throw new Error('harness.imageCommit must be a 40-character commit SHA');
  const kubectlContext = text(harness.podPool, 'harness.podPool');
  const namespace = text(pool.namespace, 'pod.warmPool.namespace');
  const imageRepository = text(pool.imageRepository, 'pod.warmPool.imageRepository').replace(/\/$/, '');
  const imageDigest = text(pool.imageDigest, 'pod.warmPool.imageDigest');
  if (!DIGEST.test(imageDigest)) throw new Error('pod.warmPool.imageDigest must be a sha256 digest');
  const expandPoolTemplatesToQuota = pool.expandPoolTemplatesToQuota;
  if (expandPoolTemplatesToQuota !== undefined && typeof expandPoolTemplatesToQuota !== 'boolean')
    throw new Error('pod.warmPool.expandPoolTemplatesToQuota must be a boolean');
  const drainingHostsValue = pool.drainingHosts ?? [];
  if (!Array.isArray(drainingHostsValue) || drainingHostsValue.some(host => typeof host !== 'string' || !host.trim())
    || new Set(drainingHostsValue).size !== drainingHostsValue.length)
    throw new Error('pod.warmPool.drainingHosts must be a unique list of host names');
  const drainingHosts = drainingHostsValue as string[];
  const allowedArchitecturesValue = pool.allowedArchitectures;
  if (allowedArchitecturesValue !== undefined && (!Array.isArray(allowedArchitecturesValue)
    || allowedArchitecturesValue.some(arch => arch !== 'amd64' && arch !== 'arm64')
    || new Set(allowedArchitecturesValue).size !== allowedArchitecturesValue.length))
    throw new Error('pod.warmPool.allowedArchitectures must be a unique list of amd64 and/or arm64');
  const allowedArchitectures = allowedArchitecturesValue as Array<'amd64' | 'arm64'> | undefined;
  const lockHash = text(pool.lockHash, 'pod.warmPool.lockHash');
  if (!LOCK_HASH.test(lockHash)) throw new Error('pod.warmPool.lockHash must be a 64-character SHA-256');
  const configuredBaseImageDigest = pool.baseImageDigest;
  const baseImageDigest = typeof configuredBaseImageDigest === 'string' && DIGEST.test(configuredBaseImageDigest)
    ? configuredBaseImageDigest : undefined;
  if (configuredBaseImageDigest !== undefined && !baseImageDigest)
    throw new Error('pod.warmPool.baseImageDigest must be a sha256 digest');
  const architecture = text(pool.architecture, 'pod.warmPool.architecture');
  const bunVersion = readFileSync(fileURLToPath(new URL('../.bun-version', import.meta.url)), 'utf8').trim();
  if (!/^\d+\.\d+\.\d+$/.test(bunVersion)) throw new Error('.bun-version must be a semantic version');
  const hostProbeUrl = httpUrl(pool.hostProbeUrl, 'pod.warmPool.hostProbeUrl', 'host.orb.internal');
  const prodProbeUrl = httpUrl(pool.prodProbeUrl, 'pod.warmPool.prodProbeUrl', 'core.elanous-prod');
  const source = privateSource(pool);
  const templates = pool.templates;
  if (!Array.isArray(templates) || templates.length === 0) throw new Error('pod.warmPool.templates is required');
  const seen = new Set<string>();
  const machineTokens: Record<string, string> = {};
  const purpose: MachinePoolDeclaration['purpose'] = profile === 'gate' ? 'gate' : profile === 'landing' ? 'land' : profile === 'feature' ? 'ta' : profile as MachinePoolDeclaration['purpose'];
  const declaredMembers = new Map<string, { host: string; count: number; digest: string; role: 'assigner' | 'executor' | 'both' }>();
  const executionCapacity = machinePoolCapacity(input.machinePools?.filter(row => row.purpose === purpose) ?? []);
  for (const member of input.machinePools?.filter(pool => pool.purpose === purpose).flatMap(pool => pool.members) ?? []) {
    const prior = declaredMembers.get(member.host);
    if (prior && prior.digest !== member.digest) throw new Error('conflicting machine pool digests for ' + member.host);
    const roles = new Set([prior?.role, member.role].filter(Boolean));
    const role = roles.has('both') || (roles.has('assigner') && roles.has('executor')) ? 'both'
      : (roles.has('assigner') ? 'assigner' : 'executor');
    declaredMembers.set(member.host, { host: member.host, count: executionCapacity[member.host]?.[purpose] ?? 0, digest: member.digest, role });
  }
  const templatesByHost = new Map<string, number>();
  for (const raw of templates) {
    const row = object(raw, 'pod.warmPool.templates[]');
    const host = text(row.host, 'pod.warmPool.templates[].host');
    templatesByHost.set(host, (templatesByHost.get(host) ?? 0) + 1);
  }
  const templateOrdinalByHost = new Map<string, number>();
  const poolTemplates = templates.map((raw, index) => {
    const row = object(raw, `pod.warmPool.templates[${index}]`);
    const host = text(row.host, `pod.warmPool.templates[${index}].host`);
    const tier = text(row.tier, `pod.warmPool.templates[${index}].tier`);
    if (!TIERS.has(tier)) throw new Error(`pod.warmPool.templates[${index}].tier must be lite or standard`);
    const nodeName = text(row.nodeName, `pod.warmPool.templates[${index}].nodeName`);
    const declared = declaredMembers.get(host);
    if (input.machinePools && !declared) throw new Error('machine pool declaration missing ' + purpose + ' member for ' + host);
    if (declared && declared.count === 0) throw new Error('machine pool member cannot execute provider jobs: ' + host);
    if (declared && declared.digest !== imageDigest) throw new Error('machine pool digest mismatch for ' + host);
    const identity = `${host}/${tier}`;
    if (seen.has(identity)) throw new Error(`duplicate pod.warmPool template ${identity}`);
    seen.add(identity);
    machineTokens[host] = token(input.machineTokens[host], `machine token for ${host}`);
    const ordinal = templateOrdinalByHost.get(host) ?? 0;
    templateOrdinalByHost.set(host, ordinal + 1);
    const templateCount = templatesByHost.get(host) ?? 1;
    if (declared && declared.count < templateCount) throw new Error(`machine pool count for ${host} is smaller than its template count`);
    const slotCount = declared ? Math.floor(declared.count / templateCount) + (ordinal < declared.count % templateCount ? 1 : 0) : undefined;
    return {
      host,
      tier: tier as 'lite' | 'standard',
      kind: profile === 'feature' ? 'implementation' as const : 'gate' as const,
      ...(slotCount !== undefined ? { slotCount } : {}),
      spec: {
        name: `warm-${host}-${tier}-template`, namespace, kubectlContext,
        workerId: `warm-${host}-${cutSha.slice(0, 12)}`, image: `${imageRepository}@${imageDigest}`,
        ...source, nodeName, cutSha,
        key: { context: kubectlContext, imageDigest, lockHash, architecture },
        runtimeContract: { ...(baseImageDigest ? { baseImageDigest } : {}), bunVersion, os: 'linux' as const, architecture, requiredTools: ['bun', 'git'] },
        memoryLimit: tier === 'lite' ? '2Gi' as const : '16Gi' as const,
        hostProbeUrl, prodProbeUrl,
      },
    };
  });
  return { candidates: [], expandPoolTemplatesToQuota: expandPoolTemplatesToQuota === true, drainingHosts,
    poolTemplates, profileConfig: { pod: { warmPoolProfile: profile } },
    ...(allowedArchitectures ? { allowedArchitectures } : {}),
    ...(baseImageDigest ? { runtimeIdentity: { baseImageDigest, lockHash, os: 'linux', architecture, bunVersion } } : {}),
    siSelection: { kind: 'implementation', imageDigest,
      runtimeContract: { ...(baseImageDigest ? { baseImageDigest } : {}), bunVersion, os: 'linux', architecture, requiredTools: ['bun', 'git'] } },
    controlUrl: controlUrl(input.controlUrl), memberToken: token(input.memberToken, 'member token'), machineTokens, ...(input.machinePools ? { machinePools: input.machinePools } : {}) };
}

/** Atomically replace the private provider config and repair permissions on an existing file. */
export function writeWarmPoolProviderConfig(path: string, config: WarmPoolProviderConfig): void {
  if (!isAbsolute(path)) throw new Error('output path must be absolute');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* no temporary output */ }
    throw error;
  }
}

function redact(config: WarmPoolProviderConfig): unknown {
  return { ...config, memberToken: '[redacted]', machineTokens: Object.fromEntries(Object.keys(config.machineTokens).map(host => [host, '[redacted]'])) };
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

interface CliOptions {
  configPath: string;
  controlUrl: string;
  memberTokenFile: string;
  machineTokenFiles: Record<string, string>;
  output: string;
  dryRun: boolean;
  serve: boolean;
  singleCandidate?: string;
  machinePoolsFile?: string;
  resourceLedgerUrl?: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let configPath = userConfigPath(), controlUrl = '', memberTokenFile = '', output = '';
  let dryRun = false, serve = false, singleCandidate: string | undefined, machinePoolsFile: string | undefined, resourceLedgerUrl: string | undefined;
  const machineTokenFiles: Record<string, string> = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value) throw new Error(`missing value for ${arg}`);
      return value;
    };
    if (arg === '--config') configPath = next();
    else if (arg === '--control-url') controlUrl = next();
    else if (arg === '--member-token-file') memberTokenFile = next();
    else if (arg === '--machine-token') {
      const [host, file, extra] = next().split('=');
      if (!host || !file || extra !== undefined) throw new Error('--machine-token must be HOST=FILE');
      machineTokenFiles[host] = file;
    } else if (arg === '--output') output = next();
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--serve') serve = true;
    else if (arg === '--single-candidate') singleCandidate = next();
    else if (arg === '--machine-pools') machinePoolsFile = next();
    else if (arg === '--resource-ledger-url') resourceLedgerUrl = next();
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!isAbsolute(configPath) || !controlUrl || !isAbsolute(memberTokenFile))
    throw new Error('usage: --config ABSOLUTE --control-url URL --member-token-file ABSOLUTE --machine-token HOST=ABSOLUTE [--resource-ledger-url URL] [--output ABSOLUTE] [--single-candidate HOST/TIER] [--dry-run|--serve]');
  if (Object.values(machineTokenFiles).some(file => !isAbsolute(file))) throw new Error('machine token files must be absolute');
  if (machinePoolsFile && !isAbsolute(machinePoolsFile)) throw new Error('--machine-pools path must be absolute');
  if (resourceLedgerUrl && !/^https?:\/\//.test(resourceLedgerUrl)) throw new Error('--resource-ledger-url must be http(s)');
  if (dryRun && serve) throw new Error('--dry-run and --serve cannot be combined');
  return { configPath, controlUrl, memberTokenFile, machineTokenFiles, machinePoolsFile, resourceLedgerUrl,
    output: output || join(dirname(configPath), 'warm-pod-provider.json'), dryRun, serve, singleCandidate };
}

function readPrivateToken(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  return token(readFileSync(path, 'utf8').trim(), label);
}

export function requireAuthoritativeMachinePoolSource(resourceLedgerUrl?: string, machinePoolsFile?: string): void {
  if (!resourceLedgerUrl) throw new Error('--resource-ledger-url is required for authoritative machine-pool declarations');
}

export async function fetchMachinePoolDeclarationsFromNexus(url: string, memberToken: string, fetcher: typeof fetch = fetch): Promise<MachinePoolDeclaration[]> {
  const response = await fetcher(url, { headers: { authorization: 'Bearer ' + memberToken } });
  if (!response.ok) throw new Error('Nexus resource-ledger request failed: HTTP ' + response.status);
  const body = await response.json() as { pools?: unknown };
  return parseMachinePoolDeclarations({ pools: body.pools });
}

export async function runWarmPoolProviderConfig(argv: readonly string[]): Promise<void> {
  const options = parseArgs(argv);
  if (!options.resourceLedgerUrl?.trim())
    throw new Error('--resource-ledger-url is required; local templates are not an authoritative pool source');
  requireAuthoritativeMachinePoolSource(options.resourceLedgerUrl, options.machinePoolsFile);
  const config = JSON.parse(readFileSync(options.configPath, 'utf8')) as unknown;
  const machineTokens = Object.fromEntries(Object.entries(options.machineTokenFiles)
    .map(([host, path]) => [host, readPrivateToken(path, `machine token for ${host}`)]));
  const memberToken = readPrivateToken(options.memberTokenFile, 'member token');
  let fromNexus: MachinePoolDeclaration[] | undefined;
  if (options.resourceLedgerUrl) {
    const hostCredentials = Object.values(machineTokens);
    if (hostCredentials.length === 0) throw new Error('--resource-ledger-url requires at least one host machine token');
    const declarations = await Promise.all(hostCredentials.map(credential =>
      fetchMachinePoolDeclarationsFromNexus(options.resourceLedgerUrl!, credential)));
    const byIdentity = new Map<string, MachinePoolDeclaration>();
    for (const pool of declarations.flat()) {
      const identity = `${pool.purpose}/${pool.fanoutGroupId}`;
      const prior = byIdentity.get(identity);
      if (prior && JSON.stringify(prior) !== JSON.stringify(pool)) throw new Error('Nexus returned conflicting machine pool declarations for ' + identity);
      byIdentity.set(identity, pool);
    }
    fromNexus = [...byIdentity.values()];
  }
  const fromCache = options.machinePoolsFile ? readMachinePoolDeclarations(options.machinePoolsFile) : undefined;
  if (fromNexus && fromCache && JSON.stringify(fromNexus) !== JSON.stringify(fromCache)) throw new Error('machine-pool cache differs from Nexus resource ledger');
  const machinePools = fromNexus ?? fromCache;
  const assembled = assembleWarmPoolProviderConfig({ config, controlUrl: options.controlUrl, memberToken, machineTokens, machinePools });
  const selected = options.singleCandidate ? selectSingleWarmPoolCandidate(assembled, options.singleCandidate) : assembled;
  if (!options.dryRun) writeWarmPoolProviderConfig(options.output, selected);
  process.stdout.write(`${JSON.stringify({ output: options.output, config: redact(selected),
    ...(options.serve ? { serve: { command: `ELANOUS_WARM_POD_PROVIDER_CONFIG=${shellQuote(options.output)} bun src/task-orchestrator/surfaces/pod-warm-worker-provider.ts --serve` } } : {}) })}\n`);
  if (!options.serve) return;
  const provider = fileURLToPath(new URL('../src/task-orchestrator/surfaces/pod-warm-worker-provider.ts', import.meta.url));
  const child = spawn(process.execPath, [provider, '--serve'], { stdio: 'inherit',
    env: { ...process.env, ELANOUS_WARM_POD_PROVIDER_CONFIG: options.output } });
  const forwardSignal = (signal: NodeJS.Signals) => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
  const forwardInterrupt = () => forwardSignal('SIGINT');
  const forwardTerminate = () => forwardSignal('SIGTERM');
  process.on('SIGINT', forwardInterrupt);
  process.on('SIGTERM', forwardTerminate);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 2);
        resolve();
      });
    });
  } finally {
    process.off('SIGINT', forwardInterrupt);
    process.off('SIGTERM', forwardTerminate);
  }
}

if (import.meta.main) {
  try { await runWarmPoolProviderConfig(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`warm-pool-provider-config: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
