// D1b(ELS-SERVER-RESTART-SURVIVE) 화면·스크롤백 스냅샷 리터럴 3종 — 재부팅 뒤 이전 화면 렌더의 원천 점검.
// ① 기록→로드→렌더 왕복(원 화면·스크롤백 그대로) ② 상한 절단(오래된 것부터 버리고 정확히 상한만)
// ③ 권한(0600). 기대값은 전부 이 파일 안의 독립 리터럴이다(제품 상수 참조 0).
// 출처: seat-state/HAND-TUI-D/evidence/d1a-holder/D1B-DESIGN-screen-scrollback.md · OP 재배정 D1b 지시.

import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
// A Unix socket path holds at most 103 bytes (macOS): the land train's long TMPDIR puts the els server/holder socket
// under <state>/els/ over it, so a state dir under a long TMPDIR falls back to /tmp (each test removes its own dir).
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
import { dirname, join } from 'node:path';
import { createElsCore, type ElsPty } from './core.js';
import {
  composeRestoredScreen, connectHolderElsPty, consumeScreenSnapshot, holderMetaPath, holdersDir, holderSnapshotPath, holderSocketPath,
  loadHolderMeta, loadScreenSnapshot, reattachHolder, restoreScreenFromSnapshot, saveHolderMeta, saveScreenSnapshot,
  spawnHolderDetached, startHolder, trimScrollbackLines, type HolderMeta,
} from './holder.js';
import { emptyJournal, type SpaceJournal } from './space.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  const pending = [...cleanups];
  cleanups.length = 0;
  for (const cleanup of pending.reverse()) await cleanup();
});

// 출처: 동기 파일 시험 — 실 PTY 대기가 없어 restart-survive 보다 짧은 상한으로 충분하다(실패 시 정지).
const LIT_TEST_MS = 5_000;

test('screen restore 1: a snapshot round-trips — record, load and render the same screen and scrollback', () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-d1b-roundtrip-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = holderSnapshotPath(root, 'lit-d1b-pane');
  const screen = '[screen 80x24 cursor=(row 23, col 0, visible true)]\nD1B_SCREEN_FINAL_LINE';
  const scrollback = 'D1B_SCROLL_OLD_LINE_1\nD1B_SCROLL_OLD_LINE_2';
  saveScreenSnapshot(path, { version: 1, paneId: 'lit-d1b-pane', ptyId: 'h:lit-d1b-pane', cols: 80, rows: 24,
    screen, scrollback, savedAt: 1_760_000_000_000 }); // 출처: savedAt — 임의 에포크 ms, 왕복 필드 비교에만 쓴다
  const loaded = loadScreenSnapshot(path);
  expect(loaded?.screen).toBe(screen);               // 독립 리터럴: 원 화면이 그대로 돌아온다
  expect(loaded?.scrollback).toBe(scrollback);       // 독립 리터럴: 원 스크롤백이 그대로 돌아온다
  expect(loaded?.paneId).toBe('lit-d1b-pane');       // 독립 리터럴: pane 식별 왕복
  expect(loaded?.ptyId).toBe('h:lit-d1b-pane');      // 독립 리터럴: pty 식별 왕복
  expect(loaded?.cols).toBe(80);                     // 출처: cols 왕복 — 임의 터미널 폭
  expect(loaded?.rows).toBe(24);                     // 출처: rows 왕복 — 임의 터미널 높이
  expect(loaded?.savedAt).toBe(1_760_000_000_000);   // 출처: savedAt 왕복 — 기록한 값 그대로(임의 에포크 ms)
  const rendered = composeRestoredScreen(loaded!.screen, loaded!.scrollback);
  expect(rendered).toBe('D1B_SCROLL_OLD_LINE_1\nD1B_SCROLL_OLD_LINE_2\n[screen 80x24 cursor=(row 23, col 0, visible true)]\nD1B_SCREEN_FINAL_LINE\n재부팅으로 종료됨 — 이전 화면 — Enter 로 다시 만들기'); // 독립 리터럴: 스크롤백→화면→상태 줄(규격 «죽은 pane 렌더 = 저장 화면 전량 + 스크롤백»)
  expect(composeRestoredScreen(screen, '')).toBe('[screen 80x24 cursor=(row 23, col 0, visible true)]\nD1B_SCREEN_FINAL_LINE\n재부팅으로 종료됨 — 이전 화면 — Enter 로 다시 만들기'); // 독립 리터럴: 빈 스크롤백이면 화면+상태 줄만
}, LIT_TEST_MS);

test('screen restore 2: scrollback past the limit drops the oldest lines first and keeps exactly the limit', () => {
  expect(trimScrollbackLines(['l1', 'l2', 'l3', 'l4', 'l5'], 3)).toEqual(['l3', 'l4', 'l5']); // 출처: 상한 3 — 5줄 중 최신 3줄만(오래된 l1·l2 부터 버림)
  expect(trimScrollbackLines(['only'], 3)).toEqual(['only']); // 출처: 상한 3 — 상한 이하는 그대로
  expect(trimScrollbackLines(['l1', 'l2'], 0)).toEqual([]);  // 출처: 상한 0 — 전부 버린다(경계)
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-d1b-trim-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = holderSnapshotPath(root, 'lit-d1b-trim');
  saveScreenSnapshot(path, { version: 1, paneId: 'lit-d1b-trim', ptyId: 'h:lit-d1b-trim', cols: 80, rows: 24,
    screen: '[screen 80x24 cursor=(row 0, col 0, visible true)]', scrollback: 'old-a\nold-b\nold-c\nnew-d\nnew-e',
    savedAt: 0 }); // 출처: savedAt 0 — 절단 점검에는 시각이 무관하다
  const trimmed = loadScreenSnapshot(path, 3); // 출처: 로더 절단 상한 3 — 제품 상수 아닌 독립 리터럴 경계
  expect(trimmed?.scrollback).toBe('old-c\nnew-d\nnew-e'); // 독립 리터럴: 오래된 old-a·old-b 를 버리고 정확히 3줄
  const deep = holderSnapshotPath(root, 'lit-d1b-deep');
  saveScreenSnapshot(deep, { version: 1, paneId: 'lit-d1b-deep', ptyId: 'h:lit-d1b-deep', cols: 80, rows: 24,
    screen: new Array(5).fill('line').join('\n'), scrollback: '', savedAt: 0 }); // 출처: 5줄 화면 — 아래 상한 4 초과 경계
  expect(loadScreenSnapshot(deep, 3, 4)).toBeUndefined(); // 출처: 화면 줄 상한 4 — 5줄짜리 screen 은 renderScreen 결과가 아니다(없는 것)
}, LIT_TEST_MS);

test('screen restore 3: the snapshot file is written 0600 under a 0700 holders directory', () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-d1b-mode-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = holderSnapshotPath(root, 'lit-d1b-mode');
  saveScreenSnapshot(path, { version: 1, paneId: 'lit-d1b-mode', ptyId: 'h:lit-d1b-mode', cols: 80, rows: 24,
    screen: 'screen', scrollback: '', savedAt: 0 }); // 출처: savedAt 0 — 권한 점검에는 시각이 무관하다
  expect(statSync(path).mode & 0o777).toBe(0o600);           // 출처: D1B-DESIGN «0600» — saveHolderMeta 양식과 같은 파일 권한
  expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);  // 출처: holdersDir 0700 — D1a 홀더 소켓 디렉터리 기준과 같다
}, LIT_TEST_MS);

test('screen restore 4: restoring reads without deleting the snapshot, and a snapshot of another pane is absent', () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-d1b-readonly-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = holderSnapshotPath(root, 'lit-d1b-read');
  saveScreenSnapshot(path, { version: 1, paneId: 'lit-d1b-read', ptyId: 'h:lit-d1b-read', cols: 80, rows: 24,
    screen: 'SCREEN_READ', scrollback: '', savedAt: 0 }); // 출처: savedAt 0 — 시각 무관
  expect(restoreScreenFromSnapshot(root, 'lit-d1b-read')).toBe('SCREEN_READ\n재부팅으로 종료됨 — 이전 화면 — Enter 로 다시 만들기'); // 독립 리터럴: 화면 + 상태 줄
  expect(existsSync(path)).toBe(true);  // 독립 리터럴: 복구는 파일을 지우지 않는다
  expect(restoreScreenFromSnapshot(root, 'lit-d1b-read')).toBeDefined(); // 독립 리터럴: 두 번째 읽기도 같은 화면
  saveScreenSnapshot(holderSnapshotPath(root, 'lit-d1b-other'), { version: 1, paneId: 'lit-d1b-intruder', ptyId: 'h:x',
    cols: 80, rows: 24, screen: 'WRONG_PANE', scrollback: '', savedAt: 0 }); // 출처: 파일 이름과 paneId 가 다른 스냅샷
  expect(restoreScreenFromSnapshot(root, 'lit-d1b-other')).toBeUndefined(); // 독립 리터럴: paneId 불일치는 부재
  consumeScreenSnapshot(root, 'lit-d1b-read');
  expect(existsSync(path)).toBe(false); // 독립 리터럴: 소비가 파일을 지운다
}, LIT_TEST_MS);

test('screen restore 5: a failed journal save keeps the snapshot; the retry restores the same screen and consumes it exactly once', () => {
  const stubPty = (): ElsPty => ({ id: 'p1', isAlive: () => true, write: () => {}, writeAll: async () => {},
    bracketedPasteEnabled: () => true, renderScreen: async () => '', onExit: () => {}, kill: () => {} });
  let stored: SpaceJournal = emptyJournal();
  const first = createElsCore({ load: () => stored, save: (next) => { stored = next; }, spawn: () => stubPty() });
  expect(first.newPane({ ws: 'ws-lit', cwd: '/tmp', command: ['sh'] }).exitCode).toBe(0); // 출처: 임의 pane 하나 — 재부팅 전 live pane
  const paneId = stored.panes[0]!.id;
  const live = stored; // 재부팅 전에 저장된 저널(pane 은 ptyId 를 가진 live)
  expect(live.panes[0]!.ptyId).toBe('p1'); // 독립 리터럴: spawn 스텁의 pty id
  const files = new Set<string>([paneId]); // 스냅샷 파일 모의 — 소비하면 지워진다
  const consumed: string[] = [];
  let failSave = true;
  let saved: SpaceJournal | undefined;
  const deps = {
    load: () => live,
    save: (next: SpaceJournal) => { if (failSave) throw new Error('disk full'); saved = next; },
    spawn: () => stubPty(),
    restoreScreen: (id: string) => (files.has(id) ? 'RESTORED_SCREEN' : undefined),
    consumeScreenSnapshot: (id: string) => { consumed.push(id); files.delete(id); },
  };
  const failed = createElsCore(deps).start();
  expect(failed?.exitCode).toBe(1);                       // 독립 리터럴: 저장 실패는 start 거절
  expect(files.has(paneId)).toBe(true);                   // 독립 리터럴: 원본 스냅샷 생존
  expect(consumed).toEqual([]);                           // 독립 리터럴: 소비 0회
  failSave = false;
  expect(createElsCore(deps).start()).toBeUndefined();    // 독립 리터럴: 재시도 성공
  expect(saved?.panes[0]?.scrollback).toBe('RESTORED_SCREEN'); // 독립 리터럴: 같은 화면 복구
  expect(saved?.panes[0]?.state).toBe('exited');          // 독립 리터럴: 재부팅으로 종료됨
  expect(consumed).toEqual([paneId]);                     // 독립 리터럴: 소비 정확히 1회
  expect(files.has(paneId)).toBe(false);
}, LIT_TEST_MS);

// ── 실제 배선 시험(리터럴 아님): saveScreenSnapshot(홀더 프로세스) → 홀더 비정상 종료 → reattachHolder →
// restoreScreenFromSnapshot → core.start 소비. 홀더는 실제 detached 프로세스, 스냅샷은 홀더의 디바운스 기록이다.
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const REAL_WIRING_MS = 40_000; // 출처: 홀더 디바운스 5 s + 기동·종료 여유 — 실패 시 정지

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function until(label: string, ok: () => boolean, ms: number): Promise<void> {
  const stop = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > stop) throw new Error(`timed out: ${label}`);
    await sleep(100);
  }
}

test('screen restore 6 (real wiring): a hard-killed holder leaves its meta behind; the holder snapshot still restores through reattach and core.start', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-d1b-real-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  let holderPid = 0;
  let live: SpaceJournal = emptyJournal();
  // 첫 서버: 실제 spawnHolderDetached + 어댑터(holderPty 와 같은 배선, 홀더 pid 만 붙잡는다).
  const first = createElsCore({
    load: () => live, save: (next) => { live = next; },
    spawn: (command, cwd, title, env) => {
      const paneId = env.ELANOUS_ELS_PANE!;
      holderPid = spawnHolderDetached({ stateRoot: root, paneId, cwd, title, env, command }).pid;
      return connectHolderElsPty(root, paneId, undefined);
    },
  });
  expect(first.newPane({ ws: 'ws-real', cwd: root, command: ['/bin/sh', '-c', 'printf "REAL_WIRING_MARKER_7Q\\r\\n"; exec cat'] }).exitCode).toBe(0);
  const paneId = live.panes[0]!.id;
  expect(live.panes[0]!.ptyId).toBe(`h:${paneId}`); // 독립 리터럴: 홀더 어댑터 id 규칙
  const before = live; // 재부팅 직전 저장된 저널(live pane)
  const snapPath = holderSnapshotPath(root, paneId);
  const metaPath = holderMetaPath(root, paneId);
  // 홀더의 실제 디바운스 기록이 마커를 담은 스냅샷을 남길 때까지 기다린다(제품 기록 경로 그대로).
  await until('holder wrote a snapshot with the marker', () => loadScreenSnapshot(snapPath)?.screen.includes('REAL_WIRING_MARKER_7Q') === true, 15_000);
  const meta = loadHolderMeta(metaPath);
  expect(meta).toBeDefined();
  // 재부팅 흉내: 홀더와 자식을 SIGKILL — 홀더가 못 지운 meta·소켓이 남는다.
  process.kill(holderPid, 'SIGKILL');
  process.kill(meta!.pid, 'SIGKILL');
  await until('holder and child gone', () => !pidAlive(holderPid) && !pidAlive(meta!.pid), 10_000);
  expect(existsSync(metaPath)).toBe(true); // 독립 리터럴: SIGKILL 은 meta 를 지우지 못한다(이 시험의 전제)
  // 두 번째 서버: 실제 reattach/restore/consume 배선.
  let saved: SpaceJournal | undefined;
  const second = createElsCore({
    load: () => before, save: (next) => { saved = next; },
    spawn: () => { throw new Error('spawn must not be called'); },
    reattach: (pane) => reattachHolder(root, pane.id),
    restoreScreen: (id) => restoreScreenFromSnapshot(root, id),
    consumeScreenSnapshot: (id) => consumeScreenSnapshot(root, id),
  });
  expect(second.start()).toBeUndefined();
  const pane = saved!.panes.find((candidate) => candidate.id === paneId)!;
  expect(pane.state).toBe('exited');                                   // 독립 리터럴: 재부팅으로 종료됨
  expect(pane.ptyId).toBe('');                                         // 독립 리터럴: PTY 소유 없음
  expect(pane.scrollback.includes('REAL_WIRING_MARKER_7Q')).toBe(true); // 독립 리터럴: 실제 홀더가 기록한 화면이 복원됐다
  expect(pane.scrollback.endsWith('재부팅으로 종료됨 — 이전 화면 — Enter 로 다시 만들기')).toBe(true);
  expect(existsSync(snapPath)).toBe(false);                             // 독립 리터럴: 저널 commit 뒤 소비
  expect(existsSync(metaPath)).toBe(false);                             // 독립 리터럴: 죽은 홀더 meta 정리
}, REAL_WIRING_MS);

test('screen restore 7: reattachHolder adopts only a holder that is really there — dead pid or missing socket is refused and its stale meta dropped', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-d1b-alive-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const deadPid = Bun.spawnSync(['/usr/bin/true']).pid; // 이미 끝나 회수된 프로세스 — 죽은 pid
  const staleMeta = (paneId: string, pid: number): HolderMeta => ({ paneId, ptyId: 'x', pid, cwd: root, command: ['sh'], title: paneId,
    socketPath: holderSocketPath(root, paneId), startedAt: 0, cols: 80, rows: 24 }); // 출처: startedAt 0 — 생존 판정과 무관
  // (a) 죽은 pid + 소켓 파일 잔존(비정상 종료 흉내)
  const deadPane = 'dp';
  mkdirSync(holdersDir(root), { recursive: true });
  const deadServer = createServer();
  await new Promise<void>((resolve) => deadServer.listen(holderSocketPath(root, deadPane), () => resolve()));
  saveHolderMeta(holderMetaPath(root, deadPane), staleMeta(deadPane, deadPid));
  expect(reattachHolder(root, deadPane)).toBeUndefined();           // 독립 리터럴: 죽은 pid 는 입양하지 않는다
  expect(existsSync(holderMetaPath(root, deadPane))).toBe(false);   // 독립 리터럴: 죽은 홀더의 meta 정리
  deadServer.close();
  // (b) 산 pid(이 시험 프로세스) 이지만 소켓 없음
  const noSock = 'ns';
  saveHolderMeta(holderMetaPath(root, noSock), staleMeta(noSock, process.pid));
  expect(reattachHolder(root, noSock)).toBeUndefined();             // 독립 리터럴: 소켓 없으면 입양하지 않는다
  expect(existsSync(holderMetaPath(root, noSock))).toBe(false);
  // (c) 실제 살아 있는 홀더는 그대로 입양된다(생존 점검이 산 홀더를 거부하지 않는다)
  const holder = await startHolder({ stateRoot: root, paneId: 'lv', cwd: root,
    command: ['/bin/sh', '-c', 'exec cat'], title: 'lv' });
  cleanups.push(() => holder.close());
  const adopted = reattachHolder(root, 'lv');
  expect(adopted).toBeDefined();                                     // 독립 리터럴: 산 홀더는 입양
  expect(adopted?.id).toBe('h:lv');
  adopted?.detach?.();
  expect(existsSync(holderMetaPath(root, 'lv'))).toBe(true);  // 독립 리터럴: 산 홀더의 meta 는 건드리지 않는다
}, LIT_TEST_MS * 2);

test('screen restore 8: start drops a leftover snapshot of a pane that already has no PTY', () => {
  const stub = (): ElsPty => ({ id: 'p1', isAlive: () => true, write: () => {}, writeAll: async () => {},
    bracketedPasteEnabled: () => true, renderScreen: async () => '', onExit: () => {}, kill: () => {} });
  let stored: SpaceJournal = emptyJournal();
  const seed = createElsCore({ load: () => stored, save: (next) => { stored = next; }, spawn: () => stub() });
  expect(seed.newPane({ ws: 'ws-lit', cwd: '/tmp', command: ['sh'] }).exitCode).toBe(0);
  const paneId = stored.panes[0]!.id;
  const noPty: SpaceJournal = { ...stored, panes: stored.panes.map((pane) => ({ ...pane, ptyId: '', state: 'exited', scrollback: 'RECORDED_FINAL' })) }; // 정상 종료로 ptyId 가 비고 최종 화면이 저널에 기록된 pane
  const files = new Set<string>([paneId]);
  const deps = { load: () => noPty, save: () => {}, spawn: () => stub(), restoreScreen: () => 'MUST_NOT_OVERWRITE',
    consumeScreenSnapshot: (id: string) => { files.delete(id); } };
  expect(files.has(paneId)).toBe(true);   // 독립 리터럴: start 전에는 파일이 있다
  expect(createElsCore(deps).start()).toBeUndefined();
  expect(files.has(paneId)).toBe(false);  // 독립 리터럴: 이미 종료된 pane 의 잔존 스냅샷은 정리된다
}, LIT_TEST_MS);

// ── OP #115096: consume ONLY AFTER APPLIED — a restore that returns undefined / '' / throws (a transient read error)
// must not consume the snapshot: file kept, 0 consumes, scrollback '' — the next start with a working restore applies it.
const NOT_APPLIED: [string, (id: string) => string | undefined][] = [
  ['undefined (injected read failure)', () => undefined],
  ['throws', () => { throw new Error('EIO transient'); }],
  ["empty string", () => ''],
];
for (const [label, failing] of NOT_APPLIED) {
  test(`screen restore 11: a PTY-less pane whose restore ${label} keeps the real snapshot; the next start applies and consumes it once`, () => {
    const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-d1b-cons-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const stub = (): ElsPty => ({ id: 'p1', isAlive: () => true, write: () => {}, writeAll: async () => {},
      bracketedPasteEnabled: () => true, renderScreen: async () => '', onExit: () => {}, kill: () => {} });
    let stored: SpaceJournal = emptyJournal();
    expect(createElsCore({ load: () => stored, save: (next) => { stored = next; }, spawn: () => stub() })
      .newPane({ ws: 'ws-cons', cwd: root, command: ['sh'] }).exitCode).toBe(0);
    const paneId = stored.panes[0]!.id;
    let journal: SpaceJournal = { ...stored, panes: stored.panes.map((pane) => ({ ...pane, ptyId: '', state: 'exited', scrollback: '' })) };
    const snap = holderSnapshotPath(root, paneId);
    saveScreenSnapshot(snap, { version: 1, paneId, ptyId: 'h:x', cols: 80, rows: 24, screen: 'CONSUME_AFTER_APPLIED_7Q', scrollback: '', savedAt: 0 });
    let consumes = 0;
    const deps = (restore: (id: string) => string | undefined): Parameters<typeof createElsCore>[0] => ({
      load: () => journal, save: (next) => { journal = next; }, spawn: () => stub(), restoreScreen: restore,
      consumeScreenSnapshot: (id) => { consumes += 1; consumeScreenSnapshot(root, id); } });
    expect(createElsCore(deps(failing)).start()).toBeUndefined();
    expect(consumes).toBe(0);              // 독립 리터럴: 적용되지 않았으면 소비 0회
    expect(existsSync(snap)).toBe(true);   // 독립 리터럴: 실파일 그대로
    expect(journal.panes[0]?.scrollback).toBe('');
    expect(createElsCore(deps((id) => restoreScreenFromSnapshot(root, id))).start()).toBeUndefined();
    expect(journal.panes[0]?.scrollback.includes('CONSUME_AFTER_APPLIED_7Q')).toBe(true);
    expect(consumes).toBe(1);
    expect(existsSync(snap)).toBe(false);
  }, LIT_TEST_MS);
}

// ── JUD-B #114918(D1b-FU): 산 pid + 소켓 파일은 있으나 아무도 받지 않는 holder(stale/unreachable). reattach 는 어댑터를 돌려주고,
// 어댑터의 연결 시한이 끝나 pane 이 exited(scrollback '')가 된다. 다음 기동이 그 저장 화면을 복원 없이 지우면 화면이 사라진다.
const STALE_ADOPT_MS = 20_000; // 출처: 어댑터 연결 시한(HOLDER_CONNECT_TIMEOUT_MS 5 s) + 재시도 간격·기동 여유 — 실패 시 정지
const STALE_TEST_MS = 40_000;  // 출처: 위 대기 + 두 번째 기동·정리 여유

function staleFixture(prefix: string): { root: string; paneId: string; journal: SpaceJournal; snap: string } {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, prefix));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const stub = (): ElsPty => ({ id: 'p1', isAlive: () => true, write: () => {}, writeAll: async () => {},
    bracketedPasteEnabled: () => true, renderScreen: async () => '', onExit: () => {}, kill: () => {} });
  let stored: SpaceJournal = emptyJournal();
  expect(createElsCore({ load: () => stored, save: (next) => { stored = next; }, spawn: () => stub() })
    .newPane({ ws: 'ws-stale', cwd: root, command: ['sh'] }).exitCode).toBe(0);
  const paneId = stored.panes[0]!.id;
  const journal: SpaceJournal = { ...stored, panes: stored.panes.map((pane) => ({ ...pane, ptyId: `h:${paneId}` })) };
  const snap = holderSnapshotPath(root, paneId);
  saveScreenSnapshot(snap, { version: 1, paneId, ptyId: `h:${paneId}`, cols: 80, rows: 24, screen: 'STALE_SAVED_MARKER_9K', scrollback: '', savedAt: 0 });
  return { root, paneId, journal, snap };
}

test('screen restore 9: an unreachable holder (live pid, socket file, no listener) keeps its saved screen until a restore succeeds', async () => {
  const { root, paneId, journal: seeded, snap } = staleFixture('els-d1b-stale-');
  const sleeper = Bun.spawn(['/bin/sleep', '300']); // 산 pid — 시험이 끝나면 정지시킨다
  cleanups.push(() => { sleeper.kill(); });
  const sock = holderSocketPath(root, paneId);
  mkdirSync(holdersDir(root), { recursive: true });
  expect(Bun.spawnSync(['python3', '-c', 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.close()', sock]).exitCode).toBe(0); // bind 만 — 소켓 파일은 남고 듣는 이는 없다
  saveHolderMeta(holderMetaPath(root, paneId), { paneId, ptyId: 'x', pid: sleeper.pid, cwd: root, command: ['sh'], title: 'x', socketPath: sock, startedAt: 0, cols: 80, rows: 24 });
  let journal = seeded;
  let restores = 0;
  let consumes = 0;
  const deps = (): Parameters<typeof createElsCore>[0] => ({ load: () => journal, save: (next) => { journal = next; },
    spawn: () => { throw new Error('spawn must not be called'); },
    reattach: (pane) => reattachHolder(root, pane.id),
    restoreScreen: (id) => { restores += 1; return restoreScreenFromSnapshot(root, id); },
    consumeScreenSnapshot: (id) => { consumes += 1; consumeScreenSnapshot(root, id); } });
  expect(createElsCore(deps()).start()).toBeUndefined();
  expect(existsSync(snap)).toBe(true); // 독립 리터럴: 어댑터 입양만으로는 저장 화면을 지우지 않는다
  await until('adapter gave up and the pane exited', () => journal.panes[0]?.state === 'exited', STALE_ADOPT_MS);
  expect(existsSync(snap)).toBe(true); // 독립 리터럴: 연결 포기 뒤에도 저장 화면이 살아 있다(아직 복원 전)
  expect(createElsCore(deps()).start()).toBeUndefined();
  expect(journal.panes[0]?.scrollback.includes('STALE_SAVED_MARKER_9K')).toBe(true); // 독립 리터럴: 저장 화면이 scrollback 으로 복원됐다
  expect(restores).toBe(1);        // 독립 리터럴: 복원 1회
  expect(consumes).toBe(1);        // 독립 리터럴: 복원한 뒤에야 소비 1회
  expect(existsSync(snap)).toBe(false);
}, STALE_TEST_MS);

test('screen restore 10 (negative control): a reachable holder is adopted untouched — nothing is restored or consumed', async () => {
  const { root, paneId, journal: seeded, snap } = staleFixture('els-d1b-reach-');
  const holder = await startHolder({ stateRoot: root, paneId, cwd: root, command: ['/bin/sh', '-c', 'exec cat'], title: 'lv' });
  cleanups.push(() => holder.close());
  saveScreenSnapshot(snap, { version: 1, paneId, ptyId: `h:${paneId}`, cols: 80, rows: 24, screen: 'REACH_SAVED_MARKER_2R', scrollback: '', savedAt: 0 });
  let journal = seeded;
  let restores = 0;
  let consumes = 0;
  const adoptedPtys: (ElsPty | undefined)[] = [];
  const core = createElsCore({ load: () => journal, save: (next) => { journal = next; },
    spawn: () => { throw new Error('spawn must not be called'); },
    reattach: (pane) => { const pty = reattachHolder(root, pane.id); adoptedPtys.push(pty); return pty; },
    restoreScreen: (id) => { restores += 1; return restoreScreenFromSnapshot(root, id); },
    consumeScreenSnapshot: (id) => { consumes += 1; consumeScreenSnapshot(root, id); } });
  cleanups.push(() => { adoptedPtys[0]?.detach?.(); });
  expect(core.start()).toBeUndefined();
  expect(adoptedPtys[0]?.id).toBe(`h:${paneId}`);        // 독립 리터럴: 산 holder 는 입양된다
  expect(journal.panes[0]?.ptyId).toBe(`h:${paneId}`);   // 독립 리터럴: pane 은 그대로 holder 소유
  expect(journal.panes[0]?.scrollback).toBe('');         // 독립 리터럴: 화면은 holder 가 갖고 있어 저널은 건드리지 않는다
  expect(restores).toBe(0);                              // 독립 리터럴: 복원 0
  expect(consumes).toBe(0);                              // 독립 리터럴: 소비 0
  expect(existsSync(snap)).toBe(true);
}, LIT_TEST_MS * 2);
