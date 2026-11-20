/**
 * LAND-BASELINE-BY-FILESET (0.3.31) — A199 기준선 영수증(착지 «기존 실패 이름 diff»)의 재사용 판정.
 *
 * S: A199 는 기준선(base) 실패 이름을 «방금 fetch 한 origin/main 과 정확히 같은 sha» 에서 잰 영수증만 받는다.
 * C: 다른 PR 이 착지해 main 이 한 칸만 움직여도 모든 대기 PR 이 기준선을 다시 잰다 — 밤사이 착지 2~7/h 의 한 원인.
 * Q: main 이 움직였어도 그 움직임이 이 PR 의 파일과 무관하면 기존 영수증을 그대로 쓸 수 있는가?
 * A: 영수증을 만들 때 PR 이 바꾼 파일 집합과 그 파일들의 base(main) blob 을 함께 적는다(baseFileBlobs).
 *    착지 때 현재 main 에서 같은 파일들의 blob 이 모두 같으면 재사용, 하나라도 다르면 재측정.
 *    blob 지도가 없는 옛 영수증은 옛 규칙(정확한 main sha 일치)만 적용한다. 새 옵션 없음.
 *
 * 실패 방향: git 을 못 읽거나, 파일이 지도에 없거나, 영수증 base 가 현재 main 의 조상이 아니면 재측정.
 */
import { gateGitSync } from './gate-git.js';
import { readFileSync } from 'node:fs';

const SHA40 = /^[0-9a-f]{40}$/i;

/** blob 읽기 결과: 40자 blob sha · null = 그 커밋에 파일 없음 · undefined = 읽기 실패. */
export interface LandBaselineGit {
  /** merge-base(base, head)..head 에서 head 가 바꾼 파일. 읽기 실패면 null. */
  changedFiles(base: string, head: string): string[] | null;
  blob(commit: string, file: string): string | null | undefined;
  /** 읽기 실패면 null. */
  isAncestor(ancestor: string, descendant: string): boolean | null;
}

export type LandBaselineFileBlobs = Record<string, string | null>;

export interface LandBaselineReceiptIdentity {
  base: string;
  baseFileBlobs?: unknown;
}

export type LandBaselineReuse =
  | { reuse: true; rule: 'exact-sha' | 'fileset-blob'; files: string[] }
  | { reuse: false; rule: 'exact-sha' | 'fileset-blob'; reason: string; files: string[] };

/** 영수증을 만들 때 부른다: head 가 바꾼 파일과 그 파일들의 base blob. 하나라도 못 읽으면 null(지도 없음 = 옛 규칙). */
export function recordLandBaselineFileBlobs(git: LandBaselineGit, base: string, head: string): LandBaselineFileBlobs | null {
  if (!SHA40.test(base) || !SHA40.test(head)) return null;
  const files = git.changedFiles(base, head);
  if (!files || !files.length) return null;
  const blobs: LandBaselineFileBlobs = {};
  for (const file of [...new Set(files)].sort()) {
    const blob = git.blob(base, file);
    if (blob === undefined || (blob !== null && !SHA40.test(blob))) return null;
    blobs[file] = blob === null ? null : blob.toLowerCase();
  }
  return blobs;
}

function validBlobMap(value: unknown): value is LandBaselineFileBlobs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length > 0 && entries.every(([file, blob]) => file.length > 0 && (blob === null || (typeof blob === 'string' && SHA40.test(blob))));
}

/** 착지 때 부른다: 현재 main 에서 이 영수증의 기준선을 그대로 쓸 수 있는가. */
export function judgeLandBaselineReuse(input: { receipt: LandBaselineReceiptIdentity; main: string; head: string; git: LandBaselineGit }): LandBaselineReuse {
  const { receipt, main, head, git } = input;
  if (!SHA40.test(receipt.base) || !SHA40.test(main) || !SHA40.test(head))
    return { reuse: false, rule: 'exact-sha', reason: 'receipt base, main or head is not a 40-hex sha', files: [] };
  if (receipt.base.toLowerCase() === main.toLowerCase()) return { reuse: true, rule: 'exact-sha', files: [] };
  if (receipt.baseFileBlobs === undefined || receipt.baseFileBlobs === null)
    return { reuse: false, rule: 'exact-sha', reason: 'receipt base is not the freshly fetched origin/main', files: [] };
  if (!validBlobMap(receipt.baseFileBlobs))
    return { reuse: false, rule: 'fileset-blob', reason: 'baseFileBlobs is malformed', files: [] };
  const recorded = receipt.baseFileBlobs;
  const ancestor = git.isAncestor(receipt.base, main);
  if (ancestor !== true)
    return { reuse: false, rule: 'fileset-blob', reason: ancestor === null ? 'ancestry of receipt base unreadable' : 'receipt base is not an ancestor of main', files: [] };
  const changed = git.changedFiles(main, head);
  if (!changed || !changed.length) return { reuse: false, rule: 'fileset-blob', reason: 'changed-file set unreadable or empty', files: [] };
  const files = [...new Set(changed)].sort();
  const unrecorded = files.filter((file) => !Object.prototype.hasOwnProperty.call(recorded, file));
  if (unrecorded.length) return { reuse: false, rule: 'fileset-blob', reason: 'changed files missing from baseFileBlobs', files: unrecorded };
  const unreadable: string[] = [];
  const moved: string[] = [];
  for (const file of files) {
    const blob = git.blob(main, file);
    if (blob === undefined) unreadable.push(file);
    else if ((blob === null ? null : blob.toLowerCase()) !== recorded[file]) moved.push(file);
  }
  if (unreadable.length) return { reuse: false, rule: 'fileset-blob', reason: 'main blob unreadable', files: unreadable };
  if (moved.length) return { reuse: false, rule: 'fileset-blob', reason: 'main changed files of this PR since the receipt', files: moved };
  return { reuse: true, rule: 'fileset-blob', files };
}

/** 실제 git 저장소 읽기(네트워크 없음 — gateGitSync 는 lazy fetch 를 끈다). */
export function landBaselineGit(repo: string): LandBaselineGit {
  const run = (args: string[]) => {
    // git-spawn-allow: read-only merge-base/diff/ls-tree of landing commits.
    const result = gateGitSync(args, repo, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return result.error ? { status: -1, stdout: '' } : { status: result.status ?? -1, stdout: result.stdout };
  };
  return {
    changedFiles(base, head) {
      const mergeBase = run(['merge-base', base, head]);
      const fork = mergeBase.stdout.trim();
      if (mergeBase.status !== 0 || !SHA40.test(fork)) return null;
      const diff = run(['diff', '-z', '--name-only', '--no-renames', `${fork}..${head}`]);
      return diff.status === 0 ? diff.stdout.split('\0').filter(Boolean) : null;
    },
    blob(commit, file) {
      // -z: 따옴표 없는 경로 그대로 — 특수 문자 경로를 «없음»으로 잘못 읽지 않는다.
      const tree = run(['ls-tree', '-z', commit, '--', file]);
      if (tree.status !== 0) return undefined;
      const rows = tree.stdout.split('\0').filter(Boolean);
      if (!rows.length) return null;
      const line = rows.find((row) => row.endsWith(`\t${file}`));
      if (!line) return undefined;
      const match = /^\d+ blob ([0-9a-f]{40})\t/.exec(line);
      return match ? match[1]! : undefined;
    },
    isAncestor(ancestor, descendant) {
      const result = run(['merge-base', '--is-ancestor', ancestor, descendant]);
      return result.status === 0 ? true : result.status === 1 ? false : null;
    },
  };
}

/**
 * 운영 착지 도구(land-name-diff-check.py)가 부르는 입구. 위치 인자만 — 새 옵션 없음.
 *   record <base40> <head40>             → baseFileBlobs JSON 한 줄(못 읽으면 rc=1)
 *   check  <receipt.json> <main40> <head40> → «REUSE rule=…» rc=0 · «REMEASURE …» rc=1
 * 저장소 = 현재 작업 디렉터리.
 */
export function runLandBaselineFilesetCli(argv: string[], git: LandBaselineGit, read: (path: string) => string = (path) => readFileSync(path, 'utf8')): { code: number; out: string } {
  const [verb, ...rest] = argv;
  if (verb === 'record' && rest.length === 2) {
    const blobs = recordLandBaselineFileBlobs(git, rest[0]!, rest[1]!);
    return blobs ? { code: 0, out: JSON.stringify(blobs) } : { code: 1, out: 'NO-BLOBS changed files or base blobs unreadable' };
  }
  if (verb === 'check' && rest.length === 3) {
    let receipt: unknown;
    try { receipt = JSON.parse(read(rest[0]!)); }
    catch (error) { return { code: 1, out: `REMEASURE receipt unreadable: ${String(error)}` }; }
    const base = (receipt as { base?: unknown } | null)?.base;
    if (!receipt || typeof receipt !== 'object' || typeof base !== 'string')
      return { code: 1, out: 'REMEASURE receipt has no base sha' };
    const verdict = judgeLandBaselineReuse({ receipt: { base, baseFileBlobs: (receipt as { baseFileBlobs?: unknown }).baseFileBlobs }, main: rest[1]!, head: rest[2]!, git });
    return verdict.reuse
      ? { code: 0, out: `REUSE rule=${verdict.rule} base=${base.slice(0, 12)} files=${verdict.files.length}` }
      : { code: 1, out: `REMEASURE rule=${verdict.rule} ${verdict.reason}${verdict.files.length ? `: ${verdict.files.join(',')}` : ''}` };
  }
  return { code: 2, out: 'usage: land-baseline-fileset.ts record <base40> <head40> | check <receipt.json> <main40> <head40>' };
}

if (import.meta.main) {
  const result = runLandBaselineFilesetCli(process.argv.slice(2), landBaselineGit(process.cwd()));
  (result.code === 0 ? process.stdout : process.stderr).write(`${result.out}\n`);
  process.exit(result.code);
}
