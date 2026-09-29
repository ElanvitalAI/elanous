// 클라우드 CLI 감지 — 이 기계에 무엇이 깔려 있고 누구로 로그인돼 있나.
// 읽기 전용이다. 버킷·객체를 만들거나 지우거나 쓰지 않는다.
// 명령 실패·시간 초과는 «로그인 안 됨»이 아니다 — signedIn: null(모름).

import { accessSync, constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { debug } from '../debug/log.js';
import { resolveCliBin, type CliBinDeps, type CliBinName } from './cli-bin.js';
import { resolveStorageConfig } from './object-store.js';

export const STORAGE_PROVIDERS = ['local', 'gcs', 'azure', 's3', 'r2'] as const;
export type StorageProviderId = (typeof STORAGE_PROVIDERS)[number];

export interface StorageCliInfo {
  name: string;
  path: string | null;
  version: string | null;
}

export interface StorageProviderDetect {
  provider: StorageProviderId;
  cli: StorageCliInfo;
  signedIn: boolean | null;
  account: string | null;
  project: string | null;
  bucketCount: number | null;
  hint: string;
}

export interface StorageCommandResult {
  code: number;
  stdout: string;
  stderr: string;
  /** 시간 초과·실행 불가. 로그인 안 됨으로 단정하지 않는다. */
  timedOut?: boolean;
}

export interface StorageDetectDeps {
  run: (bin: string, args: string[], opts: { timeoutMs: number }) => Promise<StorageCommandResult>;
  /** 알려진 설치 경로 → PATH. 없으면 null. */
  which?: (name: string) => string | null;
  /** which 를 안 줄 때 resolveCliBin 에 넘긴다. */
  cliBin?: CliBinDeps;
  home?: string;
  /** Local storage root; default = `resolveStorageConfig().localDir`. */
  localDir?: string;
  platform?: NodeJS.Platform;
  /** ~/.elanous/storage 쓰기 가능 여부. 없으면 실제 디렉터리를 본다. */
  localWritable?: boolean;
  /** 현재 storage.provider. 없으면 'local'. */
  currentProvider?: string;
  log?: (category: string, event: string, data?: unknown) => void;
}

const TIMEOUT_MS = 8000;
const CLI_BIN_NAMES = new Set<string>(['gcloud', 'aws', 'az', 'wrangler']);

const CLI_NAME: Record<Exclude<StorageProviderId, 'local'>, string> = {
  gcs: 'gcloud',
  azure: 'az',
  s3: 'aws',
  r2: 'wrangler',
};

function installHint(provider: StorageProviderId, platform: NodeJS.Platform): string {
  if (provider === 'local') return '';
  if (provider === 'gcs') {
    if (platform === 'darwin') return 'brew install --cask google-cloud-sdk';
    if (platform === 'win32') return 'winget install Google.CloudSDK';
    return 'sudo snap install google-cloud-cli --classic';
  }
  if (provider === 'azure') {
    if (platform === 'darwin') return 'brew install azure-cli';
    if (platform === 'win32') return 'winget install Microsoft.AzureCLI';
    return 'curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash';
  }
  if (provider === 's3') {
    if (platform === 'darwin') return 'brew install awscli';
    if (platform === 'win32') return 'winget install Amazon.AWSCLI';
    return 'sudo snap install aws-cli --classic';
  }
  if (platform === 'darwin') return 'brew install wrangler';
  if (platform === 'win32') return 'winget install Cloudflare.Wrangler';
  return 'npm install -g wrangler';
}

function loginHint(provider: StorageProviderId): string {
  if (provider === 'gcs') return 'gcloud auth login';
  if (provider === 'azure') return 'az login';
  if (provider === 's3') return 'aws configure sso';
  if (provider === 'r2') return 'wrangler login';
  return '';
}

/** 찾으면 그 경로. 못 찾으면 null. */
export function defaultWhich(name: string, cliBin?: CliBinDeps): string | null {
  if (!CLI_BIN_NAMES.has(name)) return null;
  return resolveCliBin(name as CliBinName, cliBin);
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
  return line ?? '';
}

function parseVersion(stdout: string, stderr: string): string | null {
  const line = firstLine(stdout) || firstLine(stderr);
  return line.length > 0 ? line : null;
}

function parseCount(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function emptyCloud(provider: Exclude<StorageProviderId, 'local'>, platform: NodeJS.Platform): StorageProviderDetect {
  return {
    provider,
    cli: { name: CLI_NAME[provider], path: null, version: null },
    signedIn: null,
    account: null,
    project: null,
    bucketCount: null,
    hint: installHint(provider, platform),
  };
}

async function runOk(
  deps: StorageDetectDeps,
  bin: string,
  args: string[],
): Promise<StorageCommandResult | null> {
  try {
    const result = await deps.run(bin, args, { timeoutMs: TIMEOUT_MS });
    if (result.timedOut || result.code !== 0) return null;
    return result;
  } catch {
    return null;
  }
}

// The local root comes from the same resolver object-store uses (one default · no home-relative literal — isolation gate).
function localRoot(deps: StorageDetectDeps): string {
  return deps.localDir ?? resolveStorageConfig(null).localDir;
}

function probeLocalWritable(dir: string): boolean {
  try {
    accessSync(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function detectLocal(deps: StorageDetectDeps, home: string): Promise<StorageProviderDetect> {
  const dir = localRoot(deps);
  const writable = deps.localWritable ?? probeLocalWritable(dir);
  return {
    provider: 'local',
    cli: { name: 'local', path: dir, version: null },
    signedIn: true,
    account: null,
    project: null,
    bucketCount: null,
    hint: writable ? `${dir} 쓰기 가능` : `${dir} 쓰기 불가`,
  };
}

async function detectGcs(deps: StorageDetectDeps, bin: string, platform: NodeJS.Platform): Promise<StorageProviderDetect> {
  const row = emptyCloud('gcs', platform);
  row.cli.path = bin;
  const version = await runOk(deps, bin, ['--version']);
  if (!version) return row;
  row.cli.version = parseVersion(version.stdout, version.stderr);
  const account = await runOk(deps, bin, ['config', 'get-value', 'account']);
  const project = await runOk(deps, bin, ['config', 'get-value', 'project']);
  if (!account && !project) {
    row.signedIn = null;
    row.hint = loginHint('gcs');
    return row;
  }
  const accountValue = account ? firstLine(account.stdout) : '';
  const projectValue = project ? firstLine(project.stdout) : '';
  const unset = (value: string) => value.length === 0 || value === '(unset)';
  if (unset(accountValue)) {
    row.signedIn = false;
    row.hint = loginHint('gcs');
    row.project = unset(projectValue) ? null : projectValue;
    return row;
  }
  row.signedIn = true;
  row.account = accountValue;
  row.project = unset(projectValue) ? null : projectValue;
  row.hint = '';
  const buckets = await runOk(deps, bin, ['storage', 'buckets', 'list', '--format=value(name)']);
  if (buckets) {
    const names = buckets.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
    row.bucketCount = names.length;
  }
  return row;
}

async function detectAzure(deps: StorageDetectDeps, bin: string, platform: NodeJS.Platform): Promise<StorageProviderDetect> {
  const row = emptyCloud('azure', platform);
  row.cli.path = bin;
  const version = await runOk(deps, bin, ['version']);
  if (!version) return row;
  row.cli.version = parseVersion(version.stdout, version.stderr);
  const show = await runOk(deps, bin, ['account', 'show', '--query', '{user:user.name,sub:name}', '-o', 'json']);
  if (!show) {
    row.signedIn = null;
    row.hint = loginHint('azure');
    return row;
  }
  let parsed: { user?: unknown; sub?: unknown } | null = null;
  try {
    parsed = JSON.parse(show.stdout) as { user?: unknown; sub?: unknown };
  } catch {
    row.signedIn = null;
    row.hint = loginHint('azure');
    return row;
  }
  const user = typeof parsed?.user === 'string' ? parsed.user.trim() : '';
  const sub = typeof parsed?.sub === 'string' ? parsed.sub.trim() : '';
  if (!user) {
    row.signedIn = false;
    row.hint = loginHint('azure');
    return row;
  }
  row.signedIn = true;
  row.account = user;
  row.project = sub || null;
  row.hint = '';
  const list = await runOk(deps, bin, ['account', 'list', '--query', 'length(@)', '-o', 'tsv']);
  if (list) row.bucketCount = parseCount(list.stdout);
  return row;
}

async function detectS3(deps: StorageDetectDeps, bin: string, platform: NodeJS.Platform): Promise<StorageProviderDetect> {
  const row = emptyCloud('s3', platform);
  row.cli.path = bin;
  const version = await runOk(deps, bin, ['--version']);
  if (!version) return row;
  row.cli.version = parseVersion(version.stdout, version.stderr);
  const identity = await runOk(deps, bin, ['sts', 'get-caller-identity', '--query', 'Arn', '--output', 'text']);
  if (!identity) {
    row.signedIn = null;
    row.hint = loginHint('s3');
    return row;
  }
  const arn = firstLine(identity.stdout);
  if (!arn || arn === 'None') {
    row.signedIn = false;
    row.hint = loginHint('s3');
    return row;
  }
  row.signedIn = true;
  row.account = arn;
  row.hint = '';
  const buckets = await runOk(deps, bin, ['s3api', 'list-buckets', '--query', 'length(Buckets)']);
  if (buckets) row.bucketCount = parseCount(buckets.stdout);
  return row;
}

async function r2FromAwsProfiles(deps: StorageDetectDeps, platform: NodeJS.Platform): Promise<StorageProviderDetect | null> {
  const which = deps.which ?? ((name: string) => defaultWhich(name, deps.cliBin));
  const aws = which('aws');
  if (!aws) return null;
  const listed = await runOk(deps, aws, ['configure', 'list-profiles']);
  if (!listed) return null;
  const profiles = listed.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
  const r2 = profiles.find((name) => name === 'r2' || name.startsWith('r2'));
  if (!r2) return null;
  return {
    provider: 'r2',
    cli: { name: 'wrangler', path: null, version: null },
    signedIn: null,
    account: r2,
    project: null,
    bucketCount: null,
    hint: `aws profile ${r2} — ${installHint('r2', platform)}`,
  };
}

async function detectR2(deps: StorageDetectDeps, bin: string | null, platform: NodeJS.Platform): Promise<StorageProviderDetect> {
  if (!bin) {
    const viaAws = await r2FromAwsProfiles(deps, platform);
    return viaAws ?? emptyCloud('r2', platform);
  }
  const row = emptyCloud('r2', platform);
  row.cli.path = bin;
  const version = await runOk(deps, bin, ['--version']);
  if (!version) return row;
  row.cli.version = parseVersion(version.stdout, version.stderr);
  const who = await runOk(deps, bin, ['whoami']);
  if (!who) {
    row.signedIn = null;
    row.hint = loginHint('r2');
    return row;
  }
  const text = `${who.stdout}\n${who.stderr}`;
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null;
  const id = text.match(/\b[0-9a-f]{32}\b/i)?.[0] ?? null;
  if (!email && !id) {
    row.signedIn = false;
    row.hint = loginHint('r2');
    return row;
  }
  row.signedIn = true;
  row.account = email;
  row.project = id;
  row.hint = '';
  return row;
}

export async function detectStorageProviders(deps: StorageDetectDeps): Promise<StorageProviderDetect[]> {
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homedir();
  const which = deps.which ?? ((name: string) => defaultWhich(name, deps.cliBin));
  const rows: StorageProviderDetect[] = [];
  rows.push(await detectLocal(deps, home));
  const gcloud = which('gcloud');
  rows.push(gcloud ? await detectGcs(deps, gcloud, platform) : emptyCloud('gcs', platform));
  const az = which('az');
  rows.push(az ? await detectAzure(deps, az, platform) : emptyCloud('azure', platform));
  const aws = which('aws');
  rows.push(aws ? await detectS3(deps, aws, platform) : emptyCloud('s3', platform));
  const wrangler = which('wrangler');
  rows.push(await detectR2(deps, wrangler, platform));
  const found = rows.filter((row) => row.provider === 'local' || row.cli.path !== null).map((row) => row.provider);
  const signedIn = rows.filter((row) => row.signedIn === true).map((row) => row.provider);
  (deps.log ?? ((category, event, data) => debug.log(category, event, data)))('storage.detect', 'done', { found, signedIn });
  return rows;
}
