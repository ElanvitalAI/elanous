/**
 * HARNESS-PARENT-ON-MSB1 — `tasks hand --live` 의 하니스 «부모»를 다른 호스트(ssh)에서 띄우는 첫 조각 ⊕ 낡은 부모 보고.
 *
 * 왜 «첫 조각»인가 (2026-10-08 실측):
 * - 부모가 호스트에서 기대는 것이 전부 «호스트 로컬 파일»이다 — 착지 동결(`landing-freeze.json` ⊕ `landing-merges/` 표지
 *   무용), 풀 예약(`HostPoolLease`), 런 원장(`run-ledger/`), logs.db. 원격 부모가 `--merge-by-host` 로 병합하면 HQ 의
 *   동결·컷 배수(drain)를 «못 본 채» 병합한다.
 * - 그래서 원격 부모는 «PR 까지만» 간다: `--merge-by-host` → `--no-auto-merge`. 병합 권한은 HQ 에 남는다(동결 안전).
 * - 발사 전 점검(preflight)이 하나라도 막히면 원격으로 띄우지 않고 «종전 로컬 발사»로 돌아간다(fail-closed · 관측 남김).
 * - 관측: 카드에 `parentHost` 를 적고, `tasks show` 가 원격 런 원장을 ssh 로 HQ 의 거울 디렉터리로 당겨 읽는다.
 *
 * 기본 OFF — `taskAgent.parentHost` 가 없고 `ELANOUS_TA_PARENT_HOST` 도 없으면 아무것도 바뀌지 않는다.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { resolveFreshGrokCredential } from '../grok/credential.js';
import { memoryQuantityBytes } from '../task-orchestrator/surfaces/pod-lease.js';
import { parsePodPool } from '../task-orchestrator/surfaces/pod-pool.js';
import { shellQuote } from './task-hand.js';

/** `taskAgent.parentHost` 설정 칸. */
export interface ParentHostConfig {
  /** ssh 대상(예: `node-b`). */
  host: string;
  /** 원격에서 부모를 띄울 git 작업 트리(절대 경로 · 원격 기준). */
  cwd: string;
  /** 원격 elanous 진입점 — 기본 `$HOME/.local/share/elanous/bin/elanous`(설치본). */
  elanous?: string;
  /** 원격 config-dir — 기본 `$HOME/.elanous`. */
  configDir?: string;
  /** 원격 부모에 줄 `--pod-pool`(원격 kube context 이름이 HQ 와 다를 때). */
  podPool?: string;
  /** Maximum simultaneous parent approvals on this host; absent means one conservative slot. */
  approvalCapacity?: number;
}

/** A list opts into multi-host selection; the legacy object retains its original launch behavior. */
export type ParentHostSetting = Partial<ParentHostConfig> | readonly Partial<ParentHostConfig>[];

export const PARENT_HOST_ENV = 'ELANOUS_TA_PARENT_HOST';
const DEFAULT_REMOTE_ELANOUS = '$HOME/.local/share/elanous/bin/elanous';
const DEFAULT_REMOTE_CONFIG_DIR = '$HOME/.elanous';
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

/** Missing child-provider metadata keeps the established Pod default: the HQ Codex mirror is needed. */
export function shouldInstallRemoteCodexAccess(effectiveChildProvider: string | undefined): boolean {
  return effectiveChildProvider === undefined || effectiveChildProvider === 'openai-codex';
}

/**
 * 켜졌나 — env 가 이긴다(`off`·`0`·빈 값이면 끔). env 가 호스트를 주면 나머지 칸(cwd 등)은 설정에서 받는다.
 * cwd 가 없으면 켜지지 않는다(어디서 띄울지 모르는 원격 발사는 하지 않는다).
 */
export function resolveParentHost(config: ParentHostSetting | undefined, env: NodeJS.ProcessEnv = process.env): ParentHostConfig | null {
  return resolveParentHosts(config, env)[0] ?? null;
}

/** Each target is validated independently; an invalid entry cannot turn a valid list into a local-only launch. */
export function resolveParentHosts(config: ParentHostSetting | undefined, env: NodeJS.ProcessEnv = process.env): ParentHostConfig[] {
  const fromEnv = env[PARENT_HOST_ENV];
  if (fromEnv !== undefined && ['', '0', 'off', 'false', 'local'].includes(fromEnv.trim().toLowerCase())) return [];
  const configured = Array.isArray(config) ? config : [config];
  const seen = new Set<string>();
  const targets: ParentHostConfig[] = [];
  if (fromEnv && Array.isArray(config) && !config.some((entry) => entry.host === fromEnv.trim())) return targets;
  for (const entry of configured) {
    if (fromEnv && Array.isArray(config) && entry?.host !== fromEnv.trim()) continue;
    const host = (fromEnv?.trim() || entry?.host || '').trim();
    const cwd = entry?.cwd?.trim();
    if (!host || !HOST_RE.test(host) || !cwd || !cwd.startsWith('/') || seen.has(host)
      || (Array.isArray(config) && entry?.approvalCapacity !== undefined
        && (!Number.isSafeInteger(entry.approvalCapacity) || entry.approvalCapacity < 1))) continue;
    seen.add(host);
    targets.push({ host, cwd, ...(entry?.elanous ? { elanous: entry.elanous } : {}), ...(entry?.configDir ? { configDir: entry.configDir } : {}), ...(entry?.podPool ? { podPool: entry.podPool } : {}), ...(entry?.approvalCapacity !== undefined ? { approvalCapacity: entry.approvalCapacity } : {}) });
    if (fromEnv) break; // Explicit host override selects one target only.
  }
  return targets;
}

/** Capacity sample is read on the host before launch. Unknown or saturated capacity is not a positive weight. */
export interface ParentHostCapacity { active: number; waiting: number; approvalHeadroom: number; load: number }

export interface ParentHostPodFit {
  state: 'fits' | 'never-fits' | 'unmeasured';
  memoryLimit: string;
  requiredBytes: number | null;
  allocatableBytes: number | null;
  reason: string;
}

/** Read node allocatable memory only. This preflight never creates a probe Pod. */
export function readParentHostPodFit(target: ParentHostConfig, memoryLimit: string, ssh: SshRunner = defaultSshRunner): ParentHostPodFit {
  const requiredBytes = memoryQuantityBytes(memoryLimit);
  const unknown = (reason: string, allocatableBytes: number | null = null): ParentHostPodFit =>
    ({ state: 'unmeasured', memoryLimit, requiredBytes, allocatableBytes, reason });
  if (requiredBytes === null || requiredBytes <= 0) return unknown('memory-limit-unreadable');
  // Without an explicit pool, the remote current kubectl context may be unrelated to the launched Job.
  if (!target.podPool) return unknown('pod-pool-unset');
  let members: ReturnType<typeof parsePodPool>;
  try { members = parsePodPool(target.podPool); }
  catch { return unknown('pod-pool-unreadable'); }
  if (!members.length) return unknown('pod-pool-empty');
  let maximum = 0;
  let unreadable = false;
  for (const member of members) {
    let result: ReturnType<SshRunner>;
    try { result = ssh(target.host, `kubectl --context ${shellQuote(member.context)} get nodes -o json`, 15_000); }
    catch { unreadable = true; continue; }
    if (result.status !== 0) { unreadable = true; continue; }
    try {
      const parsed = JSON.parse(result.stdout) as { items?: Array<{ status?: { allocatable?: { memory?: unknown } } }> };
      if (!Array.isArray(parsed.items) || parsed.items.length === 0) { unreadable = true; continue; }
      for (const node of parsed.items) {
        const raw = node?.status?.allocatable?.memory;
        const bytes = typeof raw === 'string' ? memoryQuantityBytes(raw) : null;
        if (bytes === null || bytes <= 0) { unreadable = true; continue; }
        maximum = Math.max(maximum, bytes);
      }
    } catch { unreadable = true; }
  }
  if (maximum >= requiredBytes) return { state: 'fits', memoryLimit, requiredBytes, allocatableBytes: maximum, reason: 'node-allocatable-fits' };
  if (unreadable || maximum === 0) return unknown('node-allocatable-unmeasured', maximum || null);
  return { state: 'never-fits', memoryLimit, requiredBytes, allocatableBytes: maximum, reason: 'memory-never-fits' };
}

const CAPACITY_MARKER = '__ELANOUS_PARENT_CAPACITY__';
const CAPACITY_ERROR_MARKER = '__ELANOUS_PARENT_CAPACITY_ERROR__';
const APPROVAL_MARKER = '__ELANOUS_PARENT_APPROVALS__';
const LOAD_MARKER = '__ELANOUS_PARENT_LOAD__';
/** Best-effort macOS `ps` fallback; Linux/WSL uses argv boundaries below. */
export const PARENT_HOST_ACTIVE_FILTER = String.raw`/^(([^ ]+\/)?(bun|node|nodejs) )?([^ ]+\/)?elanous(\.mjs)?( --config-dir [^ ]+)? harness (say|ask)( |$)/ && / --no-auto-merge( |$)/ && !/ --substrate local( |$)/ && !/^([^ ]+\/)?[^ ]*sh -c/`;
/** Count exact Linux argv entries so Pod-local commands and goal text cannot masquerade as host parents. */
export const PARENT_HOST_PROC_COUNT_SCRIPT = "count=0; proc_root=${1:-/proc}; for file in \"$proc_root\"/[0-9]*/cmdline; do [ -r \"$file\" ] || continue; argv=(); while IFS= read -r -d '' arg; do argv+=(\"$arg\"); done < \"$file\" 2>/dev/null || true; [ ${#argv[@]} -ge 3 ] || continue; program=\"${argv[0]##*/}\"; case \"$program\" in elanous|elanous.mjs) ;; bun|node|nodejs) script_match=0; for ((i=1; i<${#argv[@]}; i++)); do if [[ \"${argv[i]}\" == */elanous.mjs ]]; then script_match=1; break; fi; [[ \"${argv[i]}\" == harness ]] && break; done; [ \"$script_match\" -eq 1 ] || continue ;; *) continue ;; esac; harness=0; for ((i=0; i+1<${#argv[@]}; i++)); do if [[ \"${argv[i]}\" == harness && ( \"${argv[i+1]}\" == say || \"${argv[i+1]}\" == ask ) ]]; then harness=1; break; fi; done; [ \"$harness\" -eq 1 ] || continue; has_no_auto_merge=0; for arg in \"${argv[@]}\"; do [[ \"$arg\" == --no-auto-merge ]] && has_no_auto_merge=1; done; [ \"$has_no_auto_merge\" -eq 1 ] || continue; local_substrate=0; for ((i=0; i+1<${#argv[@]}; i++)); do if [[ \"${argv[i]}\" == --substrate && \"${argv[i+1]}\" == local ]]; then local_substrate=1; break; fi; done; [ \"$local_substrate\" -eq 1 ] || count=$((count+1)); done; printf '__ELANOUS_PARENT_CAPACITY__%s\\n' \"$count\""
/** Recent admission decisions are the host's measured approval backlog, not an inferred process count. */
export function readParentHostCapacity(target: ParentHostConfig, ssh: SshRunner = defaultSshRunner): ParentHostCapacity | null {
  const executable = remotePath(target.elanous ?? DEFAULT_REMOTE_ELANOUS);
  const configDir = remotePath(target.configDir ?? DEFAULT_REMOTE_CONFIG_DIR);
  const unavailable = (reason: string): null => { try { debug.log('task-agent.parent-host', 'capacity-unavailable', { host: target.host, reason }); } catch { /* fail-soft */ } return null; };
  const processCount = `if [ -r /proc/self/cmdline ]; then if command -v bash >/dev/null 2>&1; then bash -c ${shellQuote(PARENT_HOST_PROC_COUNT_SCRIPT)} -- /proc; else printf "${CAPACITY_ERROR_MARKER}bash-unavailable\\n"; exit 1; fi; else parents=$(ps -Ao command) || exit 1; printf '%s\\n' "$parents" | awk '${PARENT_HOST_ACTIVE_FILTER} { n++ } END { print "${CAPACITY_MARKER}" n+0 }'; fi`;
  const script = `${processCount}; `
    + `${executable} --config-dir ${configDir} logs --event admit-by-usage --since 5m --json --limit 1000 || exit 1; `
    + `printf '\\n${APPROVAL_MARKER}\\n'; `
    + `cpu=$(ps -Ao %cpu=) || exit 1; printf '%s\\n' "$cpu" | awk '{ total += $1 } END { printf "${LOAD_MARKER}%.3f\\n", total+0 }'; `
    + `cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null) || exit 1; printf '${LOAD_MARKER}cores=%s\\n' "$cores"`;
  try {
    const result = ssh(target.host, script, 15_000);
    if (result.status !== 0) return unavailable(result.stdout.includes(`${CAPACITY_ERROR_MARKER}bash-unavailable`) ? 'bash-unavailable' : 'remote-command-failed');
    const activeMatch = new RegExp(`^${CAPACITY_MARKER}(\\d+)$`, 'm').exec(result.stdout);
    const boundary = result.stdout.indexOf(`\n${APPROVAL_MARKER}\n`);
    const logsStart = result.stdout.indexOf('\n');
    const cpuMatch = new RegExp(`^${LOAD_MARKER}([0-9]+(?:\\.[0-9]+)?)$`, 'm').exec(result.stdout);
    const coresMatch = new RegExp(`^${LOAD_MARKER}cores=(\\d+)$`, 'm').exec(result.stdout);
    if (!activeMatch || activeMatch.index !== 0) return unavailable('active-count-marker-missing');
    if (logsStart < 0 || boundary < logsStart) return unavailable('approval-boundary-missing');
    if (!cpuMatch || !coresMatch) return unavailable('load-marker-missing');
    const active = Number(activeMatch[1]);
    const cores = Number(coresMatch[1]);
    const cpu = Number(cpuMatch[1]);
    const capacity = target.approvalCapacity ?? 1;
    if (!Number.isSafeInteger(active) || !Number.isSafeInteger(cores) || cores <= 0 || !Number.isFinite(cpu) || cpu < 0
      || !Number.isSafeInteger(capacity) || capacity <= 0) return null;
    const decisions = new Map<string, number>();
    const logs = result.stdout.slice(logsStart, boundary).trim();
    const rows = logs ? logs.split('\n').filter(Boolean) : [];
    if (rows.length >= 1000) return null;
    // `logs` prints newest first; apply older decisions first so the last recommendation wins.
    for (const line of rows.reverse()) {
      const row = JSON.parse(line) as { _meta?: unknown; category?: unknown; event?: unknown; data?: unknown };
      if (row._meta) {
        if (typeof row._meta === 'object' && row._meta !== null && (row._meta as { limitReached?: boolean }).limitReached) return null;
        continue;
      }
      if (row.category !== 'pod-lease' || row.event !== 'admit-by-usage') return null;
      const data = typeof row.data === 'string' ? JSON.parse(row.data) as { runId?: unknown; recommended?: unknown }
        : row.data as { runId?: unknown; recommended?: unknown } | null;
      if (typeof data?.runId !== 'string' || data.recommended === null) continue;
      if (!Number.isSafeInteger(data.recommended) || (data.recommended as number) < 0) return null;
      decisions.set(data.runId, data.recommended as number);
    }
    const waiting = [...decisions.values()].filter((n) => n === 0).length;
    return { active, waiting, approvalHeadroom: Math.max(0, capacity - active - waiting), load: Math.max(0, cpu / (cores * 100)) };
  } catch { return unavailable('capacity-parse-failed'); }
}

/** Weighted rendezvous rank with evidence fields for launch-time observation. */
export function rankParentHosts(targets: readonly ParentHostConfig[], runId: string, capacities: Readonly<Record<string, ParentHostCapacity | null>>): Array<{ target: ParentHostConfig; weight: number; score: number }> {
  return targets.map((target, index) => {
    const sample = capacities[target.host];
    const weight = sample && Number.isSafeInteger(sample.approvalHeadroom) && sample.approvalHeadroom > 0 && Number.isFinite(sample.load) && sample.load >= 0
      ? sample.approvalHeadroom / (1 + sample.load) : 0;
    const hash = createHash('sha256').update(`${runId}\0${target.host}`).digest();
    const fraction = (hash.readUIntBE(0, 6) + 1) / (2 ** 48 + 1);
    return { target, index, weight, score: weight > 0 ? -Math.log(fraction) / weight : Infinity };
  }).sort((a, b) => a.score - b.score || a.index - b.index).map(({ target, weight, score }) => ({ target, weight, score }));
}


/** Keep `$HOME/...` outside quotes so the remote shell expands it; quote every other path. */
function remotePath(path: string): string {
  return path.startsWith('$HOME/') ? `"$HOME"/${shellQuote(path.slice('$HOME/'.length))}` : shellQuote(path);
}

/** 원격 부모 인자 — HQ 병합 권한을 넘기지 않는다: `--merge-by-host` → `--no-auto-merge` ⊕ (있으면) `--pod-pool`. */
export function remoteParentArgs(args: readonly string[], podPool?: string): string[] {
  const out = args.map((arg) => arg === '--merge-by-host' ? '--no-auto-merge' : arg);
  if (!out.includes('--no-auto-merge') && out[0] === 'harness') out.splice(2, 0, '--no-auto-merge');
  if (podPool && !out.includes('--pod-pool')) out.splice(2, 0, '--pod-pool', podPool);
  return out;
}

/** 원격 로그 파일(원격 기준) — 부모 stdout/stderr. */
export function remoteParentLogPath(target: ParentHostConfig, runId: string): string {
  return `${target.configDir ?? DEFAULT_REMOTE_CONFIG_DIR}/remote-parents/${runId}.log`;
}

/** ssh 로 넘길 원격 셸 한 줄 — 떼어 띄우고 pid 만 찍는다. */
export function remoteLaunchScript(target: ParentHostConfig, args: readonly string[], env: Record<string, string>): string {
  const elanous = target.elanous ?? DEFAULT_REMOTE_ELANOUS;
  const configDir = target.configDir ?? DEFAULT_REMOTE_CONFIG_DIR;
  const log = remoteParentLogPath(target, env.ELANOUS_RUN_ID ?? 'unknown');
  // --config-dir keeps the parent's operational config/state; authStorePath()
  // reads XDG_CONFIG_HOME/elanous/auth.json first, as the entrypoint test proves.
  const envPart = [...Object.entries(env).filter(([key]) => key !== 'ELANOUS_STATE_DIR' && /^[A-Z_][A-Z0-9_]*$/.test(key)).map(([key, value]) => `${key}=${key === 'XDG_CONFIG_HOME' || key === 'CODEX_HOME' || key === 'GH_CONFIG_DIR' ? remotePath(value) : shellQuote(value)}`), `ELANOUS_STATE_DIR=${remotePath(configDir)}`].join(' ');
  const argv = [remotePath(elanous), '--config-dir', remotePath(configDir), ...remoteParentArgs(args, target.podPool).map(shellQuote)].join(' ');
  // 준비가 실패하면 «확실히 안 띄웠다»(not-launched=…)를 찍고 끝낸다 — 그때만 호출부가 로컬로 돌아간다.
  // 띄운 뒤에는 짧게 살아 있는지 보고 pid 를 찍는다(조기 종료면 early-exit — 역시 «안 돈다»가 확실).
  return `mkdir -p ${remotePath(`${configDir}/remote-parents`)} || { echo "not-launched=mkdir"; exit 3; }; `
    + `cd ${shellQuote(target.cwd)} || { echo "not-launched=cwd"; exit 3; }; `
    + `${envPart ? `env ${envPart} ` : ''}nohup ${argv} >> ${remotePath(log)} 2>&1 < /dev/null & p=$!; sleep 2; `
    + `if kill -0 "$p" 2>/dev/null; then echo "pid=$p"; else echo "not-launched=early-exit"; tail -3 ${remotePath(log)}; exit 4; fi`;
}

/** ssh 실행기(시험 주입). */
export type SshRunner = (host: string, script: string, timeoutMs: number, stdin?: string) => { status: number | null; stdout: string; stderr: string };

export const defaultSshRunner: SshRunner = (host, script, timeoutMs, stdin) => {
  const result = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ControlPath=none', host, script], {
    encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, ...(stdin !== undefined ? { input: stdin } : {}),
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? (result.error ? String(result.error) : '') };
};

/** PID 재사용을 피하려면 살아 있는 프로세스의 command 가 이 카드의 런 id 도 실어야 한다. */
export function remoteParentAlive(parentHost: { host: string; pid?: number; runId: string }, ssh: SshRunner = defaultSshRunner): 'alive' | 'dead' | 'unknown' {
  if (!Number.isSafeInteger(parentHost.pid) || !parentHost.pid || parentHost.pid <= 0 || !/^run-[A-Za-z0-9_-]{4,64}$/.test(parentHost.runId)) return 'unknown';
  try {
    // `env ELANOUS_RUN_ID=… nohup` 은 exec 뒤 argv 에 남지 않는다. ps eww 가 부모의 환경을 command 와 함께 보여 준다.
    // ⚠️ `eww` 는 «앞»에 둔다 — macOS(node-b) ps 는 `-o command= eww` 꼴을 `illegal argument: eww`(rc=1)로 거부해
    // 늘 'unknown' 이 된다(10-10 node-b 실측). 없는 pid 는 rc=1 · 빈 출력 → 'dead'.
    const result = ssh(parentHost.host, `ps eww -p ${parentHost.pid} -o command=`, 10_000);
    if (result.status === 0) return result.stdout.trim() ? (result.stdout.split(/[^A-Za-z0-9_-]+/).includes(parentHost.runId) ? 'alive' : 'dead') : 'dead';
    if (result.status === 1 && !result.stdout.trim() && !result.stderr.trim()) return 'dead';
    return 'unknown';
  } catch { return 'unknown'; }
}

/** 발사 전 점검 결과 — `gaps` 가 비어야 원격으로 띄운다. */
export interface ParentHostPreflight { ok: boolean; gaps: string[]; warnings: string[]; facts: Record<string, string> }

/** 원격 사실 한 번에 — key=value 줄. LLM 자격은 «존재·개수»만 센다(값을 읽지도 찍지도 않는다). */
export function preflightScript(target: ParentHostConfig): string {
  const elanous = remotePath(target.elanous ?? DEFAULT_REMOTE_ELANOUS);
  const configDir = remotePath(target.configDir ?? DEFAULT_REMOTE_CONFIG_DIR);
  return [
    `echo "version=$(${elanous} --version 2>/dev/null | tail -1 | cut -d' ' -f1)"`,
    `test -f ${configDir}/config.json && echo config=1`,
    `grep -Eq '"podPool"[[:space:]]*:[[:space:]]*"[^"[:space:]]+' ${configDir}/config.json 2>/dev/null && echo podPool=1`,
    `(cd ${shellQuote(target.cwd)} 2>/dev/null && git rev-parse --is-inside-work-tree >/dev/null 2>&1) && echo repo=1`,
    `command -v kubectl >/dev/null 2>&1 && echo kubectl=1`,
    `n=$(grep -Ec '^[[:space:]]*"openai-codex(:[^"]*)?"[[:space:]]*:[[:space:]]*\\{' ${configDir}/auth.json 2>/dev/null); echo "codexAccounts=\${n:-0}"`,
    `{ grep -Eq '"key"[[:space:]]*:[[:space:]]*"[^"]+"' "$HOME/.grok/auth.json" 2>/dev/null || [ -n "\${XAI_API_KEY:-}\${GROK_API_KEY:-}\${GROK_CODE_XAI_API_KEY:-}" ]; } && echo grok=1`,
    `{ [ -s "\${ELANOUS_KEY_CACHE_DIR:-$HOME/.cache}/openrouter_api_key" ] || [ -n "\${OPENROUTER_API_KEY:-}" ]; } && echo openrouter=1`,
    `true`,
  ].join('; ');
}

export interface PreflightInput {
  target: ParentHostConfig;
  /** HQ 의 elanous 판(첫 낱말). */
  localVersion: string;
  /** HQ 착지 동결이 «발사도 막는» 상태인가 — 원격 부모는 그 동결을 못 본다. */
  launchHoldActive: boolean;
  ssh?: SshRunner;
}

/** 기준판 — `0.2.23-dev.0` → `0.2.23`(앞 x.y.z 만). 모양이 아니면 원문 그대로(= 정확히 같아야 통과). */
export function releaseCore(version: string): string {
  return /^(\d+\.\d+\.\d+)/.exec(version)?.[1] ?? version;
}

/** 순수 판정 — 원격 사실 → 막는 칸 목록. */
export function judgeParentHostFacts(facts: Record<string, string>, input: Omit<PreflightInput, 'ssh' | 'target'> & { podPoolOverride?: boolean }): string[] {
  const gaps: string[] = [];
  if (facts.unreachable) gaps.push(`unreachable: ${facts.unreachable}`);
  else {
    if (!facts.version) gaps.push('remote-elanous-missing');
    else if (facts.version !== input.localVersion) {
      // 레일은 HQ 를 30분마다 올리고 원격은 한 주기 늦을 수 있다 — 기준판(x.y.z)이 같으면 막지 않고 경고만 남긴다(OP 10-09 13:17).
      if (releaseCore(facts.version) !== releaseCore(input.localVersion)) gaps.push(`version-mismatch: remote ${facts.version} ≠ HQ ${input.localVersion}`);
      else debug.log('task-agent.parent-host', 'version-drift', { remote: facts.version, hq: input.localVersion });
    }
    if (facts.config !== '1') gaps.push('remote-config-missing');
    if (facts.podPool !== '1' && !input.podPoolOverride) gaps.push('remote-pod-pool-unset');
    if (facts.repo !== '1') gaps.push('remote-repo-missing');
    if (facts.kubectl !== '1') gaps.push('remote-kubectl-missing');
  }
  if (input.launchHoldActive) gaps.push('hq-launch-freeze-active');
  return gaps;
}

/** 순수 판정 — 원격 LLM 자격 사실 → 경고 목록(막지 않는다 · gaps 와 별개). 못 닿은 호스트는 사실이 없으므로 경고도 없다. */
export function judgeParentHostCredentials(facts: Record<string, string>): string[] {
  if (facts.unreachable) return [];
  const warnings: string[] = [];
  if (!(Number(facts.codexAccounts) > 1)) warnings.push('codex-accounts-low');
  if (facts.grok !== '1') warnings.push('grok-credential-missing');
  if (facts.openrouter !== '1') warnings.push('openrouter-key-missing');
  return warnings;
}

export function preflightParentHost(input: PreflightInput): ParentHostPreflight {
  const ssh = input.ssh ?? defaultSshRunner;
  const facts: Record<string, string> = {};
  const result = ssh(input.target.host, preflightScript(input.target), 20_000);
  if (result.status !== 0) facts.unreachable = (result.stderr.trim().split('\n').pop() || `rc=${result.status}`).slice(0, 200);
  else for (const line of result.stdout.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) facts[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  const gaps = judgeParentHostFacts(facts, { localVersion: input.localVersion, launchHoldActive: input.launchHoldActive, podPoolOverride: Boolean(input.target.podPool) });
  const warnings = judgeParentHostCredentials(facts);
  if (warnings.length) {
    try {
      debug.log('task-agent.parent-host', 'credential-warning', {
        host: input.target.host,
        codexAccounts: Number(facts.codexAccounts) || 0,
        grok: facts.grok === '1' ? 1 : 0,
        openrouter: facts.openrouter === '1' ? 1 : 0,
      });
    } catch { /* fail-soft */ }
  }
  return { ok: gaps.length === 0, gaps, warnings, facts };
}

/** 원격이 «확실히 안 띄웠다»고 답했다 — 호출부가 로컬로 돌아가도 중복 발사가 아니다. */
export class RemoteParentNotLaunchedError extends Error {
  constructor(host: string, reason: string) { super(`원격 부모 안 뜸(${host}): ${reason}`); this.name = 'RemoteParentNotLaunchedError'; }
}

/**
 * 원격 발사 — pid 를 받으면 성공. 원격이 `not-launched=…` 로 답하면 `RemoteParentNotLaunchedError`(로컬로 가도 된다).
 * 그 밖(ssh 끊김·시간 초과·알 수 없는 답)은 «떴는지 모른다» — 일반 Error 로 던져 카드가 launch-failed 로 남게 한다
 * (⛔ 로컬로 또 띄우면 원격에 이미 뜬 부모와 중복이 될 수 있다).
 */
export function launchRemoteParent(
  target: ParentHostConfig,
  args: readonly string[],
  env: Record<string, string>,
  ssh: SshRunner = defaultSshRunner,
  grokMirrorResolver: () => OwnerGrokAccessMirror = resolveOwnerGrokAccessMirror,
  effectiveChildProvider?: string,
  now: () => number = Date.now,
): { pid: number; log: string } {
  const argvProvider = childProviderFromArgs(args);
  if (effectiveChildProvider && argvProvider && argvProvider !== effectiveChildProvider) {
    throw new Error(`effective child provider mismatch (context=${effectiveChildProvider}, argv=${argvProvider})`);
  }
  const launchArgs = effectiveChildProvider && !argvProvider
    ? [...args.slice(0, 2), '--child-llm-provider', effectiveChildProvider, ...args.slice(2)]
    : args;
  if ((effectiveChildProvider ?? argvProvider) === 'grok') {
    const mirror = grokMirrorResolver();
    installRemoteGrokAccess(target, mirror, ssh, now);
  }
  const result = ssh(target.host, remoteLaunchScript(target, launchArgs, env), 30_000);
  const log = remoteParentLogPath(target, env.ELANOUS_RUN_ID ?? 'unknown');
  const pid = Number(/^pid=(\d+)$/m.exec(result.stdout)?.[1]);
  if (result.status === 0 && Number.isSafeInteger(pid) && pid > 0) return { pid, log };
  const refused = /^not-launched=(\S+)/m.exec(result.stdout)?.[1];
  if (refused && (result.status === 3 || result.status === 4)) {
    const tail = result.stdout.split('\n').filter((line) => line.trim() && !line.startsWith('not-launched=')).slice(-1)[0] ?? '';
    throw new RemoteParentNotLaunchedError(target.host, `${refused}${tail ? `: ${tail.slice(0, 160)}` : ''}`);
  }
  throw new Error(`원격 부모 발사 결과 불확실(${target.host} · rc=${result.status}) — 중복을 피해 로컬로 다시 띄우지 않는다 · 원격에서 ELANOUS_RUN_ID=${env.ELANOUS_RUN_ID ?? '?'} 를 확인: ${(result.stderr.trim().split('\n').pop() || '').slice(0, 160)}`);
}

/** The provider selection travels as an argv pair or assignment; absent remains the existing Codex default. */
function childProviderFromArgs(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--child-llm-provider') return args[i + 1];
    if (arg.startsWith('--child-llm-provider=')) return arg.slice('--child-llm-provider='.length);
  }
  return undefined;
}

export interface OwnerGrokAccessMirror { key: string; expiresAt: string }

/** Resolve/refresh on HQ and return only a still-usable subscription access token. */
export function resolveOwnerGrokAccessMirror(opts: {
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  execImpl?: (cmd: string, args: string[], timeoutMs: number) => void;
} = {}): OwnerGrokAccessMirror {
  const credential = resolveFreshGrokCredential({
    ...(opts.home ? { home: opts.home } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.execImpl ? { execImpl: opts.execImpl } : {}),
  });
  if (!credential || credential.kind !== 'subscription') throw new Error('Grok subscription mirror unavailable: no-usable-subscription');
  // Expiry travels with the selected credential so a second auth-file read cannot pair another scope's
  // expiry with this access token if the file changes between reads.
  if (!credential.expiresAt) throw new Error('Grok subscription mirror unavailable: access-state-incomplete');
  const expiresAt = Date.parse(credential.expiresAt);
  // Keep the same two-minute safety margin that triggers HQ refresh before remote installation.
  if (!Number.isFinite(expiresAt) || expiresAt <= (opts.now ?? Date.now)() + 120_000) {
    throw new Error('Grok subscription mirror unavailable: expired-or-refresh-did-not-produce-fresh-access');
  }
  return { key: credential.token, expiresAt: credential.expiresAt };
}

/** Install one HQ-selected Grok access token over SSH stdin; never copy refresh or other scopes. */
export function installRemoteGrokAccess(
  target: ParentHostConfig,
  mirror: OwnerGrokAccessMirror,
  ssh: SshRunner = defaultSshRunner,
  now: () => number = Date.now,
): void {
  if (!mirror || typeof mirror.key !== 'string' || !mirror.key || typeof mirror.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(mirror.expiresAt)) || Date.parse(mirror.expiresAt) <= now() + 120_000) {
    throw new Error('invalid Grok access mirror');
  }
  const payload = JSON.stringify({ key: mirror.key, expires_at: mirror.expiresAt });
  const code = [
    'const fs=require("node:fs"),path=require("node:path"),os=require("node:os");',
    'const p=JSON.parse(fs.readFileSync(0,"utf8"));if(!p||typeof p.key!=="string"||!p.key||typeof p.expires_at!=="string"||!Number.isFinite(Date.parse(p.expires_at))||Date.parse(p.expires_at)<=Date.now()+120000||Object.keys(p).some(k=>!new Set(["key","expires_at"]).has(k)))process.exit(2);',
    'const dir=path.join(os.homedir(),".grok"),file=path.join(dir,"auth.json"),temp=file+"."+process.pid+".tmp";fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.chmodSync(dir,0o700);',
    'try{let auth={};try{const prior=JSON.parse(fs.readFileSync(file,"utf8"));if(!prior||typeof prior!=="object"||Array.isArray(prior))process.exit(3);auth=prior}catch(e){if(e.code!=="ENOENT")throw e}auth["https://auth.x.ai::hq-mirror"]={key:p.key,expires_at:p.expires_at};fs.writeFileSync(temp,JSON.stringify(auth),{mode:0o600});fs.chmodSync(temp,0o600);fs.renameSync(temp,file)}catch(e){try{fs.unlinkSync(temp)}catch{};throw e}',
  ].join('');
  const result = ssh(target.host, `umask 077; bun -e ${shellQuote(code)}`, 20_000, payload);
  if (result.status !== 0) throw new Error(`remote Grok access mirror failed (ssh rc=${result.status ?? 'unknown'})`);
}

/** Install access-only Codex copies over SSH stdin; credentials never enter argv, shell text, or logs. */
export function installRemoteCodexAccess(target: ParentHostConfig, mirror: { elanousAuth: string; codexAuth: string; account?: string }, ssh: SshRunner = defaultSshRunner): void {
  let elanous: { version?: number; providers?: Record<string, Record<string, unknown>> };
  let codex: { auth_mode?: string; tokens?: Record<string, unknown> };
  try {
    elanous = JSON.parse(mirror.elanousAuth) as typeof elanous;
    codex = JSON.parse(mirror.codexAuth) as typeof codex;
  } catch { throw new Error('invalid local Codex access mirror'); }
  const provider = elanous.providers?.['openai-codex'];
  const elanousTokens = provider?.tokens as Record<string, unknown> | undefined;
  const codexTokens = codex.tokens;
  if (!Number.isSafeInteger(elanous.version) || Number(elanous.version) < 1
    || typeof elanousTokens?.accessToken !== 'string' || !elanousTokens.accessToken || elanousTokens.refreshToken !== '' || elanousTokens.refresh_token !== ''
    || codex.auth_mode !== 'chatgpt'
    || typeof codexTokens?.access_token !== 'string' || !codexTokens.access_token || codexTokens.refresh_token !== '' || codexTokens.refreshToken !== '')
    throw new Error('Codex access mirror must contain a versioned store, auth mode, access tokens, and empty refresh tokens');

  const account = mirror.account ?? 'default';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(account)) throw new Error('invalid Codex mirror account name');

  const payload = JSON.stringify({ elanousVersion: elanous.version, provider, codexAuth: codex, account, storeKey: account === 'default' ? 'openai-codex' : `openai-codex:${account}` });
  const configDir = remotePath(target.configDir ?? DEFAULT_REMOTE_CONFIG_DIR);
  // HQ owns token metadata; the remote keeps only the selected named Codex credential in managed account homes.
  const code = [
    'const fs=require("node:fs"),path=require("node:path"),os=require("node:os");',
    'const payload=JSON.parse(fs.readFileSync(0,"utf8"));',
    'const read=(file)=>{try{return JSON.parse(fs.readFileSync(file,"utf8"))}catch{return {}}};',
    'const write=(file,value)=>{const temp=file+"."+process.pid+".tmp";try{fs.writeFileSync(temp,JSON.stringify(value),{mode:0o600});fs.chmodSync(temp,0o600);fs.renameSync(temp,file)}catch(error){try{fs.unlinkSync(temp)}catch{};throw error}};',
    'const elanousFile=path.join(process.argv[1],"auth.json"),configDir=path.dirname(elanousFile);fs.mkdirSync(configDir,{recursive:true,mode:0o700});',
    'const elanous=read(elanousFile);if(typeof elanous.version!=="number")elanous.version=payload.elanousVersion;elanous.providers={...(elanous.providers||{})};const defaultHome=path.join(os.homedir(),".codex"),managedAccounts=path.join(configDir,"codex-accounts");for(const key of Object.keys(elanous.providers)){if(key.startsWith("openai-codex:"))delete elanous.providers[key]}fs.rmSync(managedAccounts,{recursive:true,force:true});fs.rmSync(path.join(configDir,"remote-codex-mirror.json"),{force:true});',
    'const accountHome=payload.account==="default"?defaultHome:path.join(configDir,"codex-accounts",payload.account),tokens={...(payload.provider.tokens||{}),refreshToken:"",refresh_token:""};const upsert=(key,codexHome)=>{const current=elanous.providers[key]||{};elanous.providers[key]={...current,...payload.provider,codexHome,chatGPT:{...(current.chatGPT||{}),...(payload.provider.chatGPT||{})},tokens}};upsert("openai-codex",defaultHome);if(payload.storeKey!=="openai-codex")upsert(payload.storeKey,accountHome);write(elanousFile,elanous);',
    'const incoming=payload.codexAuth;const installCodex=(home)=>{const file=path.join(home,"auth.json");fs.mkdirSync(home,{recursive:true,mode:0o700});const current=read(file),merged={...current,...incoming};merged.auth_mode=incoming.auth_mode;if(Object.prototype.hasOwnProperty.call(incoming,"last_refresh"))merged.last_refresh=incoming.last_refresh;else delete merged.last_refresh;merged.tokens={...(incoming.tokens||{}),refresh_token:"",refreshToken:""};write(file,merged)};installCodex(defaultHome);if(accountHome!==defaultHome)installCodex(accountHome);',
  ].join('');
  const result = ssh(target.host, `umask 077; mkdir -p ${configDir} "$HOME/.codex" && bun -e ${shellQuote(code)} ${configDir}`, 20_000, payload);
  if (result.status !== 0) throw new Error(`remote Codex access mirror failed (ssh rc=${result.status ?? 'unknown'})`);
}

/** Replace the remote Codex account set with one HQ-owned, refresh-free snapshot. */
export function installRemoteCodexAccessBatch(target: ParentHostConfig, mirrors: readonly { elanousAuth: string; codexAuth: string; account: string }[], ssh: SshRunner = defaultSshRunner): void {
  if (!mirrors.length) throw new Error('Codex access mirror batch is empty');
  const seen = new Set<string>();
  const accounts = mirrors.map((mirror) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(mirror.account) || seen.has(mirror.account)) throw new Error('invalid or duplicate Codex mirror account name');
    seen.add(mirror.account);
    let elanous: { version?: number; providers?: Record<string, Record<string, unknown>> };
    let codex: { auth_mode?: string; tokens?: Record<string, unknown> };
    try { elanous = JSON.parse(mirror.elanousAuth); codex = JSON.parse(mirror.codexAuth); }
    catch { throw new Error('invalid local Codex access mirror'); }
    const provider = elanous.providers?.['openai-codex'];
    const token = provider?.tokens as Record<string, unknown> | undefined;
    if (!Number.isSafeInteger(elanous.version) || Number(elanous.version) < 1
      || typeof token?.accessToken !== 'string' || !token.accessToken || token.refreshToken !== '' || token.refresh_token !== ''
      || codex.auth_mode !== 'chatgpt' || typeof codex.tokens?.access_token !== 'string' || !codex.tokens.access_token
      || codex.tokens.refresh_token !== '' || codex.tokens.refreshToken !== '')
      throw new Error('Codex access mirror batch requires access tokens and empty refresh tokens');
    return { account: mirror.account, provider, codexAuth: codex, version: elanous.version };
  });
  const configDir = remotePath(target.configDir ?? DEFAULT_REMOTE_CONFIG_DIR);
  const code = [
    'const fs=require("node:fs"),path=require("node:path"),os=require("node:os");',
    'const items=JSON.parse(fs.readFileSync(0,"utf8"));const dir=process.argv[1],file=path.join(dir,"auth.json"),defaultHome=path.join(dir,"codex-default"),managed=path.join(dir,"codex-accounts");',
    'const read=(p)=>{try{return JSON.parse(fs.readFileSync(p,"utf8"))}catch{return {}}};',
    'const write=(p,v)=>{fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o700});const tmp=p+"."+process.pid+".tmp";try{fs.writeFileSync(tmp,JSON.stringify(v),{mode:0o600});fs.chmodSync(tmp,0o600);fs.renameSync(tmp,p)}catch(e){try{fs.unlinkSync(tmp)}catch{};throw e}};',
    // A remote parent can launch concurrently with another parent. Serialize the
    // entire auth-store + named-home transition, including stale-home pruning.
    'const lock=path.join(dir,"remote-codex-mirror.lock"),deadline=Date.now()+15000,sleep=new Int32Array(new SharedArrayBuffer(4));fs.mkdirSync(dir,{recursive:true,mode:0o700});while(true){try{fs.writeFileSync(lock,String(process.pid),{flag:"wx",mode:0o600});break}catch(e){if(e.code!=="EEXIST")throw e;try{if(Date.now()-fs.statSync(lock).mtimeMs>60000)fs.rmSync(lock,{force:true})}catch{}if(Date.now()>=deadline)throw new Error("remote Codex mirror lock timeout");Atomics.wait(sleep,0,0,25)}}try{',
    'const store=read(file);store.version=typeof store.version==="number"?store.version:items[0].version;store.providers={...(store.providers||{})};for(const key of Object.keys(store.providers)){if(key==="openai-codex"||key.startsWith("openai-codex:"))delete store.providers[key]}',
    'for(const item of items){const home=item.account==="default"?defaultHome:path.join(managed,item.account),key=item.account==="default"?"openai-codex":"openai-codex:"+item.account;const current=read(path.join(home,"auth.json")),auth={...current,...item.codexAuth,auth_mode:"chatgpt",tokens:{...(item.codexAuth.tokens||{}),refresh_token:"",refreshToken:""}};write(path.join(home,"auth.json"),auth);store.providers[key]={...item.provider,codexHome:home,tokens:{...(item.provider.tokens||{}),refreshToken:"",refresh_token:""}}}',
    'if(!store.providers["openai-codex"]){const first=items[0],home=path.join(managed,first.account);write(path.join(defaultHome,"auth.json"),{...first.codexAuth,auth_mode:"chatgpt",tokens:{...(first.codexAuth.tokens||{}),refresh_token:"",refreshToken:""}});store.providers["openai-codex"]={...store.providers["openai-codex:"+first.account],codexHome:defaultHome}}',
    'write(file,store);const keep=new Set(items.filter(x=>x.account!=="default").map(x=>x.account));try{for(const name of fs.readdirSync(managed)){if(!keep.has(name))fs.rmSync(path.join(managed,name),{recursive:true,force:true})}}catch(e){if(e.code!=="ENOENT")throw e}fs.rmSync(path.join(dir,"remote-codex-mirror.json"),{force:true});',
    '}finally{fs.rmSync(lock,{force:true})}',
  ].join('');
  const result = ssh(target.host, `umask 077; mkdir -p ${configDir} "$HOME/.codex" && bun -e ${shellQuote(code)} ${configDir}`, 20_000, JSON.stringify(accounts));
  if (result.status !== 0) throw new Error(`remote Codex access mirror batch failed (ssh rc=${result.status ?? 'unknown'})`);
}

// ── 관측: 원격 런 원장 거울 ─────────────────────────────────────────────────────────────

const RUN_ID_RE = /^run-[A-Za-z0-9_-]{4,64}$/;

/** HQ 쪽 거울 디렉터리 — `<prodRoot>/remote-parents/<host>/run-ledger`. */
export function remoteLedgerMirrorDir(prodRoot: string, host: string): string {
  return join(prodRoot, 'remote-parents', host.replace(/[^A-Za-z0-9._-]/g, '_'), 'run-ledger');
}

/** 거울 디렉터리 전부(카드 원장 읽기가 연합 목록 뒤에 붙인다). */
export function remoteLedgerMirrorDirs(prodRoot: string): string[] {
  const base = join(prodRoot, 'remote-parents');
  if (!existsSync(base)) return [];
  try {
    return readdirSync(base).map((host) => join(base, host, 'run-ledger')).filter((dir) => existsSync(dir));
  } catch { return []; }
}

/**
 * 원격 런 원장(부모 ⊕ 그 원장이 가리키는 Pod 자식)을 HQ 거울로 당긴다 — 읽기 전용(원격에 쓰지 않는다).
 * 돌려주는 값 = 당긴 런 id. 원격을 못 읽으면 던진다(호출부가 «없음»이 아니라 실패로 적는다).
 */
export function mirrorRemoteRunLedgers(target: Pick<ParentHostConfig, 'host' | 'configDir'>, runId: string, prodRoot: string, ssh: SshRunner = defaultSshRunner): string[] {
  if (!RUN_ID_RE.test(runId)) throw new Error(`invalid runId: ${runId}`);
  const dir = remoteLedgerMirrorDir(prodRoot, target.host);
  mkdirSync(dir, { recursive: true });
  const remoteDir = `${target.configDir ?? DEFAULT_REMOTE_CONFIG_DIR}/run-ledger`;
  const pulled: string[] = [];
  const pull = (id: string): string | null => {
    const file = remotePath(`${remoteDir}/${id}.jsonl`);
    // 부재만 ABSENT — 권한·읽기 오류는 cat 의 비0 종료로 올라와 던진다(«없음»으로 바꾸지 않는다).
    const result = ssh(target.host, `if [ -e ${file} ]; then cat ${file}; else echo __ELANOUS_ABSENT__; fi`, 20_000);
    if (result.status !== 0) throw new Error(`원격 원장 읽기 실패(${target.host} ${id}): ${(result.stderr.trim().split('\n').pop() || `rc=${result.status}`).slice(0, 200)}`);
    const path = join(dir, `${id}.jsonl`);
    if (result.stdout.trim() === '__ELANOUS_ABSENT__') {
      // 원격에서 사라졌으면 낡은 거울도 걷는다 — 지난 사진을 지금 근거로 읽지 않게.
      rmSync(path, { force: true });
      return null;
    }
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, result.stdout);
    renameSync(tmp, path);
    pulled.push(id);
    return result.stdout;
  };
  const host = pull(runId);
  if (host) {
    const children = new Set<string>();
    for (const line of host.split('\n')) {
      try {
        const entry = JSON.parse(line) as { event?: string; data?: { childRunId?: unknown } };
        if (entry.event === 'pod-child-run' && typeof entry.data?.childRunId === 'string' && RUN_ID_RE.test(entry.data.childRunId) && entry.data.childRunId !== runId) children.add(entry.data.childRunId);
      } catch { /* 깨진 줄은 원장 읽기가 다룬다 */ }
    }
    for (const child of children) pull(child);
  }
  try { debug.log('task-agent', 'remote-ledger-mirrored', { host: target.host, runId, pulled }); } catch { /* fail-soft */ }
  return pulled;
}

// ── 낡은 부모 보고(읽기 전용 · 죽이지 않는다) ─────────────────────────────────────────────

export interface HarnessParentProcess { pid: number; ageHours: number; runId: string | null; version: string | null; seat: string | null; kind: 'say' | 'ask' | 'queue-child' }

/** macOS/Linux `etime` — `[[dd-]hh:]mm:ss`. */
export function parseEtime(value: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value.trim());
  if (!match) return null;
  const [, d, h, m, s] = match;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s);
}

/** `ps -axwwE -o pid=,etime=,command=` 출력 → 하니스 부모들. 런 id 는 env 꼬리의 «마지막» `ELANOUS_RUN_ID=`. */
export function parseHarnessParents(psOutput: string): HarnessParentProcess[] {
  const rows: HarnessParentProcess[] = [];
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const command = match[3]!;
    const head = command.slice(0, 600);
    const kind = /harness-queue-child\.ts/.test(head) ? 'queue-child' : /elanous\.mjs\b.*\bharness (say|ask)\b/.exec(head)?.[1] as 'say' | 'ask' | undefined;
    if (!kind) continue;
    const seconds = parseEtime(match[2]!);
    if (seconds === null) continue;
    const runIds = [...command.matchAll(/(?:^|\s)ELANOUS_RUN_ID=(run-[A-Za-z0-9_-]{4,64})(?=\s|$)/g)].map((m) => m[1]!);
    rows.push({
      pid: Number(match[1]),
      ageHours: Math.round((seconds / 3600) * 10) / 10,
      runId: runIds.at(-1) ?? null,
      version: /\/versions\/([^/\s]+)\//.exec(head)?.[1] ?? null,
      seat: /--seat (\S+)/.exec(head)?.[1] ?? null,
      kind,
    });
  }
  return rows;
}

export interface StaleParentRow extends HarnessParentProcess { reasons: string[]; runStatus: string | null }

export interface StaleParentDeps {
  ps?: () => string;
  /** 런 원장(없으면 null · 못 읽으면 던진다). */
  loadLedger?: (runId: string) => Array<{ event: string; data?: Record<string, unknown> }> | null;
  /** 살아 있는 Pod Job 의 `elanous.run`/`elanous.child-run` 라벨 — null 이면 «못 쟀다»(Pod 근거 없음). */
  podRuns?: () => ReadonlySet<string> | null;
  labelOf?: (runId: string) => string;
}

/**
 * 나이 ≥ olderThanHours 인 부모 중 «원장이 끝났다»(run-status 줄) 또는 «Pod 이 없다»(Pod 목록을 쟀고 부모·자식 라벨이 없다)인 것.
 * 읽기만 한다 — 죽이지 않는다. 런 id 를 모르는 부모는 `run-id-unknown` 으로 따로 적는다(낡음 판정이 아니다).
 */
export function staleHarnessParents(olderThanHours: number, deps: StaleParentDeps = {}): { rows: StaleParentRow[]; scanned: number; podRunsMeasured: boolean } {
  const ps = deps.ps ?? (() => spawnSync('ps', ['-axwwE', '-o', 'pid=,etime=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout ?? '');
  const parents = parseHarnessParents(ps());
  let podRuns: ReadonlySet<string> | null = null;
  try { podRuns = deps.podRuns ? deps.podRuns() : null; } catch { podRuns = null; }
  const label = deps.labelOf ?? ((id: string) => id);
  const rows: StaleParentRow[] = [];
  for (const parent of parents) {
    if (parent.ageHours < olderThanHours) continue;
    const reasons: string[] = [];
    let runStatus: string | null = null;
    if (!parent.runId) reasons.push('run-id-unknown');
    else {
      let ledger: ReturnType<NonNullable<StaleParentDeps['loadLedger']>> = null;
      try { ledger = deps.loadLedger ? deps.loadLedger(parent.runId) : null; } catch (error) { reasons.push(`ledger-unreadable: ${(error instanceof Error ? error.message : String(error)).slice(0, 80)}`); }
      const status = [...(ledger ?? [])].reverse().find((entry) => entry.event === 'run-status' && typeof entry.data?.runStatus === 'string');
      if (status) { runStatus = String(status.data!.runStatus); reasons.push(`ledger-terminal(${runStatus})`); }
      if (podRuns) {
        const ids = [parent.runId, ...(ledger ?? []).filter((entry) => entry.event === 'pod-child-run' && typeof entry.data?.childRunId === 'string').map((entry) => entry.data!.childRunId as string)];
        if (!ids.some((id) => podRuns!.has(label(id)))) reasons.push('pod-gone');
      }
    }
    if (reasons.length) rows.push({ ...parent, reasons, runStatus });
  }
  rows.sort((a, b) => b.ageHours - a.ageHours);
  return { rows, scanned: parents.length, podRunsMeasured: podRuns !== null };
}

/** HQ 의 elanous 판 — 이 패키지의 package.json(첫 낱말 = `--version` 첫 낱말과 같은 모양). */
export function localElanousVersion(): string {
  try { return String((JSON.parse(readFileSync(resolve(import.meta.dir, '../../package.json'), 'utf8')) as { version?: string }).version ?? ''); } catch { return ''; }
}
