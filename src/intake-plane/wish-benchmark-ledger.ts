import { debug } from '../debug/log.js';
import { constants, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { dlopen, FFIType } from 'bun:ffi';
import { elanousStateRoot } from '../autopilot/state-paths.js';

/** Bench samples live in the instance's private state, never in a repository or card response. */
export function wishBenchmarkLedgerPath(root: string = elanousStateRoot()): string {
  // OP D 길 원장(채널 10-04 22:48)과 같은 파일·같은 줄 꼴 — OP 가 손으로 더하는 줄과 섞여 한 표본이 된다.
  return join(root, 'bench', 'goal-bench-requirements.jsonl');
}

function privateDirectory(path: string, privateMode: boolean): void {
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const state = lstatSync(path);
  if (state.isSymbolicLink() || !state.isDirectory()) throw new Error(`Unsafe wish benchmark directory: ${path}`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (privateMode) fchmodSync(fd, 0o700);
    const opened = fstatSync(fd);
    if (opened.dev !== state.dev || opened.ino !== state.ino) {
      throw new Error(`Wish benchmark directory changed while opening: ${path}`);
    }
  } finally { closeSync(fd); }
}

function realExistingPrefix(path: string): string {
  let head = path; const tail: string[] = [];
  for (;;) {
    try { return join(realpathSync(head), ...tail.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(head); if (parent === head) return path;
      tail.push(basename(head)); head = parent;
    }
  }
}

function preparePrivateDirectory(root: string): string {
  // 맥에서 `/var` 는 `/private/var` 링크다 — 이미 있는 상위 경로는 실제 경로로 풀고, 새로 만들 아래 칸만 링크를 막는다.
  const absolute = realExistingPrefix(resolve(root));
  let current = parse(absolute).root;
  const parts = absolute.slice(current.length).split(/[\\/]/).filter(Boolean);
  for (const part of parts) {
    current = join(current, part);
    // A sample cannot be written inside a source checkout, even if the state root was overridden.
    try {
      lstatSync(join(current, '.git'));
      throw new Error(`Wish benchmark state root is inside a repository: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    privateDirectory(current, false);
  }
  for (const part of ['bench']) {
    current = join(current, part);
    privateDirectory(current, true);
  }
  return current;
}

// Advisory locks belong to the open descriptor, not the pathname: SIGKILL closes it automatically.
// Keep the lock file itself in place so no competing writer can lock a different inode.
const libc = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  flock: { args: [FFIType.int, FFIType.int], returns: FFIType.int },
});

function withLedgerLock(dir: string, action: () => void): void {
  const lock = join(dir, '.wish-cards.lock');
  const fd = openSync(lock, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1) throw new Error('Unsafe wish benchmark lock');
    fchmodSync(fd, 0o600);
    // LOCK_EX blocks rather than stealing a live writer's lock. Kernel releases it on crash.
    if (libc.symbols.flock(fd, 2) !== 0) throw new Error('Wish benchmark ledger lock failed');
    const current = lstatSync(lock);
    if (opened.dev !== current.dev || opened.ino !== current.ino) throw new Error('Wish benchmark lock changed while waiting');
    action();
  } finally {
    closeSync(fd);
  }
}

export function recordWishBenchmarkSample(
  sample: { cardId: string; at: string; surface: string; text: string },
): void {
  const stateRoot = elanousStateRoot();
  const dir = preparePrivateDirectory(stateRoot);
  const expected = lstatSync(dir);
  const path = wishBenchmarkLedgerPath(stateRoot);
  withLedgerLock(dir, () => {
    const current = lstatSync(dir);
    if (!current.isDirectory() || current.dev !== expected.dev || current.ino !== expected.ino) {
      throw new Error('Wish benchmark directory changed while waiting for lock');
    }
    // Re-check under the lock: another process may have recorded this card while we waited.
    const fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const state = fstatSync(fd);
      if (!state.isFile() || state.nlink !== 1) throw new Error('Wish benchmark ledger is not a private regular file');
      fchmodSync(fd, 0o600);
      if (readFileSync(fd, 'utf8').split('\n').some(line => {
        if (!line) return false;
        const row = JSON.parse(line) as { id?: string; cardId?: string };
        return (row.id ?? row.cardId) === sample.cardId;
      })) return;
      // 줄 꼴 = OP 원장과 같다: id · at · surface · text(원문 그대로) · chars · op_cells(참조 칸 — OP 가 채운다) · note.
      const line = JSON.stringify({ id: sample.cardId, at: sample.at, surface: sample.surface, text: sample.text,
        chars: Array.from(sample.text).length, op_cells: [], note: 'wish-card' }) + '\n';
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }
  });
}

/** 카드 생성 경로용: 벤치 원장 쓰기가 실패해도(저장소 안 상태 루트 · 권한 · 링크) 소원 카드는 만들어져야 한다.
 *  실패는 관측 한 줄로만 남긴다(원문은 싣지 않는다). */
export function recordWishBenchmarkSampleSafely(sample: Parameters<typeof recordWishBenchmarkSample>[0]): boolean {
  try {
    recordWishBenchmarkSample(sample);
    return true;
  } catch (error) {
    debug.log('intake.wish-bench', 'skipped', { cardId: sample.cardId, surface: sample.surface, reason: String((error as Error)?.message ?? error).split(':')[0] });
    return false;
  }
}
