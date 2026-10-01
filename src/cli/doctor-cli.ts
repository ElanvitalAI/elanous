import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { discoverChromeBinary } from '../browser-cdp/client.js';
import { resolveUsableLlm, type UsableLlm } from '../llm/usable-llm.js';
import { detectLocale } from '../expression/locale.js';
import { findRetiredConfigKeysInFile, getUserConfig, type RetiredConfigKey, type UserConfig } from '../user-config.js';
import { codeRevision } from '../version/code-revision.js';
import {
  checkReadiness,
  servicePathRefs,
  detectSubstrate,
  parseDockerInfo,
  parseKubectlServerVersion,
  parseMeminfo,
  parseVmStatAvailableBytes,
  type DockerProbe,
  type KubernetesProbe,
  type MemoryProbe,
  type ReadinessDeps,
  type ReadinessReport,
  type SubstrateSignals,
} from './doctor-readiness.js';
import { debug } from '../debug/log.js';
import { resolveDaemonEndpoint, type ResolveDaemonEndpointOpts } from '../nexus/daemon-endpoint.js';
import { applyDoctorFixes, applyGitInstall, applyServiceRestart, applySudoFixes, planDoctorFixes, type DoctorFixDeps, type DoctorFixItem } from './doctor-fix.js';
import { ADVISABLE_DOCTOR_FIX_IDS, adviseDoctorFixes, type DoctorAdvice } from './doctor-llm-assist.js';
import { gitInstallPlan } from './git-install-plan.js';
import { detectDistroFamily, parseOsRelease } from './doctor-distro.js';
import { checkPythonEnv } from './python-cli.js';
import { describeModes, formatModeLine, type DoctorMode } from './doctor-modes.js';

function defaultCheckPythonEnv(): { status: 'ok' | 'fixable' | 'manual'; evidence: string; remedy?: string } {
  const c = checkPythonEnv(false);
  return { status: c.status, evidence: c.evidence, ...(c.remedy ? { remedy: c.remedy } : {}) };
}

const requireFromHere = createRequire(import.meta.url);

export type CredentialSource = 'env' | 'cache' | 'skill-env' | 'user-config' | 'unresolved';

export type FreeFallbackMode = 'auto' | 'manual' | 'none';

export interface DoctorCredential {
  name: string;
  resolved: boolean;
  source: CredentialSource;
  note: string;
  requiredFor?: string[];
  freeFallback?: string;
  freeFallbackMode?: FreeFallbackMode;
  satisfiedBy?: { name: string; source: Exclude<CredentialSource, 'unresolved'> };
}

interface ResourceMetadata {
  env: string[];
  requiredFor?: string[];
  freeFallback?: string;
  freeFallbackMode?: FreeFallbackMode;
}

interface ResourceMetadataLoad {
  metadata: Map<string, ResourceMetadata>;
  available: boolean;
}

export interface DoctorExternalCommand {
  name: string;
  tier: string;
  status: 'found' | 'missing' | 'broken' | 'skipped' | 'unknown-probe';
  detail?: string;
  breaks?: string;
  fix?: string;
  breaks_broken?: string;
  fix_broken?: string;
  platform?: string;
}

export interface DoctorCapability {
  credential: string;
  name: string;
  freeFallback?: string;
}

export interface DoctorCapabilitySummary {
  available: DoctorCapability[];
  unavailable: DoctorCapability[];
  unknownCredentials: string[];
}

export interface DoctorReport {
  ok: boolean;
  credentials: DoctorCredential[];
  externalCommands: DoctorExternalCommand[];
  requiredMissing?: string[];
  capabilitySummary?: DoctorCapabilitySummary;
  /** Read-only configuration and chat-use status. Present on a successful report. */
  modes?: DoctorMode[];
  /** F1 readiness. Present on a successful report. Absent when the report itself failed. */
  readiness?: ReadinessReport;
  reason?: string;
  catalogMetadataUnavailable?: boolean;
  externalCommandsCatalogUnavailable?: boolean;
  externalCommandsCatalogReason?: string;
  /** 설정 파일에 남아 있는 폐기 키(설정 졸업). 로더는 값을 쓰지 않는다. 없으면 빈 배열. */
  retiredConfigKeys?: RetiredConfigKey[];
}

export interface DoctorOptions {
  repositoryRoot?: string;
  /** 빌드 도구 탐침(시험 seam) — 주입 안 하면 실제 `make`·`c++ -std=gnu++20` 탐침. */
  probeBuildToolchain?: () => { make: boolean | null; cxx20: boolean | null };
  /** 파이썬 환경 판정(시험 seam) — 기본 = `elanous python check` 와 같은 함수(실제 파이썬으로 잰다). */
  checkPythonEnv?: () => { status: 'ok' | 'fixable' | 'manual'; evidence: string; remedy?: string } | null;
  /** L0 substrate·docker·kubernetes·memory 탐침(시험 seam) — 주입 안 하면 `defaultProbeHostEnvironment`. */
  probeHostEnvironment?: () => HostEnvironmentProbe | null;
  env?: NodeJS.ProcessEnv;
  cacheDir?: string;
  tavilyEnvFile?: string;
  userConfig?: UserConfig;
  getUserConfig?: () => UserConfig;
  /** 폐기 키를 찾을 설정 파일 경로(시험 주입). 없으면 기본 설정 경로. */
  configPath?: string;
  readFile?: (path: string) => string;
  exists?: (path: string) => boolean;
  commandExists?: (name: string) => boolean;
  /** Whether this process runs as root (uid 0) — git install then skips sudo. Test seam. */
  isRoot?: boolean;
  discoverChromeBinary?: () => string | null;
  loadNativeModule?: (name: string) => boolean;
  resolveNativeModuleDir?: (name: string) => string | null;
  isExecutable?: (path: string) => boolean;
  pathDelimiter?: string;
  platform?: NodeJS.Platform;
  /**
   * Injected F1 lookups. When omitted, runDoctor resolves them read-only.
   * A provided object is used as-is — omitted fields stay unmeasured (`unknown`),
   * they are not filled in from the machine.
   */
  readiness?: ReadinessDeps;
  checkReadiness?: (deps: ReadinessDeps) => ReadinessReport;
  resolveLlm?: () => UsableLlm;
  /** Legacy read-only seam; route selection no longer uses provider-name presence. */
  listAuthProviders?: () => readonly string[];
  /** Read-only `codeRevision()`. */
  codeRevision?: () => string | undefined;
  /** Read-only `GET /v1/health`. `null` means no response. */
  fetchHealth?: () => { daemonSha?: string } | null;
  /** Test seam — daemon address. `null` means this universe has no daemon (do not guess a port). */
  resolveDaemonEndpoint?: (opts?: ResolveDaemonEndpointOpts) => { healthUrl: string } | null;
  /**
   * Read-only install prefix. `null` means a checkout was confirmed.
   * Throw when the lookup itself fails — that is not a checkout.
   */
  readInstallPrefix?: () => string | null | undefined;
  /** 저장소가 시험한 bun 판(시험 seam) — 기본은 패키지 뿌리의 `.bun-version`. */
  bunPin?: () => string | null;
  /** 리눅스 TMPDIR/bun 캐시 파일시스템 비교(시험 seam). */
  tmpdirSameFsAsBunCache?: () => boolean | null;
  /** Read-only `gh auth status` exit code. `null` means it could not be run. */
  ghAuthStatus?: () => number | null;
  /** `gh --version` 의 판(예: "2.45.0") · null = 못 쟀다(시험 seam). */
  ghVersion?: () => string | null;
}

export interface DoctorCliDeps extends DoctorOptions, Pick<DoctorFixDeps, 'home' | 'readdir' | 'appendFile' | 'writeFile' | 'mkdir' | 'lstat' | 'chmod' | 'rename' | 'remove' | 'temporaryPath' | 'installStaticTool' | 'smokeCheck' | 'pythonSetup' | 'recheckPythonEnv'> {
  /** Git install-only seams; all other doctor repairs retain their existing consent rules. */
  gitInteractive?: boolean;
  confirmGitInstall?: (display: string) => Promise<boolean>;
  runGitInstallCommand?: (command: string, args: readonly string[]) => { status: number | null };
  out?: { log: (value: string) => void };
  err?: { error: (value: string) => void };
  setExitCode?: (code: number) => void;
  /** P5 시험 seam — `--sudo` 실행기. */
  applySudoFixes?: typeof applySudoFixes;
  /** D5 시험 seam — `--restart` 실행기. */
  applyServiceRestart?: typeof applyServiceRestart;
  /** Read-only advice call; injection avoids any real LLM access in tests. */
  adviseLlm?: (prompt: string, provider: string, model: string) => Promise<string>;
  resolveAdviceProvider?: (config: UserConfig) => { provider: string; model: string; auth: string };
  confirmAdvice?: (message: string) => Promise<boolean>;
  adviceInteractive?: boolean;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tavilyNames = new Set(['TAVILY_API_KEY', 'TAVILY_KEY']);

function defaultCodeRevision(): string | undefined {
  try {
    return codeRevision();
  } catch {
    return undefined;
  }
}

/** Test seam — records the curl argv `defaultFetchHealth` actually runs. */
let fetchHealthSpawn: typeof spawnSync = spawnSync;

export function setFetchHealthSpawnForTest(spawn: typeof spawnSync | null): void {
  fetchHealthSpawn = spawn ?? spawnSync;
}

function defaultFetchHealth(resolveEndpoint: (opts?: ResolveDaemonEndpointOpts) => { healthUrl: string } | null = resolveDaemonEndpoint): { daemonSha?: string } | null {
  const healthUrl = resolveEndpoint()?.healthUrl;
  if (!healthUrl) return null;
  const probe = fetchHealthSpawn('curl', ['-fsS', '--max-time', '2', healthUrl], {
    encoding: 'utf8',
    timeout: 3000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (probe.status !== 0 || probe.error || typeof probe.stdout !== 'string' || probe.stdout.trim().length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(probe.stdout);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const daemonSha = (parsed as { daemonSha?: unknown }).daemonSha;
    return typeof daemonSha === 'string' ? { daemonSha } : {};
  } catch {
    return null;
  }
}

/** `gh --version` → "2.45.0" · 못 돌리거나 못 읽으면 null. */
export function defaultGhVersion(commandExists: (name: string) => boolean): string | null {
  if (!commandExists('gh')) return null;
  const probe = spawnSync('gh', ['--version'], { encoding: 'utf8', timeout: 8000 });
  if (probe.error || probe.status !== 0) return null;
  return /gh version (\d+\.\d+(?:\.\d+)?)/.exec(probe.stdout ?? '')?.[1] ?? null;
}

function defaultGhAuthStatus(commandExists: (name: string) => boolean): number | null {
  if (!commandExists('gh')) return null;
  const probe = spawnSync('gh', ['auth', 'status'], {
    encoding: 'utf8',
    timeout: 8000,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  if (probe.error || probe.status === null) return null;
  return probe.status;
}

/**
 * Install prefix when this process is the installed copy.
 * `scripts/install.sh` writes `$PREFIX/install.json` and runs the package from
 * `$PREFIX/current/node_modules/elanous`. The marker is one level above
 * `current`, not beside the package. A checkout (no such file three levels
 * above the package) returns `null`. The file body is not returned.
 */
/**
 * 설치 prefix — 설치기의 세 모양을 다 안다: ⓐ 판 폴더 실경로 `$PREFIX/versions/<판>/node_modules/elanous`
 * (`import.meta.url` 은 심링크를 풀어 이 모양이 된다) ⓑ `$PREFIX/current/node_modules/elanous` ⓒ 옛 `$PREFIX/node_modules/elanous`.
 * `.git` 이 있으면 체크아웃(`null`) · 아무것도 확인 못 하면 `undefined`(모른다 — 「체크아웃」으로 읽지 않는다).
 * 🩸 2026-09-24: 종전 판은 ⓐ 에서 `versions/` 를 prefix 로 읽어 설치본 doctor 가 「running from a checkout」이라 했다.
 */
/** `TMPDIR`(없으면 os.tmpdir) 와 bun 설치 캐시(`BUN_INSTALL_CACHE_DIR` · 없으면 ~/.bun/install/cache)의 `st_dev` 비교 — 하나라도 못 재면 null. */
export function defaultTmpdirSameFsAsBunCache(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): boolean | null {
  try {
    const tmp = env.TMPDIR?.trim() || tmpdir();
    const cache = env.BUN_INSTALL_CACHE_DIR?.trim() || join(env.BUN_INSTALL?.trim() || join(home, '.bun'), 'install', 'cache');
    return statSync(tmp).dev === statSync(cache).dev;
  } catch {
    return null;
  }
}

export function defaultReadInstallPrefix(packageRoot: string, exists: (path: string) => boolean): string | null | undefined {
  const holder = resolve(packageRoot, '..', '..');      // versions/<판> | current | $PREFIX(옛)
  const parent = resolve(holder, '..');
  if (basename(parent) === 'versions') {
    const root = resolve(parent, '..');
    if (exists(join(root, 'install.json'))) return root;
  }
  if (basename(holder) === 'current' && exists(join(parent, 'install.json'))) return parent;
  if (exists(join(holder, 'install.json'))) return holder;
  if (exists(join(packageRoot, '.git'))) return null;
  return undefined;
}

interface ReadinessLookup {
  env: NodeJS.ProcessEnv;
  pathDelimiter: string;
  platform: NodeJS.Platform;
  commandExists: (name: string) => boolean;
  getConfig: () => UserConfig;
  codeRevision: () => string | undefined;
  fetchHealth: () => { daemonSha?: string } | null;
  readInstallPrefix: () => string | null | undefined;
  ghAuthStatus: () => number | null;
  ghVersion?: () => string | null;
  tmpdirSameFsAsBunCache: () => boolean | null;
  /** 경로가 git 작업 트리 안인가(시험 seam) — 기본은 위로 올라가며 `.git` 을 찾는다. */
  isInsideGitTree?: (path: string) => boolean;
  /** 저장소가 시험한 bun 판(`.bun-version`) · 지금 도는 bun 판(시험 seam). */
  bunPin?: () => string | null;
  bunVersion?: () => string | null;
  /** `/etc/os-release` 본문(시험 seam) — 못 읽으면 null. */
  readOsRelease?: () => string | null;
  /** 빌드 도구 탐침(시험 seam). */
  probeBuildToolchain?: () => { make: boolean | null; cxx20: boolean | null };
  /** 파이썬 환경 판정(시험 seam) — 기본 = `elanous python check` 와 같은 함수(실제 파이썬으로 잰다). */
  checkPythonEnv?: () => { status: 'ok' | 'fixable' | 'manual'; evidence: string; remedy?: string } | null;
  /** L0 substrate·docker·kubernetes·memory 탐침(시험 seam). `null` 을 돌려주면 네 칸 모두 «못 쟀다». */
  probeHostEnvironment?: () => HostEnvironmentProbe | null;
  /** node-pty 외부 명령 탐침 결과(보고서에서). */
  nodePty?: 'found' | 'missing' | 'broken' | null;
  /** 서비스 파일(시험 seam) — 없으면 null. */
  readServiceFile?: () => { path: string; text: string } | null;
  /** 첫 PATH 의 `elanous` 실경로(시험 seam). */
  elanousOnPath?: (pathEntries: readonly string[]) => string | null;
}

/** 경로(또는 그 조상)에 `.git` 이 있나 — 읽기만. */
export function defaultIsInsideGitTree(path: string, exists: (p: string) => boolean = existsSync): boolean {
  let dir = resolve(path);
  for (;;) {
    if (exists(join(dir, '.git'))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function safe(read: () => string | null): string | null {
  try { return read(); } catch { return null; }
}

/** 저장소가 시험한 bun 판 — 패키지 뿌리의 `.bun-version`(설치기·Pod 이미지와 같은 한 칸). 못 읽으면 null. */
export function readBunPin(root: string, read: (path: string) => string = (path) => readFileSync(path, 'utf8')): string | null {
  try {
    const value = read(join(root, '.bun-version')).trim();
    return /^\d+\.\d+\.\d+$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** PATH 를 앞에서부터 보고 처음 만나는 `elanous` 의 실경로(링크를 끝까지 푼 것). 없으면 null. */
export function defaultElanousOnPath(pathEntries: readonly string[]): string | null {
  for (const entry of pathEntries) {
    const candidate = join(entry, 'elanous');
    if (!existsSync(candidate)) continue;
    try { return realpathSync(candidate); } catch { return null; }
  }
  return null;
}

/** Read-only F1 lookups. A failed probe stays `null` (unmeasured), never a guessed absence. */
function resolveReadinessDeps(lookup: ReadinessLookup): ReadinessDeps {
  let provider: string | null = null;
  try {
    const configured = lookup.getConfig().llm?.provider;
    provider = typeof configured === 'string' && configured.trim().length > 0 ? configured.trim() : 'auto';
  } catch {
    provider = null;
  }
  if (provider !== null && provider !== 'auto' && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(provider)) {
    provider = null;
  }
  const pathEntries = (lookup.env.PATH ?? '').split(lookup.pathDelimiter).filter((entry) => entry.length > 0);
  let ghOnPath: boolean | null = null;
  let ghAuthStatus: number | null = null;
  let ghVersion: string | null = null;
  try {
    ghOnPath = lookup.commandExists('gh');
    ghAuthStatus = ghOnPath ? lookup.ghAuthStatus() : null;
    ghVersion = ghOnPath && lookup.ghVersion ? lookup.ghVersion() : null;
  } catch {
    ghOnPath = null;
    ghAuthStatus = null;
  }
  const commandOnPath = (name: string): boolean | null => {
    try { return lookup.commandExists(name); } catch { return null; }
  };
  const rgOnPath = commandOnPath('rg');
  const codexOnPath = commandOnPath('codex');
  const nodeOnPath = commandOnPath('node');
  // codex 가 npm 스크립트(`#!/usr/bin/env node`)인가, 정적 바이너리인가 — 바이너리면 node 가 필요 없다
  // (📏 2026-09-25 amazonlinux:2: doctor --fix 가 정적 codex 를 넣었는데 「codex requires node」로 남았다).
  const codexNeedsNode = codexOnPath === true ? codexIsNodeScript(pathEntries) : null;
  const codexCodeModeHost = codexNeedsNode === false ? codexHasCodeModeHost(pathEntries) : null;
  let installPrefix: string | null | undefined;
  try {
    installPrefix = lookup.readInstallPrefix();
  } catch {
    installPrefix = undefined;
  }
  let elanousOnPath: string | null | undefined;
  try {
    elanousOnPath = (lookup.elanousOnPath ?? defaultElanousOnPath)(pathEntries);
  } catch {
    elanousOnPath = undefined;
  }
  let health: { daemonSha?: string } | null = null;
  try {
    health = lookup.fetchHealth();
  } catch {
    health = null;
  }
  let revision: string | null = null;
  try {
    const value = lookup.codeRevision();
    revision = typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  } catch {
    revision = null;
  }
  let serviceFile: { path: string; text: string } | null | undefined;
  try {
    serviceFile = (lookup.readServiceFile ?? (() => defaultReadServiceFile(lookup.platform)))();
  } catch {
    serviceFile = undefined;
  }
  // 서비스 파일이 가리키는 경로 중 git 작업 트리 안인 것(읽기만) — 못 읽으면 undefined(못 쟀다).
  let serviceGitTreeRefs: string[] | undefined;
  if (serviceFile) {
    try {
      serviceGitTreeRefs = servicePathRefs(serviceFile.text).filter((ref) => (lookup.isInsideGitTree ?? defaultIsInsideGitTree)(ref));
    } catch {
      serviceGitTreeRefs = undefined;
    }
  }
  let host: HostEnvironmentProbe | null = null;
  try {
    host = (lookup.probeHostEnvironment ?? (() => defaultProbeHostEnvironment({ env: lookup.env, platform: lookup.platform, commandExists: lookup.commandExists, pathEntries })))();
  } catch {
    host = null;
  }
  const detected = host?.substrate ? detectSubstrate(host.substrate) : null;
  debug.log('doctor.substrate', 'probed', {
    substrate: detected?.substrate ?? null,
    signal: detected?.signal ?? null,
    docker: host?.docker ? { onPath: host.docker.onPath, info: host.docker.info?.kind ?? null, serverVersion: host.docker.info?.kind === 'engine' ? host.docker.info.engine.serverVersion ?? null : null } : null,
    kubernetes: host?.kubernetes ? { onPath: host.kubernetes.onPath, hasContext: host.kubernetes.context === undefined ? null : host.kubernetes.context !== null, server: host.kubernetes.server?.kind ?? null } : null,
    memory: host?.memory ?? null,
  });
  let tmpdirSameFsAsBunCache: boolean | null = null;
  if (lookup.platform === 'linux') {
    try { tmpdirSameFsAsBunCache = lookup.tmpdirSameFsAsBunCache(); } catch { tmpdirSameFsAsBunCache = null; }
  }
  return {
    provider,
    ghOnPath,
    ghAuthStatus,
    ghVersion,
    rgOnPath,
    codexOnPath,
    nodeOnPath,
    codexNeedsNode,
    codexCodeModeHost,
    installPrefix,
    pathEntries,
    elanousOnPath,
    health,
    codeRevision: revision,
    platform: lookup.platform,
    tmpdirSameFsAsBunCache,
    ...(serviceGitTreeRefs !== undefined ? { serviceGitTreeRefs } : {}),
    bunVersion: safe(lookup.bunVersion ?? (() => (typeof Bun !== 'undefined' ? Bun.version : null))),
    bunPin: safe(lookup.bunPin ?? (() => null)),
    serviceFile,
    buildToolchain: (() => { try { return (lookup.probeBuildToolchain ?? (() => defaultProbeBuildToolchain(lookup.commandExists, pathEntries)))(); } catch { return null; } })(),
    pythonEnv: (() => { try { return (lookup.checkPythonEnv ?? defaultCheckPythonEnv)(); } catch { return null; } })(),
    nodePty: lookup.nodePty ?? null,
    substrate: host?.substrate ?? null,
    docker: host?.docker ?? null,
    kubernetes: host?.kubernetes ?? null,
    memory: host?.memory ?? null,
    distro: detectDistroFamily(lookup.platform, lookup.platform === 'linux' ? readOsReleaseSafely(lookup) : null),
  };
}

/** `make` 가 있나 · C++ 컴파일러가 `-std=gnu++20` 한 줄을 받나(버전 문자열로 추측하지 않는다). 못 돌리면 null. */
export function defaultProbeBuildToolchain(commandExists: (name: string) => boolean, pathEntries: readonly string[] = []): { make: boolean | null; cxx20: boolean | null } {
  let make: boolean | null = null;
  try { make = commandExists('make'); } catch { make = null; }
  // 🩸 2026-09-25 amazonlinux:2 컨테이너: 기본 `c++` 는 gcc7(C++20 불가)이고 gcc10 은 `gcc10-g++` 로 따로 깔린다 —
  //   «처음 찾은 하나»만 재면 gcc10 을 깔아도 영영 manual 이었다. ⇒ 후보를 차례로 재고 «하나라도» 받으면 통과.
  //   (node-pty 재빌드는 amzn2 에서 CXX=gcc10-g++ 로 한다 — doctor-fix nodePtyRebuildPlan.)
  const names = ['c++', 'g++', 'clang++', 'gcc10-g++'].filter((candidate) => { try { return commandExists(candidate); } catch { return false; } });
  if (!names.length) return { make, cxx20: false };
  let sawNull = false;
  for (const name of names) {
    // 존재를 확인한 «같은» PATH 에서 절대 경로를 찾아 실행한다 — 이름으로 부르면 실행 PATH 가 달라 못 찾을 수 있다(2026-09-24 실측).
    const compiler = pathEntries.map((dir) => join(dir, name)).find((path) => existsSync(path)) ?? name;
    try {
      const probe = spawnSync(compiler, ['-std=gnu++20', '-x', 'c++', '-fsyntax-only', '-'], { input: 'int main() { return 0; }\n', encoding: 'utf8', timeout: 20_000 });
      if (probe.error) { sawNull = true; continue; }
      if (probe.status === 0) return { make, cxx20: true };
    } catch {
      sawNull = true;
    }
  }
  return { make, cxx20: sawNull ? null : false };
}

export interface HostEnvironmentProbe {
  substrate: SubstrateSignals | null;
  docker: DockerProbe | null;
  kubernetes: KubernetesProbe | null;
  memory: MemoryProbe | null;
}

/** 탐침 한 발의 결과. `timedOut` = 제한 시간에 걸렸다 · `error` = 돌리지 못했다(둘 다 «못 쟀다»). */
export interface ProbeRun { status: number | null; stdout: string; stderr: string; timedOut: boolean; error: boolean }

function defaultRunProbe(command: string, args: readonly string[], timeoutMs: number): ProbeRun {
  const probe = spawnSync(command, [...args], { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
  const code = (probe.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    status: probe.status,
    stdout: probe.stdout ?? '',
    stderr: probe.stderr ?? '',
    timedOut: code === 'ETIMEDOUT' || (probe.status === null && probe.signal === 'SIGTERM'),
    error: probe.error !== undefined && code !== 'ETIMEDOUT',
  };
}

/** 표시용 한 줄 — stderr 첫 비어 있지 않은 줄(160자). */
function firstLine(text: string): string | undefined {
  const line = text.split('\n').map((entry) => entry.trim()).find((entry) => entry.length > 0);
  return line === undefined ? undefined : line.slice(0, 160);
}

export interface HostEnvironmentProbeOptions {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  commandExists: (name: string) => boolean;
  pathEntries: readonly string[];
  exists?: (path: string) => boolean;
  /** 파일 본문 — 없거나 못 읽으면 null. */
  readText?: (path: string) => string | null;
  run?: (command: string, args: readonly string[], timeoutMs: number) => ProbeRun;
}

/**
 * L0(RFC docker·k8s 사다리) — 어디서 도나 · docker 엔진 · k8s API · 시스템 RAM. 읽기 전용.
 * ⛔ 컨테이너를 띄우거나 이미지를 받는 탐침은 없다 — `docker info`·`kubectl version` 까지만.
 * 못 잰 칸은 «없음»이 아니라 null/unknown 으로 남긴다.
 */
export function defaultProbeHostEnvironment(options: HostEnvironmentProbeOptions): HostEnvironmentProbe {
  const exists = options.exists ?? ((path: string) => existsSync(path));
  const readText = options.readText ?? ((path: string) => { try { return existsSync(path) ? readFileSync(path, 'utf8') : null; } catch { return null; } });
  const run = options.run ?? defaultRunProbe;
  const safeExists = (path: string): boolean | null => { try { return exists(path); } catch { return null; } };
  const onPath = (name: string): boolean | null => { try { return options.commandExists(name); } catch { return null; } };
  // 존재를 확인한 «같은» PATH 에서 절대 경로를 찾는다(defaultProbeBuildToolchain 과 같은 이유).
  const resolveBin = (name: string): string => options.pathEntries.map((dir) => join(dir, name)).find((path) => existsSync(path)) ?? name;

  const substrate: SubstrateSignals = {
    kubernetesServiceHost: Boolean(options.env.KUBERNETES_SERVICE_HOST?.trim()),
    serviceAccountNamespace: safeExists('/var/run/secrets/kubernetes.io/serviceaccount/namespace'),
    dockerenv: safeExists('/.dockerenv'),
    containerenv: safeExists('/run/.containerenv'),
    cgroup: options.platform === 'linux' ? readText('/proc/1/cgroup') : null,
    containerEnv: options.env.container?.trim() || null,
  };

  const dockerOnPath = onPath('docker');
  let docker: DockerProbe = { onPath: dockerOnPath };
  if (dockerOnPath === true) {
    const result = run(resolveBin('docker'), ['info', '--format', '{{json .}}'], 5_000);
    const engine = result.timedOut || result.error ? null : parseDockerInfo(result.stdout.trim().split('\n')[0] ?? '');
    const info: DockerProbe['info'] = result.timedOut
      ? { kind: 'timeout' }
      : result.error
        ? null
        : result.status === 0 && engine
          ? { kind: 'engine', engine }
          : { kind: 'no-response', ...(firstLine(result.stderr) ? { detail: firstLine(result.stderr) } : {}) };
    docker = { onPath: true, info };
    if (options.platform === 'darwin' && info?.kind === 'no-response') {
      docker.desktopApp = safeExists('/Applications/OrbStack.app') ? 'OrbStack' : safeExists('/Applications/Docker.app') ? 'Docker' : null;
    }
  }

  const kubectlOnPath = onPath('kubectl');
  let kubernetes: KubernetesProbe = { onPath: kubectlOnPath };
  if (kubectlOnPath === true) {
    const kubectl = resolveBin('kubectl');
    const current = run(kubectl, ['config', 'current-context'], 5_000);
    if (!current.timedOut && !current.error) {
      const context = current.status === 0 ? current.stdout.trim() || null : null;
      kubernetes = { onPath: true, context };
      if (context !== null) {
        const version = run(kubectl, ['version', '--request-timeout=5s', '-o', 'json'], 8_000);
        const gitVersion = version.timedOut || version.error ? null : parseKubectlServerVersion(version.stdout);
        kubernetes.server = version.timedOut
          ? { kind: 'timeout' }
          : version.error
            ? null
            : gitVersion
              ? { kind: 'ok', gitVersion }
              : { kind: 'no-response', ...(firstLine(version.stderr) ? { detail: firstLine(version.stderr) } : {}) };
      }
    }
  }

  let memory: MemoryProbe | null = null;
  if (options.platform === 'darwin') {
    const size = run('/usr/sbin/sysctl', ['-n', 'hw.memsize'], 3_000);
    const vm = run('/usr/bin/vm_stat', [], 3_000);
    const total = size.status === 0 && /^\d+$/.test(size.stdout.trim()) ? Number(size.stdout.trim()) : null;
    memory = { totalBytes: total, availableBytes: vm.status === 0 ? parseVmStatAvailableBytes(vm.stdout) : null, source: 'sysctl hw.memsize + vm_stat free+inactive' };
  } else if (options.platform === 'linux') {
    const text = readText('/proc/meminfo');
    memory = text === null ? { totalBytes: null, availableBytes: null, source: '/proc/meminfo' } : { ...parseMeminfo(text), source: '/proc/meminfo' };
  }

  return { substrate, docker, kubernetes, memory };
}

function readOsReleaseSafely(lookup: ReadinessLookup): string | null {
  try {
    return (lookup.readOsRelease ?? (() => (existsSync('/etc/os-release') ? readFileSync('/etc/os-release', 'utf8') : null)))();
  } catch {
    return null;
  }
}

/** 외부 명령 보고서의 node-pty 상태(없으면 null). */
function nodePtyStatus(commands: readonly DoctorExternalCommand[]): 'found' | 'missing' | 'broken' | null {
  const status = commands.find((command) => command.name === 'node-pty')?.status;
  return status === 'found' || status === 'missing' || status === 'broken' ? status : null;
}

/** LLM 키(`required_for: [*-llm]`)가 하나라도 풀렸나 — 직접이든 형제 이름으로든. */
export function llmKeyResolvedFrom(credentials: readonly DoctorCredential[]): boolean {
  return credentials.some((credential) => (credential.resolved || credential.satisfiedBy !== undefined)
    && (credential.requiredFor ?? []).some((use) => /llm/i.test(use)));
}

/** 빠졌거나 고장 난 외부 명령 중 처방 문면이 있는 것 — `--fix` 가 자동으로 못 고치므로 «사람 한 줄»로 싣는다(🅢 #20263 ③). */
export function manualCommandFixes(report: DoctorReport): string[] {
  if (!report.ok) return [];
  return report.externalCommands.flatMap((command) => {
    if (command.status !== 'missing' && command.status !== 'broken') return [];
    const fix = command.status === 'broken' ? command.fix_broken ?? command.fix : command.fix;
    return fix ? [`${command.name}: manual — ${fix}`] : [];
  });
}

/** 이 기계의 넥서스 서비스 파일 — macOS launchd plist · Linux systemd user unit. 없으면 null · 다른 플랫폼은 undefined(못 잼). */
/** PATH 의 첫 `codex` 가 셔뱅 스크립트(`#!`)면 true · 바이너리면 false · 못 찾음/못 읽음 = null. */
export function codexIsNodeScript(pathEntries: readonly string[], read: (path: string) => Buffer | null = readHead): boolean | null {
  for (const dir of pathEntries) {
    const head = read(join(dir, 'codex'));
    if (head === null) continue;
    return head.length >= 2 && head[0] === 0x23 && head[1] === 0x21;
  }
  return null;
}

/** PATH 의 첫 codex 의 «실제 경로» 옆에 `codex-code-mode-host` 가 있나(brew cask 는 Caskroom 옆 · 정적 설치는 같은 bin). null = 못 찾음. */
export function codexHasCodeModeHost(pathEntries: readonly string[], fsx: { exists: (p: string) => boolean; realpath: (p: string) => string } = { exists: existsSync, realpath: realpathSync }): boolean | null {
  for (const dir of pathEntries) {
    const candidate = join(dir, 'codex');
    if (!fsx.exists(candidate)) continue;
    try { return fsx.exists(join(dirname(fsx.realpath(candidate)), 'codex-code-mode-host')); } catch { return null; }
  }
  return null;
}

function readHead(path: string): Buffer | null {
  try {
    const fd = openSync(path, 'r');
    try { const buf = Buffer.alloc(2); const n = readSync(fd, buf, 0, 2, 0); return buf.subarray(0, n); } finally { closeSync(fd); }
  } catch { return null; }
}

export function defaultReadServiceFile(platform: NodeJS.Platform, home: string = homedir()): { path: string; text: string } | null | undefined {
  const path = platform === 'darwin'
    ? join(home, 'Library', 'LaunchAgents', 'com.elanous.nexus.plist')
    : platform === 'linux' ? join(home, '.config', 'systemd', 'user', 'elanous-nexus.service') : null;
  if (!path) return undefined;
  if (!existsSync(path)) return null;
  return { path, text: readFileSync(path, 'utf8') };
}

function fixKeyNames(deps: DoctorCliDeps): string[] | undefined {
  try {
    const read = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
    const names = credentialNames(read(join(deps.repositoryRoot ?? repositoryRoot, '.env.example'))).map((name) => name.toLowerCase());
    return names.length ? names : undefined;
  } catch {
    return undefined;
  }
}

function credentialNames(example: string): string[] {
  const names = new Set<string>();
  for (const line of example.split('\n')) {
    const match = line.match(/^\s*(?:#\s*)?([A-Z][A-Z0-9_]*)=/);
    if (match) names.add(match[1]!);
  }
  return [...names];
}

function hasValue(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function loadResourceMetadata(path: string, readFile: (path: string) => string): ResourceMetadataLoad {
  try {
    const parsed = parseYaml(readFile(path)) as { resources?: unknown } | null;
    if (!Array.isArray(parsed?.resources)) return { metadata: new Map(), available: false };
    const metadata = new Map<string, ResourceMetadata>();
    for (const resource of parsed.resources) {
      if (typeof resource !== 'object' || resource === null) continue;
      const entry = resource as { env?: unknown; required_for?: unknown; free_fallback?: unknown; free_fallback_mode?: unknown };
      const env = Array.isArray(entry.env) && entry.env.every((value) => typeof value === 'string')
        ? entry.env as string[]
        : [];
      const requiredFor = Array.isArray(entry.required_for) && entry.required_for.every((value) => typeof value === 'string')
        ? entry.required_for as string[]
        : undefined;
      const freeFallback = typeof entry.free_fallback === 'string' ? entry.free_fallback : undefined;
      const freeFallbackMode = entry.free_fallback_mode === 'auto' || entry.free_fallback_mode === 'manual' || entry.free_fallback_mode === 'none'
        ? entry.free_fallback_mode
        : undefined;
      for (const name of env) {
        metadata.set(name, {
          env,
          ...(requiredFor !== undefined ? { requiredFor } : {}),
          ...(freeFallback !== undefined ? { freeFallback } : {}),
          ...(freeFallbackMode !== undefined ? { freeFallbackMode } : {}),
        });
      }
    }
    return { metadata, available: true };
  } catch {
    return { metadata: new Map(), available: false };
  }
}

function skillEnvHasCredential(text: string, name: string): boolean {
  return text.split('\n').some((line) => {
    const match = line.trim().match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    return match?.[1] === name && hasValue(match[2]);
  });
}

interface ExternalCommandsLoad {
  commands: DoctorExternalCommand[];
  available: boolean;
  reason?: string;
}

function defaultLoadNativeModule(name: string): boolean {
  // 🩸 2026-09-24 빈 VM: 잘못 빌드된 node-pty 를 «이 프로세스»에서 불러오자 bun 이 panic 으로 죽었다(doctor 전체가 core dump).
  //    ⇒ 위치만 여기서 풀고, 불러오기는 자식 프로세스에서 — 죽어도 «못 불러옴»으로 보고한다.
  let resolved: string;
  try { resolved = requireFromHere.resolve(name); } catch { return false; }
  const probe = spawnSync(process.execPath, ['-e', 'require(process.argv[1])', resolved], { encoding: 'utf8', timeout: 30_000 });
  return probe.status === 0;
}

function probeNativeModule(name: string, loadNativeModule: (name: string) => boolean): boolean {
  try {
    return loadNativeModule(name);
  } catch {
    return false;
  }
}

function defaultResolveNativeModuleDir(name: string): string | null {
  try {
    return dirname(requireFromHere.resolve(`${name}/package.json`));
  } catch {
    return null;
  }
}

function defaultIsExecutable(path: string): boolean {
  return (statSync(path).mode & 0o111) !== 0;
}

function nodePtySpawnHelperPath(moduleDir: string): string {
  return join(moduleDir, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper');
}

function probeNativeModuleStatus(
  name: string,
  platform: NodeJS.Platform,
  loadNativeModule: (name: string) => boolean,
  resolveNativeModuleDir: (name: string) => string | null,
  isExecutable: (path: string) => boolean,
): 'found' | 'missing' | 'broken' {
  if (!probeNativeModule(name, loadNativeModule)) return 'missing';
  if (name !== 'node-pty' || platform !== 'darwin') return 'found';
  try {
    const moduleDir = resolveNativeModuleDir(name);
    if (moduleDir == null) return 'found';
    return isExecutable(nodePtySpawnHelperPath(moduleDir)) ? 'found' : 'broken';
  } catch {
    return 'found';
  }
}

function describeUnknownProbe(probe: unknown): string {
  if (typeof probe === 'string') return probe;
  if (typeof probe === 'object' && probe !== null) {
    try {
      return JSON.stringify(probe);
    } catch {
      return stringifyYaml(probe).trimEnd();
    }
  }
  return String(probe);
}

function loadExternalCommands(path: string, readFile: (path: string) => string, commandExists: (name: string) => boolean, discoverChrome: () => string | null, platform: NodeJS.Platform, loadNativeModule: (name: string) => boolean, resolveNativeModuleDir: (name: string) => string | null, isExecutable: (path: string) => boolean): ExternalCommandsLoad {
  let source: string;
  try {
    source = readFile(path);
  } catch (error) {
    return { commands: [], available: false, reason: `could not read catalog/external-commands.yaml: ${error instanceof Error ? error.message : String(error)}` };
  }

  let parsed: { commands?: unknown } | null;
  try {
    parsed = parseYaml(source) as { commands?: unknown } | null;
  } catch (error) {
    return { commands: [], available: false, reason: `could not parse catalog/external-commands.yaml: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!Array.isArray(parsed?.commands)) {
    return { commands: [], available: false, reason: 'catalog/external-commands.yaml has no commands array.' };
  }

  const commands: DoctorExternalCommand[] = [];
  for (const item of parsed.commands) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as { name?: unknown; tier?: unknown; breaks?: unknown; breaks_broken?: unknown; fix?: unknown; fix_broken?: unknown; platform?: unknown; probe?: unknown };
    if (typeof entry.name !== 'string' || typeof entry.tier !== 'string') continue;
    const platformName = typeof entry.platform === 'string' ? entry.platform : undefined;
    const platformOnly = entry.tier === 'platform' && platformName !== undefined;
    const skipped = platformOnly && platformName !== platform;
    const probe = entry.probe === undefined ? 'path' : entry.probe;
    const chromePath = !skipped && probe === 'chrome-discovery' ? discoverChrome() : null;
    const nativeStatus = !skipped && probe === 'native-module'
      ? probeNativeModuleStatus(entry.name, platform, loadNativeModule, resolveNativeModuleDir, isExecutable)
      : 'missing';
    const status = skipped
      ? 'skipped'
      : probe === 'path'
        ? commandExists(entry.name) ? 'found' : 'missing'
        : probe === 'chrome-discovery'
          ? chromePath === null ? 'missing' : 'found'
          : probe === 'native-module'
            ? nativeStatus
            : 'unknown-probe';
    commands.push({
      name: entry.name,
      tier: entry.tier,
      status,
      ...(!skipped && chromePath !== null
        ? { detail: chromePath }
        : !skipped && probe !== 'path' && probe !== 'chrome-discovery' && probe !== 'native-module'
          ? { detail: describeUnknownProbe(probe) }
          : {}),
      ...(typeof entry.breaks === 'string' && !skipped ? { breaks: entry.breaks } : {}),
      ...(typeof entry.breaks_broken === 'string' && !skipped ? { breaks_broken: entry.breaks_broken } : {}),
      ...(typeof entry.fix === 'string' && !skipped ? { fix: entry.fix } : {}),
      ...(typeof entry.fix_broken === 'string' && !skipped ? { fix_broken: entry.fix_broken } : {}),
      ...(platformName !== undefined ? { platform: platformName } : {}),
    });
  }
  return { commands, available: true };
}

function describe(source: CredentialSource): string {
  switch (source) {
    case 'env': return 'resolved from environment';
    case 'cache': return 'resolved from credential cache';
    case 'skill-env': return 'resolved from skill .env';
    case 'user-config': return 'resolved from elanous user config';
    case 'unresolved': return 'not configured in a supported source';
  }
}

function sourceFor(name: string, options: Required<Pick<DoctorOptions, 'env' | 'cacheDir' | 'tavilyEnvFile' | 'userConfig' | 'readFile' | 'exists'>>): CredentialSource {
  if (name === 'FIRECRAWL_API_KEY' && hasValue(options.userConfig.registry.discovery.firecrawl.apiKey)) return 'user-config';

  const cachePath = join(options.cacheDir, name.toLowerCase());
  if (!options.env.ELANOUS_KEEP_ENV_KEYS && options.exists(cachePath) && hasValue(options.readFile(cachePath))) return 'cache';

  if (hasValue(options.env[name])) return 'env';

  if (tavilyNames.has(name) && options.exists(options.tavilyEnvFile) && skillEnvHasCredential(options.readFile(options.tavilyEnvFile), name)) return 'skill-env';

  return 'unresolved';
}

/**
 * Partitions mapped credentials plus unresolved unmapped credentials for the
 * capability summary. Resolved unmapped credentials remain in the existing
 * per-credential detail because the catalog supplies no capability to name.
 */
function hasMappedCapabilities(credential: DoctorCredential): credential is DoctorCredential & { requiredFor: string[] } {
  return credential.requiredFor !== undefined && credential.requiredFor.length > 0;
}

export function summarizeDoctorCapabilities(credentials: readonly DoctorCredential[]): DoctorCapabilitySummary {
  const available: DoctorCapability[] = [];
  const unavailable: DoctorCapability[] = [];
  const unknownCredentials: string[] = [];
  for (const credential of credentials) {
    if (!hasMappedCapabilities(credential)) {
      // ⛔ «풀렸는지»로 거르지 않는다. 자격이 풀렸어도 지도가 그 자격의 «능력 이름»을 안 갖고 있으면
      //    「무엇을 푸는지 모른다」가 맞는 답이고, 그것을 「할 수 있다」로도 「못 한다」로도 접으면 거짓이다.
      //    📏 2026-09-21 실측: 이 가드 때문에 ANTHROPIC_API_KEY·OPENAI_API_KEY·EODHD_API_KEY·
      //       GEMINI_API_KEY 넷이 세 묶음 «어디에도» 안 들어가 조용히 사라졌다.
      //    ⇒ 먼저 「이름이 있나」로 가르고, 이름이 있을 때만 「자격이 풀렸나」로 가른다.
      unknownCredentials.push(credential.name);
      continue;
    }
    const capabilities = credential.requiredFor.map((name) => ({
      credential: credential.name,
      name,
      ...(credential.freeFallback !== undefined ? { freeFallback: credential.freeFallback } : {}),
    }));
    (credential.resolved ? available : unavailable).push(...capabilities);
  }
  return { available, unavailable, unknownCredentials };
}

function gitPlanFor(options: DoctorOptions) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const has = options.commandExists ?? ((name: string) => {
    const extensions = platform === 'win32'
      ? (env.PATHEXT?.split(';').filter(Boolean).map((extension) => extension.toLowerCase()) ?? ['.com', '.exe', '.bat', '.cmd'])
      : [''];
    return (env.PATH ?? '').split(options.pathDelimiter ?? delimiter).some((dir) =>
      dir.length > 0 && extensions.some((extension) => exists(join(dir, `${name}${extension}`))));
  });
  let distro: string | undefined = options.readiness?.distro;
  if (platform === 'linux' && (!distro || distro === 'unknown')) {
    try {
      const fields = parseOsRelease((options.readFile ?? ((path) => readFileSync(path, 'utf8')))('/etc/os-release'));
      distro = fields.ID?.toLowerCase();
      if (!distro || distro === 'unknown') distro = detectDistroFamily(platform, `ID_LIKE=${fields.ID_LIKE ?? ''}`);
    } catch { distro = undefined; }
  }
  return gitInstallPlan({ platform, distro, has, isRoot: options.isRoot ?? (typeof process.getuid === 'function' && process.getuid() === 0) });
}

export function runDoctor(options: DoctorOptions = {}): DoctorReport {
  const root = options.repositoryRoot ?? repositoryRoot;
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const exists = options.exists ?? existsSync;
  const pathDelimiter = options.pathDelimiter ?? delimiter;
  const platform = options.platform ?? process.platform;
  const commandExists = options.commandExists ?? ((name: string) => {
    const hasExtension = /\.[^./\\]+$/.test(name);
    const pathExtensions = env.PATHEXT?.split(';').filter(Boolean).map((extension) => extension.toLowerCase());
    const extensions = platform === 'win32' && !hasExtension
      ? pathExtensions?.length ? pathExtensions : ['.com', '.exe', '.bat', '.cmd']
      : [''];
    return (env.PATH ?? '').split(pathDelimiter).some((directory) =>
      directory.length > 0 && extensions.some((extension) => exists(join(directory, `${name}${extension}`))),
    );
  });
  const discoverChrome = options.discoverChromeBinary ?? discoverChromeBinary;
  const loadNativeModule = options.loadNativeModule ?? defaultLoadNativeModule;
  const resolveNativeModuleDir = options.resolveNativeModuleDir ?? defaultResolveNativeModuleDir;
  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  const getConfig = options.getUserConfig ?? getUserConfig;
  try {
    const names = credentialNames(readFile(join(root, '.env.example')));
    if (names.length === 0) return { ok: false, credentials: [], externalCommands: [], reason: 'Credential definitions are empty.' };
    const resourceMetadata = loadResourceMetadata(join(root, 'catalog', 'resources.yaml'), readFile);
    const externalCommands = loadExternalCommands(join(root, 'catalog', 'external-commands.yaml'), readFile, commandExists, discoverChrome, platform, loadNativeModule, resolveNativeModuleDir, isExecutable);

    const resolutionOptions = {
      env,
      cacheDir: options.cacheDir ?? (env.ELANOUS_KEY_CACHE_DIR?.trim() || join(homedir(), '.cache')),
      tavilyEnvFile: options.tavilyEnvFile ?? env.TAVILY_ENV_FILE ?? join(homedir(), '.claude', 'skills', 'omni-crawl', '.env'),
      userConfig: options.userConfig ?? getConfig(),
      readFile,
      exists,
    };
    const credentials: DoctorCredential[] = names.map((name) => {
      const source = sourceFor(name, resolutionOptions);
      const metadata = resourceMetadata.metadata.get(name);
      return {
        name,
        resolved: source !== 'unresolved',
        source,
        note: describe(source),
        ...(metadata?.requiredFor !== undefined ? { requiredFor: metadata.requiredFor } : {}),
        ...(metadata?.freeFallback !== undefined ? { freeFallback: metadata.freeFallback } : {}),
        ...(metadata?.freeFallbackMode !== undefined ? { freeFallbackMode: metadata.freeFallbackMode } : {}),
      };
    });
    for (const credential of credentials) {
      if (credential.source !== 'unresolved') continue;
      const metadata = resourceMetadata.metadata.get(credential.name);
      const sibling = metadata?.env
        .filter((name) => name !== credential.name)
        .map((name) => ({ name, source: sourceFor(name, resolutionOptions) }))
        .find((candidate): candidate is { name: string; source: Exclude<CredentialSource, 'unresolved'> } => candidate.source !== 'unresolved');
      if (sibling) credential.satisfiedBy = sibling;
    }
    const requiredMissing = externalCommands.commands
      .filter((command) => command.tier === 'required' && (command.status === 'missing' || command.status === 'broken'))
      .map((command) => command.name);
    const missingGit = externalCommands.commands.find((command) => command.name === 'git' && command.status === 'missing');
    if (missingGit) missingGit.fix = gitPlanFor(options).display;
    const evaluateReadiness = options.checkReadiness ?? checkReadiness;
    const readiness = options.readiness !== undefined
      ? options.readiness
      : resolveReadinessDeps({
        env,
        pathDelimiter,
        platform,
        commandExists,
        getConfig: () => resolutionOptions.userConfig,
        codeRevision: options.codeRevision ?? defaultCodeRevision,
        fetchHealth: options.fetchHealth ?? (() => defaultFetchHealth(options.resolveDaemonEndpoint ?? resolveDaemonEndpoint)),
        readInstallPrefix: options.readInstallPrefix ?? (() => defaultReadInstallPrefix(root, exists)),
        bunPin: options.bunPin ?? (() => readBunPin(root)),
        ghAuthStatus: options.ghAuthStatus ?? (() => defaultGhAuthStatus(commandExists)),
        ghVersion: options.ghVersion ?? (() => defaultGhVersion(commandExists)),
        tmpdirSameFsAsBunCache: options.tmpdirSameFsAsBunCache ?? (() => defaultTmpdirSameFsAsBunCache(env)),
        nodePty: nodePtyStatus(externalCommands.commands),
        ...(options.probeBuildToolchain ? { probeBuildToolchain: options.probeBuildToolchain } : {}),
        ...(options.checkPythonEnv ? { checkPythonEnv: options.checkPythonEnv } : {}),
        ...(options.probeHostEnvironment ? { probeHostEnvironment: options.probeHostEnvironment } : {}),
      });
    // An injected readiness snapshot stays as-is. For a real machine, measure the
    // same runtime route as `start` rather than inferring usability from key names.
    if (options.readiness === undefined && readiness.provider !== null) {
      try { readiness.usableLlm = options.resolveLlm ? options.resolveLlm() : resolveUsableLlm({ config: resolutionOptions.userConfig }); }
      catch { readiness.usableLlm = null; }
    }
    return {
      ok: true,
      credentials,
      externalCommands: externalCommands.commands,
      requiredMissing,
      capabilitySummary: summarizeDoctorCapabilities(credentials),
      modes: describeModes(resolutionOptions.userConfig),
      readiness: evaluateReadiness(readiness),
      retiredConfigKeys: findRetiredConfigKeysInFile(options.configPath, readFile),
      ...(resourceMetadata.available ? {} : { catalogMetadataUnavailable: true }),
      ...(externalCommands.available ? {} : {
        externalCommandsCatalogUnavailable: true,
        ...(externalCommands.reason !== undefined ? { externalCommandsCatalogReason: externalCommands.reason } : {}),
      }),
    };
  } catch {
    return { ok: false, credentials: [], externalCommands: [], reason: 'Could not build credential report from local configuration.' };
  }
}

function formatReadiness(readiness: ReadinessReport | undefined): string[] {
  if (readiness === undefined) return [];
  const todo = readiness.items.filter((entry) => entry.status === 'manual' || entry.status === 'fixable');
  return [
    'Readiness:',
    ...readiness.items.map((entry) => {
      const remedy = entry.remedy === undefined ? '' : ` — ${entry.remedy}`;
      return `  ${entry.id}: ${entry.status} — ${entry.evidence}${remedy}`;
    }),
    todo.length === 0
      ? 'Nothing to do.'
      : `To do (${todo.length}): ${todo.map((entry) => entry.id).join(', ')} — each line above ends with its fix`,
  ];
}

function humanFreeFallback(value: string): string {
  return value.replace(/\s+/g, ' ')
    .split(/\b(?:MEASURED|CHANGED)\s*(?::|\d{4}-\d{2}-\d{2})/i, 1)[0]!
    .replace(/\(📏[^)]*\)/g, '')
    .replace(/\s*[—–·]\s*(?:src|skills|scripts|catalog|test)\/.*$/g, '')
    .replace(/\([^)]*\b(?:src|skills|scripts|catalog|test)\/[\w./:-]+[^)]*\)/g, '')
    .replace(/\b(?:src|skills|scripts|catalog|test)\/[\w./:-]+|\b[\w-]+\.ts(?::\d+)?/g, '')
    .replace(/\s{2,}/g, ' ').trim().replace(/[—–·;,\s]+$/, '');
}

export function humanBreaks(value: string): string | undefined {
  if (value.trim().toLowerCase() === 'unmeasured'
    || /\b\d+ test (failures|errors)\b|\bmeasured\b|\bpostmortem\b|\bquota\b/i.test(value)
    || /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(value)) return undefined;
  return humanFreeFallback(value) || undefined;
}

function formatCapabilitySummary(summary: DoctorCapabilitySummary): string[] {
  const unavailable = summary.unavailable.map((capability) =>
    `  ${capability.name} — unlock with ${capability.credential}${capability.freeFallback !== undefined && humanFreeFallback(capability.freeFallback) ? `; free alternative: ${humanFreeFallback(capability.freeFallback)}` : ''}`,
  );
  return [
    'Available:',
    ...(summary.available.length === 0 ? ['  None.'] : summary.available.map((capability) => `  ${capability.name} — unlocked by ${capability.credential}`)),
    'Unavailable:',
    ...(unavailable.length === 0 ? ['  None.'] : unavailable),
    'Unknown by credential:',
    ...(summary.unknownCredentials.length === 0 ? ['  Empty.'] : summary.unknownCredentials.map((credential) => `  ${credential}`)),
  ];
}

export function formatDoctorReport(report: DoctorReport, options: { credentials?: boolean } = {}): string {
  if (!report.ok) return `Doctor failed: ${report.reason ?? 'unknown error'}`;
  const capabilitySummary = report.capabilitySummary ?? summarizeDoctorCapabilities(report.credentials);
  const requiredMissing = report.requiredMissing ?? report.externalCommands
    .filter((command) => command.tier === 'required' && (command.status === 'missing' || command.status === 'broken'))
    .map((command) => command.name);
  const resolved = report.credentials.filter((credential) => credential.resolved).length;
  const satisfied = report.credentials.filter((credential) => !credential.resolved && credential.satisfiedBy !== undefined).length;
  return [
    ...formatReadiness(report.readiness),
    ...(requiredMissing.length ? [`⛔ Required commands missing: ${requiredMissing.join(', ')}`] : []),
    `Credentials: ${resolved}/${report.credentials.length} resolved${satisfied ? ` · ${satisfied} satisfied by alternative names` : ''} · details: elanous doctor --credentials`,
    ...(options.credentials ? report.credentials.map((credential) => [
      `${credential.name}: ${credential.resolved ? 'resolved' : 'unresolved'} (${credential.source}) — ${credential.note}`,
      ...(credential.satisfiedBy !== undefined ? [`  Satisfied by: ${credential.satisfiedBy.name} (${credential.satisfiedBy.source})`] : []),
      ...(credential.requiredFor !== undefined ? [`  Required for: ${credential.requiredFor.join(', ')}`] : []),
      ...(credential.freeFallback !== undefined ? [`  Free fallback${credential.freeFallbackMode === 'auto' || credential.freeFallbackMode === 'manual' || credential.freeFallbackMode === 'none' ? ` [${credential.freeFallbackMode}]` : ''}: ${humanFreeFallback(credential.freeFallback)}`] : []),
    ].join('\n')) : []),
    ...(report.catalogMetadataUnavailable ? ['Catalog metadata unavailable: could not read catalog/resources.yaml.'] : []),
    ...(report.retiredConfigKeys ?? []).map(({ path, reason }) => `Retired config key: ${path} — ${reason}`),
    'External commands:',
    ...report.externalCommands.map((command) => {
      const breaks = command.status === 'broken' ? command.breaks_broken ?? command.breaks : command.breaks;
      const visibleBreaks = breaks === undefined ? undefined : humanBreaks(breaks);
      const fix = command.status === 'broken' ? command.fix_broken ?? command.fix : command.fix;
      return [
        `${command.name}: ${command.status === 'skipped' ? `skipped (${command.platform}-only)` : `${command.status} (${command.tier})`}${command.detail === undefined ? '' : ` — ${command.detail}`}`,
        ...((command.status === 'missing' || command.status === 'broken') && visibleBreaks !== undefined ? [`  Breaks: ${visibleBreaks}`] : []),
        ...((command.status === 'missing' || command.status === 'broken') && fix !== undefined ? [`  Fix: ${fix}`] : []),
      ].join('\n');
    }),
    ...(report.externalCommandsCatalogUnavailable ? [`External commands catalog unavailable: ${report.externalCommandsCatalogReason ?? 'catalog/external-commands.yaml is unavailable.'}`] : []),
    ...formatCapabilitySummary(capabilitySummary),
    ...(report.modes ? ['모드:', ...report.modes.map((row) => `  ${formatModeLine(row)}`)] : []),
  ].join('\n');
}

async function requestDoctorAdvice(report: DoctorReport, plan: ReturnType<typeof planDoctorFixes>, deps: DoctorCliDeps): Promise<DoctorAdvice & { provider: string; model: string; ms: number }> {
  const started = Date.now();
  const locale = detectLocale(process.env);
  let provider = 'auto';
  let model = '(none)';
  const failure = (reason: string) => ({ ok: false, reason, summary: '', order: [], manual: [], dropped: 0, provider, model, ms: Date.now() - started });
  const log = (event: 'requested' | 'advised' | 'failed', orderCount = 0, dropped = 0) =>
    debug.log('doctor.advise', event, { provider, model, locale, ms: Date.now() - started, orderCount, dropped, applied: 0 });
  log('requested');
  try {
    const config = deps.userConfig ?? (deps.getUserConfig ?? getUserConfig)();
    const llm = await import('../llm.js');
    const selected = (deps.resolveAdviceProvider ?? llm.decideProviderForConfig)(config);
    provider = selected.provider.replace(/^auto:/, '');
    model = selected.model;
    if (selected.auth === 'none' || provider === 'auto' || !llm.PROVIDERS[provider]) {
      log('failed');
      const remedy = report.readiness?.items.find((item) => item.id === 'provider-decision')?.remedy ?? 'elanous login openai-codex';
      return failure(`LLM 없음 — 구독이 있으면 \`elanous llm detect --probe --apply\`, 없으면 \`${remedy}\`(기기 코드) 뒤 다시 \`elanous doctor --advise\``);
    }
    const advice = await adviseDoctorFixes({
      locale,
      report: report.readiness ?? { items: [] },
      plan: { ...plan, items: plan.items.filter((item) => item.status === 'fixable' && ADVISABLE_DOCTOR_FIX_IDS.has(item.id)) },
      llm: (prompt) =>
      deps.adviseLlm ? deps.adviseLlm(prompt, provider, model) : llm.streamLLM([
        { role: 'system', content: 'Read-only diagnosis. Return JSON only. Never execute commands.' },
        { role: 'user', content: prompt },
      ], () => {}, { provider: llm.PROVIDERS[provider], model }),
    });
    log(advice.ok ? 'advised' : 'failed', advice.order.length, advice.dropped);
    return { ...advice, provider, model, ms: Date.now() - started };
  } catch {
    log('failed');
    return failure('LLM failed or timed out');
  }
}

function formatDoctorAdvice(advice: DoctorAdvice): string {
  if (!advice.ok) return advice.reason ?? 'LLM failed or timed out';
  return [
    `LLM 조언: ${advice.summary}`,
    '순서  항목  수리 id  이유',
    ...advice.order.map((entry, index) => `${index + 1}.  ${entry.readinessId}  ${entry.fixId ?? '사람 할 일'}  ${entry.why}`),
    ...advice.manual.map((entry) => `사람 할 일: ${entry}`),
    `버린 제안 ${advice.dropped}개`,
  ].join('\n');
}

async function confirmDoctorAdvice(message: string, json: boolean): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: json ? process.stderr : process.stdout });
  try { return /^(y|yes)$/i.test((await prompt.question(message)).trim()); }
  catch { return false; }
  finally { prompt.close(); }
}

export function registerDoctorCommand(program: Command, deps: DoctorCliDeps = {}): void {
  const out = deps.out ?? { log: (value: string) => console.log(value) };
  const err = deps.err ?? { error: (value: string) => console.error(value) };
  const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  program.command('doctor')
    .description('Reports whether credentials resolve and where each resolution comes from')
    .option('--json', 'structured output')
    .option('--credentials', 'show per-credential details in human-readable output')
    .option('--fix', 'show repairs; git installation asks on a TTY (other repairs require --yes)')
    .option('--advise', 'ask the configured LLM to rank catalog repairs (read-only advice)')
    .option('--yes', 'apply planned doctor repairs (requires --fix)')
    .option('--sudo', 'also run the planned sudo install lines — only where `sudo -n true` works (requires --fix --yes)')
    .option('--restart', 'restart the nexus service when it runs a different version than this installed copy, then verify it (requires --fix --yes · interrupts bots, terminals and running turns)')
    .action(async (opts: { json?: boolean; credentials?: boolean; fix?: boolean; advise?: boolean; yes?: boolean; sudo?: boolean; restart?: boolean }) => {
      if (opts.yes && !opts.fix) {
        err.error('--yes requires --fix');
        setExitCode(1);
        return;
      }
      if (opts.advise && (opts.sudo || opts.restart)) {
        err.error('--advise does not run --sudo or --restart; use the deterministic --fix path for those actions');
        setExitCode(1);
        return;
      }
      if (opts.sudo && !(opts.fix && opts.yes)) {
        err.error('--sudo requires --fix --yes');
        setExitCode(1);
        return;
      }
      if (opts.restart && !(opts.fix && opts.yes)) {
        err.error('--restart requires --fix --yes');
        setExitCode(1);
        return;
      }
      const report = runDoctor(deps);
      if (!report.ok) {
        err.error(report.reason ?? 'Could not build credential report.');
        setExitCode(1);
        return;
      }
      if (!opts.fix && !opts.advise) {
        out.log(opts.json ? JSON.stringify(report, null, 2) : formatDoctorReport(report, { credentials: opts.credentials }));
        if (report.requiredMissing?.length) setExitCode(1);
        return;
      }
      const makeFixes = (source: DoctorReport): DoctorFixDeps => ({
        env: deps.env,
        home: deps.home,
        cacheDir: deps.cacheDir,
        readdir: deps.readdir,
        readiness: deps.readiness ?? { ...resolveReadinessDeps({
          env: deps.env ?? process.env,
          pathDelimiter: deps.pathDelimiter ?? delimiter,
          platform: deps.platform ?? process.platform,
          commandExists: deps.commandExists ?? ((name) => (deps.env ?? process.env).PATH?.split(deps.pathDelimiter ?? delimiter).some((dir) => existsSync(join(dir, name))) ?? false),
          getConfig: () => deps.userConfig ?? (deps.getUserConfig ?? getUserConfig)(),
          codeRevision: deps.codeRevision ?? defaultCodeRevision,
          fetchHealth: deps.fetchHealth ?? (() => defaultFetchHealth(deps.resolveDaemonEndpoint ?? resolveDaemonEndpoint)),
          readInstallPrefix: deps.readInstallPrefix ?? (() => defaultReadInstallPrefix(deps.repositoryRoot ?? repositoryRoot, deps.exists ?? existsSync)),
          ghAuthStatus: deps.ghAuthStatus ?? (() => null),
          // gh 판은 수리 계획에 쓰인다(낡은 gh → 정적 gh) — 🩸 09-25: 여기서 안 재서 계획은 보고서에만 뜨고 적용이 안 됐다.
          ghVersion: deps.ghVersion ?? (() => defaultGhVersion((name) => (deps.env ?? process.env).PATH?.split(deps.pathDelimiter ?? delimiter).some((dir) => existsSync(join(dir, name))) ?? false)),
          tmpdirSameFsAsBunCache: deps.tmpdirSameFsAsBunCache ?? (() => defaultTmpdirSameFsAsBunCache(deps.env ?? process.env)),
          ...(source.ok ? { nodePty: nodePtyStatus(source.externalCommands) } : {}),
          // L0 칸(substrate·docker·kubernetes·memory)은 «정보성·선택 기능»이라 수리 계획에 싣지 않는다 —
          // `--sudo` 가 `sudo systemctl start docker` 를 «설치 줄»로 치지 않게 하고, docker·kubectl 탐침(최대 수 초)을 두 번 돌리지 않는다.
          // 보고서(`runDoctor`)에는 그대로 나온다.
          probeHostEnvironment: () => null,
        }), usableLlm: (() => {
          try { return deps.resolveLlm ? deps.resolveLlm() : resolveUsableLlm({ config: deps.userConfig ?? (deps.getUserConfig ?? getUserConfig)() }); }
          catch { return null; }
        })() },
        exists: deps.exists,
        readFile: deps.readFile,
        writeFile: deps.writeFile,
        appendFile: deps.appendFile,
        mkdir: deps.mkdir,
        lstat: deps.lstat,
        chmod: deps.chmod,
        rename: deps.rename,
        remove: deps.remove,
        temporaryPath: deps.temporaryPath,
        installStaticTool: deps.installStaticTool,
        smokeCheck: deps.smokeCheck,
        pythonSetup: deps.pythonSetup,
        recheckPythonEnv: deps.recheckPythonEnv,
        // 키 캐시에서 다룰 이름 = doctor 가 보고하는 자격 이름(같은 `.env.example` · 소문자) — 다른 프로그램 캐시는 안 건드린다.
        keyNames: fixKeyNames(deps),
      });
      const fixes = makeFixes(report);
      // Planning never writes; existing repairs require --yes, while git alone can use affirmative TTY consent.
      const plan = planDoctorFixes(fixes);
      const advice = opts.advise ? await requestDoctorAdvice(report, plan, deps) : undefined;
      if (!opts.fix) {
        out.log(opts.json
          ? JSON.stringify({ ...report, advise: advice }, null, 2)
          : [formatDoctorReport(report, { credentials: opts.credentials }), formatDoctorAdvice(advice!)].join('\n'));
        if (report.requiredMissing?.length) setExitCode(1);
        return;
      }
      const selected = advice?.ok
        ? new Set<DoctorFixItem['id']>(advice.order.flatMap((entry): DoctorFixItem['id'][] => entry.fixId && entry.fixId !== 'git-install' && ADVISABLE_DOCTOR_FIX_IDS.has(entry.fixId) ? [entry.fixId] : []))
        : undefined;
      const selectedGit = advice?.ok ? advice.order.some((entry) => entry.fixId === 'git-install') : true;
      const selectedCount = plan.items.filter((item) => item.status === 'fixable' && selected?.has(item.id)).length
        + (selectedGit && advice?.ok && report.externalCommands.some((command) => command.name === 'git' && command.status === 'missing') ? 1 : 0);
      const interactive = deps.adviceInteractive ?? (process.stdin.isTTY === true && (opts.json ? process.stderr.isTTY === true : process.stdout.isTTY === true));
      if (advice?.ok && !opts.yes && interactive && selectedCount > 0) {
        const preview = formatDoctorAdvice(advice);
        if (opts.json) err.error(preview);
        else out.log(preview);
      }
      const agreed = advice?.ok && !opts.yes && interactive && selectedCount > 0
        ? await (deps.confirmAdvice ?? ((message) => confirmDoctorAdvice(message, opts.json === true)))(`위 ${selectedCount}개를 실행할까요? [y/N] `)
        : false;
      const applySelected = opts.yes || agreed;
      const gitPlan = report.externalCommands.some((command) => command.name === 'git' && command.status === 'missing') ? gitPlanFor(deps) : undefined;
      const installGit = () => applyGitInstall(gitPlan!, {
        yes: advice?.ok ? applySelected : opts.yes,
        interactive: advice?.ok ? false : deps.gitInteractive ?? (process.stdin.isTTY === true && (opts.json ? process.stderr.isTTY === true : process.stdout.isTTY === true)),
        confirm: deps.confirmGitInstall,
        run: deps.runGitInstallCommand,
        platform: deps.platform ?? process.platform,
        json: opts.json,
      });
      // P5: sudo 설치 줄을 «먼저» 친다 — 빌드 도구가 서야 뒤의 node-pty 재빌드가 된다.
      const sudoResult = opts.sudo ? (deps.applySudoFixes ?? applySudoFixes)(plan.manual) : undefined;
      // sudo 로 뭔가 깔았으면 보고서·준비 상태를 «다시 잰다» — 빌드 도구가 선 뒤에야 node-pty 재빌드가 계획에 오른다.
      const afterSudo = sudoResult?.runs.some((entry) => entry.result === 'ran') ? makeFixes(runDoctor(deps)) : fixes;
      let gitInstall: Awaited<ReturnType<typeof applyGitInstall>> | undefined;
      let results: ReturnType<typeof applyDoctorFixes> | undefined;
      if (advice?.ok && applySelected) {
        // Invoke only known catalog operations, in the vetted order (including git).
        const appliedItems: NonNullable<typeof results>['items'] = [];
        for (const entry of advice.order) {
          if (entry.fixId === 'git-install') {
            if (gitPlan) gitInstall = await installGit();
          } else if (entry.fixId && selected?.has(entry.fixId)) {
            const single = applyDoctorFixes(afterSudo, true, new Set([entry.fixId]));
            appliedItems.push(...single.items.filter((item) => item.id === entry.fixId));
          }
        }
        const remaining = applyDoctorFixes(afterSudo, false, new Set<DoctorFixItem['id']>());
        results = { items: [...appliedItems, ...remaining.items.filter((item) => !selected?.has(item.id))], exitCode: appliedItems.some((item) => item.result === 'failed') ? 1 : 0 };
      } else {
        gitInstall = gitPlan && selectedGit ? await installGit() : undefined;
        results = applySelected ? applyDoctorFixes(afterSudo, true, selected) : undefined;
      }
      if (advice?.ok && (results || gitInstall?.ran)) debug.log('doctor.advise', 'applied', {
        provider: advice.provider, model: advice.model, locale: detectLocale(process.env), ms: advice.ms, orderCount: advice.order.length,
        dropped: advice.dropped, applied: (results?.items.filter((item) => item.result === 'fixed').length ?? 0) + (gitInstall?.ran && gitInstall.ok ? 1 : 0),
      });
      // D5: 다른 수리가 다 끝난 «뒤» 재시작 — 서비스 파일을 고쳤으면 그 판으로 뜬다.
      const restartResult = opts.restart && afterSudo.readiness
        ? await (deps.applyServiceRestart ?? applyServiceRestart)({ readiness: afterSudo.readiness })
        : undefined;
      // PATH cannot change in this process; re-probe readiness rather than treating a saved block as PATH=ok.
      const currentReport = results || gitInstall?.ran ? runDoctor(deps) : report;
      if (gitInstall?.ran && gitInstall.ok && currentReport.requiredMissing?.includes('git')) {
        gitInstall.detail = 'git init 성공 · 현재 doctor PATH 에서 git 을 찾지 못했습니다. 새 셸에서 다시 확인하세요.';
      }
      if (opts.json) out.log(JSON.stringify({ report: currentReport, plan, manualCommands: manualCommandFixes(currentReport), ...(gitPlan ? { gitPlan, gitInstall } : {}), ...(sudoResult ? { sudo: sudoResult } : {}), ...(results ? { results } : {}), ...(restartResult ? { restart: restartResult } : {}), ...(advice ? { advise: advice } : {}) }, null, 2));
      else out.log([
        formatDoctorReport(currentReport, { credentials: opts.credentials }),
        ...(advice ? [formatDoctorAdvice(advice)] : []),
        'Fix plan:',
        ...plan.items.map((item) => `  ${item.id}: ${item.status} — ${item.path} — ${item.action}${item.reason ? ` — ${item.reason}` : ''}`),
        ...plan.manual.map((item) => `  ${item.id}: manual${item.remedy ? ` — ${item.remedy}` : ''}`),
        ...manualCommandFixes(currentReport).map((line) => `  ${line}`),
        ...(gitInstall ? [`Git installation: ${gitInstall.detail}${gitPlan?.note ? ` — ${gitPlan.note}` : ''}`] : []),
        ...(sudoResult ? [sudoResult.sudoAvailable
          ? `Sudo installation: ${sudoResult.runs.length ? sudoResult.runs.map((entry) => `${entry.result} — ${entry.command}${entry.detail ? ` — ${entry.detail}` : ''}`).join(' · ') : '칠 줄 없음'}`
          : 'Sudo installation: 건너뜀 — 이 기계는 sudo 에 암호가 필요하다(sudo -n true 실패). 위 «manual» 줄을 직접 치세요.'] : []),
        ...(results ? ['Applied:', ...results.items.map((item) => `  ${item.id}: ${item.result} — ${item.path}${item.reason ? ` — ${item.reason}` : ''}`)] : ['적용하려면 --fix --yes']),
        ...(restartResult ? [`Service restart: ${restartResult.result} — ${restartResult.reason}`] : []),
      ].join('\n'));
      const exitCode = Math.max(results?.exitCode ?? 0, sudoResult?.exitCode ?? 0, restartResult?.result === 'failed' ? 1 : 0, currentReport.requiredMissing?.length ? 1 : 0, gitInstall?.ran && !gitInstall.ok ? 1 : 0);
      if (results || exitCode) setExitCode(exitCode);
    });
}
