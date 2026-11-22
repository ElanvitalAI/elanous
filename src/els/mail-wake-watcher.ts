// ELS-CODEX-SEAT-MAIL-WAKE (0.3.33 · OP #132092·#132156) — els 로 옮긴 codex CLI 자리(JUD·REL·RES-INFRA)는
// runtime=eln 이 아니라서 자기 우편 감시(eln-mail-watch)가 없다: 우편이 와도 깨어나지 않는다
// (11-22 JUD 11:20 뒤 2시간 정지 · 보안 판정 7건 적체의 뿌리). 이 감시자가 그 안전망이다.
// 서버당 하나(src/els/server.ts 가 stall-alert 와 함께 띄운다).
// 구동 방식(OP #132156): 주기 폴링 금지 · env/옵션 스위치 금지 — 우편 원장(messages.db*) 기록 변화를
// fs.watch 로 구독해, 이벤트가 올 때만(시작 시 1회 포함) 확인 회차를 돈다. 버스트는 한 회차로 묶는다.
// 확인 회차: seatBindings() 의 라이브 자리마다 안 읽은 우편을 보고, 그 pane 이 idle+빈 입력이면
// 서버 소유 PTY 로 «우편 확인» 한 줄을 sendVerified 주입한다('turn started' 영수 확인까지 —
// 완수선: 노크 뒤 60초 안 턴 시작). 한 에피소드(안 읽음 0→N)에 원칙 1회 · busy 면 그 pane 의 PTY 출력을
// 구독해 idle 전환(턴 종료 출력)을 잡아 같은 watcher 로 다시 본다 · runtime=eln 자리는 건드리지 않는다(그 몸은 자기 큐를 스스로
// 비운다 — 한 우편 두 턴 #87012 금지). 원장은 읽기만 한다. 영수는 mail-wake.jsonl
// (256 KiB 상한 · .1 한 세대 — child-results 와 같은 규칙).

import { appendFileSync, mkdirSync, renameSync, statSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { ElsCore } from './core.js';

/** 이벤트 버스트를 한 확인 회차로 묶는 상수(환경·옵션으로 바꿀 수 없다 — OP #132156). */
export const MAIL_WAKE_DEBOUNCE_MS = 1_000;
/** 칸 완수선: 노크 → 턴 시작까지 이 안(시험 우주 codex 자리 우편 1통 → 60초). */
export const MAIL_WAKE_WITHIN_MS = 60_000;
/** 주입 문면 — eln TUI 자리 큐 노티스와 같은 한 줄(본문·보낸이 없는 문턱 노크). */
export const MAIL_WAKE_LINE = '우편 확인';
/** 원장 감시 오류 뒤 재무장까지의 상수(주기 폴링이 아니라 자가 치유 지연). */
const REARM_MS = 15_000;
const RECEIPTS_MAX_BYTES = 256 * 1024;

/** The server seams this watcher needs (createElsCore satisfies them; tests pass a fake). */
export type MailWakeCore = Pick<ElsCore, 'seatBindings' | 'status' | 'sendVerified' | 'onOutput'>;

export interface MailWakeDeps {
  readonly now?: () => number;
  /** 우편 원장 경로(기본 = msg 원장 messages.db — 이 파일명 접두의 기록 변화를 구독한다). */
  readonly ledgerPath?: string;
  /** 자리별 안 읽은 우편 뱃지(시험 주입 · 기본 = 원장 읽기 전용). null/불가 = 모름(넘어간다). */
  readonly unreadBadge?: (seat: string) => { count: number } | null;
  /** runtime=eln 자리는 자기 큐를 스스로 비운다 — 노크 0. 모름(undef)이면 노크한다(codex 자리가 옳다). */
  readonly runtimeOf?: (seat: string) => string | undefined;
  /** 실제 자리 레지스트리 루트 — 주입 없는 기본 runtimeOf(msg-wake seatDeliveryView)가 읽는다. 생산 기본 = ~/elanous-hq/seat-state. */
  readonly seatStateRoot?: string;
  readonly wakeLine?: (seat: string) => string;
  /** 영수 파일 경로(기본 = stateRoot els 디렉터리 옆 mail-wake.jsonl). */
  readonly receiptsPath?: string;
  /** 원장 이벤트 소스(시험 우주 주입 · 기본 = fs.watch 원장 디렉터리). 반환값 = 구독 해지. */
  readonly subscribeLedger?: (onChange: () => void) => (() => void) | undefined;
  readonly log?: (line: string) => void;
}

export interface MailWakeWatcher {
  /** Stop watching and detach (idempotent). A check already running may finish. */
  stop(): void;
  readonly watching: boolean;
  /** One check now (ledger events call the same; tests drive it directly). */
  check(): Promise<void>;
}

/** One knocked episode: (pane, unread-set) — a second knock needs the unread count to pass through 0. */
type Episode = { seat: string; unread: number; knockedAt: number };

/** 기본 우편 원장 경로(OP #132628 수리): 폴백까지 격리 인식 단일 루트로 조립한다. */
export function defaultLedgerPath(): string {
  try {
    const { defaultMsgStorePath } = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
    return defaultMsgStorePath();
  } catch {
    // homedir+'.elanous' 직접 조립은 격리 시험 우주에서 운영 원장을 보게 한다(isolation-gate · 격리 4우주 위반).
    // msg-store 로딩이 실패해도 같은 축(elanousStateRoot — ELANOUS_STATE_DIR 존중)으로 되돌아간다.
    const { elanousStateRoot } = require('../autopilot/state-paths.js') as typeof import('../autopilot/state-paths.js');
    return join(elanousStateRoot(), 'msg', 'messages.db');
  }
}

function defaultUnreadBadge(path?: string): (seat: string) => { count: number } | null {
  return (seat) => {
    try {
      const { readUnreadMailBadge, defaultMsgStorePath } = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
      return readUnreadMailBadge(seat, path ?? defaultMsgStorePath());
    } catch { return null; }
  };
}

/** runtime=eln seats answer their own mail queue; they are never knocked (한 우편 두 턴 금지 #87012).
 * 판별은 의존성 없는 자리 레지스트리 모듈의 실제 export(readSeatRegistryV2·seatRegistryV2Entry · v1 투영 포함) —
 * JUD-B #39648 must ①: seat-registry 에는 registrySnapshot export 가 없고, msg-wake 를 당기면 pty-shell 의존(@xterm/headless)
 * 까지 따라와 가벼운 감시자 기본 경로가 깨진다. 생산 기본 레지스트리 루트 = ~/elanous-hq/seat-state(msg-wake resolveSeatStateRoot 와 같은 값). */
function defaultRuntimeOf(seatStateRoot?: string): (seat: string) => string | undefined {
  return (seat) => {
    try {
      const mod = require('../loops/seat-registry.js') as {
        readSeatRegistryV2?: (path: string) => { status: string; registry?: { seats: ReadonlyArray<{ address: string; runtime?: string }> } };
        seatRegistryV2Entry?: (registry: { seats: ReadonlyArray<{ address: string; runtime?: string }> }, address: string) => { runtime?: string } | undefined;
      };
      if (!mod.readSeatRegistryV2 || !mod.seatRegistryV2Entry) return undefined;
      const root = seatStateRoot ?? join(homedir(), 'elanous-hq', 'seat-state');
      const read = mod.readSeatRegistryV2(join(root, 'seat-registry.json'));
      if (read.status !== 'ready' || !read.registry) return undefined;
      return mod.seatRegistryV2Entry(read.registry, seat.trim().toUpperCase())?.runtime;
    } catch { return undefined; }
  };
}

/**
 * 기본 이벤트 소스 — 원장 디렉터리를 fs.watch 한다. SQLite WAL 쓰기는 -wal/-shm 파일을 건드리므로
 * 파일 하나가 아니라 디렉터리를 보고 원장 파일명 접두(prefix, prefix-wal, prefix-shm)로 거른다.
 */
function defaultSubscribeLedger(ledgerPath: string, log: (line: string) => void): (onChange: () => void) => (() => void) | undefined {
  return (onChange) => {
    const dir = dirname(ledgerPath);
    const prefix = basename(ledgerPath);
    let stopped = false;
    let watcher: FSWatcher | undefined;
    let rearmTimer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      if (stopped) return;
      try {
        watcher = watch(dir, { persistent: true }, (_event, filename) => {
          if (typeof filename === 'string' && (filename === prefix || filename.startsWith(`${prefix}-`))) onChange();
        });
        watcher.on('error', (error) => {
          log(`els: mail wake ledger watch error (${error instanceof Error ? error.message : String(error)}) — re-arm in 15s`);
          if (stopped) return;
          rearmTimer = setTimeout(arm, REARM_MS);
          rearmTimer.unref?.();
        });
      } catch (error) {
        log(`els: mail wake ledger watch unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    arm();
    return () => {
      stopped = true;
      if (rearmTimer !== undefined) clearTimeout(rearmTimer);
      watcher?.close();
    };
  };
}

export function startMailWakeWatcher(core: MailWakeCore, deps: MailWakeDeps = {}): MailWakeWatcher {
  const now = deps.now ?? Date.now;
  const ledgerPath = deps.ledgerPath ?? defaultLedgerPath();
  const unreadBadge = deps.unreadBadge ?? defaultUnreadBadge(ledgerPath);
  const runtimeOf = deps.runtimeOf ?? defaultRuntimeOf(deps.seatStateRoot);
  const wakeLine = deps.wakeLine ?? (() => MAIL_WAKE_LINE);
  const log = deps.log ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const receiptsPath = deps.receiptsPath;
  const episodes = new Map<string, Episode>();
  /** busy 대기 pane 들의 onOutput 구독 해지 — idle 전환(턴 종료 출력)이 확인 회차를 다시 연(JUD-B #39648 must ②). */
  const busyWaits = new Map<string, () => void>();
  let stopped = false;
  let checking = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingDuringCheck = false;

  const receipt = (line: Record<string, unknown>): void => {
    if (!receiptsPath) return;
    try {
      mkdirSync(dirname(receiptsPath), { recursive: true });
      try { if (statSync(receiptsPath).size > RECEIPTS_MAX_BYTES) renameSync(receiptsPath, `${receiptsPath}.1`); } catch { /* no file yet */ }
      appendFileSync(receiptsPath, `${JSON.stringify({ at: new Date(now()).toISOString(), ...line })}\n`, { mode: 0o600 });
    } catch { /* 영수 실패가 회차를 죽이지 않는다 */ }
  };

  const check = async (): Promise<void> => {
    if (stopped || checking) return;
    checking = true;
    try {
      for (const binding of core.seatBindings()) {
        try {
          if (runtimeOf(binding.seat) === 'eln') continue;
          const badge = unreadBadge(binding.seat);
          const unread = badge?.count ?? 0;
          if (unread <= 0) { episodes.delete(binding.pane); disarmBusyWait(binding.pane); continue; }   // 에피소드 끝 — 다음 0→N 에 다시 노크
          if (episodes.get(binding.pane)?.knockedAt !== undefined) continue;  // 이 에피소드는 이미 노크함
          // 구독이 상태 확인보다 앞선다(JUD-B #39648 must ① 경합): status 는 busy 화면을 비동기로 반환하는데,
          // 그 반환을 기다리는 사이 턴 종료 출력이 지나가면 구독 뒤에는 그 이벤트가 다시 오지 않는다 —
          // 먼저 세운 구독이 잡아 후속 확인 회차를 연다(추가 원장·출력이 없어도 미읽음을 다시 본다).
          armBusyWait(binding.pane);
          const status = await core.status(binding.pane);
          let view: { state?: string; inputEmpty?: boolean | 'unknown' };
          try { view = JSON.parse(status.message); } catch { continue; }
          // 턴 중이면 대기 — 위에서 세운 구독 그대로 idle 전환(턴 종료 출력) 이벤트에 같은 watcher 로 다시 본다.
          if (view.state !== 'idle' || view.inputEmpty !== true) { continue; }
          disarmBusyWait(binding.pane);
          const sent = await core.sendVerified(binding.pane, wakeLine(binding.seat), true);
          if (sent.exitCode === 0 && sent.message.includes('turn started')) {
            episodes.set(binding.pane, { seat: binding.seat, unread, knockedAt: now() });
            receipt({ pane: binding.pane, seat: binding.seat, unread, result: 'turn-started', line: wakeLine(binding.seat) });
          } else {
            log(`els: mail wake not sent to ${binding.seat} (${binding.pane}): ${sent.message.slice(0, 160)}`);
          }
        } catch (error) {
          log(`els: mail wake check skipped ${binding.seat} (${binding.pane}): ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally { checking = false; }
  };

  /** 원장 이벤트(들)를 디바운스해 한 확인 회차로 묶는다 — 주기 타이머는 없다. */
  const scheduleCheck = (): void => {
    if (stopped) return;
    if (debounceTimer !== undefined) return;              // 대기 중 타이머가 이미 이 버스트를 묶는다
    if (checking) { pendingDuringCheck = true; return; }  // 회차 실행 중 온 이벤트는 그 회차가 끝난 뒤 한 번 더
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void check().finally(() => {
        if (pendingDuringCheck && !stopped) { pendingDuringCheck = false; scheduleCheck(); }
      });
    }, MAIL_WAKE_DEBOUNCE_MS);
    debounceTimer.unref?.();
  };

  /** idle 전환 감시 등록: 그 pane 의 PTY 출력(턴 종료 포함)이 오면 같은 watcher 로 확인 회차를 다시 연다.
   *  status 확인보다 먼저 세운다(JUD-B #39648 must ①) — 비동기 status 사이에 지나가는 턴 종료 출력도 놓치지 않는다.
   *  원장 이벤트만 기다리면 busy→idle 뒤 추가 우편이 없을 때 그 자리의 우편은 영영 미처리된다(must ②). */
  const armBusyWait = (pane: string): void => {
    if (stopped || busyWaits.has(pane)) return;
    const sub = core.onOutput(pane, () => scheduleCheck());
    if (sub) busyWaits.set(pane, sub.dispose);
  };
  const disarmBusyWait = (pane: string): void => {
    const dispose = busyWaits.get(pane);
    if (dispose === undefined) return;
    busyWaits.delete(pane);
    try { dispose(); } catch { /* 구독이 이미 끝났다 */ }
  };

  const unsubscribe = (deps.subscribeLedger ?? defaultSubscribeLedger(ledgerPath, log))(scheduleCheck);
  void check().finally(() => {   // 시작 시 1회 — 서버가 꺼져 있던 사이 온 우편도 문턱에서 잡는다(주기 폴링 아님)
    if (pendingDuringCheck && !stopped) { pendingDuringCheck = false; scheduleCheck(); }   // 시작 회차 중 온 이벤트도 후속 회차로(JUD-B #39648 must ③)
  });

  return {
    watching: true,
    stop: () => {
      stopped = true;
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      for (const dispose of busyWaits.values()) { try { dispose(); } catch { /* already ended */ } }
      busyWaits.clear();
      unsubscribe?.();
    },
    check,
  };
}
