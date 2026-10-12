import { spawnSync } from 'node:child_process';
import { debug } from '../debug/log.js';
import type { ResourceView } from '../control-plane/ledger.js';
import type { MachineLedger, MachineFleetIntent } from '../machines/machine-ledger.js';

/**
 * 호스트 닥터 — 첫 조각(FLEET-DOCTOR-1 · 읽기 전용).
 * 설계 정본 = 내부 문서 `RFC-fleet-host-doctor-2026-10-11` §A1·A2·A4·A5.
 * 점검은 코드 분기가 아니라 선언 표(HOST_DOCTOR_CHECKS)다.
 */

export type HostDoctorPlatform = 'darwin' | 'linux' | 'wsl';
export type HostDoctorRole = 'worker' | 'hq';
export type HostDoctorFixKind = 'auto' | 'sudo' | 'approval' | 'human';
export type HostDoctorCheckStatus = 'pass' | 'fail' | 'unmeasured';
export type HostDoctorBundle = 'access' | 'engine' | 'platform';

/** 원격 한 발의 결과. `null` = 그 발을 아예 못 쐈다(→ unmeasured). */
export interface HostDoctorRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** 주입 가능한 원격 실행 — 기본 = ssh BatchMode · `<host>=local` 이면 이 기계(bash -c). */
export type HostDoctorRemote = (host: string, probe: string) => HostDoctorRun | null;

/** HQ 실측값(본부의 설치 판 · 이미지 핀) — 없으면 그 점검은 unmeasured 다. */
export interface HostDoctorExpected {
  installVersion?: string;
  imagePin?: string;
}

export interface HostDoctorExpectContext {
  platform: HostDoctorPlatform | null;
  arch: string | null;
  expected: HostDoctorExpected;
}

export type HostDoctorExpectResult =
  | { status: 'pass' | 'fail'; observed: string; expected: string }
  | { status: 'unmeasured'; observed: string; expected: string };

export interface HostDoctorCheckSpec {
  id: string;
  bundle: HostDoctorBundle;
  platforms: readonly HostDoctorPlatform[];
  roles: readonly HostDoctorRole[];
  /** 원격 셸 한 줄. */
  probe: string;
  expect: (run: HostDoctorRun, ctx: HostDoctorExpectContext) => HostDoctorExpectResult;
  fixKind: HostDoctorFixKind;
  fix?: string;
}

export interface HostDoctorCheckResult {
  id: string;
  status: HostDoctorCheckStatus;
  observed: string;
  expected: string;
  fixKind: HostDoctorFixKind;
  fix?: string;
}

/** 대장 레코드 종류 `setup-status {id, ok, missing[], fixHref}` 의 몸 ⊕ 확장 칸(RFC-fleet-host-doctor §A0 · 독자 이름 fleet.host.v1 은 쓰지 않는다). */
export interface HostDoctorReport {
  /** setup-status.id — 호스트 이름. */
  id: string;
  /** setup-status.ok — fail 0 ⊕ unmeasured 0 일 때만. */
  ok: boolean;
  /** setup-status.missing — fail ⊕ unmeasured 점검 id. */
  missing: string[];
  /** setup-status.fixHref — 고치는 길(빠진 것이 없으면 null). */
  fixHref: string | null;
  // ── 확장 칸 ──
  platform: HostDoctorPlatform | null;
  arch: string | null;
  role: HostDoctorRole;
  measuredAt: string;
  checks: HostDoctorCheckResult[];
}

/** 빠진 점검이 있을 때의 고치는 길 — 사람 손 처방은 RFC 표, 자동 처방은 node-setup(다음 조각 FLEET-DOCTOR-FIX 가 --fix 로 잇는다). */
export const HOST_DOCTOR_FIX_HREF = 'docs/RFC-fleet-host-doctor-2026-10-11.md';

const ALL_PLATFORMS: readonly HostDoctorPlatform[] = ['darwin', 'linux', 'wsl'];
const ALL_ROLES: readonly HostDoctorRole[] = ['worker', 'hq'];

function line(value: string): string {
  return value.trim().split('\n')[0] ?? '';
}

function nonEmpty(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** uname -m 과 docker 의 아키텍처 이름을 한 이름으로 — x86_64≡amd64 · aarch64≡arm64(10-11 WSL 실물: «x86_64 vs docker amd64» 오판). */
export function normalizeArch(arch: string): string {
  const lower = arch.trim().toLowerCase();
  if (lower === 'x86_64' || lower === 'x64') return 'amd64';
  if (lower === 'aarch64' || lower === 'arm64v8') return 'arm64';
  return lower;
}

/** 묶음 셋(접근 · 엔진 · 판)의 선언 표 — 첫 조각. */
export const HOST_DOCTOR_CHECKS: readonly HostDoctorCheckSpec[] = [
  // ── 접근 ──
  {
    id: 'ssh.batch',
    bundle: 'access',
    platforms: ALL_PLATFORMS,
    roles: ALL_ROLES,
    // 원격 한 발 자체가 `ssh -o BatchMode=yes <host>` 로 간다 — 그 발이 «ok» 를 돌려주면 그게 증거다.
    //   (원격 안에서 다시 `ssh localhost` 를 치면 «그 호스트가 자기 자신에게» 붙는지를 재게 된다 · 10-11 실물 오판)
    probe: 'echo ok',
    expect: (run) => ({
      status: run.status === 0 && line(run.stdout) === 'ok' ? 'pass' : 'fail',
      observed: run.status === 0 ? line(run.stdout) || '(empty)' : `exit ${run.status ?? 'none'}`,
      expected: 'ssh -o BatchMode=yes works without a password prompt',
    }),
    fixKind: 'human',
    fix: 'put this host key in ~/.ssh/authorized_keys of the host user',
  },
  {
    id: 'tailnet.online',
    bundle: 'access',
    platforms: ALL_PLATFORMS,
    roles: ALL_ROLES,
    probe: 'command -v tailscale >/dev/null 2>&1 || { echo no-cli; exit 0; }; tailscale status >/dev/null 2>&1 && echo online || echo offline',
    expect: (run) => {
      const out = line(run.stdout);
      if (out === 'no-cli') return { status: 'unmeasured', observed: 'tailscale CLI not on the non-interactive PATH', expected: 'tailscale is up and logged in' };
      return { status: out === 'online' ? 'pass' : 'fail', observed: out || `exit ${run.status ?? 'none'}`, expected: 'tailscale is up and logged in' };
    },
    fixKind: 'human',
    fix: 'run `tailscale up` on the host',
  },
  {
    id: 'path.noninteractive',
    bundle: 'access',
    platforms: ALL_PLATFORMS,
    roles: ALL_ROLES,
    probe: 'command -v bun; command -v codex',
    expect: (run) => {
      const found = run.stdout.trim().split('\n').map((entry) => entry.trim()).filter(nonEmpty);
      return {
        status: found.length >= 2 ? 'pass' : 'fail',
        observed: found.length ? found.join(' ') : 'none on PATH',
        expected: 'bun and codex reachable on the default non-interactive PATH',
      };
    },
    fixKind: 'human',
    fix: 'install bun/codex into a PATH a non-interactive shell already sees (no ~/.bashrc edits)',
  },
  // ── 엔진 ──
  {
    id: 'docker.engine',
    bundle: 'engine',
    platforms: ALL_PLATFORMS,
    roles: ALL_ROLES,
    probe: "docker info --format '{{.ServerVersion}}' 2>/dev/null",
    expect: (run) => ({
      status: run.status === 0 && nonEmpty(line(run.stdout)) ? 'pass' : 'fail',
      observed: run.status === 0 ? line(run.stdout) || '(empty)' : `docker info exit ${run.status ?? 'none'}`,
      expected: 'a real docker engine answers (not a desktop shim)',
    }),
    fixKind: 'human',
    fix: 'start the docker engine on the host',
  },
  {
    id: 'k3d.cluster',
    bundle: 'engine',
    platforms: ALL_PLATFORMS,
    roles: ALL_ROLES,
    // ⛔ `--no-header` 는 k3d v5 에 없는 플래그다(«unknown flag» → 빈 출력 → «클러스터 없음» 오판 · 10-11 node-c·WSL 실물).
    probe: 'command -v k3d >/dev/null 2>&1 || { echo no-cli; exit 0; }; out=$(k3d cluster list -o json 2>/dev/null) || { echo error; exit 0; }; printf %s "$out" | grep -q \'"name"\' && echo present || echo none',
    expect: (run) => {
      const out = line(run.stdout);
      if (out === 'no-cli') return { status: 'unmeasured', observed: 'k3d not on the non-interactive PATH', expected: 'at least one k3d cluster exists' };
      if (out === 'error') return { status: 'unmeasured', observed: 'k3d cluster list failed', expected: 'at least one k3d cluster exists' };
      return { status: out === 'present' ? 'pass' : 'fail', observed: out === 'present' ? 'present' : 'no k3d cluster', expected: 'at least one k3d cluster exists' };
    },
    fixKind: 'human',
    fix: 'create the k3d cluster (scripts/fleet/node-setup.sh)',
  },
  {
    id: 'registry.local',
    bundle: 'engine',
    platforms: ALL_PLATFORMS,
    roles: ALL_ROLES,
    // 풀 레지스트리는 k3d-elanous-registry:5050 이다(호스트 포트 5050) · 5000 은 맨 docker registry 관례라 대체로만 본다.
    probe: 'for port in 5050 5000; do curl -fsS --max-time 3 "http://localhost:$port/v2/" >/dev/null 2>&1 && { echo "reachable:$port"; exit 0; }; done; echo unreachable',
    expect: (run) => {
      const out = line(run.stdout);
      return {
        status: out.startsWith('reachable:') ? 'pass' : 'fail',
        observed: out.startsWith('reachable:') ? `localhost:${out.slice('reachable:'.length)} reachable` : 'localhost:5050/5000 /v2 unreachable',
        expected: 'local registry answers on localhost:5050 (or 5000)',
      };
    },
    fixKind: 'human',
    fix: 'start the local registry container',
  },
  // ── 판 ──
  {
    id: 'install.version',
    bundle: 'platform',
    platforms: ALL_PLATFORMS,
    roles: ALL_ROLES,
    probe: 'elanous --version 2>/dev/null || echo none',
    expect: (run, ctx) => {
      const observed = line(run.stdout) || 'none';
      if (!nonEmpty(ctx.expected.installVersion)) {
        return { status: 'unmeasured', observed, expected: 'HQ install version (not supplied)' };
      }
      return { status: observed === ctx.expected.installVersion ? 'pass' : 'fail', observed, expected: ctx.expected.installVersion };
    },
    fixKind: 'auto',
    fix: 'reinstall this host from the HQ install line',
  },
  {
    id: 'image.pin',
    bundle: 'platform',
    platforms: ALL_PLATFORMS,
    roles: ALL_ROLES,
    probe: "docker ps --format '{{.Image}}' 2>/dev/null | grep -m1 elanous || true",
    expect: (run, ctx) => {
      const observed = line(run.stdout);
      if (!nonEmpty(ctx.expected.imagePin)) {
        return { status: 'unmeasured', observed: observed || 'none', expected: 'HQ image pin (not supplied)' };
      }
      return { status: nonEmpty(observed) && observed === ctx.expected.imagePin ? 'pass' : 'fail', observed: observed || 'no elanous image running', expected: ctx.expected.imagePin };
    },
    fixKind: 'auto',
    fix: 'restart the pod from the pinned image',
  },
  {
    id: 'image.arch',
    bundle: 'platform',
    platforms: ALL_PLATFORMS,
    roles: ALL_ROLES,
    probe: "uname -m; docker version --format '{{.Server.Arch}}' 2>/dev/null",
    expect: (run) => {
      const [hostArch, engineArch] = run.stdout.trim().split('\n').map((entry) => entry.trim());
      // docker 가 답하지 않으면 엔진 쪽을 «못 쟀다» — fail 이 아니라 unmeasured(k3d·tailscale 과 같은 원칙).
      if (!nonEmpty(engineArch)) {
        return { status: 'unmeasured', observed: `${hostArch || 'none'} vs docker (no answer)`, expected: 'image architecture matches uname -m' };
      }
      return {
        status: nonEmpty(hostArch) && nonEmpty(engineArch) && normalizeArch(hostArch) === normalizeArch(engineArch) ? 'pass' : 'fail',
        observed: nonEmpty(hostArch) || nonEmpty(engineArch) ? `${hostArch ?? 'none'} vs docker ${engineArch ?? 'none'}` : 'none',
        expected: 'image architecture matches uname -m',
      };
    },
    fixKind: 'auto',
    fix: 'pull the image pinned to this host architecture',
  },
  {
    id: 'node.present',
    bundle: 'platform',
    platforms: ALL_PLATFORMS,
    roles: ALL_ROLES,
    probe: 'command -v node || echo none',
    expect: (run) => {
      const observed = line(run.stdout) || 'none';
      return { status: observed !== 'none' && nonEmpty(observed) ? 'pass' : 'fail', observed, expected: 'node is on PATH (codex shebang)' };
    },
    fixKind: 'auto',
    fix: 'install node (scripts/fleet/node-setup.sh)',
  },
];

/** 기본 원격 실행 — `<host>=local` 이면 이 기계의 비대화형 셸, 아니면 ssh BatchMode. 못 쏘면 null. */
export function defaultHostDoctorRemote(host: string, probe: string): HostDoctorRun | null {
  const viaSsh = host !== 'local';
  const spawned = viaSsh
    // `--` 로 host 를 끊는다(«-o…» 로 시작하는 인자가 ssh 옵션으로 읽히지 않게) · ConnectTimeout 으로 패킷을 떨구는 호스트의 대기를 줄인다.
    ? spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '--', host, probe], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawnSync('bash', ['-c', probe], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return hostDoctorRunFromSpawn(spawned, viaSsh);
}

/** spawn 결과 → 원격 한 발. ⛔ ssh 는 «연결 자체» 실패(거부·이름 못 풂·키 거절)를 exit 255 로 낸다 — 그건 탐침이
 *  «못 쐈다» 이므로 null(→ unmeasured)이다. 그대로 넘기면 모든 점검이 «✗ fail» 로 읽힌다(10-11 리뷰 must-fix). */
export function hostDoctorRunFromSpawn(
  spawned: { error?: Error; status: number | null; stdout?: string | null; stderr?: string | null },
  viaSsh: boolean,
): HostDoctorRun | null {
  if (spawned.error || spawned.status === null) return null;
  if (viaSsh && spawned.status === 255) return null;
  return { status: spawned.status, stdout: spawned.stdout ?? '', stderr: spawned.stderr ?? '' };
}

export interface HostDoctorOptions {
  host: string;
  role?: HostDoctorRole;
  remote?: HostDoctorRemote;
  expected?: HostDoctorExpected;
  now?: () => Date;
  /** HQ observations: null means the source could not be read; [] means a successful empty reading. */
  membership?: {
    intent: MachineLedger | null;
    machines: readonly ResourceView[] | null;
    parentHosts: readonly { host?: string; podPool?: string; approvalCapacity?: number }[] | null;
    intentError?: string;
    machinesError?: string;
    parentHostsError?: string;
  };
}

function membershipCheck(id: string, status: HostDoctorCheckStatus, observed: string, expected: string): HostDoctorCheckResult {
  return { id, status, observed, expected, fixKind: 'human', fix: 'compare Nexus machine registration, machines.yaml intent, and taskAgent.parentHost' };
}

/** Pure HQ comparison. A failed query is null (unmeasured); a successful empty result is a real missing host. */
export function checkHostMembership(host: string, platform: HostDoctorPlatform | null, membership: NonNullable<HostDoctorOptions['membership']>): HostDoctorCheckResult[] {
  const intent: MachineFleetIntent | undefined = membership.intent?.machines.find((row) => row.fleet?.sshName === host)?.fleet;
  const registryExpected = intent ? `live machine ${host} · role ${intent.role}` : `machines.yaml fleet intent for ${host}`;
  let registry: HostDoctorCheckResult;
  if (membership.intent === null || membership.machines === null) {
    registry = membershipCheck('registry.member', 'unmeasured', membership.intent === null
      ? `intent ledger unavailable (repository checkout required)${membership.intentError ? `: ${membership.intentError}` : ''}`
      : `Nexus machine query unavailable${membership.machinesError ? `: ${membership.machinesError}` : ''}`, registryExpected);
  } else if (!intent) {
    registry = membershipCheck('registry.member', 'fail', 'host absent from fleet intent', registryExpected);
  } else {
    // `machine` is the Nexus identity; `name` is a display label. A missing/expired record
    // is a measured failure even when the remote platform probe did not run.
    const rows = membership.machines.filter((row) => row.kind === 'machine' && row.machine === host && !row.expired);
    const row = rows[0];
    const role = row?.attrs.role;
    if (!row) registry = membershipCheck('registry.member', 'fail', 'no live Nexus machine record', registryExpected);
    else if (rows.length !== 1) registry = membershipCheck('registry.member', 'fail', `${rows.length} live machine records`, registryExpected);
    else if (typeof role !== 'string') registry = membershipCheck('registry.member', 'unmeasured', 'machine attrs.role unavailable', registryExpected);
    else if (role !== intent.role) registry = membershipCheck('registry.member', 'fail', `machine role ${role}`, registryExpected);
    // Existence and role have been measured above; a pass still needs the platform probe.
    else if (platform === null) registry = membershipCheck('registry.member', 'unmeasured', 'host platform unavailable', `intent platform ${intent.platform}`);
    else if (platform !== intent.platform) registry = membershipCheck('registry.member', 'fail', `host platform ${platform}`, `intent platform ${intent.platform}`);
    else registry = membershipCheck('registry.member', 'pass', `live machine ${host} · role ${role}`, registryExpected);
  }

  const parentExpected = intent ? `taskAgent.parentHost ${host} · ${intent.podPool} · cap ${intent.cap}` : `machines.yaml fleet intent for ${host}`;
  let parent: HostDoctorCheckResult;
  if (membership.intent === null || membership.parentHosts === null) {
    parent = membershipCheck('parentHost.member', 'unmeasured', membership.intent === null
      ? `intent ledger unavailable (repository checkout required)${membership.intentError ? `: ${membership.intentError}` : ''}`
      : `taskAgent.parentHost unavailable${membership.parentHostsError ? `: ${membership.parentHostsError}` : ''}`, parentExpected);
  } else if (!intent) {
    parent = membershipCheck('parentHost.member', 'fail', 'host absent from fleet intent', parentExpected);
  } else {
    const rows = membership.parentHosts.filter((row) => row.host === host);
    const row = rows[0];
    if (intent.cap === 0) parent = membershipCheck('parentHost.member', rows.length === 0 ? 'pass' : 'fail', rows.length === 0 ? 'disabled in both intent and parent config' : 'disabled host still in parent config', 'host absent from taskAgent.parentHost (cap 0)');
    else if (!row) parent = membershipCheck('parentHost.member', 'fail', 'host absent from taskAgent.parentHost', parentExpected);
    else if (rows.length !== 1 || row.podPool !== intent.podPool || row.approvalCapacity !== intent.cap) {
      parent = membershipCheck('parentHost.member', 'fail', `host entries ${rows.length} · pool ${row.podPool ?? '(missing)'} · cap ${row.approvalCapacity ?? '(missing)'}`, parentExpected);
    } else parent = membershipCheck('parentHost.member', 'pass', `host ${host} · pool ${row.podPool} · cap ${row.approvalCapacity}`, parentExpected);
  }
  return [registry, parent];
}

/** 원격 `uname -s` ⊕ `/proc/version` 의 microsoft 로 darwin|linux|wsl. 못 재면 null. */
export function detectHostDoctorPlatform(remote: HostDoctorRemote, host: string): HostDoctorPlatform | null {
  const uname = remote(host, 'uname -s');
  if (!uname || uname.status !== 0) return null;
  const kernel = line(uname.stdout).toLowerCase();
  if (kernel === 'darwin') return 'darwin';
  if (kernel === 'linux') {
    const procVersion = remote(host, 'cat /proc/version 2>/dev/null || true');
    return procVersion && procVersion.status === 0 && /microsoft/i.test(procVersion.stdout) ? 'wsl' : 'linux';
  }
  return null;
}

/** 원격 아키텍처(`uname -m`). 못 재면 null. */
export function detectHostDoctorArch(remote: HostDoctorRemote, host: string): string | null {
  const run = remote(host, 'uname -m');
  if (!run || run.status !== 0) return null;
  const arch = line(run.stdout);
  return nonEmpty(arch) ? arch : null;
}

/** 못 쏜 점검 — 기대값 칸엔 셸 탐침이 아니라 그 점검의 «기대 문장»을 싣는다(다른 경로와 같은 뜻). */
function unmeasuredBecauseUnreached(spec: HostDoctorCheckSpec, options: { platform: HostDoctorPlatform | null; arch: string | null; expected: HostDoctorExpected }): HostDoctorCheckResult {
  const expected = spec.expect({ status: 1, stdout: '', stderr: '' }, { platform: options.platform, arch: options.arch, expected: options.expected }).expected;
  return { id: spec.id, fixKind: spec.fixKind, ...(spec.fix !== undefined ? { fix: spec.fix } : {}), status: 'unmeasured', observed: 'remote probe did not run', expected };
}

/** 점검 하나를 돌린다 — 원격 실패는 «pass 가 아닌» unmeasured 로만 간다. */
function runCheck(spec: HostDoctorCheckSpec, options: Required<Pick<HostDoctorOptions, 'host'>> & { remote: HostDoctorRemote; role: HostDoctorRole; platform: HostDoctorPlatform | null; arch: string | null; expected: HostDoctorExpected }): HostDoctorCheckResult {
  const run = options.remote(options.host, spec.probe);
  const base = { id: spec.id, fixKind: spec.fixKind, ...(spec.fix !== undefined ? { fix: spec.fix } : {}) };
  if (run === null) return unmeasuredBecauseUnreached(spec, options);
  const verdict = spec.expect(run, { platform: options.platform, arch: options.arch, expected: options.expected });
  return { ...base, status: verdict.status, observed: verdict.observed, expected: verdict.expected };
}

/** `elanous doctor host <host>` — 읽기 전용. ok 는 fail 0 ⊕ unmeasured 0 일 때만. */
export function runHostDoctor(options: HostDoctorOptions): HostDoctorReport {
  const host = options.host;
  const role: HostDoctorRole = options.role === 'hq' ? 'hq' : 'worker';
  const remote = options.remote ?? defaultHostDoctorRemote;
  const expected = options.expected ?? {};
  // 첫 발(uname -s)부터 못 쏘면 그 호스트에 «닿지 않는다» — 남은 탐침을 하나씩 기다리지 않고 전부 unmeasured 로 둔다.
  const reached = remote(host, 'uname -s') !== null;
  const platform = reached ? detectHostDoctorPlatform(remote, host) : null;
  const arch = reached ? detectHostDoctorArch(remote, host) : null;
  const specs = HOST_DOCTOR_CHECKS.filter((spec) => spec.roles.includes(role));
  const remoteChecks = reached
    ? specs.map((spec) => runCheck(spec, { host, remote, role, platform, arch, expected }))
    : specs.map((spec) => unmeasuredBecauseUnreached(spec, { platform, arch, expected }));
  const checks = [...remoteChecks, ...(role === 'worker' && options.membership ? checkHostMembership(host, platform, options.membership) : [])];
  const mismatch = checks.filter((check) => (check.id === 'registry.member' || check.id === 'parentHost.member') && check.status === 'fail');
  if (mismatch.length) debug.log('fleet.doctor', 'membership-mismatch', { host, checks: mismatch.map((check) => ({ id: check.id, observed: check.observed, expected: check.expected })) });
  const membershipUnmeasured = checks.filter((check) => (check.id === 'registry.member' || check.id === 'parentHost.member') && check.status === 'unmeasured');
  if (membershipUnmeasured.length) debug.log('fleet.doctor', 'membership-unmeasured', { host, checks: membershipUnmeasured.map((check) => ({ id: check.id, observed: check.observed })) });
  const fail = checks.filter((check) => check.status === 'fail').map((check) => check.id);
  const unmeasured = checks.filter((check) => check.status === 'unmeasured').map((check) => check.id);
  const measuredAt = (options.now ?? (() => new Date()))().toISOString();
  debug.log('fleet.doctor', 'host-checked', { host, platform, role, fail, unmeasured });
  const missing = [...fail, ...unmeasured];
  return {
    id: host,
    ok: missing.length === 0,
    missing,
    fixHref: missing.length === 0 ? null : HOST_DOCTOR_FIX_HREF,
    platform,
    arch,
    role,
    measuredAt,
    checks,
  };
}

/** 사람 출력 한 줄씩 — 기본은 «✓|✗|→ <id> <한 줄>»(node-setup.sh --check),
 *  membership 미측정은 눈에 보이는 «⚠ <id> unmeasured: <원인>»을 쓴다. */
export function formatHostDoctorLines(report: HostDoctorReport): string[] {
  return report.checks.map((check) => {
    if ((check.id === 'registry.member' || check.id === 'parentHost.member') && check.status === 'unmeasured') {
      return `⚠ ${check.id} unmeasured: ${check.observed}`;
    }
    const mark = check.status === 'pass' ? '✓' : check.status === 'fail' ? '✗' : '→';
    const detail = check.status === 'fail' ? `${check.observed} (expected: ${check.expected})` : check.observed;
    return `${mark} ${check.id} ${detail}`;
  });
}
