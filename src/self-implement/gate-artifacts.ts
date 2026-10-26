import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { SPAWN_SYNC_MAX_BUFFER } from '../util/spawn-sync-output.js';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { ShardRunResult } from '../self-dev/shard-run.js';
import type { SshResult } from './gate-remote.js';

/**
 * SIDE-VERIFY — `self gate --artifact-dir <dir>` 산출 파일(R2 판정 입력 재료).
 *
 * ⭐ «쓰기만» 한다 — 판정·exit 코드·기존 출력은 이 파일이 «안» 만진다. 쓰기가 실패해도 게이트 결과는 그대로다.
 * ⛔ JUnit 이 없으면 경로를 «지어내지 않는다» — `junitPath` 를 빼고 `diagnostic` 만 남긴다.
 * ⛔ 못 쓴 것은 «조용히» 빠뜨리지 않고 `artifactsUnavailable` 로 이유를 적는다.
 *
 * 키 이름은 R2 판정 CLI(`scripts/release-loop/gate-r2-verdict.ts` · #28024)의 run 입력과 맞춘다 —
 * `head40`·`envKey`·`cohort`·`rc`·`junitPath`·`resultPath`. 쪽마다 그 꼴로 두어 그대로 뽑아 쓸 수 있게 한다.
 */

export const GATE_ARTIFACT_SUMMARY = 'summary.json';
/** run 별 결과 파일 접미 — `<shardId>-<attempt>-<side>.result.json`(R2 CLI 는 run 마다 «독립» resultPath 를 요구한다). */
export const GATE_ARTIFACT_RESULT_SUFFIX = '.result.json';

/** 왜 조각별 JUnit 이 없는가 — 경로가 원리상 그것을 안 만드는 자리. */
export type GateArtifactsUnavailable =
  /** 원격에서 잰 커밋이 `--artifact-dir` 를 모른다(그 커밋에 산출 모듈이 없다) — 원격 인자에 안 실었다. */
  | 'remote-unsupported'
  /** 원격에서 돌았지만 그 호스트의 산출 디렉토리를 못 가져왔다(ssh 실패·잘림·summary 없음). */
  | 'remote-fetch-failed'
  /** 분할 없는 직접 `bun test` 경로 — JUnit 을 만들지 않는다(조각 JUnit 은 `--shards` 일 때만). */
  | 'unsharded'
  /** 시험 단계가 없었다(변경이 시험 범위 밖). */
  | 'no-tests';

export interface GateArtifactRun {
  /** run 식별자 = `<shardId>-<attempt>-<side>`(side = current|baseline). 옛 산출(이 칸 이전)에는 없다. */
  runId?: string;
  /** 이 쪽이 잰 커밋(current = HEAD · baseline = base). 해석 못 했으면 null(지어내지 않는다). */
  head40: string | null;
  envKey: string;
  /** 이 쪽이 실제로 돌린 시험 경로(정렬). 기준 쪽에서 실제 파일이 안 알려졌으면 null(조각 파일로 지어내지 않는다). */
  cohort: string[] | null;
  rc: number | null;
  signal: string | null;
  junitPath?: string;
  /** 이 run «만» 담은 결과 파일(`<runId>.result.json` 절대 경로). 옛 산출(runId 없음)은 summary.json 경로였다. */
  resultPath: string;
  diagnostic?: string;
}

export interface GateArtifactShard {
  shardId: string;
  attempt: number;
  files: string[];
  current: GateArtifactRun;
  baseline: GateArtifactRun;
  /** Latest incomplete attempt only; the verdict remains unmeasured. */
  unmeasuredReason?: string;
}

/** SIDE-VERIFY ③ — 판정 «정수»(OPT 열차 영수증 재료). 이름은 게이트 집계(`SelfGateCliResult.baseline` ·
 *  `unrunImporterTotal`)를 따른다. ⛔ `null` = 「못 셌다」 — 「0」이 아니다(이유는 `countsUnavailableReason`). */
export interface GateArtifactCounts {
  introduced: number | null;
  preexisting: number | null;
  unknown: number | null;
  preconditionUnmet: number | null;
  /** 바뀐 소스를 import 하는데 이번에 안 돈 시험 수(`unrun importer tests: N`). 색인 조회 실패면 null. */
  unrunImporters: number | null;
}

export const NULL_GATE_ARTIFACT_COUNTS: GateArtifactCounts = Object.freeze({
  introduced: null, preexisting: null, unknown: null, preconditionUnmet: null, unrunImporters: null,
});

export interface GateArtifactSummary extends GateArtifactCounts {
  head40: string | null;
  base40: string | null;
  envKey: string;
  shards: number;
  cohort: string[];
  shardsDetail: GateArtifactShard[];
  /** 기존 게이트 판정 문자열 그대로(조각 경로 = aggregate.status · 그 밖 = passed/failed/skipped · 원격 = null). */
  verdict: string | null;
  /** 판정 줄(`tests: …` / `[gate-baseline] …` / `shards: unmeasured (…)`) 그대로. */
  verdictLine?: string;
  timeoutRechecks?: readonly { name: string; file: string; originalDiagnostic?: string; result: 'pass' | 'timeout' | 'failure' | 'unknown'; elapsedMs: number; rawResultLine: string }[];
  exitCode: number;
  /** 정수 칸 중 하나라도 null 일 때만 — 왜 못 셌나(한 줄). */
  countsUnavailableReason?: string;
  unmeasuredReason?: string;
  /** Per-shard cause even when no process attempt was recorded. */
  unmeasuredByShard?: Record<string, string>;
  /** 분할 없는 경로의 지금 쪽 `bun test` 종료 코드(그 경로엔 JUnit 이 없어 shardsDetail 이 비다). */
  unshardedRc?: number | null;
  artifactsUnavailable?: GateArtifactsUnavailable;
  /** 원격에서 잰 산출을 이 호스트로 가져왔다 — 그 호스트(경로는 로컬로 고쳐 썼고 head40·envKey 는 원격 값 그대로). */
  remoteHost?: string;
}

/** envKey 근거: 저장소에 «환경 키» 선례가 없다(rg envKey → LLM 자격 키뿐). ⇒ 결정 = 호스트|bun 리비전|플랫폼-아키텍처. */
export function defaultGateEnvKey(): string {
  const bun = (globalThis as { Bun?: { revision?: string } }).Bun?.revision ?? process.versions.bun ?? 'unknown';
  return `${hostname()}|bun ${bun}|${process.platform}-${process.arch}`;
}

export type RevResolver = (ref: string) => string | null;

export function defaultRevResolver(cwd: string): RevResolver {
  return (ref) => {
    const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd, encoding: 'utf8', maxBuffer: SPAWN_SYNC_MAX_BUFFER });
    const sha = (result.stdout ?? '').trim();
    return result.status === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  };
}

export function resolveArtifactDir(dir: string, cwd: string): string {
  return isAbsolute(dir) ? dir : resolve(cwd, dir);
}

const sorted = (values: readonly string[]): string[] => [...new Set(values)].sort();
const safeName = (value: string): string => value.replace(/[^A-Za-z0-9._-]+/g, '_');

export interface GateArtifactInput {
  dir: string;
  head40: string | null;
  base40: string | null;
  envKey: string;
  testFiles: readonly string[];
  verdict: string | null;
  verdictLine?: string;
  timeoutRechecks?: readonly { name: string; file: string; originalDiagnostic: string; result: 'pass' | 'timeout' | 'failure' | 'unknown'; elapsedMs: number; rawResultLine: string }[];
  exitCode: number;
  /** 판정 정수(못 센 칸은 null ⊕ countsUnavailableReason). 안 주면 다섯 다 null · 이유 'not recorded' — 칸은 «늘» 쓴다. */
  counts?: GateArtifactCounts;
  countsUnavailableReason?: string;
  unmeasuredReason?: string;
  sharded?: ShardRunResult;
  /** 분할 없는 경로의 지금 쪽 종료 코드(그 경로엔 JUnit 이 없다). */
  unshardedRc?: number | null;
  artifactsUnavailable?: GateArtifactsUnavailable;
}

/** 지난 실행이 «실제로 썼다고 summary 에 적은» JUnit ⊕ run 결과 파일만 걷는다 — 같은 디렉토리를 다시 쓸 때 옛 XML 이
 *  이번 결과로 읽히지 않게. 이름 꼴로 고르지 않는다(남의 파일을 지울 수 있다). summary 를 못 읽으면 아무것도 안 지운다. */
function clearPreviousRun(dir: string, summaryPath: string): void {
  let previous: { shardsDetail?: { current?: { junitPath?: unknown }; baseline?: { junitPath?: unknown } }[] };
  try { previous = JSON.parse(readFileSync(summaryPath, 'utf8')); } catch { return; }
  // `--artifact-dir out/` 처럼 끝 슬래시가 붙어도 같은 디렉토리로 본다(기록된 경로는 join 으로 정규화돼 있다).
  const root = resolve(dir);
  const inDir = (path: string) => resolve(dirname(path)) === root;
  for (const shard of Array.isArray(previous.shardsDetail) ? previous.shardsDetail : []) {
    for (const run of [shard?.current, shard?.baseline] as { runId?: unknown; junitPath?: unknown; resultPath?: unknown }[]) {
      if (typeof run?.junitPath === 'string' && inDir(run.junitPath)) rmSync(run.junitPath, { force: true });
      // 결과 파일은 «그 run 이 쓴 이름»(`<runId>.result.json`)일 때만 — resultPath 가 남의 파일을 가리켜도 안 지운다.
      if (typeof run?.runId === 'string' && typeof run.resultPath === 'string' && inDir(run.resultPath)
        && basename(run.resultPath) === `${run.runId}${GATE_ARTIFACT_RESULT_SUFFIX}`) rmSync(run.resultPath, { force: true });
    }
  }
}

/** run 결과 파일 본문 — R2 run 입력과 같은 키(`resultPath` 는 자기 자신 · R2 가 run 과 대조한다). */
function runResultBody(run: GateArtifactRun): string {
  const { runId, head40, envKey, cohort, rc, signal, junitPath, diagnostic, resultPath } = run;
  return `${JSON.stringify({
    runId, head40, envKey, cohort, rc, signal,
    ...(junitPath !== undefined ? { junitPath } : {}),
    ...(diagnostic !== undefined ? { diagnostic } : {}),
    resultPath,
  }, null, 2)}\n`;
}

/** summary.json ⊕ 조각별 JUnit ⊕ run 별 결과 파일을 쓴다. 던지면 호출부가 «경고 한 줄»로만 접는다(판정 불변). */
export function writeGateArtifacts(input: GateArtifactInput): { summaryPath: string; junitFiles: string[] } {
  mkdirSync(input.dir, { recursive: true });
  const summaryPath = join(input.dir, GATE_ARTIFACT_SUMMARY);
  clearPreviousRun(input.dir, summaryPath);
  const junitFiles: string[] = [];
  const shardsDetail: GateArtifactShard[] = [];
  for (const attempt of input.sharded?.attempts ?? []) {
    const files = sorted(input.sharded?.shards.find((shard) => shard.id === attempt.shardId)?.files ?? []);
    const side = (kind: 'current' | 'baseline'): GateArtifactRun => {
      const junit = kind === 'current' ? attempt.currentJUnit : attempt.baselineJUnit;
      const rc = (kind === 'current' ? attempt.currentExitCode : attempt.baselineExitCode) ?? null;
      const signal = (kind === 'current' ? attempt.currentSignal : attempt.baselineSignal) ?? null;
      const diagnostic = kind === 'current' ? attempt.currentDiagnostic : attempt.baselineDiagnostic;
      const runId = `${safeName(attempt.shardId)}-${attempt.attempt}-${kind}`;
      const run: GateArtifactRun = {
        runId,
        head40: kind === 'current' ? input.head40 : input.base40,
        envKey: input.envKey,
        cohort: kind === 'current' ? files : attempt.baselineFiles ? sorted(attempt.baselineFiles) : null,
        rc, signal, resultPath: join(input.dir, `${runId}${GATE_ARTIFACT_RESULT_SUFFIX}`),
      };
      if (junit !== undefined) {
        const path = join(input.dir, `${safeName(attempt.shardId)}-${attempt.attempt}-${kind}.xml`);
        writeFileSync(path, junit);
        junitFiles.push(path);
        run.junitPath = path;
      } else {
        run.diagnostic = diagnostic ?? 'no JUnit produced';
      }
      writeFileSync(run.resultPath, runResultBody(run));
      return run;
    };
    shardsDetail.push({
      shardId: attempt.shardId, attempt: attempt.attempt, files, current: side('current'), baseline: side('baseline'),
      ...(input.sharded?.unmeasuredByShard?.[attempt.shardId] !== undefined
        && attempt === input.sharded.attempts.filter((item) => item.shardId === attempt.shardId).at(-1)
        ? { unmeasuredReason: input.sharded.unmeasuredByShard[attempt.shardId] } : {}),
    });
  }
  const counts = input.counts ?? NULL_GATE_ARTIFACT_COUNTS;
  const summary: GateArtifactSummary = {
    head40: input.head40,
    base40: input.base40,
    envKey: input.envKey,
    shards: input.sharded ? input.sharded.shards.length : 0,
    cohort: sorted(input.testFiles),
    shardsDetail,
    verdict: input.verdict,
    ...(input.verdictLine !== undefined ? { verdictLine: input.verdictLine } : {}),
    ...(input.timeoutRechecks ? { timeoutRechecks: input.timeoutRechecks } : {}),
    exitCode: input.exitCode,
    introduced: counts.introduced,
    preexisting: counts.preexisting,
    unknown: counts.unknown,
    preconditionUnmet: counts.preconditionUnmet,
    unrunImporters: counts.unrunImporters,
    ...(Object.values(counts).some((value) => value === null)
      ? { countsUnavailableReason: input.countsUnavailableReason ?? 'not recorded' } : {}),
    ...(input.unmeasuredReason !== undefined ? { unmeasuredReason: input.unmeasuredReason } : {}),
    ...(input.sharded?.unmeasuredByShard !== undefined ? { unmeasuredByShard: input.sharded.unmeasuredByShard } : {}),
    ...(input.unshardedRc !== undefined ? { unshardedRc: input.unshardedRc } : {}),
    ...(input.artifactsUnavailable !== undefined ? { artifactsUnavailable: input.artifactsUnavailable } : {}),
  };
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return { summaryPath, junitFiles };
}

/** 원격으로 분배됐는데 그 호스트의 산출을 못 가져왔을 때 — 빈손을 «정직하게» 적는다(조용한 누락 금지). */
export function writeRemoteUnavailableGateArtifacts(
  dir: string,
  cwd: string,
  baseRef: string | undefined,
  exitCode: number,
  reason: 'remote-unsupported' | 'remote-fetch-failed',
  resolveRev: RevResolver = defaultRevResolver(cwd),
  envKey: () => string = defaultGateEnvKey,
): { summaryPath: string; junitFiles: string[] } {
  return writeGateArtifacts({
    dir: resolveArtifactDir(dir, cwd),
    head40: resolveRev('HEAD'),
    base40: baseRef ? resolveRev(baseRef) : null,
    envKey: envKey(),
    testFiles: [],
    verdict: null,
    exitCode,
    counts: NULL_GATE_ARTIFACT_COUNTS,
    countsUnavailableReason: reason,
    artifactsUnavailable: reason,
  });
}

// ── 원격 산출 회수 (SIDE-VERIFY-GATE-SHARDS ②) ──────────────────────────────
// 원격 run 은 `$W` 임시 트리에서 돌고 끝나면 trap 이 `$W` 를 지운다(gate-remote.ts remoteScript). 그래서 원격 쪽
// `--artifact-dir` 는 `$W` «밖»의 호스트 디스크 경로(/var/tmp/elanous-gate-artifacts-<nonce>)로 준다 — run 이 끝나도 남고, 회수
// ssh 가 읽은 뒤 지운다. 회수 프로토콜은 tar 없이 «이름 줄 · base64 한 줄» 쌍 ⊕ 끝 표지(잘림 판별).

export const REMOTE_ARTIFACT_PREFIX = '/var/tmp/elanous-gate-artifacts-';
const FETCH_END = '__GATE_ARTIFACTS_END__';
/** 다 보냈지만 원격 dir 을 못 지웠다 — 회수는 성공, 잔여는 경고로 드러낸다(조용히 남기지 않는다). */
const FETCH_END_KEPT = '__GATE_ARTIFACTS_END_KEPT__';
const FETCH_MISSING = '__GATE_ARTIFACTS_MISSING__';
const FETCH_READ_FAILED = '__GATE_ARTIFACTS_READ_FAILED__';
// Legacy `/tmp` receipts remain readable for in-flight runs; new paths use host disk `/var/tmp`.
const remoteDirPattern = /^\/(?:var\/)?tmp\/elanous-gate-artifacts-[0-9a-f]{8,64}$/;
const artifactNamePattern = /^[A-Za-z0-9._-]+$/;
export const REMOTE_ARTIFACT_FETCH_TIMEOUT_MS = 5 * 60_000;

export function newRemoteArtifactDir(nonce: string = randomBytes(8).toString('hex')): string {
  const dir = `${REMOTE_ARTIFACT_PREFIX}${nonce}`;
  if (!remoteDirPattern.test(dir)) throw new Error(`invalid remote artifact dir: ${dir}`);
  return dir;
}

/** 원격에서 잴 커밋이 `--artifact-dir` 를 아나 — 그 커밋에 산출 모듈이 있나로 본다(#28030 이 CLI 옵션과 함께 넣었다).
 *  모르는 커밋에 옵션을 실으면 원격 CLI 가 «알 수 없는 옵션»으로 죽어 판정 자체가 바뀐다 — 그래서 싣기 «전»에 묻는다. */
export function remoteCommitSupportsArtifactDir(repo: string, commit = 'HEAD',
  catFile: (repo: string, spec: string) => boolean = (cwd, spec) => spawnSync('git', ['cat-file', '-e', spec], { cwd, stdio: 'ignore' }).status === 0): boolean {
  return catFile(repo, `${commit}:src/self-implement/gate-artifacts.ts`);
}

/** 회수 스크립트: 디렉토리의 정규 파일을 «이름 줄 · base64 한 줄»로 내보내고 끝 표지를 찍은 뒤 지운다. */
export function remoteArtifactFetchScript(remoteDir: string): string {
  if (!remoteDirPattern.test(remoteDir)) throw new Error(`invalid remote artifact dir: ${remoteDir}`);
  return [
    `D='${remoteDir}'`,
    `[ -d "$D" ] || { echo '${FETCH_MISSING}' >&2; exit 3; }`,
    'cd "$D" || exit 3',
    // base64 를 파이프 «앞»에 두면 그 실패가 tr 의 rc 에 묻힌다 — 치환으로 받아 자기 rc 를 보고, 줄 접기(tr)의 rc 도 본다(깨진 JUnit 을 성공으로 안 보낸다).
    `fail() { cd / && rm -rf "$D"; echo '${FETCH_READ_FAILED}' "$1" >&2; exit 4; }`,
    'for f in *; do [ -f "$f" ] || continue; b=$(base64 < "$f") || fail "$f"; printf \'%s\\n\' "$f"; printf \'%s\' "$b" | tr -d \'\\n\\r\' || fail "$f"; printf \'\\n\'; done',
    'cd / || exit 3',
    `if rm -rf "$D" && [ ! -e "$D" ]; then printf '%s\\n' '${FETCH_END}'; else printf '%s\\n' '${FETCH_END_KEPT}'; fi`,
    'exit 0',
    '',
  ].join('\n');
}

export function remoteArtifactCleanupScript(remoteDir: string): string {
  if (!remoteDirPattern.test(remoteDir)) throw new Error(`invalid remote artifact dir: ${remoteDir}`);
  return `rm -rf '${remoteDir}'\nexit 0\n`;
}

/** 회수 출력 → 파일 목록. 끝 표지가 없거나 꼴이 어긋나면 null(잘린 출력을 «일부 성공»으로 읽지 않는다). */
export function parseRemoteArtifactFetch(stdout: string): { files: Map<string, Buffer>; remoteDirKept: boolean } | null {
  const lines = stdout.split('\n');
  const end = lines.findIndex((line, i) => i % 2 === 0 && (line === FETCH_END || line === FETCH_END_KEPT));
  if (end < 0 || lines.slice(end + 1).some((line) => line !== '')) return null;
  const files = new Map<string, Buffer>();
  for (let i = 0; i < end; i += 2) {
    const name = lines[i]!;
    const body = lines[i + 1]!;
    if (!artifactNamePattern.test(name) || name === '.' || name === '..' || !/^[A-Za-z0-9+/=]*$/.test(body)) return null;
    files.set(name, Buffer.from(body, 'base64'));
  }
  return { files, remoteDirKept: lines[end] === FETCH_END_KEPT };
}

/** 가져온 원격 산출을 로컬 `dir` 에 같은 꼴로 쓴다 — junitPath·resultPath 만 로컬 경로로 고치고, 나머지(head40·envKey·
 *  rc·cohort·verdict)는 원격 값 그대로. summary 가 적은 JUnit ⊕ run 결과 파일(runId 가 있는 run)이 하나라도 안 왔으면
 *  «아무것도 안 쓰고» 던진다(원격 summary 의 사실을 로컬에서 고쳐 쓰지 않는다 — 회수 실패다).
 *  runId 가 없는 run(결과 파일 이전 커밋에서 잰 원격) 은 옛 꼴 그대로 resultPath = 로컬 summary.json 이다. */
export function importRemoteGateArtifacts(dir: string, files: Map<string, Buffer>, host: string): { summaryPath: string; junitFiles: string[] } {
  const raw = files.get(GATE_ARTIFACT_SUMMARY);
  if (!raw) throw new Error('remote summary.json missing');
  const summary = JSON.parse(raw.toString('utf8')) as GateArtifactSummary;
  if (!summary || typeof summary !== 'object' || !Array.isArray(summary.shardsDetail)) throw new Error('remote summary.json malformed');
  const referenced = summary.shardsDetail.flatMap((shard) => [shard?.current?.junitPath, shard?.baseline?.junitPath])
    .filter((path): path is string => typeof path === 'string').map((path) => basename(path));
  const missing = referenced.filter((name) => name === GATE_ARTIFACT_SUMMARY || !files.has(name));
  if (missing.length) throw new Error(`remote JUnit not fetched: ${missing.join(', ')}`);
  const runs = summary.shardsDetail.flatMap((shard) => [shard?.current, shard?.baseline])
    .filter((run): run is GateArtifactRun => !!run && typeof run === 'object');
  const resultName = (run: GateArtifactRun) => `${run.runId}${GATE_ARTIFACT_RESULT_SUFFIX}`;
  const withRunId = runs.filter((run) => typeof run.runId === 'string');
  // summary 가 가리킨 파일(resultPath 의 이름)이 바로 `<runId>.result.json` 이어야 한다 — 같은 이름의 «다른» 파일로 대신하지 않는다.
  const badRunId = withRunId.filter((run) => !artifactNamePattern.test(resultName(run))
    || typeof run.resultPath !== 'string' || basename(run.resultPath) !== resultName(run));
  if (badRunId.length) throw new Error(`remote runId/resultPath mismatch: ${badRunId.map((run) => run.runId).join(', ')}`);
  const missingResults = withRunId.map(resultName).filter((name) => !files.has(name));
  if (missingResults.length) throw new Error(`remote run result not fetched: ${missingResults.join(', ')}`);
  const remoteResults = new Map<string, Record<string, unknown>>();
  for (const run of withRunId) {
    let parsed: unknown;
    try { parsed = JSON.parse(files.get(resultName(run))!.toString('utf8')); } catch { parsed = null; }
    // 결과 파일은 summary run 과 «같은 내용»이어야 한다 — 키 집합이 같고, 경로 둘은 이름만, 나머지는 값 그대로 대조한다
    // (여분·빠진 키나 다른 값이면 쓰기 «전»에 회수 실패).
    const result = parsed as Record<string, unknown> | null;
    const expected = run as unknown as Record<string, unknown>;
    const keys = (value: Record<string, unknown>) => JSON.stringify(Object.keys(value).sort());
    const sameName = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && basename(a) === basename(b);
    if (!result || typeof result !== 'object' || Array.isArray(result) || keys(result) !== keys(expected)
      || Object.keys(expected).some((key) => (key === 'junitPath' || key === 'resultPath')
        ? !sameName(result[key], expected[key]) : JSON.stringify(result[key]) !== JSON.stringify(expected[key])))
      throw new Error(`remote run result disagrees with summary: ${resultName(run)}`);
    remoteResults.set(run.runId!, result);
  }
  mkdirSync(dir, { recursive: true });
  const summaryPath = join(dir, GATE_ARTIFACT_SUMMARY);
  clearPreviousRun(dir, summaryPath);
  const junitFiles: string[] = [];
  const relocate = (run: GateArtifactRun | undefined) => {
    if (!run || typeof run !== 'object') return;
    run.resultPath = typeof run.runId === 'string' ? join(dir, resultName(run)) : summaryPath;
    if (typeof run.junitPath === 'string') {
      const name = basename(run.junitPath);
      const bytes = files.get(name)!;
      const path = join(dir, name);
      writeFileSync(path, bytes);
      junitFiles.push(path);
      run.junitPath = path;
    }
    if (typeof run.runId !== 'string') return;
    // 결과 파일도 경로 둘(junitPath·resultPath)만 로컬로 고치고 나머지는 원격 값 그대로 둔다.
    const result = remoteResults.get(run.runId)!;
    if (typeof run.junitPath === 'string') result.junitPath = run.junitPath; else delete result.junitPath;
    result.resultPath = run.resultPath;
    writeFileSync(run.resultPath, `${JSON.stringify(result, null, 2)}\n`);
  };
  for (const shard of summary.shardsDetail) { relocate(shard?.current); relocate(shard?.baseline); }
  // Optional observations stay optional for older remote commits. Neither changes the gate verdict.
  for (const [name, bytes] of files) if ((name === 'progress.json' || name.endsWith('.failure.json'))
    && artifactNamePattern.test(name)) writeFileSync(join(dir, name), bytes);
  summary.remoteHost = host;
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return { summaryPath, junitFiles };
}

export type RemoteSsh = (host: string, script: string, timeoutMs: number) => SshResult;

/** 원격 산출 디렉토리를 가져와 로컬에 쓴다. 실패는 던지지 않고 이유를 돌려준다(호출부가 remote-fetch-failed 로 적는다). */
export function fetchRemoteGateArtifacts(input: { host: string; remoteDir: string; localDir: string; ssh: RemoteSsh; timeoutMs?: number }):
  { ok: true; summaryPath: string; junitFiles: string[]; remoteDirKept: boolean } | { ok: false; reason: string } {
  let run: SshResult;
  try { run = input.ssh(input.host, remoteArtifactFetchScript(input.remoteDir), input.timeoutMs ?? REMOTE_ARTIFACT_FETCH_TIMEOUT_MS); }
  catch (error) { return { ok: false, reason: `ssh threw: ${error instanceof Error ? error.message : String(error)}` }; }
  const stderr = Buffer.from(run.stderr).toString('utf8').trim();
  if (run.rc !== 0 || run.error) {
    const why = stderr.includes(FETCH_MISSING) ? 'remote artifact dir missing'
      : stderr.includes(FETCH_READ_FAILED) ? `remote artifact read failed: ${stderr.split(FETCH_READ_FAILED).at(-1)!.trim()}` : `ssh rc=${run.rc}${run.error ? ` ${run.error}` : ''}${stderr ? `: ${stderr.split('\n').slice(-1)[0]}` : ''}`;
    return { ok: false, reason: why };
  }
  const parsed = parseRemoteArtifactFetch(Buffer.from(run.stdout).toString('utf8'));
  if (!parsed) return { ok: false, reason: 'fetch output cut or malformed' };
  try { return { ok: true, ...importRemoteGateArtifacts(input.localDir, parsed.files, input.host), remoteDirKept: parsed.remoteDirKept }; }
  catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
}
