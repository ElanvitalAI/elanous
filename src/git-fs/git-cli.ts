import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';
import { hasCliStderrSink, writeCliStderr } from './cli-stderr.js';
import { runGitWithRetry, type GitRunner } from './retry.js';

const LF = 0x0a;
const HELP_ARGUMENTS = new Set(['--help', '-h']);
const HELP_GUIDANCE = "[elanous git] Wraps git and automatically retries transient lock failures. Bare/default-remote pushes to an open PR owned by another seat are refused; other push forms pass through with an observation. --force-owner overrides a covered push only after a successful audit row. A final result line such as '[git] status ok rc=0' is written to stderr. Git's own help follows.\n";

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

type PushVerification = {
  readonly primaryOutcome: 'CONFIRMED_APPLIED' | 'UNCONFIRMED';
  readonly verification: 'ls-remote' | 'not-attempted';
  readonly reason?: 'unsupported-push-shape' | 'source-ref-unreadable' | 'source-ref-changed' | 'remote-query-failed' | 'ref-mismatch';
  readonly ref?: string;
  readonly expectedSha?: string;
  readonly observedSha?: string;
};

type PushTarget = { remote: string; sourceRef: string; targetRef: string; pushUrl: string; expectedSha: string; sourceReflog: string; sourceRefFile: string };

/** Accept only a single explicit full branch refspec without command-side effects. */
function explicitBranchPush(args: string[]): { remote: string; sourceRef: string; targetRef: string } | undefined {
  let commandIndex = -1;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (GLOBAL_OPTIONS_WITH_OPERANDS.has(arg)) { index++; continue; }
    if (arg.startsWith('-')) continue;
    commandIndex = index;
    break;
  }
  if (commandIndex < 0 || args[commandIndex] !== 'push') return undefined;
  const operands: string[] = [];
  const flagsWithValue = new Set(['-o', '--push-option', '--receive-pack', '--exec']);
  const noValueFlags = new Set(['--force', '-f', '--porcelain', '--verbose', '-v', '--quiet', '-q', '--progress', '--atomic', '--signed']);
  for (let index = commandIndex + 1; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--force-with-lease' || arg.startsWith('--force-with-lease=')) continue;
    if (flagsWithValue.has(arg)) { index++; if (index >= args.length) return undefined; continue; }
    if ([...flagsWithValue].some((flag) => arg.startsWith(`${flag}=`))) continue;
    if (noValueFlags.has(arg)) continue;
    if (arg.startsWith('-')) return undefined;
    operands.push(arg);
  }
  if (operands.length !== 2 || operands.some((operand) => !operand || operand.startsWith('-'))) return undefined;
  const [remote, rawRefspec] = operands as [string, string];
  const refspec = rawRefspec.startsWith('+') ? rawRefspec.slice(1) : rawRefspec;
  const separator = refspec.indexOf(':');
  if (separator === 0 || separator !== refspec.lastIndexOf(':')) return undefined;
  const sourceRef = separator < 0 ? refspec : refspec.slice(0, separator);
  const rawTargetRef = separator < 0 ? refspec : refspec.slice(separator + 1);
  const targetRef = rawTargetRef;
  if (!sourceRef.startsWith('refs/heads/') || !targetRef.startsWith('refs/heads/') || targetRef === 'refs/heads/' || !sourceRef || !targetRef
    || /[*?\[\]]/.test(sourceRef + targetRef) || sourceRef.startsWith('-')) return undefined;
  return { remote, sourceRef, targetRef };
}

/** A direct URL query is only equivalent when no second insteadOf rewrite would change it. */
function pushUrlIsStable(url: string, prefix: string[]): boolean {
  const configured = spawnSync('git', [...prefix, 'config', '--null', '--get-regexp', '^url\\..*\\.insteadof$'], {
    encoding: 'utf8', env: process.env, timeout: 10_000,
  });
  if (configured.status !== 0 && configured.status !== 1) return false;
  let longest = '';
  let replacement = '';
  let conflictingRewrite = false;
  for (const line of configured.stdout.split('\0').filter(Boolean)) {
    const separator = line.indexOf('\n');
    if (separator < 0) return false;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    const match = /^url\.(.*)\.insteadof$/i.exec(key);
    if (match && url.startsWith(value)) {
      const candidate = `${match[1]}${url.slice(value.length)}`;
      if (value.length > longest.length) {
        longest = value;
        replacement = candidate;
        conflictingRewrite = false;
      } else if (value.length === longest.length && candidate !== replacement) {
        conflictingRewrite = true;
      }
    }
  }
  return !conflictingRewrite && (!longest || replacement === url);
}

function readSourceReflog(sourceRef: string, prefix: string[]): string | undefined {
  const reflog = spawnSync('git', [...prefix, 'reflog', 'show', '--format=%H%x09%gs', sourceRef], {
    encoding: 'utf8', env: process.env, timeout: 10_000, maxBuffer: Infinity,
  });
  return reflog.status === 0 && reflog.stdout.length > 0 ? reflog.stdout : undefined;
}

/** Only confirm a loose, ordinary branch ref whose file identity and contents remain unchanged. */
function readSourceRefFile(sourceRef: string, expectedSha: string, prefix: string[]): string | undefined {
  const pathResult = spawnSync('git', [...prefix, 'rev-parse', '--git-path', sourceRef], {
    encoding: 'utf8', env: process.env, timeout: 10_000,
  });
  if (pathResult.status !== 0 || !pathResult.stdout.trim()) return undefined;
  const refPath = resolve(process.cwd(), pathResult.stdout.trim());
  try {
    const stat = lstatSync(refPath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    const contents = readFileSync(refPath);
    if (contents.toString('utf8').trim() !== expectedSha) return undefined;
    return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs, contents.toString('hex')].join(':');
  } catch {
    return undefined;
  }
}

/** Capture the requested branch commit and the single effective push URL before running the push. */
function preparePushVerification(args: string[]): PushTarget | undefined {
  const push = explicitBranchPush(args);
  if (!push) return undefined;
  const prefix = globalOptionPrefix(args);
  const source = spawnSync('git', [...prefix, 'rev-parse', '--verify', `${push.sourceRef}^{commit}`], {
    encoding: 'utf8', env: process.env, timeout: 10_000,
  });
  const expectedSha = source.status === 0 ? source.stdout.trim() : '';
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(expectedSha)) return undefined;
  const symbolic = spawnSync('git', [...prefix, 'symbolic-ref', '--quiet', push.sourceRef], {
    encoding: 'utf8', env: process.env, timeout: 10_000,
  });
  if (symbolic.status !== 1) return undefined;
  const sourceReflog = readSourceReflog(push.sourceRef, prefix);
  if (!sourceReflog) return undefined;
  const sourceRefFile = readSourceRefFile(push.sourceRef, expectedSha, prefix);
  if (!sourceRefFile) return undefined;
  const urls = spawnSync('git', [...prefix, 'remote', 'get-url', '--push', '--all', push.remote], {
    encoding: 'utf8', env: process.env, timeout: 10_000,
  });
  const pushUrls = urls.status === 0 ? urls.stdout.trim().split(/\r?\n/).filter(Boolean) : [];
  if (pushUrls.length !== 1) return undefined;
  if (!pushUrlIsStable(pushUrls[0]!, prefix)) return undefined;
  return { ...push, pushUrl: pushUrls[0]!, expectedSha, sourceReflog, sourceRefFile };
}

function sourceRefUnchanged(push: PushTarget, prefix: string[]): boolean {
  const symbolic = spawnSync('git', [...prefix, 'symbolic-ref', '--quiet', push.sourceRef], {
    encoding: 'utf8', env: process.env, timeout: 10_000,
  });
  if (symbolic.status !== 1) return false;
  const source = spawnSync('git', [...prefix, 'rev-parse', '--verify', `${push.sourceRef}^{commit}`], {
    encoding: 'utf8', env: process.env, timeout: 10_000,
  });
  return source.status === 0 && source.stdout.trim() === push.expectedSha
    && readSourceReflog(push.sourceRef, prefix) === push.sourceReflog
    && readSourceRefFile(push.sourceRef, push.expectedSha, prefix) === push.sourceRefFile;
}

/** Compare the unchanged source ref and exact push URL after a failed push. */
function verifyPushAfterFailure(push: PushTarget | undefined, args: string[]): PushVerification {
  if (!push) return { primaryOutcome: 'UNCONFIRMED', verification: 'not-attempted', reason: 'unsupported-push-shape' };
  const prefix = globalOptionPrefix(args);
  if (!sourceRefUnchanged(push, prefix)) {
    return { primaryOutcome: 'UNCONFIRMED', verification: 'not-attempted', reason: 'source-ref-changed', ref: push.targetRef, expectedSha: push.expectedSha };
  }
  const remote = spawnSync('git', [...prefix, 'ls-remote', '--quiet', push.pushUrl, push.targetRef], {
    encoding: 'utf8', env: process.env, timeout: 10_000,
  });
  if (remote.status !== 0) return { primaryOutcome: 'UNCONFIRMED', verification: 'ls-remote', reason: 'remote-query-failed', ref: push.targetRef, expectedSha: push.expectedSha };
  const lines = remote.stdout.trim().split(/\r?\n/).filter(Boolean);
  const rows = lines.map((line) => {
    const match = /^([0-9a-f]{40}|[0-9a-f]{64})\t(\S+)$/.exec(line);
    return match ? { sha: match[1]!, ref: match[2]! } : undefined;
  });
  if (rows.some((row) => row === undefined)) {
    return { primaryOutcome: 'UNCONFIRMED', verification: 'ls-remote', reason: 'ref-mismatch', ref: push.targetRef, expectedSha: push.expectedSha };
  }
  const targetRows = rows.filter((row): row is { sha: string; ref: string } => row !== undefined && row.ref === push.targetRef);
  const observedSha = targetRows.length === 1 ? targetRows[0]!.sha : undefined;
  if (!sourceRefUnchanged(push, prefix)) {
    return { primaryOutcome: 'UNCONFIRMED', verification: 'ls-remote', reason: 'source-ref-changed', ref: push.targetRef, expectedSha: push.expectedSha, ...(observedSha ? { observedSha } : {}) };
  }
  return observedSha === push.expectedSha
    ? { primaryOutcome: 'CONFIRMED_APPLIED', verification: 'ls-remote', ref: push.targetRef, expectedSha: push.expectedSha, observedSha }
    : { primaryOutcome: 'UNCONFIRMED', verification: 'ls-remote', reason: 'ref-mismatch', ref: push.targetRef, expectedSha: push.expectedSha, ...(observedSha ? { observedSha } : {}) };
}

function pushPartialOutcomeLine(result: PushVerification, exitCode: number): string {
  if (result.primaryOutcome === 'CONFIRMED_APPLIED') {
    return `[git] push PARTIAL_OUTCOME primary-outcome=CONFIRMED_APPLIED verification=ls-remote ref=${result.ref} sha=${result.expectedSha} rc=${exitCode}`;
  }
  return `[git] push PARTIAL_OUTCOME primary-outcome=UNCONFIRMED verification=${result.verification}${result.reason ? ` reason=${result.reason}` : ''}${result.ref ? ` ref=${result.ref}` : ''} rc=${exitCode}`;
}

function asBuffer(chunk: Buffer | string | null | undefined): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk);
  return Buffer.alloc(0);
}

type PushOwnershipPr = { number: number; headRefName?: string; body?: string; labels?: { name?: string }[]; headRepositoryOwner?: { login?: string }; headRepositoryFullName?: string };
type PushOwnershipDecision = { args: string[]; notice?: string; blocked?: boolean };

function gitCommandCwd(args: string[]): string {
  let cwd = process.cwd();
  const prefix = globalOptionPrefix(args);
  for (let index = 0; index < prefix.length; index++) {
    if (prefix[index] === '-C') {
      const value = prefix[++index];
      if (value) cwd = resolve(cwd, value);
    }
  }
  return cwd;
}

function callerSeat(cwd = process.cwd()): string | undefined {
  const fromEnv = [process.env.ELANOUS_TRACK, process.env.ELANOUS_HARNESS_SEAT]
    .map((value) => value?.trim())
    .find((value): value is string => Boolean(value && /^[A-Z][A-Z0-9-]{1,11}$/.test(value)));
  if (fromEnv) return fromEnv;
  const parts = cwd.split(/[\\/]+/);
  const seatIndex = parts.lastIndexOf('seats');
  const fromPath = seatIndex >= 0 ? parts[seatIndex + 1] : undefined;
  return fromPath && /^[A-Z][A-Z0-9-]{1,11}$/.test(fromPath) ? fromPath : undefined;
}

const PUSH_OPTIONS_WITH_OPERANDS = new Set(['-o', '--push-option', '--receive-pack', '--repo', '--exec']);
const PUSH_OPTIONS_WITH_INLINE_OPERANDS = ['--push-option=', '--receive-pack=', '--repo=', '--exec='];

type ParsedPushArgs = { args: string[]; forceOwner: boolean; unsupportedOption?: string };

/** Remove our override flag only when it is unambiguously an option, never when Git consumes it as a value. */
function parsePushArgs(args: string[]): ParsedPushArgs {
  const pushIndex = globalOptionPrefix(args).length;
  if (args[pushIndex] !== 'push') return { args, forceOwner: false, unsupportedOption: 'push command not found' };
  const removed = new Set<number>();
  let forceOwner = false;
  for (let index = pushIndex + 1; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--') break;
    if (PUSH_OPTIONS_WITH_OPERANDS.has(arg) || /^-[qv]*o$/.test(arg)) {
      if (index + 1 >= args.length) return { args, forceOwner: false, unsupportedOption: `${arg} requires an operand` };
      index++;
      continue;
    }
    if (PUSH_OPTIONS_WITH_INLINE_OPERANDS.some((option) => arg.startsWith(option))) continue;
    if (arg === '--force-owner') {
      removed.add(index);
      forceOwner = true;
      continue;
    }
    if (arg.startsWith('-')) return { args, forceOwner: false, unsupportedOption: arg };
  }
  return { args: args.filter((_, index) => !removed.has(index)), forceOwner };
}

function pushArgs(args: string[]): string[] {
  return args.slice(globalOptionPrefix(args).length + 1);
}

type ResolvedPushTarget = { remoteUrl: string; source: string; branch: string };
type ResolvedPush = { targets: ResolvedPushTarget[] };

function resolvePushTargets(args: string[], remote: string): ResolvedPush | undefined {
  const prefix = globalOptionPrefix(args);
  const dryRun = spawnSync('git', [...prefix, 'push', '--dry-run', '--porcelain', '--no-verify', remote], {
    // Keep cwd at the caller's original directory so every relative -C is applied exactly once by Git.
    cwd: process.cwd(), encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
  });
  if (dryRun.error) return undefined;

  const targets: ResolvedPushTarget[] = [];
  const lines = [...dryRun.stdout.split(/\r?\n/), ...dryRun.stderr.split(/\r?\n/)];
  const reportedUrls = [...new Set(lines.flatMap((line) => {
    const header = /^To\s+(.+)$/.exec(line);
    return header ? [header[1]!.trim()] : [];
  }))];
  if (reportedUrls.length !== 1) return undefined;
  const remoteUrl = reportedUrls[0]!;
  for (const line of lines) {
    const match = /^[ *+=!\-]\s+(\S+):(\S+)(?:\s|$)/.exec(line);
    const source = match?.[1];
    const destination = match?.[2];
    if (remoteUrl && source && destination?.startsWith('refs/heads/')) targets.push({ remoteUrl, source, branch: destination.slice('refs/heads/'.length) });
  }
  const unique = [...new Map(targets.map((target) => [`${target.remoteUrl}\0${target.source}\0${target.branch}`, target])).values()];
  return unique.length > 0 ? { targets: unique } : undefined;
}

function githubRepository(remoteUrl: string): string | undefined {
  const match = /(?:github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?$/.exec(remoteUrl.replace(/[?#].*$/, ''));
  return match?.[1];
}

function prSeat(pr: PushOwnershipPr): string | undefined {
  const label = pr.labels?.map((item) => item.name ?? '').find((name) => /^seat:[A-Z][A-Z0-9-]{1,11}$/.test(name));
  return label?.slice('seat:'.length);
}

type OwnedPushPr = { repository: string; pr: PushOwnershipPr };

function appendPushOwnerLedger(row: Record<string, unknown>): string | undefined {
  const path = join(elanousStateRoot(), 'git', 'push-owner-guard.jsonl');
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`, { encoding: 'utf8', mode: 0o600 });
    return undefined;
  } catch (error) {
    return `push owner guard audit failed (${error instanceof Error ? error.message : String(error)})`;
  }
}

function guardPushOwnership(args: string[]): PushOwnershipDecision {
  const parsedArgs = parsePushArgs(args);
  const forceOwner = parsedArgs.forceOwner;
  const gitArgs = parsedArgs.args;
  const cwd = gitCommandCwd(args);
  const seat = callerSeat(cwd);
  const passUncertain = (reason: string): PushOwnershipDecision => {
    const auditFailure = appendPushOwnerLedger({ seat: seat ?? null, verdict: 'pass-uncertain', reason,
      ...(forceOwner ? { forceOwnerRequested: true } : {}) });
    if (forceOwner && auditFailure) return { args: gitArgs, blocked: true, notice: auditFailure };
    return { args: gitArgs, notice: `push owner guard: ${reason}; proceeding without an ownership verdict${auditFailure ? ` · ${auditFailure}` : ''}` };
  };
  const supplied = pushArgs(gitArgs);
  if (parsedArgs.unsupportedOption) return passUncertain(`unsupported push option ${parsedArgs.unsupportedOption}; arguments are passed through unchanged`);
  const explicitRemote = supplied.length === 1 && !supplied[0]!.startsWith('-') ? supplied[0] : undefined;
  if (!(supplied.length === 0 || explicitRemote !== undefined)) {
    return passUncertain('only a bare push or one default-remote push is covered; explicit options and refspecs are passed through');
  }

  const prefix = globalOptionPrefix(args);
  const branchResult = spawnSync('git', [...prefix, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 });
  if (branchResult.status !== 0 || branchResult.error) return passUncertain('current branch is not available');
  const currentBranch = branchResult.stdout.trim();
  const config = (key: string) => spawnSync('git', [...prefix, 'config', '--get', key], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 });
  const defaultRemote = [
    `branch.${currentBranch}.pushRemote`, 'remote.pushDefault', `branch.${currentBranch}.remote`,
  ].map(config).find((result) => result.status === 0 && result.stdout.trim())?.stdout.trim() ?? 'origin';
  if (explicitRemote && explicitRemote !== defaultRemote) return passUncertain(`remote ${explicitRemote} is not the configured default remote ${defaultRemote}`);
  const urls = spawnSync('git', [...prefix, 'remote', 'get-url', '--push', '--all', defaultRemote], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 });
  if (urls.status !== 0 || urls.error) return passUncertain(`default remote ${defaultRemote} could not be resolved`);
  const pushUrls = urls.stdout.split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
  if (pushUrls.length !== 1) return passUncertain(`default remote ${defaultRemote} has ${pushUrls.length} push destinations`);
  const resolved = resolvePushTargets(args, defaultRemote);
  if (!resolved || resolved.targets.length !== 1) return passUncertain('Git did not report exactly one push destination');
  const target = resolved.targets[0]!;
  if (target.branch !== currentBranch) return passUncertain(`push destination branch ${target.branch} differs from current branch ${currentBranch}`);
  const sourceBranch = target.source === 'HEAD' ? currentBranch
    : target.source.startsWith('refs/heads/') ? target.source.slice('refs/heads/'.length) : undefined;
  if (sourceBranch !== currentBranch) return passUncertain(`push source ${target.source} is not the current branch ${currentBranch}`);
  const repository = githubRepository(target.remoteUrl);
  if (!repository || githubRepository(pushUrls[0]!)?.toLowerCase() !== repository.toLowerCase()) {
    return passUncertain('the single push destination is not a matching GitHub remote');
  }

  const found: OwnedPushPr[] = [];
  const repositoryResult = spawnSync('gh', ['api', `repos/${repository}`], { cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
  if (repositoryResult.status !== 0 || repositoryResult.error) return passUncertain(`GitHub repository metadata unavailable for ${repository}`);
  let parentRepository: string | undefined;
  try {
    const metadata = JSON.parse(repositoryResult.stdout) as { parent?: { full_name?: unknown } };
    const parent = metadata.parent?.full_name;
    if (typeof parent === 'string' && parent && parent !== repository) parentRepository = parent;
  } catch { return passUncertain(`GitHub repository metadata unreadable for ${repository}`); }
  const headOwner = repository.split('/')[0]!;
  for (const baseRepository of [...new Set([...(parentRepository ? [parentRepository] : []), repository])]) {
    const response = spawnSync('gh', ['api', '--method', 'GET', `repos/${baseRepository}/pulls`, '-f', 'state=open', '-f', `head=${headOwner}:${target.branch}`, '-f', 'per_page=100'], {
      cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
    });
    if (response.status !== 0 || response.error) return passUncertain(`open PR lookup failed for ${baseRepository} ${target.branch}`);
    try {
      const parsed: unknown = JSON.parse(response.stdout);
      if (!Array.isArray(parsed)) throw new Error('expected PR list');
      for (const item of parsed) {
        if (item === null || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>;
        const head = row.head && typeof row.head === 'object' ? row.head as Record<string, unknown> : undefined;
        const headRepo = head?.repo && typeof head.repo === 'object' ? head.repo as Record<string, unknown> : undefined;
        const owner = headRepo?.owner && typeof headRepo.owner === 'object' ? headRepo.owner as Record<string, unknown> : undefined;
        const labels = Array.isArray(row.labels) ? row.labels.filter((label): label is { name?: string } => label !== null && typeof label === 'object') : [];
        if (typeof row.number !== 'number' || head?.ref !== target.branch
          || typeof owner?.login !== 'string' || owner.login.toLowerCase() !== headOwner.toLowerCase()) continue;
        if (typeof headRepo?.full_name !== 'string' || !headRepo.full_name) return passUncertain(`open PR head repository unavailable for ${baseRepository} ${target.branch}`);
        if (headRepo.full_name.toLowerCase() !== repository.toLowerCase()) continue;
        found.push({ repository: baseRepository, pr: {
          number: row.number, headRefName: target.branch, headRepositoryOwner: { login: headOwner },
          headRepositoryFullName: headRepo.full_name,
          body: typeof row.body === 'string' ? row.body : '', labels,
        } });
      }
    } catch { return passUncertain(`open PR lookup unreadable for ${baseRepository} ${target.branch}`); }
  }
  const uniquePrs = [...new Map(found.map((row) => [`${row.repository}#${row.pr.number}`, row])).values()];
  if (forceOwner) {
    const auditFailure = appendPushOwnerLedger({
      seat: seat ?? null, verdict: 'force-owner', PR: uniquePrs.map(({ repository: prRepository, pr }) => ({ repository: prRepository, number: pr.number })),
      target: { repository, branch: target.branch }, reason: '--force-owner',
    });
    return auditFailure ? { args: gitArgs, blocked: true, notice: auditFailure } : { args: gitArgs };
  }
  const foreign = uniquePrs.find(({ pr }) => {
    const ownerSeat = prSeat(pr);
    return seat !== undefined && ownerSeat !== undefined && ownerSeat !== seat;
  });
  if (foreign) return { args: gitArgs, blocked: true, notice: `push refused: branch ${foreign.pr.headRefName ?? '(unknown)'} belongs to PR #${foreign.pr.number} in ${foreign.repository} seat:${prSeat(foreign.pr)} (current seat:${seat}); use --force-owner to override` };
  if (uniquePrs.some(({ pr }) => !seat || !prSeat(pr))) return passUncertain('open PR or caller seat ownership is unknown');
  return { args: gitArgs };
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
  const pushTarget = subcommand === 'push' ? preparePushVerification(args) : undefined;
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
      signal: command.signal,
      ...(command.error ? { errorCode: (command.error as NodeJS.ErrnoException).code } : {}),
      stdout: rawStdout.toString('utf8'),
      stderr: rawStderr.toString('utf8'),
    };
  };
  const ownership = subcommand === 'push' ? guardPushOwnership(args) : { args };
  const result = ownership.blocked
    ? { status: 1, stdout: '', stderr: ownership.notice ?? 'push refused by owner guard' }
    : runGitWithRetry(ownership.args, runner);
  if (ownership.blocked && ownership.notice) rawStderr = Buffer.from(`${ownership.notice}\n`);
  else if (ownership.notice) stderrChunks.push(Buffer.from(`${ownership.notice}\n`));

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

  const initialExitCode = result.status ?? 1;
  const pushVerification = subcommand === 'push' && initialExitCode !== 0
    ? verifyPushAfterFailure(pushTarget, args)
    : undefined;
  const exitCode = pushVerification?.primaryOutcome === 'CONFIRMED_APPLIED' ? 0 : initialExitCode;
  const leftKind = exitCode !== 0 && probesForRun
    ? newlyLeftState(probesBefore, probeSnapshot(args, probesForRun, process.env))
    : undefined;
  // ⛔ 「무엇이 중단됐나」(kind)와 「충돌인가」(unmerged)는 «다른 물음»이다 — 둘을 합쳐 적지 않는다.
  const leftReason = leftKind
    ? `${leftKind}-${hasUnmergedPaths(args, process.env) ? 'conflict' : 'in-progress'}`
    : undefined;
  stderrChunks.push(Buffer.from(pushVerification
    ? `${pushPartialOutcomeLine(pushVerification, exitCode)}\n`
    : `[git] ${subcommand} ${exitCode === 0 ? 'ok' : 'FAILED'} rc=${exitCode}`
      + (leftReason ? ` worktree-changed=yes reason=${leftReason}` : '')
      + '\n'));
  writeCliStderr({ source: 'git', exitCode, raw: Buffer.concat(stderrChunks) });
  process.exitCode = exitCode;
  if (pushVerification) {
    debug.log('git.cli', 'partial-outcome', {
      subcommand,
      exitCode,
      primaryOutcome: pushVerification.primaryOutcome,
      ...(pushVerification.ref ? { ref: pushVerification.ref } : {}),
      ...(pushVerification.expectedSha ? { expectedSha: pushVerification.expectedSha } : {}),
      ...(pushVerification.observedSha ? { observedSha: pushVerification.observedSha } : {}),
      verification: pushVerification.verification,
      ...(pushVerification.reason ? { reason: pushVerification.reason } : {}),
    });
  }
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
