import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { hasCliStderrSink, writeCliStderr } from './cli-stderr.js';
import { runGitWithRetry, type GitRunner } from './retry.js';

const LF = 0x0a;
const HELP_ARGUMENTS = new Set(['--help', '-h']);
const HELP_GUIDANCE = "[elanous git] Wraps git and automatically retries transient lock failures. A final result line such as '[git] status ok rc=0' is written to stderr. Git's own help follows.\n";

const GLOBAL_OPTIONS_WITH_OPERANDS = new Set([
  '-C',
  '-c',
  '--config-env',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
]);

// ⛔⭐⭐ 「실패했다」와 「아무것도 안 바뀌었다」는 «다른 값»이다.
//   충돌로 멈춘 merge 는 rc=1 이지만 ***작업 트리엔 머지가 절반 들어가 있다***. 상태 줄이
//   `FAILED rc=1` 뿐이면 읽는 쪽이 「아무 일도 없었다」로 읽고 되돌려서 «작업을 잃는다».
//   ⛔ 그래도 「성공했다」고 «쓰지 않는다» — 쓰는 것은 「트리가 바뀌었다」는 사실뿐이다.
//
// ⛔⭐⭐⭐ 판정 근거는 «출력»이 아니라 «파일시스템 상태»다. 이유 둘:
//   ⓐ 출력은 «남의 글»을 나르는 통로다 — `git diff` 가 그 문구를 담은 diff 를 내면 오탐이 된다.
//   ⓑ git 은 이 진단을 «로케일에 따라 번역»한다 — 영어가 아니면 표지가 «조용히» 사라진다.
//   ⇒ git 이 «남기는 파일»은 번역되지 않고 남의 글이 흉내낼 수 없다.
interface WorktreeStateProbe {
  /** 상태 이름 — 「무엇이 중단됐나」. ⛔ 「충돌」이라 «단정하지 않는다»(아래 참조). */
  readonly kind: string;
  /** git 이 「중단된 작업」을 표시하려고 git-dir 에 남기는 경로들(하나라도 있으면 참). */
  readonly markers: readonly string[];
}

const MERGE_PROBE: WorktreeStateProbe = { kind: 'merge', markers: ['MERGE_HEAD'] };
const REBASE_PROBE: WorktreeStateProbe = { kind: 'rebase', markers: ['rebase-merge', 'rebase-apply', 'REBASE_HEAD'] };
const CHERRY_PICK_PROBE: WorktreeStateProbe = { kind: 'cherry-pick', markers: ['CHERRY_PICK_HEAD'] };

// ⛔ `pull` 은 `pull.rebase=true`·`--rebase` 면 ***rebase 상태***를 남긴다 —
//   MERGE_HEAD 만 보면 그 경우 표지가 «조용히» 사라진다. ⇒ pull 은 둘 다 본다.
// ⛔ 여기 «없는» 하위 명령(revert·am 등)은 실제 경로를 안 재봤기 때문이다 —
//   재보지 않은 것을 계약에 넣으면 그 자체가 「없는 것을 있다고 적는」 형태다.
const SUBCOMMAND_PROBES: Readonly<Record<string, readonly WorktreeStateProbe[]>> = {
  merge: [MERGE_PROBE],
  pull: [MERGE_PROBE, REBASE_PROBE],
  rebase: [REBASE_PROBE],
  'cherry-pick': [CHERRY_PICK_PROBE],
};

/** 원래 argv 에서 하위 명령 «앞»의 전역 옵션만 떼어 낸다 — `-C <dir>` 같은 것이 git-dir 을 바꾼다. */
function globalOptionPrefix(args: string[]): string[] {
  const prefix: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (GLOBAL_OPTIONS_WITH_OPERANDS.has(arg)) {
      prefix.push(arg, args[++index] ?? '');
      continue;
    }
    if (arg.startsWith('-')) { prefix.push(arg); continue; }
    return prefix;
  }
  return prefix;
}

/** 실패한 «그 명령»과 같은 전역 옵션으로 물어야 한다. `-C <dir>` 을 빼면 다른 저장소를 본다. */
function runGitQuery(args: string[], query: string[], env: NodeJS.ProcessEnv): string | undefined {
  const resolved = spawnSync('git', [...globalOptionPrefix(args), ...query], { encoding: 'utf8', env, timeout: 10_000 });
  return resolved.status === 0 ? resolved.stdout : undefined;
}

/** 각 probe 의 마커가 «지금» 있는지. git-dir 을 못 읽으면 `undefined` — false 로 «단정하지 않는다». */
function probeSnapshot(args: string[], probes: readonly WorktreeStateProbe[], env: NodeJS.ProcessEnv): ReadonlyMap<string, boolean> | undefined {
  const gitDir = runGitQuery(args, ['rev-parse', '--absolute-git-dir'], env)?.trim();
  if (!gitDir) return undefined;
  return new Map(probes.map((probe) => [probe.kind, probe.markers.some((marker) => existsSync(join(gitDir, marker)))]));
}

/** ⛔⭐ ***마커가 생겼다 ≠ 충돌이다.*** `git rebase --exec false` 는 충돌 없이도 rebase 상태를 남긴다.
 *  그때 `…-conflict` 라 쓰면 ***안 일어난 일을 적는 것***이다 ⇒ 인덱스의 «해결 안 된 경로»를 따로 묻는다.
 *  ⛔ 그 물음을 «경로 목록»으로 받으면 안 된다 — 충돌 경로가 많으면 기본 `maxBuffer`(1MiB)를 넘겨
 *    실패하고, 그러면 ***진짜 충돌이 `in-progress` 로 거짓 표기***된다.
 *  ✅ `--quiet` 은 산출을 «아예 안 낸다» — 답이 종료 코드로 온다(0=없음 · 1=있음).
 *  ⛔ 그 밖의 종료 코드(≥2)는 「없다」가 아니라 «모른다» — 충돌이라 단정하지 않는다. */
function hasUnmergedPaths(args: string[], env: NodeJS.ProcessEnv): boolean {
  const probe = spawnSync('git', [...globalOptionPrefix(args), 'diff', '--quiet', '--diff-filter=U'], {
    encoding: 'utf8', env, timeout: 10_000,
  });
  return probe.status === 1;
}

/** ⛔⭐ 「지금 마커가 있다」로는 부족하다 — ***이미 중단된 머지가 있는 상태***에서 새 `git merge` 를 치면
 *  그 명령은 「머지를 안 끝냈다」로 실패하는데, 마커는 «원래» 있던 것이다. 그때 표지를 붙이면
 *  ***이번 명령이 뭔가 했다고 거짓말***한다. ⇒ 실행 «전» 스냅샷과 비교해 ***이번에 생긴 것***만 본다.
 *  ⚠️ 정직한 한계: 마커가 «전에도 후에도» 있는 경우(진행 중이던 rebase 가 또 충돌)는 못 가르므로
 *    표지를 «안 붙인다». 거짓 양성보다 거짓 음성을 고른다. */
function newlyLeftState(before: ReadonlyMap<string, boolean> | undefined, after: ReadonlyMap<string, boolean> | undefined): string | undefined {
  if (!before || !after) return undefined;
  for (const [kind, present] of after) {
    if (present && before.get(kind) === false) return kind;
  }
  return undefined;
}

function gitSubcommand(args: string[]): string {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (GLOBAL_OPTIONS_WITH_OPERANDS.has(arg)) {
      index++;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return arg;
  }
  return '(none)';
}

function asBuffer(chunk: Buffer | string | null | undefined): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk);
  return Buffer.alloc(0);
}

/** Execute git through the git-fs retry gateway and append a pipe-visible outcome.
 *  ⚠️ 무손실 실행(리뷰 must-fix MF-234e0b53): `maxBuffer: Infinity` 로 기본 1MB 한도의 truncation 을
 *  없애고, `encoding` 을 지정하지 않아 stdout/stderr 를 **Buffer 원본 그대로** 받는다. utf8 로 디코딩하면
 *  유효하지 않은 바이트가 U+FFFD 로 변형되므로(관측: `[239,191,189,…]`), 디코딩·재조합 없이 원 바이트를
 *  그대로 통과시킨다. 재시도 관문(`runGitWithRetry`)은 동기 계약이라 청크 스트리밍과 양립하지 않는다 —
 *  스트리밍하면 재시도 시 이미 내보낸 바이트가 중복된다. ⇒ 동기 버퍼링 + 무손실 통과가 올바른 화해다. */
export function runGitCli(args: string[]): void {
  const startedAt = performance.now();
  const subcommand = gitSubcommand(args);
  // ⛔ 실행 «전» 스냅샷 — 이 명령이 마커를 남길 수 있는 종류일 때만 잰다(무관한 명령엔 비용 0).
  const probesForRun = SUBCOMMAND_PROBES[subcommand];
  const probesBefore = probesForRun ? probeSnapshot(args, probesForRun, process.env) : undefined;
  const stderrChunks: Buffer[] = [];
  if (HELP_ARGUMENTS.has(args[0] ?? '')) {
    if (hasCliStderrSink()) stderrChunks.push(Buffer.from(HELP_GUIDANCE));
    else process.stderr.write(HELP_GUIDANCE);
  }
  let attempts = 0;
  let rawStdout: Buffer = Buffer.alloc(0);
  let rawStderr: Buffer = Buffer.alloc(0);
  const runner: GitRunner = (gitArgs) => {
    attempts++;

    const command = spawnSync('git', gitArgs, { maxBuffer: Infinity });
    rawStdout = asBuffer(command.stdout);
    rawStderr = asBuffer(command.stderr);
    // 문자열은 재시도 관문의 transient 판정(락 문구 매칭)에만 쓰고, 출력에는 절대 쓰지 않는다.
    return {
      status: command.status,
      stdout: rawStdout.toString('utf8'),
      stderr: rawStderr.toString('utf8'),
    };
  };
  const result = runGitWithRetry(args, runner);

  if (rawStdout.length) process.stdout.write(rawStdout);
  if (rawStderr.length) stderrChunks.push(rawStderr);

  // ⛔⭐⭐⭐⭐⭐ **상태 줄은 `stderr` 로 나간다** — 2026-08-09 정정(라이브에서 «둘이» 밟았다).
  //   초판은 stdout 에 썼다. 그러면 ***산출을 값으로 쓰는 모든 소비자가 깨진다***:
  //     `$(elanous git rev-parse HEAD)` → SHA ⊕ 상태 줄 «두 줄» (실측)
  //     `elanous gh … --json | jq`      → `jq: parse error` (실측 · `[S]` 가 밟았다)
  //   ⭐ 그리고 stderr 가 «파이프 생존»을 더 잘 준다 — 파이프는 stdout «만» 나르므로
  //     `… | jq` 를 해도 상태 줄은 ***사람 화면에 그대로 남는다***. 목적이 더 잘 달성된다.
  //   ⛔ 대신 `2>/dev/null` 이면 안 보인다 — 그건 「stderr 를 버리겠다」는 «명시적 선택»이고
  //     `git`·`gh` 자신의 오류도 똑같이 사라지므로 일관된다.
  //   ⇒ 📌 stdout 은 이제 ***원 바이트 그대로만*** 나간다(separator 도 안 붙인다).
  const endsWithoutLf = (buf: Buffer): boolean => buf.length > 0 && buf[buf.length - 1] !== LF;
  if (endsWithoutLf(rawStderr)) stderrChunks.push(Buffer.from('\n'));

  const exitCode = result.status ?? 1;
  const leftKind = exitCode !== 0 && probesForRun
    ? newlyLeftState(probesBefore, probeSnapshot(args, probesForRun, process.env))
    : undefined;
  // ⛔ 「무엇이 중단됐나」(kind)와 「충돌인가」(unmerged)는 «다른 물음»이다 — 둘을 합쳐 적지 않는다.
  const leftReason = leftKind
    ? `${leftKind}-${hasUnmergedPaths(args, process.env) ? 'conflict' : 'in-progress'}`
    : undefined;
  stderrChunks.push(Buffer.from(
    `[git] ${subcommand} ${exitCode === 0 ? 'ok' : 'FAILED'} rc=${exitCode}`
    + (leftReason ? ` worktree-changed=yes reason=${leftReason}` : '')
    + '\n',
  ));
  writeCliStderr({ source: 'git', exitCode, raw: Buffer.concat(stderrChunks) });
  process.exitCode = exitCode;
  debug.log('git.cli', 'completed', {
    subcommand,
    exitCode,
    ok: exitCode === 0,
    ...(leftReason ? { worktreeChanged: true, worktreeChangedReason: leftReason } : {}),
    durationMs: Math.round(performance.now() - startedAt),
    lockRetryCount: Math.max(0, attempts - 1),
    measurementScope: 'wrapper-numerator-only; raw shell git and PATH/hook denominator are out of scope',
  });
}
