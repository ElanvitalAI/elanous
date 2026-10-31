import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { userConfigPath } from '../src/user-config.js';
import type { WarmWorkerCandidate } from '../src/task-orchestrator/surfaces/pod-warm-worker-provider.js';

const TOKEN = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const LOCK_HASH = /^[a-f0-9]{64}$/;
const TIERS = new Set(['lite', 'standard']);

type JsonObject = Record<string, unknown>;

export interface WarmPoolProviderConfig {
  candidates: WarmWorkerCandidate[];
  poolTemplates: Array<{
    host: string;
    tier: 'lite' | 'standard';
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
      memoryLimit: '2Gi' | '16Gi';
      hostProbeUrl: string;
      prodProbeUrl: string;
    };
  }>;
  profileConfig: { pod: { warmPoolProfile: string } };
  controlUrl: string;
  memberToken: string;
  machineTokens: Record<string, string>;
}

export interface AssembleWarmPoolProviderConfigInput {
  config: unknown;
  controlUrl: string;
  memberToken: string;
  machineTokens: Record<string, string>;
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
  const lockHash = text(pool.lockHash, 'pod.warmPool.lockHash');
  if (!LOCK_HASH.test(lockHash)) throw new Error('pod.warmPool.lockHash must be a 64-character SHA-256');
  const architecture = text(pool.architecture, 'pod.warmPool.architecture');
  const hostProbeUrl = httpUrl(pool.hostProbeUrl, 'pod.warmPool.hostProbeUrl', 'host.orb.internal');
  const prodProbeUrl = httpUrl(pool.prodProbeUrl, 'pod.warmPool.prodProbeUrl', 'core.elanous-prod');
  const source = privateSource(pool);
  const templates = pool.templates;
  if (!Array.isArray(templates) || templates.length === 0) throw new Error('pod.warmPool.templates is required');
  const seen = new Set<string>();
  const machineTokens: Record<string, string> = {};
  const poolTemplates = templates.map((raw, index) => {
    const row = object(raw, `pod.warmPool.templates[${index}]`);
    const host = text(row.host, `pod.warmPool.templates[${index}].host`);
    const tier = text(row.tier, `pod.warmPool.templates[${index}].tier`);
    if (!TIERS.has(tier)) throw new Error(`pod.warmPool.templates[${index}].tier must be lite or standard`);
    const nodeName = text(row.nodeName, `pod.warmPool.templates[${index}].nodeName`);
    const identity = `${host}/${tier}`;
    if (seen.has(identity)) throw new Error(`duplicate pod.warmPool template ${identity}`);
    seen.add(identity);
    machineTokens[host] = token(input.machineTokens[host], `machine token for ${host}`);
    return {
      host,
      tier: tier as 'lite' | 'standard',
      spec: {
        name: `warm-${host}-${tier}-template`, namespace, kubectlContext,
        workerId: `warm-${host}-${cutSha.slice(0, 12)}`, image: `${imageRepository}@${imageDigest}`,
        ...source, nodeName, cutSha,
        key: { context: kubectlContext, imageDigest, lockHash, architecture },
        memoryLimit: tier === 'lite' ? '2Gi' as const : '16Gi' as const,
        hostProbeUrl, prodProbeUrl,
      },
    };
  });
  return { candidates: [], poolTemplates, profileConfig: { pod: { warmPoolProfile: profile } },
    controlUrl: controlUrl(input.controlUrl), memberToken: token(input.memberToken, 'member token'), machineTokens };
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
}

function parseArgs(argv: readonly string[]): CliOptions {
  let configPath = userConfigPath(), controlUrl = '', memberTokenFile = '', output = '';
  let dryRun = false, serve = false, singleCandidate: string | undefined;
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
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!isAbsolute(configPath) || !controlUrl || !isAbsolute(memberTokenFile))
    throw new Error('usage: --config ABSOLUTE --control-url URL --member-token-file ABSOLUTE --machine-token HOST=ABSOLUTE [--output ABSOLUTE] [--single-candidate HOST/TIER] [--dry-run|--serve]');
  if (Object.values(machineTokenFiles).some(file => !isAbsolute(file))) throw new Error('machine token files must be absolute');
  if (dryRun && serve) throw new Error('--dry-run and --serve cannot be combined');
  return { configPath, controlUrl, memberTokenFile, machineTokenFiles,
    output: output || join(dirname(configPath), 'warm-pod-provider.json'), dryRun, serve, singleCandidate };
}

function readPrivateToken(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  return token(readFileSync(path, 'utf8').trim(), label);
}

export async function runWarmPoolProviderConfig(argv: readonly string[]): Promise<void> {
  const options = parseArgs(argv);
  const config = JSON.parse(readFileSync(options.configPath, 'utf8')) as unknown;
  const machineTokens = Object.fromEntries(Object.entries(options.machineTokenFiles)
    .map(([host, path]) => [host, readPrivateToken(path, `machine token for ${host}`)]));
  const assembled = assembleWarmPoolProviderConfig({ config, controlUrl: options.controlUrl,
    memberToken: readPrivateToken(options.memberTokenFile, 'member token'), machineTokens });
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
