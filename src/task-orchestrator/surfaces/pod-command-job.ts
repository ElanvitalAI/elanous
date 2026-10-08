// ☸️ 명령 Job — 하니스 없이 스크립트 한 줄을 Pod 에서 돌리고 `~/outbox` 산출을 호스트로 돌려받는다.
//
// 자격은 기본 0 이다. `skills` 에 이름이 있을 때만 그 스킬 `.env`(기존 스킬 키 관 · 런 Secret · 0600)를,
// `llm: 'grok'` 일 때만 grok access 사본(refresh 없음 · `hostGrokCredentials` 검사 재사용)을 싣는다.
// codex·elanous 자격 파일은 이 Job 에 없다. 격리 관문(호스트 넥서스에 닿으면 종료)은 기존 Job 과 같다.
// 명령 인자는 셸 문자열로 이어붙이지 않고 `"$@"` 로 따로 인용한다.

import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { getUserConfig } from '../../user-config.js';
import { debug } from '../../debug/log.js';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { collectPodArtifacts } from './pod-artifact-return.js';
import { getDefaultLogStore, type LogStore } from '../../mss/logging/log-store.js';
import { podBunCacheVolume } from './pod-bun-cache.js';
import { podHostDirsInit, podInstallSlotsVolume } from './pod-install-slots.js';
import { type PodPoolMember, PodPoolScheduler, resolvePodPoolSpec, parsePodPool, checkPodPool, syncPoolImages, type PoolKubectl } from './pod-pool.js';
import { podSkillsDigest, readSkillEnvFiles, resolvePodSkills } from './pod-skills.js';
import { podSourceScript, type PodSource } from './pod-source-receive.js';
import {
  POD_CHILD_REQUESTS,
  POD_JOB_DEADLINE_SECONDS,
  defaultGhToken,
  defaultKubectl,
  hostGrokCredentials,
  podImageFreshness,
  podJobName,
  type Kubectl,
} from './self-implement-pod.js';

/** CLI `--deadline` 생략 시 — 기존 Pod Job 수명 상한과 같다. */
export const POD_COMMAND_DEADLINE_SECONDS = POD_JOB_DEADLINE_SECONDS;

export const POD_NETWORK_SKILLS = ['omni-crawl', 'omni-digest'] as const;
export const POD_LITE_IMAGE = 'elanous-harness-lite:local';

export const POD_LITE_MEMORY_LIMIT = '2Gi';

/** 요청은 한도를 넘을 수 없다(쿠버네티스가 Job 을 거부한다) — lite 2Gi 처럼 한도가 기본 요청보다 작으면 한도로 맞춘다. */
/** The command Job container's CPU limit when the caller names none (GATE-SPEED A3①: unchanged default). */
export const POD_COMMAND_CPU_LIMIT_DEFAULT = '4';

/** Container CPU request/limit override. Omitted fields keep the defaults (request `POD_CHILD_REQUESTS.cpu` · limit 4). */
export interface PodCpu { request?: string; limit?: string }

/** Kubernetes CPU quantity → millicores (`1` · `0.5` · `500m`); null when it is not a positive quantity we accept. */
export function podCpuMillis(value: string): number | null {
  const m = /^(?:(\d+(?:\.\d{1,3})?)|(\d+)m)$/.exec(value.trim());
  if (!m) return null;
  const millis = m[1] !== undefined ? Math.round(Number(m[1]) * 1000) : Number(m[2]);
  return Number.isSafeInteger(millis) && millis > 0 ? millis : null;
}

/** Resolve a CPU override against the defaults; throws when a value is malformed or the request exceeds the limit (k8s would refuse the Job). */
export function resolvePodCpu(cpu: PodCpu | undefined): { request: string; limit: string } {
  const request = cpu?.request?.trim() || POD_CHILD_REQUESTS.cpu;
  const limit = cpu?.limit?.trim() || POD_COMMAND_CPU_LIMIT_DEFAULT;
  const r = podCpuMillis(request), l = podCpuMillis(limit);
  if (r === null) throw new Error(`pod cpu request is not a positive CPU quantity: ${request}`);
  if (l === null) throw new Error(`pod cpu limit is not a positive CPU quantity: ${limit}`);
  if (r > l) throw new Error(`pod cpu request ${request} exceeds limit ${limit}`);
  return { request, limit };
}

/** Config value → CPU override (release gate `release.loop.gatePodCpu`). A scalar (`2` · `"1500m"`) sets request = limit;
 *  `{ request, limit }` sets either side. Absent/empty = undefined (request 1 / limit 4). Malformed values throw. */
export function parsePodCpu(value: unknown, label = 'cpu'): PodCpu | undefined {
  const text = (v: unknown): string | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'number' && typeof v !== 'string') throw new Error(`${label} must be a CPU quantity or { request, limit }`);
    return String(v).trim() || undefined;
  };
  let cpu: PodCpu;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const { request, limit, ...rest } = value as Record<string, unknown>;
    if (Object.keys(rest).length) throw new Error(`${label} has unknown keys: ${Object.keys(rest).join(', ')}`);
    const r = text(request), l = text(limit);
    cpu = { ...(r ? { request: r } : {}), ...(l ? { limit: l } : {}) };
  } else {
    const both = text(value);
    cpu = both ? { request: both, limit: both } : {};
  }
  if (!cpu.request && !cpu.limit) return undefined;
  resolvePodCpu(cpu);
  return cpu;
}

export function memoryRequestWithin(limit: string | undefined): string {
  const gi = (value: string | undefined) => { const m = /^(\d+)Gi$/.exec(value ?? ''); return m ? Number(m[1]) : null; };
  const request = gi(POD_CHILD_REQUESTS.memory);
  const max = gi(limit);
  return request !== null && max !== null && request > max ? limit! : POD_CHILD_REQUESTS.memory;
}

/** POD7 must-fix: the skill list alone can't tell a network-only job from one that needs ffmpeg/browser — so lite is
 *  only ever chosen when the caller says so (`lite`), and then only for network skills without a clone. Anything we
 *  can't judge keeps the full image. A lite request that doesn't fit is refused with the reason, not silently widened. */
export function podCommandImageFor(skills: readonly string[], clone: boolean, lite = false): string {
  if (!lite) return 'elanous-harness:local';
  if (clone) throw new Error('pod command: --lite 는 clone 없는 명령만 받는다(lite 이미지는 git·빌드 도구가 적다)');
  const outside = skills.filter((skill) => !(POD_NETWORK_SKILLS as readonly string[]).includes(skill));
  if (skills.length === 0 || outside.length > 0) {
    throw new Error(`pod command: --lite 는 네트워크 스킬(${POD_NETWORK_SKILLS.join('·')})만 받는다${outside.length ? ` — 벗어난 스킬: ${outside.join(', ')}` : ' — --skill 이 없다'}`);
  }
  return POD_LITE_IMAGE;
}

const COMMAND_LOG_CHARS = 80;

/** 자식 로그 전문 상한(바이트) — 넘으면 끝부분을 남긴다. config `pod.childLogMaxBytes` 가 양의 정수일 때만 그 값. */
export const POD_CHILD_LOG_MAX_BYTES_DEFAULT = 1_048_576;

export function podChildLogMaxBytes(read: () => number | undefined = () => getUserConfig().pod?.childLogMaxBytes): number {
  const configured = read();
  return typeof configured === 'number' && Number.isSafeInteger(configured) && configured > 0
    ? configured
    : POD_CHILD_LOG_MAX_BYTES_DEFAULT;
}

/** 크기 상한을 넘으면 끝부분을 남긴다(잘린 앞은 표시). */
export function tailBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  const cut = bytes.subarray(bytes.length - maxBytes);
  let start = 0;
  while (start < cut.length && (cut[start]! & 0xc0) === 0x80) start += 1;
  return `…[앞 ${bytes.length - maxBytes}바이트 생략]\n${cut.subarray(start).toString('utf8')}`;
}

const GATE = `ok=0
for i in $(seq 1 60); do
  if curl -s -m 1 -o /dev/null http://host.orb.internal:31415/health || curl -s -m 1 -o /dev/null http://core.elanous-prod:8080/; then ok=0; else ok=$((ok+1)); fi
  [ "$ok" -ge 3 ] && { echo "[gate] isolation enforced after \${i} probes"; exit 0; }
  sleep 0.5
done
echo "[gate] ISOLATION NOT ENFORCED within 30s"; exit 1`;

/** Export the command's log store into the existing outbox return channel without changing the command exit status. */
const COMMAND_LOG_EXPORT = `if mkdir -p "$HOME/outbox/pod-logs" && elanous --test="$HOME/.elanous-test" logs --instance prod --since 12h --limit 20000 --json --json-data > "$HOME/outbox/pod-logs/logs.jsonl"; then
  logs_size=$(( $(wc -c < "$HOME/outbox/pod-logs/logs.jsonl") ))
  if [ "$logs_size" -gt 5242880 ]; then
    tail -c 5242880 "$HOME/outbox/pod-logs/logs.jsonl" | tail -n +2 > "$HOME/outbox/pod-logs/logs.jsonl.tail" && mv -f "$HOME/outbox/pod-logs/logs.jsonl.tail" "$HOME/outbox/pod-logs/logs.jsonl"
    printf 'ELANOUS_POD_LOGS_TRUNCATED %s %s\\n' "$logs_size" "$(( $(wc -c < "$HOME/outbox/pod-logs/logs.jsonl") ))"
  fi
else
  logs_rc=$?
  rm -f "$HOME/outbox/pod-logs/logs.jsonl"
  printf 'ELANOUS_POD_LOGS_UNAVAILABLE export-exit-%s\\n' "$logs_rc"
fi`;

/** 기존 Job 과 같은 `~/outbox` 조각 형식(`ELANOUS_POD_ARTIFACT`). 원장 회수는 하지 않는다. */
const ARTIFACT_EMIT = `set -o pipefail
artifact_bytes=0
if [ -d "$HOME/outbox" ]; then
  while IFS= read -r -d '' file; do
    [ -f "$file" ] && [ ! -L "$file" ] || continue
    relative=\${file#"$HOME/outbox/"}
    size=$(( $(wc -c < "$file") ))
    if [ "$size" -gt 5242880 ] || [ $((artifact_bytes + size)) -gt 20971520 ]; then
      printf 'ELANOUS_POD_ARTIFACT_SKIPPED %s %s\\n' "$relative" "$size"
      continue
    fi
    path_token=$(printf '%s' "$relative" | base64 | tr -d '\\n' | tr '+/' '-_' | tr -d '=')
    if encoded=$(gzip -c "$file" | base64 | tr -d '\\n'); then
      artifact_bytes=$((artifact_bytes + size))
      total=$(( (\${#encoded} + 7999) / 8000 ))
      for ((n=1; n<=total; n++)); do
        chunk=\${encoded:$(( (n-1)*8000 )):8000}
        printf 'ELANOUS_POD_ARTIFACT %s %s/%s %s\\n' "$path_token" "$n" "$total" "$chunk"
      done
    else
      printf 'ELANOUS_POD_ARTIFACT_SKIPPED %s %s\\n' "$relative" "$size"
    fi
  done < <(find "$HOME/outbox" -type f -print0)
fi`;

export interface PodCommandJobInput {
  /** POD1 — this launch's own label; cleanup selects by it, never by name alone. */
  launch?: string;
  name: string;
  namespace: string;
  image: string;
  imagePullPolicy?: 'Never' | 'IfNotPresent';
  repoUrl: string;
  command: readonly string[];
  skills: readonly string[];
  /** pod run opt-in: return this command's local log store with its outbox artifacts. */
  returnLogs?: boolean;
  llm?: 'grok';
  /** 저장소를 clone 한다 — 비공개 저장소라 GitHub 토큰이 Secret 으로 간다(명시 opt-in). 기본은 clone 없이 `~/work` 에서 이미지의 `elanous` 로 돈다. */
  clone?: boolean;
  hostMirror?: string;
  bunCache?: string;
  /** GATE-INSTALL-CACHE — hostPath of the node-wide install tokens (release gate shards only · `pod-install-slots.ts`). */
  installSlots?: string;
  /** 컨테이너 메모리 한도(기본 16Gi) — 게이트가 파일 하나 격리 Job 에 올린다. */
  memoryLimit?: string;
  /** GATE-SPEED A3①: CPU request/limit override (release gate shards only). Omitted = request 1 / limit 4. */
  cpu?: PodCpu;
  source?: PodSource;
  deadlineSeconds: number;
  runId?: string;
}

function bashSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 명령 Job 매니페스트. `skills`·`llm` 을 안 주면 Secret 키를 하나도 참조하지 않는다. */
export function podCommandJobManifest(o: PodCommandJobInput): Record<string, unknown> {
  const skillNames = [...new Set(o.skills.map((s) => s.trim()).filter(Boolean))];
  for (const name of skillNames) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) throw new Error(`pod command skill name rejected: ${name}`);
  }
  const grok = o.llm === 'grok';
  const bunCache = o.bunCache ? podBunCacheVolume(o.bunCache) : undefined;
  const installSlots = o.installSlots ? podInstallSlotsVolume(o.installSlots) : undefined;
  // hostPath directories the uid-1000 child writes: a root init container hands them over (DirectoryOrCreate is root 0755).
  const hostDirMounts = [...(bunCache ? [bunCache.volumeMount] : []), ...(installSlots ? [installSlots.volumeMount] : [])];
  const cpu = resolvePodCpu(o.cpu);
  const quotedArgs = o.command.map(bashSingleQuote).join(' ');
  const credLines = [
    ...(grok ? ['mkdir -p ~/.grok && install -m 600 /creds/grok-auth.json ~/.grok/auth.json'] : []),
    ...(skillNames.length
      ? [`for n in ${skillNames.join(' ')}; do [ -d ~/.claude/skills/$n ] && install -m 600 /creds/skillenv-$n ~/.claude/skills/$n/.env; done`]
      : []),
  ];
  const script = [
    'set -u',
    ...credLines,
    'curl -s -m 3 -o /dev/null http://host.orb.internal:31415/health && { echo "[pod] ISOLATION FAIL"; exit 3; }',
    ...(o.clone
      ? ['export GH_TOKEN="$(cat /creds/gh-token)" && gh auth setup-git', podSourceScript(o.source ?? { kind: 'default' }, o.repoUrl)]
      : ['mkdir -p ~/work && cd ~/work']),
    ...(bunCache ? [bunCache.shellPrefix] : []),
    `set -- ${quotedArgs}`,
    '"$@"',
    'rc=$?',
    // A command may not end in LF; keep artifact markers on their own line for the existing parser.
    ...(o.returnLogs ? ["printf '\\n'", COMMAND_LOG_EXPORT] : []),
    ARTIFACT_EMIT,
    'exit $rc',
  ].join('\n');
  const secretKeys = grok || skillNames.length || o.clone === true;
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: o.name, namespace: o.namespace, labels: { 'elanous.substrate': 'pod', 'elanous.job': o.name, 'elanous.kind': 'command', ...(o.launch ? { 'elanous.launch': o.launch } : {}) } },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 7200,
      activeDeadlineSeconds: o.deadlineSeconds,
      template: {
        metadata: { labels: { 'elanous.job': o.name, 'elanous.kind': 'command', ...(o.launch ? { 'elanous.launch': o.launch } : {}) } },
        spec: {
          restartPolicy: 'Never',
          securityContext: { runAsUser: 1000, fsGroup: 1000 },
          initContainers: [
            { name: 'isolation-gate', image: o.image, imagePullPolicy: o.imagePullPolicy ?? 'Never', command: ['bash', '-c'], args: [GATE] },
            ...(hostDirMounts.length ? [podHostDirsInit(o.image, o.imagePullPolicy ?? 'Never', hostDirMounts)] : []),
          ],
          containers: [{
            name: 'child', image: o.image, imagePullPolicy: o.imagePullPolicy ?? 'Never',
            resources: { requests: { ...POD_CHILD_REQUESTS, cpu: cpu.request, memory: memoryRequestWithin(o.memoryLimit) }, limits: { memory: o.memoryLimit ?? '16Gi', cpu: cpu.limit } },
            command: ['bash', '-c'], args: [script],
            env: [
              ...(o.runId ? [{ name: 'ELANOUS_RUN_ID', value: o.runId }] : []),
              { name: 'ELANOUS_SUBSTRATE', value: 'pod' },
              { name: 'ELANOUS_POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
            ],
            ...(secretKeys || o.hostMirror || hostDirMounts.length ? { volumeMounts: [
              ...(secretKeys ? [{ name: 'creds', mountPath: '/creds', readOnly: true }] : []),
              ...(o.hostMirror ? [{ name: 'host-mirror', mountPath: '/host-mirror', readOnly: true }] : []),
              ...hostDirMounts,
            ] } : {}),
          }],
          ...(secretKeys || o.hostMirror || hostDirMounts.length ? { volumes: [
            ...(secretKeys ? [{ name: 'creds', secret: { secretName: `${o.name}-creds`, defaultMode: 0o400 } }] : []),
            ...(o.hostMirror ? [{ name: 'host-mirror', hostPath: { path: o.hostMirror, type: 'Directory' } }] : []),
            ...(bunCache ? [bunCache.volume] : []),
            ...(installSlots ? [installSlots.volume] : []),
          ] } : {}),
        },
      },
    },
  };
}

export function commandJobSecret(o: {
  name: string;
  namespace: string;
  skills: readonly string[];
  skillEnvText: Readonly<Record<string, string>>;
  grokAuth?: string;
  ghToken?: string;
  launch?: string;
}): Record<string, unknown> | null {
  const stringData: Record<string, string> = {};
  if (o.grokAuth !== undefined) stringData['grok-auth.json'] = o.grokAuth;
  if (o.ghToken !== undefined) stringData['gh-token'] = o.ghToken;
  for (const name of o.skills) {
    const text = o.skillEnvText[name];
    if (text !== undefined) stringData[`skillenv-${name}`] = text;
  }
  if (Object.keys(stringData).length === 0) return null;
  return {
    apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
    metadata: { name: `${o.name}-creds`, namespace: o.namespace, labels: { 'elanous.job': o.name, ...(o.launch ? { 'elanous.launch': o.launch } : {}) } },
    stringData,
  };
}

export function podCommandScript(manifest: Record<string, unknown>): string {
  const spec = manifest.spec as { template: { spec: { containers: Array<{ args: string[] }> } } };
  return spec.template.spec.containers[0]!.args[0]!;
}

export function podCommandSecretKeys(secret: Record<string, unknown> | null): string[] {
  if (!secret) return [];
  return Object.keys((secret.stringData as Record<string, string> | undefined) ?? {});
}

export interface PodArtifactCollection {
  /** 회수한 산출 파일 수(child.log 제외). 로그 조회 실패면 null. */
  files: number | null;
  /** 회수한 산출 파일의 상대 경로. */
  names: string[];
  /** 로그 조회 자체가 실패했을 때의 사유. 성공이면 null. */
  error: string | null;
}

export interface PodCommandResult {
  exitCode: number;
  artifactsDir: string;
  job: string;
  /** 이 런이 실제로 쓴 이미지(레지스트리 판 태그 또는 로컬 이름). */
  image?: string;
  /** collectPodArtifacts 가 회수한 파일. 로그 조회 실패면 files=null · error=사유. runPodCommand 는 항상 채운다. */
  artifacts?: PodArtifactCollection;
}

export interface RunPodCommandOptions {
  command: readonly string[];
  /** pod run opt-in; other runPodCommand callers keep their existing Job script. */
  returnLogs?: boolean;
  pool?: string;
  skills?: readonly string[];
  llm?: 'grok';
  clone?: boolean;
  hostMirror?: string;
  bunCache?: string;
  /** GATE-INSTALL-CACHE — hostPath of the node-wide install tokens (absolute). */
  installSlots?: string;
  /** 컨테이너 메모리 한도(기본 16Gi · lite 면 2Gi). */
  memoryLimit?: string;
  /** GATE-SPEED A3①: CPU request/limit override — only the release gate passes it. Omitted = request 1 / limit 4. */
  cpu?: PodCpu;
  /** POD7: 호출부가 «네트워크 스킬만 쓰는 명령»이라고 말할 때만 lite 이미지 ⊕ 2Gi. */
  lite?: boolean;
  source?: PodSource;
  ghToken?: () => string;
  deadlineSeconds?: number;
  namespace?: string;
  image?: string;
  repoUrl?: string;
  runId?: string;
  name?: string;
  pollMs?: number;
  kubectl?: Kubectl;
  /** A caller-owned scheduler is self-capped: acquires count only its own Jobs, never cluster occupancy (POOLGLOBAL-REG). */
  poolScheduler?: PodPoolScheduler;
  checkPool?: typeof checkPodPool;
  syncImages?: typeof syncPoolImages;
  imageCommit?: string | null;
  readSkillEnv?: (skills: readonly string[]) => Record<string, string>;
  grokCredentials?: () => { grokAuth?: string; grokApiKey?: string; ghToken: string };
  artifactsRoot?: string;
  /** Test seam for the launching instance's log store. */
  logStore?: LogStore | null;
  sleep?: (ms: number) => Promise<void>;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
  env?: NodeJS.ProcessEnv;
  configHostMirror?: () => string | undefined;
  /** 자식 로그 전문 상한(바이트). 생략 시 config `pod.childLogMaxBytes`, 없으면 1MiB. 넘으면 끝부분 우선. */
  childLogMaxBytes?: number;
}

function jobFinished(types: string): 'complete' | 'failed' | null {
  if (/Complete|SuccessCriteriaMet/.test(types)) return 'complete';
  if (/Failed|FailureTarget/.test(types)) return 'failed';
  return null;
}

function artifactNames(logs: string): string[] {
  const names = new Set<string>();
  for (const line of logs.split(/\r?\n/)) {
    const match = /^ELANOUS_POD_ARTIFACT (\S+) \d+\/\d+ /.exec(line);
    if (!match) continue;
    try {
      const path = Buffer.from(match[1]!, 'base64url').toString('utf8');
      if (path && !path.split('/').some((part) => part === '' || part === '.' || part === '..')) names.add(path);
    } catch { /* 회수 쪽(collectPodArtifacts)이 불완전 사유를 남긴다 */ }
  }
  return [...names];
}

function exitCodeFromPod(kubectl: Kubectl, namespace: string, job: string, state: 'complete' | 'failed'): number {
  const got = kubectl(['-n', namespace, 'get', 'pods', '-l', `job-name=${job}`, '-o', 'jsonpath={.items[0].status.containerStatuses[?(@.name=="child")].state.terminated.exitCode}']);
  const code = Number(got.stdout.trim());
  if (got.status === 0 && Number.isInteger(code)) return code;
  return state === 'complete' ? 0 : 1;
}

/** 명령 Job 의 목표 이미지 판. 원격 노드면 발사 트리의 HEAD(없으면 로컬 이미지 판) · 이 기계면 로컬 이미지 판. */
export function podCommandTargetCommit(o: { remote: boolean; gitHead: () => string | null; localImageCommit: () => string | null }): string | null {
  if (o.remote) return o.gitHead() ?? o.localImageCommit();
  return o.localImageCommit();
}

/** 풀 자리 · 이미지 판 · Job 적용 · 완료 대기 · 산출 회수 · Secret 정리. */
export async function runPodCommand(options: RunPodCommandOptions): Promise<PodCommandResult> {
  const command = [...options.command];
  if (command.length === 0) throw new Error('pod command: 명령이 비었다');
  const skills = [...new Set((options.skills ?? []).map((s) => s.trim()).filter(Boolean))];
  const llm = options.llm;
  const log = options.log ?? ((c, e, d) => debug.log(c, e, d));
  const baseKubectl = options.kubectl ?? defaultKubectl;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const namespace = options.namespace ?? 'elanous-test';
  const image = options.image ?? podCommandImageFor(skills, options.clone === true, options.lite === true);
  const memoryLimit = options.memoryLimit ?? (image === POD_LITE_IMAGE ? POD_LITE_MEMORY_LIMIT : undefined);
  const repoUrl = options.repoUrl ?? 'https://github.com/ElanvitalAI/elanous';
  const deadlineSeconds = options.deadlineSeconds ?? POD_COMMAND_DEADLINE_SECONDS;
  // POD1 (10-01): two launches in the same moment got the same `si-cmd-<time>` and the failing one's cleanup
  // deleted the other's credentials. The name now has a random tail, and cleanup selects this launch's label.
  const launch = randomBytes(6).toString('hex');
  const name = options.name ?? podJobName(`cmd-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`);
  const own = `elanous.job=${name},elanous.launch=${launch}`;
  const env = options.env ?? process.env;
  const hostMirror = (options.hostMirror ?? env.ELANOUS_POD_HOST_MIRROR
    ?? (options.configHostMirror ?? (() => getUserConfig().pod?.hostMirror))())?.trim() || undefined;
  if (hostMirror && !isAbsolute(hostMirror)) throw new Error('pod.hostMirror must be an absolute directory path');
  const bunCache = options.bunCache?.trim() || undefined;
  if (bunCache && !isAbsolute(bunCache)) throw new Error('pod.bunCache must be an absolute directory path');
  const installSlots = options.installSlots?.trim() || undefined;
  if (installSlots && !isAbsolute(installSlots)) throw new Error('pod installSlots must be an absolute directory path');
  // Fail before any Secret/Job is applied — a bad quantity must not reach the cluster.
  if (options.cpu) resolvePodCpu(options.cpu);

  let member: PodPoolMember | null = null;
  let pool = options.poolScheduler;
  if (!pool) {
    const spec = resolvePodPoolSpec(options.pool, env, () => options.kubectl ? undefined : getUserConfig().pod?.pool);
    if (options.pool && !spec) throw new Error('pod command: 풀 스펙이 비었다');
    if (spec) {
      const members = parsePodPool(spec);
      const checked = (options.checkPool ?? checkPodPool)(members, baseKubectl as PoolKubectl);
      if (!checked.ok) throw new Error('pod command: 풀의 노드가 하나도 준비되지 않았다');
      // Occupancy reads go through the same kubectl as the readiness check (an injected one included).
      pool = new PodPoolScheduler(checked.ready, { kubectl: baseKubectl as PoolKubectl });
    }
  }
  if (pool) {
    // POOLGLOBAL-REG: a caller that hands in its own scheduler (the release gate fans its shards over one) holds its own
    // concurrency cap — its Jobs count against the spec caps, not the cluster's goal Pods (#24253 → 0.2.15 gate ran 1 shard).
    const selfCapped = options.poolScheduler !== undefined;
    for (;;) {
      member = await pool.tryAcquire(undefined, undefined, { selfCapped });
      if (member) break;
      await sleep(options.pollMs ?? 15_000);
    }
  }
  const currentContext = member || options.kubectl ? null : baseKubectl(['config', 'current-context']);
  const context = member?.context ?? (currentContext?.status === 0 ? currentContext.stdout.trim() : '');
  const kubectl: Kubectl = (args, stdin) => baseKubectl(context ? ['--context', context, ...args] : [...args], stdin);
  const cleanupSecret = () => { kubectl(['-n', namespace, 'delete', 'secret', '-l', own, '--ignore-not-found']); };
  const artifactRoot = options.artifactsRoot ?? `${effectiveInstanceRoot()}/pod-artifacts`;
  const artifactsDir = `${artifactRoot}/${name}`;
  try {
    if (!context && !options.kubectl) throw new Error('pod command: kubectl context 를 확인할 수 없다');
    let grokAuth: string | undefined;
    if (llm === 'grok') {
      const creds = (options.grokCredentials ?? (() => hostGrokCredentials({ env, apiKeyOptIn: false })))();
      if (!creds.grokAuth) throw new Error('grok: 구독 자격 없음 · API 키 opt-in 꺼짐 또는 키 없음');
      let parsed: unknown;
      try { parsed = JSON.parse(creds.grokAuth); } catch { throw new Error('grok: Pod 구독 자격 JSON 이 아니다'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.values(parsed).some((scope) => scope && typeof scope === 'object' && typeof (scope as { key?: unknown }).key === 'string') || /"[^"]*refresh[^"]*"\s*:/i.test(creds.grokAuth)) {
        throw new Error('grok: Pod 구독 자격에 access 토큰이 없거나 refresh 필드가 있다');
      }
      grokAuth = creds.grokAuth;
    }
    const skillEnvText = skills.length ? (options.readSkillEnv ?? readSkillEnvFiles)(skills) : {};
    // ☸️ 원격 노드면 목표 판 = 발사 트리의 HEAD(하니스 발사와 같은 규칙) — 이 기계의 로컬 이미지 판을 따르지 않는다.
    //   🐞 2026-09-27(🅞 실측): 로컬 `elanous-harness:local` 이 옛 판(30f95cf1)이라 레지스트리의 옛 태그를 골라 새 스킬이 없는 이미지로 돌았다.
    const imageCommit = options.imageCommit !== undefined
      ? options.imageCommit
      : options.kubectl ? null
        : podCommandTargetCommit({
          remote: Boolean(member?.sshHost),
          gitHead: () => spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim() || null,
          localImageCommit: () => podImageFreshness({ image }).imageCommit,
        });
    if (pool && member) {
      const localSkillsDigest = options.kubectl ? null : image === POD_LITE_IMAGE
        ? podSkillsDigest(POD_NETWORK_SKILLS, resolve(import.meta.dir, '../../../skills')).digest
        : podSkillsDigest(resolvePodSkills(env).skills).digest;
      const syncs = await (options.syncImages ?? syncPoolImages)([member], image, imageCommit, { localSkillsDigest });
      const synced = syncs.get(member.context);
      if (synced && !synced.ok) throw new Error(`pod command: 이미지 판을 못 맞췄다: ${synced.detail}`);
      if (synced?.imageRef) member = { ...member, imageRef: synced.imageRef };
    }
    const imageRef = member?.imageRef;
    if (!imageRef) log('pod.command-job', 'image-fallback-local', { reason: !member ? 'no-pool-member' : !imageCommit ? 'image-commit-unavailable' : 'registry-tag-unavailable' });
    const ghToken = options.clone ? (options.ghToken ?? defaultGhToken)() : undefined;
    const secret = commandJobSecret({ name, namespace, launch, skills, skillEnvText, ...(grokAuth !== undefined ? { grokAuth } : {}), ...(ghToken !== undefined ? { ghToken } : {}) });
    if (secret) {
      const applied = kubectl(['apply', '-f', '-'], JSON.stringify(secret));
      if (applied.status !== 0) throw new Error(applied.stderr.trim() || 'pod command: Secret 적용 실패');
    }
    const manifest = podCommandJobManifest({
      name, namespace, launch, image: imageRef ?? image,
      ...(imageRef ? { imagePullPolicy: 'IfNotPresent' as const } : {}),
      repoUrl, command, skills, ...(options.returnLogs ? { returnLogs: true } : {}), ...(llm ? { llm } : {}), ...(options.clone ? { clone: true } : {}),
      ...(options.source ? { source: options.source } : {}), ...(hostMirror ? { hostMirror } : {}), ...(bunCache ? { bunCache } : {}), ...(installSlots ? { installSlots } : {}), ...(memoryLimit ? { memoryLimit } : {}), ...(options.cpu ? { cpu: options.cpu } : {}), deadlineSeconds,
      ...(options.runId ? { runId: options.runId } : {}),
    });
    kubectl(['-n', namespace, 'delete', 'job', '-l', own, '--ignore-not-found']);
    const applied = kubectl(['apply', '-f', '-'], JSON.stringify(manifest));
    if (applied.status !== 0) {
      cleanupSecret();
      throw new Error(applied.stderr.trim() || 'pod command: Job 적용 실패');
    }
    let state: 'complete' | 'failed' = 'failed';
    for (;;) {
      const got = kubectl(['-n', namespace, 'get', 'job', name, '-o', 'jsonpath={.status.conditions[*].type}']);
      const finished = jobFinished(got.stdout);
      if (finished) { state = finished; break; }
      await sleep(options.pollMs ?? 15_000);
    }
    const logsResult = kubectl(['-n', namespace, 'logs', `job/${name}`, '-c', 'child']);
    const logsFailed = logsResult.status !== 0;
    const logs = logsFailed ? '' : logsResult.stdout;
    const artifactDir = artifactRoot;
    let artifacts: PodArtifactCollection;
    if (logsFailed) {
      const reason = logsResult.stderr.trim() || `kubectl logs exit ${logsResult.status}`;
      artifacts = { files: null, names: [], error: reason };
      log('pod.command', 'artifact-collect-failed', { job: name, reason });
    } else {
      const store = options.returnLogs ? (options.logStore === undefined ? getDefaultLogStore() : options.logStore) : null;
      collectPodArtifacts(logs, {
        dir: artifactDir, job: name, log: (c, e, d) => log(c, e, d),
        ...(options.returnLogs ? { logStore: store } : {}),
      });
      const names = artifactNames(logs);
      // A plain command need not write JSONL. Make its child output queryable without changing the store schema.
      if (options.returnLogs && store) {
        try {
          const output = logs.split(/\r?\n/).filter((line) => !line.startsWith('ELANOUS_POD_ARTIFACT ')).join('\n').trim();
          if (output) store.insertPodBatch(name, [{ line: -1, surface: 'pod', rec: {
            ts: new Date().toISOString(), category: 'pod.command', event: 'child-output', level: 'info',
            data: { job: name, output: tailBytes(output, options.childLogMaxBytes ?? podChildLogMaxBytes()), origin: 'pod', podJob: name },
          } }]);
        } catch (error) {
          log('pod.command', 'child-output-import-failed', { job: name, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      artifacts = { files: names.length, names, error: null };
    }
    // 표지가 없어도 알리는 경로는 실제로 존재해야 한다. 자식 로그 전문은 child.log (상한 넘으면 끝부분).
    mkdirSync(artifactsDir, { recursive: true });
    const maxBytes = options.childLogMaxBytes ?? podChildLogMaxBytes();
    const childLog = logsFailed ? `산출 회수 못 함: ${artifacts.error}` : tailBytes(logs, maxBytes);
    writeFileSync(resolve(artifactsDir, 'child.log'), childLog);
    const exitCode = exitCodeFromPod(kubectl, namespace, name, state);
    cleanupSecret();
    log('pod.command', 'job-finished', {
      job: name,
      exitCode,
      skills,
      llm: llm ?? null,
      command: command.join(' ').slice(0, COMMAND_LOG_CHARS),
      artifactsDir,
      artifacts,
      ...(logsFailed ? { artifactError: `산출 회수 못 함: ${artifacts.error}` } : {}),
    });
    return { exitCode, artifactsDir, job: name, image: imageRef ?? image, artifacts };
  } catch (err) {
    cleanupSecret();
    throw err;
  } finally {
    if (member && pool) pool.release(member);
  }
}
