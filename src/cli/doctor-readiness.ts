import { remediesFor, type DistroFamily } from './doctor-distro.js';
import { providerSecretNames } from '../nexus/install/launchd.js';
import { win32 } from 'node:path';
/**
 * F1 readiness — read-only detection for the four places a new user actually falls.
 * Every external lookup is an injected dependency. This module never writes and
 * never returns a credential value.
 *
 * Remedy lines that the goal text does not spell out come from existing conventions,
 * and only when the platform that makes that command runnable is known:
 * - gh missing on linux: `내부 문서 `MANUAL-environment-setup-by-platform-2026-09-20``
 *   (`sudo apt-get install -y … gh …`). macOS uses Homebrew (`brew install gh`);
 *   Windows uses winget. An unmeasured platform omits the remedy — a sentence
 *   is not a command the person can type.
 * - install PATH: `scripts/install.sh` PATH block
 *   (`export PATH=$(shell_quote "$PREFIX/bin"):"\$PATH"`). The prefix is quoted;
 *   `$PATH` stays outside the quotes so the shell expands the existing PATH.
 * - service restart, darwin only: `내부 문서 `RFC-install-cutover-pilot-to-installed-2026-09-24``
 *   and `src/autopilot/daemon-control.ts`
 *   (`launchctl kickstart -k gui/$(id -u)/com.elanous.nexus`).
 *   linux: `src/nexus/install/systemd.ts` (`systemctl --user restart elanous-nexus`).
 *   An omitted platform does not assume darwin.
 */

export type ReadinessStatus = 'ok' | 'fixable' | 'manual' | 'unknown';

export interface ReadinessItem {
  id: string;
  status: ReadinessStatus;
  evidence: string;
  remedy?: string;
}

export interface ReadinessReport {
  items: ReadinessItem[];
}

export interface ReadinessDeps {
  /**
   * Configured `llm.provider`. `null` means the value was not measured.
   * Absent is the configured default `auto` (callers that did not look it up
   * must pass `null` rather than omit it).
   */
  provider?: string | null;
  /**
   * Codex subscription login is present. `null` means not measured.
   * The token itself is never passed in.
   */
  codexLogin?: boolean | null;
  /** LLM 을 부를 자격이 «하나라도» 있나(어떤 로그인이든 · LLM 키가 풀렸든). 없으면(undefined/null) 못 쟀다. */
  llmCredentialAvailable?: boolean | null;
  /** `gh` is on PATH. `null` means not measured. */
  ghOnPath?: boolean | null;
  /** `gh --version` 의 판 · null/undefined = 못 쟀다. */
  ghVersion?: string | null;
  /**
   * Exit status of `gh auth status`. `null` means the command could not be run
   * or was not measured. Ignored when `ghOnPath` is false.
   */
  ghAuthStatus?: number | null;
  /** Harness commands on PATH. null/undefined means not measured. */
  rgOnPath?: boolean | null;
  codexOnPath?: boolean | null;
  /** Codex CLI uses a node shebang; null/undefined means not measured. */
  nodeOnPath?: boolean | null;
  /** PATH 의 codex 가 node 스크립트인가(false = 정적 바이너리 → node 불필요) · null/undefined = 못 쟀다. */
  codexNeedsNode?: boolean | null;
  /** codex 가 바이너리일 때 그 실제 경로 옆에 `codex-code-mode-host` 가 있나 · null/undefined = 못 쟀거나 해당 없음(npm 스크립트). */
  codexCodeModeHost?: boolean | null;
  /**
   * Install prefix when this process is the installed copy (`install.json` present).
   * `null` means a checkout was confirmed — PATH is not required.
   * Absent means not measured. A failed lookup must stay absent, not become `null`:
   * failing to read the install is not evidence of a checkout.
   */
  installPrefix?: string | null;
  /** PATH directories, already split. Absent means PATH was not measured. */
  pathEntries?: readonly string[] | null;
  /**
   * Real path of the first `elanous` found on PATH. `null` = none found · absent = not measured.
   * 🩸 2026-09-24: 전역 `~/.bun/bin/elanous` 가 설치본으로 링크돼 있어도 «설치본 bin 이 PATH 에 없다»고 fixable 을 냈다.
   */
  elanousOnPath?: string | null;
  /**
   * Parsed `/v1/health` body. `null` means no response — not "the service is down".
   * Absent means the probe was not run.
   */
  health?: { daemonSha?: string } | null;
  /** `codeRevision()` of the code this doctor is running. Absent means not measured. */
  codeRevision?: string | null;
  /**
   * Host platform. Required to name a platform-specific remedy (gh install,
   * service restart). Absent means the platform was not measured — those
   * remedies are omitted instead of assuming darwin or printing a sentence.
   */
  platform?: NodeJS.Platform;
  /**
   * 리눅스에서 `TMPDIR` 와 bun 설치 캐시가 «같은 파일시스템»인가(`st_dev` 비교). `null` = 못 쟀다.
   * 🩸 다르면 bun 이 optional 의존성(node-pty 등)을 «조용히» 빠뜨린다(EXDEV · oven-sh/bun#38079 · 2026-09-22 실측 4/4).
   */
  tmpdirSameFsAsBunCache?: boolean | null;
  /** 서비스 파일이 가리키는 경로(작업 폴더 · PWA 폴더) 중 git 작업 트리 안인 것 — 못 쟀으면 undefined. */
  serviceGitTreeRefs?: string[];
  /** 지금 도는 bun 판 · 저장소가 시험한 판(`.bun-version`) — 못 읽으면 null. */
  bunVersion?: string | null;
  bunPin?: string | null;
  /** 배포판 계열(`doctor-distro.ts`). 주입 안 하면 종전 동작(linux=apt). */
  /** 빌드 도구 탐침 — `make` 가 PATH 에 있나 · C++ 컴파일러가 `-std=gnu++20` 을 받나(한 줄 컴파일). null = 못 잼. */
  buildToolchain?: { make: boolean | null; cxx20: boolean | null } | null;
  /** node-pty 외부 명령 탐침 결과(`require` · spawn-helper). null = 못 잼. */
  nodePty?: 'found' | 'missing' | 'broken' | null;
  /** elanous 파이썬 환경(`elanous python check` 와 같은 판정) — null = 못 쟀다. */
  pythonEnv?: { status: 'ok' | 'fixable' | 'manual'; evidence: string; remedy?: string } | null;
  distro?: DistroFamily;
  /** 어디서 도나(L0 · RFC docker·k8s 사다리) — 원 신호만. 판정은 `detectSubstrate`. 없으면(undefined/null) 못 쟀다. */
  substrate?: SubstrateSignals | null;
  /** docker CLI·엔진 탐침. 없으면(undefined/null) 못 쟀다. ⛔ 컨테이너를 띄우는 탐침은 없다 — `docker info` 까지만. */
  docker?: DockerProbe | null;
  /** kubectl·API 서버 탐침. 없으면(undefined/null) 못 쟀다. */
  kubernetes?: KubernetesProbe | null;
  /** 시스템 RAM(바이트). 없으면(undefined/null) 못 쟀다. */
  memory?: MemoryProbe | null;
  /** 서비스 파일(launchd plist · systemd unit) 경로와 본문. `null` = 서비스 파일 없음 · 없으면(undefined) 못 쟀다. ⛔ 본문은 보고에 싣지 않는다(평문 키가 있을 수 있다). */
  serviceFile?: { path: string; text: string } | null;
}

/**
 * L0 신호 — `true`/`false` = 쟀다 · `null` = 못 쟀다(읽기 실패). 문자열 칸은 `null` = 없음/못 읽음.
 * 감지 순서(RFC docker·k8s 사다리 L0): KUBERNETES_SERVICE_HOST → serviceaccount namespace →
 * `/.dockerenv`·`/run/.containerenv` → `/proc/1/cgroup` → env `container`.
 */
export interface SubstrateSignals {
  kubernetesServiceHost: boolean | null;
  serviceAccountNamespace: boolean | null;
  dockerenv: boolean | null;
  containerenv: boolean | null;
  /** `/proc/1/cgroup` 본문. cgroup v2 에서는 `0::/` 뿐일 수 있다 — 그때는 다른 신호로 판정한다. */
  cgroup: string | null;
  /** env `container`(systemd·podman 관례) 값. */
  containerEnv: string | null;
}

export type Substrate = 'kubernetes' | 'container' | 'host';

export interface DockerEngineInfo { serverVersion?: string; ncpu?: number; memTotalBytes?: number; operatingSystem?: string }

export interface DockerProbe {
  /** docker CLI 가 PATH 에 있나. null = 못 쟀다. */
  onPath: boolean | null;
  /**
   * `docker info` 결과. `engine` = 엔진이 답했다 · `no-response` = CLI 가 돌았고 엔진이 답하지 않았다(종료 코드 ≠ 0 · 서버 칸 없음) ·
   * `timeout` = 제한 시간 안에 안 끝났다(못 쟀다) · `null`/absent = 돌리지 못했다(못 쟀다).
   */
  info?: { kind: 'engine'; engine: DockerEngineInfo } | { kind: 'no-response'; detail?: string } | { kind: 'timeout' } | null;
  /** macOS 에서 깔린 데스크톱 엔진 앱 — 처방 한 줄을 고르는 데만 쓴다. null = 없음 · absent = 안 쟀다. */
  desktopApp?: 'OrbStack' | 'Docker' | null;
}

export interface KubernetesProbe {
  /** kubectl 이 PATH 에 있나. null = 못 쟀다. */
  onPath: boolean | null;
  /** `kubectl config current-context`. 문자열 = 컨텍스트 · `null` = 컨텍스트 없음(종료 코드 ≠ 0) · absent = 못 쟀다. */
  context?: string | null;
  /** `kubectl version -o json` 의 서버 응답. `no-response` = API 서버 무응답 · `timeout`/absent = 못 쟀다. */
  server?: { kind: 'ok'; gitVersion: string } | { kind: 'no-response'; detail?: string } | { kind: 'timeout' } | null;
}

export interface MemoryProbe {
  /** 바이트. null = 못 쟀다. */
  totalBytes: number | null;
  /** 바이트. null = 못 쟀다. macOS = (free + inactive) 페이지 × 페이지 크기 · linux = MemAvailable. */
  availableBytes: number | null;
  /** 어디서 쟀나(`sysctl+vm_stat` · `/proc/meminfo`). */
  source: string;
}

const KNOWN_PROVIDERS =new Set(['auto', 'openai-codex', 'openai', 'grok', 'openrouter', 'anthropic', 'gemini', 'local', 'zhipu', 'dashscope', 'moonshot']);
const GH_AUTH_REMEDY = 'gh auth login';
const GH_INSTALL_LINUX = 'sudo apt-get install -y gh';
const GH_INSTALL_DARWIN = 'brew install gh';
const GH_INSTALL_WINDOWS = 'winget install --id GitHub.cli -e';
// 운영이 설치본(`~/.local/share/elanous/current`)으로 돌면 재시작만으로는 새 코드가 안 들어간다 — 체크아웃에서 설치 «뒤» 재시작.
//   ⛔ 한 줄로 «실행 가능»해야 한다 — 중간에 `#` 주석을 두면 뒤의 재시작이 주석으로 먹힌다.
const INSTALL_FIRST = 'bash scripts/install.sh --no-modify-path &&';   // 최신 체크아웃에서
const DARWIN_RESTART = `${INSTALL_FIRST} launchctl kickstart -k gui/$(id -u)/com.elanous.nexus`;
const LINUX_RESTART = `${INSTALL_FIRST} systemctl --user restart elanous-nexus`;

/** GitHub token shapes plus sk-/pk-/rk- and bearer values. Never printed. */
const SECRET_TEXT = /(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|bearer\s+[A-Za-z0-9._~+/-]+=*/gi;
/** Hex commit ids only. Anything else is not a revision and must not match. */
const COMMIT_TEXT = /^[0-9a-f]+$/i;

function redact(value: string): string {
  return value.replace(SECRET_TEXT, '[redacted]');
}

/** POSIX single-quote. The path itself is kept; only the shell metacharacters are quoted. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function item(id: string, status: ReadinessStatus, evidence: string, remedy?: string): ReadinessItem {
  const safeEvidence = redact(evidence);
  if (remedy === undefined) return { id, status, evidence: safeEvidence };
  return { id, status, evidence: safeEvidence, remedy: redact(remedy) };
}

function providerDecision(deps: ReadinessDeps): ReadinessItem {
  if (deps.provider === undefined || deps.provider === null) {
    return item('provider-decision', 'unknown', 'llm.provider was not measured');
  }
  const provider = deps.provider.trim() || 'auto';
  if (provider !== 'auto') {
    // 아는 provider 이름만 보여 준다 — 설정 칸에 자격 같은 값이 들어와 있어도 보고에 싣지 않는다.
    const shown = KNOWN_PROVIDERS.has(provider) ? provider : '(set · value not shown)';
    return item('provider-decision', 'ok', `llm.provider=${shown}`);
  }
  if (deps.codexLogin === undefined || deps.codexLogin === null) {
    return item('provider-decision', 'unknown', 'llm.provider=auto but codex login was not measured');
  }
  if (deps.codexLogin === true) {
    // 2026-09-24 결정(`#20142`) — auto 는 codex 구독을 먼저 쓰고 계정 회전·llm.fallbackChain 이 뒤를 잇는다.
    return item('provider-decision', 'ok', 'llm.provider=auto uses the codex login first; account rotation and llm.fallbackChain apply');
  }
  // 🩸 2026-09-24 빈 VM(🅢 #20263): 로그인도 키도 없는데 여기서 `ok` 가 나왔다(거짓 초록) — auto 가 고를 것이 없다.
  if (deps.llmCredentialAvailable === false) {
    return item('provider-decision', 'manual', 'llm.provider=auto but no LLM login or key was found — LLM commands will fail', 'elanous login openai-codex');
  }
  return item('provider-decision', 'ok', 'llm.provider=auto and no codex login');
}

/** Debian 계열 apt 의 gh 는 GH_MIN_VERSION 미만이다(📏 09-25: Debian 12 = 2.23 · Ubuntu 24.04 = 2.45) — apt 로 깔면 곧바로
 *  「낡았다」로 다시 걸린다(GCP debian-12 에서 `--sudo` 가 실제로 2.23 을 깔았다). `--fix` 는 고정 판 정적 gh 를 받는다. */
const GH_INSTALL_PINNED = 'elanous doctor --fix --yes';

function ghInstallRemedy(platform: NodeJS.Platform | undefined, distro?: DistroFamily): string | undefined {
  if (platform === 'linux' && (distro === undefined || distro === 'debian')) return GH_INSTALL_PINNED;
  // 계열을 알면 표에서(모르는 계열 = 추측하지 않고 없음) · 계열을 안 쟀으면 종전 동작.
  if (distro !== undefined) return remediesFor(distro)?.gh;
  if (platform === 'linux') return GH_INSTALL_LINUX;
  if (platform === 'darwin') return GH_INSTALL_DARWIN;
  if (platform === 'win32') return GH_INSTALL_WINDOWS;
  return undefined;
}

/** gh 최소 판 — 이보다 낡으면 `gh pr`·`gh issue view` 의 GraphQL 이 폐기된 Projects(classic) 필드를 물어 실패한다.
 *  🩸 2026-09-25 k8s Pod(Ubuntu 24.04 apt gh 2.45.0): 하니스 PR 생성이 「Projects (classic) is being deprecated」로 실패 ·
 *  🌐 cli/cli#12476 「upgrade gh to around 2.80.0」 · 이 맥 2.89.0 은 정상. */
export const GH_MIN_VERSION = '2.80';

export function ghVersionAtLeast(have: string, want: string = GH_MIN_VERSION): boolean {
  const [a = 0, b = 0] = have.split('.').map(Number);
  const [c = 0, d = 0] = want.split('.').map(Number);
  return a > c || (a === c && b >= d);
}

function ghAuth(deps: ReadinessDeps): ReadinessItem {
  if (deps.ghOnPath === undefined || deps.ghOnPath === null) {
    return item('gh-auth', 'unknown', 'gh on PATH was not measured');
  }
  if (deps.ghOnPath !== true) {
    return item('gh-auth', 'manual', 'gh is not on PATH', ghInstallRemedy(deps.platform, deps.distro));
  }
  if (deps.ghVersion && !ghVersionAtLeast(deps.ghVersion)) {
    const remedy = deps.platform === 'linux' ? 'elanous doctor --fix --yes' : deps.platform === 'darwin' ? 'brew upgrade gh' : undefined;
    return item('gh-auth', 'manual', `gh ${deps.ghVersion} is older than ${GH_MIN_VERSION} — \`gh pr\` GraphQL queries fail (Projects classic deprecation · cli/cli#12476)`, remedy);
  }
  if (deps.ghAuthStatus === null || deps.ghAuthStatus === undefined) {
    return item('gh-auth', 'unknown', 'gh is on PATH but gh auth status could not be run');
  }
  if (deps.ghAuthStatus === 0) {
    return item('gh-auth', 'ok', 'gh auth status exited 0');
  }
  return item('gh-auth', 'manual', `gh auth status exited ${deps.ghAuthStatus}`, GH_AUTH_REMEDY);
}

function harnessTools(deps: ReadinessDeps): ReadinessItem {
  const { rgOnPath, codexOnPath, nodeOnPath } = deps;
  const missing = [rgOnPath === false ? 'rg' : '', codexOnPath === false ? 'codex' : ''].filter(Boolean);
  // 정적 codex 바이너리(node 불필요)가 이미 있으면 node 부재는 결손이 아니다.
  const nodeMissing = nodeOnPath === false && !(codexOnPath === true && deps.codexNeedsNode === false);
  // 🩸 2026-09-25 L2: codex 바이너리만 있고 짝이 없으면 `--version` 은 되고 실제 작업은 「shell tool failed to start」.
  if (codexOnPath === true && deps.codexCodeModeHost === false) {
    return item('harness-tools', 'manual', 'codex binary has no codex-code-mode-host next to it — its shell tool cannot start', deps.platform === 'linux' ? 'elanous doctor --fix --yes' : undefined);
  }
  if (!missing.length && !nodeMissing) {
    return rgOnPath == null || codexOnPath == null || nodeOnPath == null
      ? item('harness-tools', 'unknown', 'rg, codex or node on PATH was not measured')
      : item('harness-tools', 'ok', 'rg, codex and node are on PATH');
  }
  const remedies = remediesFor(deps.distro ?? 'unknown');
  const commands = [
    rgOnPath === false ? remedies?.rg : undefined,
    nodeMissing && deps.distro !== 'debian' ? remedies?.node : undefined,
    // On Debian, Node installation is an instruction, not a shell command: npm cannot run until Node is installed.
    codexOnPath === false && nodeOnPath != null && (!nodeMissing || (deps.distro !== 'debian' && remedies?.node)) ? remedies?.codex : undefined,
  ].filter((command): command is string => command !== undefined);
  const nodeInstruction = nodeMissing && deps.distro === 'debian' ? remedies?.node : undefined;
  const nodeEvidence = nodeMissing ? ' (node missing)' : codexOnPath === false && nodeOnPath == null ? ' (node not measured)' : '';
  // 계열에 설치 줄이 없는 도구는 «추측하지 않고» 이름을 댄다(예: Amazon Linux 2 의 rg·node).
  const noLine = [rgOnPath === false && !remedies?.rg ? 'rg' : '', nodeMissing && !remedies?.node ? 'node' : ''].filter(Boolean);
  const manualNote = noLine.length ? ` — no install line for this distro: install ${noLine.join(', ')} manually` : '';
  const unmeasured = rgOnPath == null || codexOnPath == null ? ' (other harness tool not measured)' : '';
  return item('harness-tools', 'manual', `${missing.length ? `${missing.join(' and ')} missing from harness tools` : 'codex requires node'}${nodeEvidence}${unmeasured}${manualNote}${nodeInstruction && commands.length ? ` — ${nodeInstruction}` : ''}`, commands.join(' && ') || nodeInstruction);
}

function normalizeDir(value: string): string {
  return value.trim().replace(/[\\/]+$/, '');
}

/** Display form of a path. Comparison always uses the original. */
function displayPath(value: string): string {
  return redact(value) === value ? value : '[redacted-path]';
}

function installPath(deps: ReadinessDeps): ReadinessItem {
  if (deps.installPrefix === undefined) {
    return item('install-path', 'unknown', 'install prefix was not measured');
  }
  if (deps.installPrefix === null) {
    return item('install-path', 'ok', 'running from a checkout');
  }
  const prefix = normalizeDir(deps.installPrefix);
  if (!prefix) {
    return item('install-path', 'unknown', 'install prefix was empty');
  }
  if (deps.pathEntries == null) {
    return item('install-path', 'unknown', `installed at ${displayPath(prefix)} but PATH was not measured`);
  }
  const windows = deps.platform === 'win32';
  const bin = windows ? win32.join(prefix, 'bin') : `${prefix}/bin`;
  const windowsKey = (value: string) => win32.normalize(normalizeDir(value)).toLowerCase();
  const present = windows
    ? deps.pathEntries.flatMap((entry) => entry.split(';')).some((entry) => windowsKey(entry) === windowsKey(bin))
    : deps.pathEntries.some((entry) => normalizeDir(entry) === bin);
  const shown = displayPath(prefix);
  const shownBin = displayPath(bin);
  if (present) {
    return item('install-path', 'ok', `${shownBin} is on PATH`);
  }
  if (typeof deps.elanousOnPath === 'string' && (windows
    ? windowsKey(deps.elanousOnPath).startsWith(`${windowsKey(prefix)}\\`)
    : deps.elanousOnPath.startsWith(`${prefix}/`))) {
    return item('install-path', 'ok', `elanous on PATH resolves into the install (${displayPath(deps.elanousOnPath)})`);
  }
  if (shown !== prefix) {
    // 경로를 가려야 하면 실행 가능한 명령을 줄 수 없다 — 자리표시자 명령 대신 사람 몫으로 둔다.
    return item('install-path', 'manual', `installed at ${shown} but its bin is not on PATH — add it to PATH yourself`);
  }
  return item(
    'install-path',
    'fixable',
    `installed at ${shown} but ${shownBin} is not on PATH`,
    windows ? `$env:PATH = '${bin.replace(/'/g, "''")}' + [IO.Path]::PathSeparator + $env:PATH` : `export PATH=${shellQuote(bin)}:"$PATH"`,
  );
}

/**
 * One direction only: the running daemon's sha is a prefix of this code's revision
 * (health often returns the short sha). The reverse — a longer daemon sha — is a
 * different commit. Comparison uses the original strings, never a redacted form.
 */
function daemonMatchesCode(daemonSha: string, revision: string): boolean {
  const left = daemonSha.trim().toLowerCase();
  const right = revision.trim().toLowerCase();
  if (!COMMIT_TEXT.test(left) || !COMMIT_TEXT.test(right)) return false;
  if (left.length > right.length) return false;
  return right.startsWith(left);
}

function restartRemedy(platform: NodeJS.Platform | undefined, installed: boolean): string | undefined {
  // 설치본에서 도는 doctor 면 코드는 이미 설치본에 있다 — 재시작만 하면 된다(`doctor` 의 재시작 플래그가 같은 줄을 대신 친다).
  if (installed) {
    if (platform === 'linux') return 'systemctl --user restart elanous-nexus';
    if (platform === 'darwin') return 'launchctl kickstart -k gui/$(id -u)/com.elanous.nexus';
    return undefined;
  }
  if (platform === 'linux') return LINUX_RESTART;
  if (platform === 'darwin') return DARWIN_RESTART;
  return undefined;
}

function serviceVersion(deps: ReadinessDeps): ReadinessItem {
  if (deps.health === undefined) {
    return item('service-version', 'unknown', 'health was not measured');
  }
  if (deps.health === null) {
    return deps.serviceFile === null
      ? item('service-version', 'ok', 'no service installed; nothing to compare')
      : item('service-version', 'unknown', 'health did not respond; not measured');
  }
  const daemonSha = typeof deps.health.daemonSha === 'string' ? deps.health.daemonSha.trim() : '';
  const revision = (deps.codeRevision ?? '').trim();
  if (!daemonSha || !revision) {
    return item(
      'service-version',
      'unknown',
      `health responded but a commit is missing (daemonSha=${daemonSha ? redact(daemonSha) : 'absent'}, code=${revision ? redact(revision) : 'absent'})`,
    );
  }
  const shownDaemon = redact(daemonSha);
  const shownRevision = redact(revision);
  if (daemonMatchesCode(daemonSha, revision)) {
    return item('service-version', 'ok', `daemonSha ${shownDaemon} matches code ${shownRevision}`);
  }
  return item(
    'service-version',
    'manual',
    `daemonSha ${shownDaemon} differs from code ${shownRevision}`,
    restartRemedy(deps.platform, typeof deps.installPrefix === 'string' && deps.installPrefix.length > 0),
  );
}

/** 빌드 도구(RFC #20265 P2) — node-pty 가 선택 의존성이라 빌드 실패를 설치기가 rc 0 으로 삼킨다. «버전 문자열로 추측하지 않고» 한 줄 컴파일로 잰다. */
function buildToolchain(deps: ReadinessDeps): ReadinessItem {
  const probe = deps.buildToolchain;
  if (probe === undefined || probe === null) return item('build-toolchain', 'unknown', 'build toolchain was not measured');
  if (probe.make === null || probe.cxx20 === null) return item('build-toolchain', 'unknown', `make=${probe.make ?? '?'} c++20=${probe.cxx20 ?? '?'} — one probe could not run`);
  if (probe.make && probe.cxx20) return item('build-toolchain', 'ok', 'make on PATH and the C++ compiler accepts -std=gnu++20');
  const missing = [probe.make ? '' : 'make', probe.cxx20 ? '' : 'a C++20 compiler'].filter(Boolean).join(' and ');
  return item('build-toolchain', 'manual', `${missing} missing — node-pty cannot be built`, remediesFor(deps.distro ?? 'unknown')?.buildToolchain);
}

/** node-pty — 빠졌거나 고장이면: 빌드 도구가 있으면 `--fix` 가 재빌드한다 · 없으면 빌드 도구가 먼저다. */
function nodePty(deps: ReadinessDeps): ReadinessItem {
  if (deps.nodePty === undefined || deps.nodePty === null) return item('node-pty', 'unknown', 'node-pty was not measured');
  if (deps.nodePty === 'found') return item('node-pty', 'ok', 'node-pty loads');
  const toolchain = buildToolchain(deps);
  if (toolchain.status === 'ok') return item('node-pty', 'fixable', `node-pty is ${deps.nodePty} and the build toolchain is present — rebuild it`, 'elanous doctor --fix --yes');
  return item('node-pty', 'manual', `node-pty is ${deps.nodePty} — install the build toolchain first (see build-toolchain), then run elanous doctor --fix --yes (re-running the installer on the same version does not rebuild it)`, remediesFor(deps.distro ?? 'unknown')?.buildToolchain);
}

/** 파이썬 환경 — RFC #20265 A3 · 대표 결정: 표준 = elanous 소유 venv. 판정 자체는 `src/python/resolve-python.ts` `evaluatePythonEnv`. */
function pythonEnv(deps: ReadinessDeps): ReadinessItem {
  if (deps.pythonEnv === undefined || deps.pythonEnv === null) return item('python-env', 'unknown', 'python environment was not measured');
  const { status, evidence, remedy } = deps.pythonEnv;
  if (status === 'fixable') return item('python-env', 'fixable', evidence, 'elanous doctor --fix --yes');
  if (status === 'manual') {
    if (deps.platform === 'win32') return item('python-env', 'manual', evidence, remedy);
    // 버전 미달·파이썬 없음 — pyenv 빌드 의존성을 계열별로 앞에 붙인다(모르는 계열은 추측하지 않는다).
    // ensurepip 가 없는 경우(Ubuntu python3-venv)는 처방이 이미 venv 한 줄이다 — pyenv 빌드 의존성(십여 패키지)을 붙이지 않는다(09-24 빈 VM 에서 불필요하게 깔렸다).
    // 파이썬이 아예 없고 배포판 파이썬이 선언을 넘는 계열이면 — 빌드가 아니라 배포판 패키지 한 줄(2026-09-25 컨테이너 실측).
    const base = /^no python3 found/.test(evidence) ? remediesFor(deps.distro ?? 'unknown')?.pythonBase : undefined;
    if (base) return item('python-env', 'manual', evidence, `${base} && elanous python setup --yes`);
    // 선언 파일이 설치본에 없는 경우도 빌드 의존성과 무관하다 — 처방은 판 올림 하나(09-25 베어 ubuntu:24.04 · v0.1.0 이 선언 파일 없이 나갔다).
    const deps2 = /ensurepip|was not found next to this elanous/.test(evidence) ? undefined : remediesFor(deps.distro ?? 'unknown')?.pythonBuildDeps;
    return item('python-env', 'manual', evidence, [deps2, remedy].filter(Boolean).join(' && ') || undefined);
  }
  return item('python-env', 'ok', evidence);
}

/** 판 폴더(`…/versions/<판>/node_modules/elanous/…`)를 가리키는 서비스 파일 — 그 판이 정리되면 서비스가 죽는다(#20237 이전에 깐 기계). */
export const SERVICE_VERSION_FOLDER = /\/versions\/[^/<\s"']+\/node_modules\/elanous\//;
const SERVICE_BARE_ELANOUS = /<string>elanous<\/string>\s*<string>nexus<\/string>|ExecStart=elanous\s/;

export interface ServiceSecretEntry { name: string; value: string; start: number; end: number }

/** Only the service environment block is inspected; offsets allow removal without re-rendering unrelated content. */
export function serviceSecretEntries(text: string): ServiceSecretEntry[] {
  const allowed = new Set(providerSecretNames());
  const entries: ServiceSecretEntry[] = [];
  const block = /<key>\s*EnvironmentVariables\s*<\/key>\s*<dict>([\s\S]*?)<\/dict>/g;
  for (const match of text.matchAll(block)) {
    const body = match[1]!;
    const base = match.index! + match[0].indexOf(body);
    for (const pair of body.matchAll(/<key>\s*([A-Z][A-Z0-9_]*)\s*<\/key>\s*<string>([\s\S]*?)<\/string>/g)) {
      if (!allowed.has(pair[1]!)) continue;
      const value = pair[2]!.replace(/&(?:amp|lt|gt|quot|apos|#(?:x[0-9a-fA-F]+|[0-9]+));/g, (entity) => {
        const known: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
        if (known[entity]) return known[entity];
        const hex = entity.startsWith('&#x');
        return String.fromCodePoint(parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10));
      });
      entries.push({ name: pair[1]!, value, start: base + pair.index!, end: base + pair.index! + pair[0].length });
    }
  }
  // systemd's installer emits one quoted assignment per line. Do not match comments or other directives.
  for (const match of text.matchAll(/^[\t ]*Environment[\t ]*=[\t ]*"([A-Z][A-Z0-9_]*)=((?:\\.|[^"\\])*)"[\t ]*(?:\r?\n|$)/gm)) {
    if (!allowed.has(match[1]!)) continue;
    entries.push({ name: match[1]!, value: match[2]!.replace(/\\(["\\])/g, '$1'), start: match.index!, end: match.index! + match[0].length });
  }
  return entries;
}

function serviceSecrets(deps: ReadinessDeps): ReadinessItem {
  if (deps.serviceFile === undefined) return item('service-secrets', 'unknown', 'service file could not be read or was not measured');
  if (deps.serviceFile === null) return item('service-secrets', 'ok', 'no service file installed');
  const names = [...new Set(serviceSecretEntries(deps.serviceFile.text).map((entry) => entry.name))].sort();
  return names.length
    ? item('service-secrets', 'fixable', `provider keys in service environment: ${names.join(', ')} (names only)`, 'elanous doctor --fix --yes')
    : item('service-secrets', 'ok', 'no provider keys in service environment');
}

/** 서비스 파일에서 «운영이 기대는 경로»를 뽑는다 — launchd plist · systemd unit 둘 다(순수 함수). */
export function servicePathRefs(text: string): string[] {
  const refs: string[] = [];
  const plist = /<key>(WorkingDirectory|ELANOUS_PWA_STATIC_DIR)<\/key>\s*<string>([^<]+)<\/string>/g;
  for (const m of text.matchAll(plist)) refs.push(m[2]!.trim());
  for (const m of text.matchAll(/^(?:WorkingDirectory=|Environment="?ELANOUS_PWA_STATIC_DIR=)([^"\n]+)"?$/gm)) refs.push(m[1]!.trim());
  return [...new Set(refs)];
}

function serviceFile(deps: ReadinessDeps): ReadinessItem {
  if (deps.serviceFile === undefined) return item('service-file', 'unknown', 'service file was not measured');
  if (deps.serviceFile === null) return item('service-file', 'ok', 'no service file installed');
  const { path, text } = deps.serviceFile;
  if (SERVICE_VERSION_FOLDER.test(text)) {
    return item('service-file', 'fixable', `${path} points at a version folder (versions/<ver>) — it breaks when that version is pruned`, 'elanous doctor --fix --yes');
  }
  if (SERVICE_BARE_ELANOUS.test(text)) {
    return item('service-file', 'manual', `${path} runs a bare \`elanous\` (resolved through PATH at boot)`, 'elanous nexus install');
  }
  // 🩸 09-26: 운영 서비스가 사람 작업 트리(pilot)를 가리켰다 — 작업 폴더 ⊕ PWA 폴더. 화면이 데몬 코드보다 8시간 낡았다.
  if (deps.serviceGitTreeRefs && deps.serviceGitTreeRefs.length > 0) {
    return item('service-file', 'manual', `${path} depends on a git working tree (${deps.serviceGitTreeRefs.join(', ')}) — the service follows whatever that tree holds, not the installed version`, deps.platform === 'linux' ? 'cd ~ && elanous nexus install --systemd-user' : 'cd ~ && elanous nexus install --launchd');
  }
  return item('service-file', 'ok', `${path} uses a stable command path`);
}

/** Read-only readiness. Callers inject every lookup; this function performs none. */
const BUN_TMPDIR_REMEDY = 'mkdir -p ~/tmp-bun && export TMPDIR=~/tmp-bun  # then re-run the install';

/** bun 판 — 설치기·Pod 이미지·doctor 가 `.bun-version` 한 칸을 따른다(09-25 결정 · 판이 갈리면 같은 코드가 기계마다 다르게 돈다). */
function bunVersionItem(deps: ReadinessDeps): ReadinessItem {
  if (!deps.bunVersion || !deps.bunPin) return item('bun-version', 'unknown', `bun ${deps.bunVersion ?? '?'} · tested ${deps.bunPin ?? '?'} (.bun-version) — one side could not be read`);
  if (deps.bunVersion === deps.bunPin) return item('bun-version', 'ok', `bun ${deps.bunVersion} = the tested version (.bun-version)`);
  const remedy = deps.platform === 'win32' ? undefined : `curl -fsSL https://bun.sh/install | bash -s bun-v${deps.bunPin}`;
  return item('bun-version', 'manual', `bun ${deps.bunVersion} differs from the tested ${deps.bunPin} (.bun-version) — elanous is verified on that one`, remedy);
}

function bunTmpdir(deps: ReadinessDeps): ReadinessItem {
  if (deps.platform !== 'linux') return item('bun-tmpdir', 'ok', 'not Linux — the TMPDIR/bun-cache filesystem split only bites on Linux');
  if (deps.tmpdirSameFsAsBunCache === undefined || deps.tmpdirSameFsAsBunCache === null) {
    return item('bun-tmpdir', 'unknown', 'TMPDIR and the bun install cache could not both be inspected');
  }
  if (deps.tmpdirSameFsAsBunCache) return item('bun-tmpdir', 'ok', 'TMPDIR and the bun install cache are on the same filesystem');
  return item('bun-tmpdir', 'fixable', 'TMPDIR and the bun install cache are on different filesystems — bun may silently skip optional dependencies (EXDEV)', BUN_TMPDIR_REMEDY);
}

/**
 * 순수 판정 — 첫 양성 신호가 이긴다(순서 = RFC L0). 양성이 없으면 host.
 * 잰 신호가 «하나도» 없으면 null(못 쟀다) — 「신호 없음」과 「못 읽음」을 섞지 않는다.
 * ⚠️ cgroup v2 의 `0::/` 는 호스트의 증거가 «아니다»(컨테이너 안에서도 그렇게 보인다) — 그래서 파일 신호를 먼저 본다.
 */
export function detectSubstrate(signals: SubstrateSignals): { substrate: Substrate; signal: string } | null {
  if (signals.kubernetesServiceHost === true) return { substrate: 'kubernetes', signal: 'env KUBERNETES_SERVICE_HOST' };
  if (signals.serviceAccountNamespace === true) return { substrate: 'kubernetes', signal: '/var/run/secrets/kubernetes.io/serviceaccount/namespace' };
  if (signals.dockerenv === true) return { substrate: 'container', signal: '/.dockerenv' };
  if (signals.containerenv === true) return { substrate: 'container', signal: '/run/.containerenv' };
  const cgroup = signals.cgroup ?? '';
  if (/kubepods/.test(cgroup)) return { substrate: 'kubernetes', signal: '/proc/1/cgroup kubepods' };
  const runtime = /docker|containerd|libpod/.exec(cgroup);
  if (runtime) return { substrate: 'container', signal: `/proc/1/cgroup ${runtime[0]}` };
  const containerEnv = (signals.containerEnv ?? '').trim();
  if (containerEnv) return { substrate: 'container', signal: `env container=${containerEnv}` };
  const measured = [signals.kubernetesServiceHost, signals.serviceAccountNamespace, signals.dockerenv, signals.containerenv].some((value) => value !== null)
    || signals.cgroup !== null || signals.containerEnv !== null;
  if (!measured) return null;
  return { substrate: 'host', signal: 'no container or kubernetes signal' };
}

function substrateItem(deps: ReadinessDeps): ReadinessItem {
  if (deps.substrate === undefined || deps.substrate === null) return item('substrate', 'unknown', 'substrate was not measured');
  const detected = detectSubstrate(deps.substrate);
  if (!detected) return item('substrate', 'unknown', 'no substrate signal could be read');
  return item('substrate', 'ok', `${detected.substrate} (${detected.signal})`);
}

const GIB = 1024 ** 3;
function gb(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)}GB`;
}

function dockerStartRemedy(platform: NodeJS.Platform | undefined, desktopApp: DockerProbe['desktopApp']): string | undefined {
  if (platform === 'darwin') {
    if (desktopApp === 'OrbStack') return 'open -a OrbStack';
    if (desktopApp === 'Docker') return 'open -a Docker';
    return undefined; // 어떤 엔진 앱이 깔렸는지 모르면 추측하지 않는다.
  }
  if (platform === 'linux') return 'sudo systemctl start docker';
  return undefined;
}

function dockerItem(deps: ReadinessDeps): ReadinessItem {
  const probe = deps.docker;
  if (probe === undefined || probe === null || probe.onPath === null) return item('docker', 'unknown', 'docker CLI on PATH was not measured');
  if (probe.onPath === false) return item('docker', 'ok', 'not installed — optional (container verification matrix needs it)');
  const info = probe.info;
  if (info === undefined || info === null) return item('docker', 'unknown', 'docker is on PATH but docker info could not be run');
  if (info.kind === 'timeout') return item('docker', 'unknown', 'docker info did not finish in time — engine state not measured');
  if (info.kind === 'no-response') {
    const detail = info.detail ? ` (${info.detail})` : '';
    return item('docker', 'manual', `docker CLI is on PATH but the engine did not respond${detail}`, dockerStartRemedy(deps.platform, probe.desktopApp));
  }
  const { serverVersion, ncpu, memTotalBytes, operatingSystem } = info.engine;
  const parts = [
    `engine ${serverVersion ?? '?'}${operatingSystem ? ` (${operatingSystem})` : ''}`,
    ncpu !== undefined ? `${ncpu} CPU` : '',
    memTotalBytes !== undefined ? `${gb(memTotalBytes)} memory` : '',
  ].filter(Boolean);
  return item('docker', 'ok', parts.join(' · '));
}

function kubernetesItem(deps: ReadinessDeps): ReadinessItem {
  const probe = deps.kubernetes;
  if (probe === undefined || probe === null || probe.onPath === null) return item('kubernetes', 'unknown', 'kubectl on PATH was not measured');
  if (probe.onPath === false) return item('kubernetes', 'ok', 'kubectl not installed — optional');
  if (probe.context === undefined) return item('kubernetes', 'unknown', 'kubectl is on PATH but its current context could not be read');
  if (probe.context === null) return item('kubernetes', 'ok', 'kubectl installed, no context — optional');
  const server = probe.server;
  if (server === undefined || server === null || server.kind === 'timeout') {
    return item('kubernetes', 'unknown', `context ${probe.context} — API server state not measured`);
  }
  if (server.kind === 'no-response') {
    const detail = server.detail ? ` (${server.detail})` : '';
    return item('kubernetes', 'manual', `context ${probe.context}: cluster unreachable${detail}`, `kubectl --context ${shellQuote(probe.context)} cluster-info`);
  }
  return item('kubernetes', 'ok', `context ${probe.context} · server ${server.gitVersion}`);
}

/**
 * 근거 있는 하한 «하나»만 둔다(⛔ 자의적 임계 금지): k3s 서버가 약 1.3GB 를 쓴다 —
 * https://docs.k3s.io/reference/resource-profiling · 그 위에 여유를 붙여 2GB.
 */
export const MEMORY_AVAILABLE_FLOOR_BYTES = 2 * GIB;

function memoryItem(deps: ReadinessDeps): ReadinessItem {
  const probe = deps.memory;
  if (probe === undefined || probe === null) return item('memory', 'unknown', 'system memory was not measured');
  if (probe.totalBytes === null && probe.availableBytes === null) return item('memory', 'unknown', `system memory could not be read (${probe.source})`);
  const engine = deps.docker?.info?.kind === 'engine' ? deps.docker.info.engine : undefined;
  const dockerVm = engine?.memTotalBytes !== undefined ? ` · docker VM ${gb(engine.memTotalBytes)}` : '';
  const total = probe.totalBytes === null ? 'total ?' : `total ${gb(probe.totalBytes)}`;
  const available = probe.availableBytes === null ? 'available ?' : `available ${gb(probe.availableBytes)}`;
  const evidence = `${total} · ${available}${dockerVm} (${probe.source})`;
  if (probe.availableBytes === null) return item('memory', 'unknown', `${evidence} — available memory not measured`);
  if (probe.availableBytes < MEMORY_AVAILABLE_FLOOR_BYTES) {
    return item('memory', 'manual', `${evidence} — below the ~1.3GB a k3s server needs plus headroom`);
  }
  return item('memory', 'ok', evidence);
}

/** `vm_stat` 본문 → (free + inactive) × 페이지 크기. 페이지 크기는 첫 줄에서 읽는다(Apple Silicon 16384 · Intel 4096). 못 읽으면 null. */
export function parseVmStatAvailableBytes(text: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(text);
  const free = /^Pages free:\s+(\d+)\.?\s*$/m.exec(text);
  const inactive = /^Pages inactive:\s+(\d+)\.?\s*$/m.exec(text);
  if (!pageSize || !free || !inactive) return null;
  return (Number(free[1]) + Number(inactive[1])) * Number(pageSize[1]);
}

/** `/proc/meminfo` 본문 → MemTotal·MemAvailable(바이트 · kB 를 곱한다). 칸이 없으면 그 칸만 null. */
export function parseMeminfo(text: string): { totalBytes: number | null; availableBytes: number | null } {
  const field = (name: string): number | null => {
    const match = new RegExp(`^${name}:\\s+(\\d+)\\s*kB\\s*$`, 'm').exec(text);
    return match ? Number(match[1]) * 1024 : null;
  };
  return { totalBytes: field('MemTotal'), availableBytes: field('MemAvailable') };
}

/** `docker info --format '{{json .}}'` 본문 → 엔진 칸. 서버 버전이 없으면(엔진 무응답) null. */
export function parseDockerInfo(text: string): DockerEngineInfo | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const serverVersion = typeof record.ServerVersion === 'string' && record.ServerVersion ? record.ServerVersion : undefined;
  if (!serverVersion) return null;
  return {
    serverVersion,
    ...(typeof record.NCPU === 'number' ? { ncpu: record.NCPU } : {}),
    ...(typeof record.MemTotal === 'number' ? { memTotalBytes: record.MemTotal } : {}),
    ...(typeof record.OperatingSystem === 'string' && record.OperatingSystem ? { operatingSystem: record.OperatingSystem } : {}),
  };
}

/** `kubectl version -o json` 본문 → 서버 gitVersion. 서버 칸이 없으면 null. */
export function parseKubectlServerVersion(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { serverVersion?: { gitVersion?: unknown } } | null;
    return typeof parsed?.serverVersion?.gitVersion === 'string' ? parsed.serverVersion.gitVersion : null;
  } catch {
    return null;
  }
}

export function checkReadiness(deps: ReadinessDeps = {}): ReadinessReport {
  return {
    items: [
      providerDecision(deps),
      ghAuth(deps),
      harnessTools(deps),
      installPath(deps),
      serviceVersion(deps),
      bunVersionItem(deps),
      bunTmpdir(deps),
      serviceFile(deps),
      serviceSecrets(deps),
      buildToolchain(deps),
      nodePty(deps),
      pythonEnv(deps),
      substrateItem(deps),
      dockerItem(deps),
      kubernetesItem(deps),
      memoryItem(deps),
    ],
  };
}
