'use client';

// WT-S-2 — multi-terminal tab strip. Replaces the WT-S-1 single-input
// TerminalSelector with a horizontal list of active terminals + add /
// close affordances.
//
// Invariants:
//   - Tabs are the source of truth for "what terminals exist" in the
//     current PWA tab. localStorage persists the list across reloads;
//     a `terminal/list` ACP call on mount reconciles against the
//     daemon (server-side terminals not in our local list show up,
//     local ids the daemon doesn't know about stay queued for spawn).
//   - Active tab id is hoisted to /term page state; TerminalPanel keeps every
//     open XtermView keyed by terminal id and hides only the inactive panels.
//   - WT-B4 — the "+" button spawns explicitly, with no `terminalId`,
//     so the daemon issues the name and we adopt it. This replaced the
//     older invariant ("no explicit spawn call here"): under it the
//     client minted `preview-N` locally and the daemon could only
//     record what it was told, so a tab could exist that the daemon
//     had never heard of.
//     Spawn still ALSO happens implicitly — switching to a not-yet-known
//     id mounts XtermView, which calls `terminal/spawn` with that id.
//     The daemon side is idempotent, so the two paths compose: `onAdd`
//     creates the PTY and XtermView re-attaches to the same one.
//     ⚠️ The implicit path is still how ids that we did NOT get from the
//     daemon (restored localStorage tabs, the offline fallback below)
//     come into being, so it is not dead code.
//   - The X removes a local tab only. Explicit termination is a separate
//     confirmed control that calls `terminal/destroy`.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, MessagesSquare, Minimize2, Users } from 'lucide-react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import type { AcpConnectionState, DaemonTerminalControlResult } from '@/lib/daemon-client';
import { debugLog } from '@/lib/debug';
import { terminalChipLabel } from './terminal-chip-label';
import { originChipText, originTooltipText } from './terminal-origin-label';
import { tabCloseAction, terminateConfirmation, type OwnerRunUsage } from './tab-close-intent';

const STORAGE_KEY = 'elanous.webterm.tabs';
const HIDDEN_STORAGE_KEY = 'elanous.webterm.hidden-tabs';

export type InitialTerminalState =
  | { status: 'pending' }
  | { status: 'ready'; issuedBy: 'daemon' | 'local'; fallbackReason?: string };

interface Props {
  activeId: string | null;
  onActiveChange: (id: string) => void;
  onInitialTerminalState?: (state: InitialTerminalState) => void;
  /** Minimized = only this tab strip is visible; the other panels
   *  (multi-device · controls · REPL) are hidden by the parent.
   *  When true the strip surfaces compact status pills (recording dot,
   *  peer count) so the user keeps the essential signals without
   *  expanding the panels. */
  minimized?: boolean;
  onToggleMinimize?: () => void;
  /** Callbacks parent feeds with state hoisted from the hidden panels
   *  so we can render their essential status compactly here. */
  recording?: boolean;
  peerCount?: number;
  chatDockOpen?: boolean;
  onToggleChatDock?: () => void;
  /** Track 2 — `:tab next|prev|<N>` resolved by sticky REPL. nonce
   *  guarantees a fresh value triggers the effect even when the user
   *  re-issues the same intent (e.g. `:tab next` twice). */
  tabIntent?: { intent: 'next' | 'prev' | number; nonce: number } | null;
  onTabsChange?: (tabs: readonly string[]) => void;
  /** A direct PTY link observes an existing owner; never mint a shell while it is open. */
  suspendInitialSpawn?: boolean;
}

interface DaemonListEntry {
  terminalId: string;
  isAlive: boolean;
  /** ⚠️ 아래 셋은 `parseTerminalListResponse` 가 «검증하지 않는다» — 데몬 판마다
   *  있을 수도 없을 수도 있고, 우리가 판정에 쓰는 것은 위 둘뿐이다. 검증 안 하는
   *  필드를 필수라 «주장»하면 타입이 거짓말을 한다. */
  pid?: number;
  cols?: number;
  rows?: number;
  /** P4 — 마지막 PTY 출력 시각(epoch ms). 구 데몬은 미포함(optional). */
  lastOutputAt?: number;
  ownerRunUsage?: OwnerRunUsage;
  terminalOriginCategory?: 'direct-human' | 'elanous' | 'external-tool' | 'unknown';
  terminalOriginReason?: string;
  externalToolName?: string;
  controller?: string;
}

/** P4 — 탭 상태 refresh cadence. terminal/list 는 레지스트리 선형 스캔이라
 *  가볍고, 데몬이 list 변화를 push 하지 않으므로 폴링이 유일한 신선도원. */
const STATUS_POLL_MS = 15_000;

/** 신뢰할 수 없는 상태에서 쓰는 빈 지도 — 매 렌더 새 Map 을 만들면 memo 가 깨진다. */
const EMPTY_DAEMON_INFO: ReadonlyMap<string, DaemonListEntry> = new Map();

function lastActivityLabel(ms?: number): string {
  if (!ms || !Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 30) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

type TerminalControlAction = 'takeover' | 'release';

function terminalControlAction(info: DaemonListEntry | undefined): TerminalControlAction | null {
  if (!info?.isAlive || info.controller === undefined) return null;
  return info.controller === 'human' ? 'release' : 'takeover';
}

function terminalControlLabel(action: TerminalControlAction): string {
  return action === 'takeover' ? '넘겨받기' : '놓기';
}

function terminalControlMessage(
  action: TerminalControlAction,
  result: DaemonTerminalControlResult,
): string {
  switch (result.status) {
    case 'success':
      return action === 'takeover' ? '터미널을 넘겨받았습니다.' : '터미널 제어를 놓았습니다.';
    case 'unknown-pty':
      return '이 PTY를 찾을 수 없습니다. 목록을 새로고침해 주세요.';
    case 'denied':
      return '이 PTY의 제어를 바꿀 권한이 없습니다.';
    case 'failed':
      return 'PTY 제어 전환에 실패했습니다. 잠시 후 다시 시도해 주세요.';
    case 'owner-unreachable':
      return 'PTY 소유 프로세스에 연결할 수 없어 제어를 전환하지 못했습니다.';
    default: {
      const unhandled: never = result.status;
      return unhandled;
    }
  }
}

export function loadTabIds(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v) => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}

export function saveTabIds(ids: readonly string[]): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
}

export function loadHiddenTabIds(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(HIDDEN_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string' && id.length > 0) : [];
  } catch {
    return [];
  }
}

export function saveHiddenTabIds(ids: readonly string[]): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(HIDDEN_STORAGE_KEY, JSON.stringify(ids));
}

export function nextDefaultId(existing: readonly string[]): string {
  // preview-1, preview-2, ... — pick the smallest n not already used.
  let n = 1;
  while (existing.includes(`preview-${n}`)) n += 1;
  return `preview-${n}`;
}

/** `terminal/list` 응답이 «진짜 목록인가»를 가른다.
 *
 *  ⛔ 종전엔 `res?.terminals ?? []` 로 받아서, 응답이 없거나 모양이 다른 경우도
 *  「빈 목록을 성공적으로 봤다」와 «같은 값»이 됐다. 그러면 「데몬이 아무 터미널도
 *  모른다」로 읽혀 ***모든 탭이 정리 대상***이 된다 — 조회 실패가 탭 전멸로 이어진다.
 *  ⇒ 배열을 «실제로 받았을 때만» 성공이다. 리뷰 must-fix. */
export function parseTerminalListResponse(
  res: unknown,
): { ok: true; entries: DaemonListEntry[] } | { ok: false; reason: 'no-response' | 'malformed' } {
  if (res === undefined || res === null) return { ok: false, reason: 'no-response' };
  const terminals = (res as { terminals?: unknown }).terminals;
  if (!Array.isArray(terminals)) return { ok: false, reason: 'malformed' };
  // ⛔ 원소까지 본다. 배열이라는 것만 믿고 t.terminalId 를 읽으면 [null] 하나에
  //    폴 루프가 던지고, 모양이 다른 엔트리는 「데몬이 안다」로 «잘못» 기록된다.
  const entries: DaemonListEntry[] = [];
  for (const item of terminals) {
    if (typeof item !== 'object' || item === null) return { ok: false, reason: 'malformed' };
    const { terminalId, isAlive, pid, cols, rows, lastOutputAt, ownerRunUsage, terminalOriginCategory, terminalOriginReason, externalToolName, controller } =
      item as Record<string, unknown>;
    // ⛔ 공백만 있는 id 는 거절한다 — 같은 파일의 resolveNewTabId 가 이미 그렇게
    //    하고 있어, 여기서 통과시키면 «한 파일 안에서 계약이 갈린다».
    if (typeof terminalId !== 'string' || terminalId.trim().length === 0) return { ok: false, reason: 'malformed' };
    if (typeof isAlive !== 'boolean') return { ok: false, reason: 'malformed' };
    // ⛔ 검증한 것만 «새 객체로» 옮긴다. 통째로 캐스팅하면 optional 필드의
    //    런타임 타입이 여전히 거짓말한다(예: pid 가 문자열인데 number 로 읽힌다).
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    entries.push({
      terminalId,
      isAlive,
      ...(num(pid) !== undefined ? { pid: num(pid) } : {}),
      ...(num(cols) !== undefined ? { cols: num(cols) } : {}),
      ...(num(rows) !== undefined ? { rows: num(rows) } : {}),
      ...(num(lastOutputAt) !== undefined ? { lastOutputAt: num(lastOutputAt) } : {}),
      ...(ownerRunUsage === 'running' || ownerRunUsage === 'terminated-live-owner' || ownerRunUsage === 'no-run-id' || ownerRunUsage === 'unknown'
        ? { ownerRunUsage }
        : {}),
      ...(terminalOriginCategory === 'direct-human' || terminalOriginCategory === 'elanous' || terminalOriginCategory === 'external-tool' || terminalOriginCategory === 'unknown'
        ? { terminalOriginCategory }
        : {}),
      ...(typeof terminalOriginReason === 'string' ? { terminalOriginReason } : {}),
      ...(typeof externalToolName === 'string' ? { externalToolName } : {}),
      ...(typeof controller === 'string' ? { controller } : {}),
    });
  }
  return { ok: true, entries };
}

/** 탭을 «데몬이 아는가»로 셋으로 가른다.
 *
 *  행 단위 점은 이미 이 셋을 색으로 말한다(초록 alive · 빨강 데몬이 알지만
 *  죽음 · 회색 데몬이 모름). 그런데 헤더는 「N terminals · M alive」만 말해서
 *  ***나머지 N-M 이 무엇인지 침묵***했다.
 *
 *  📏 2026-08-17 실측: 화면이 「13 terminals · 1 alive」라 말했고, 그 12 는
 *  데몬 재시작으로 PTY 가 사라진 뒤 로컬 목록에만 남은 것이었다. 합집합이
 *  단방향이라(더하기만 하고 빼지 않는다) 한 번 들어온 id 가 영영 남는다. */
export function summarizeTabs(
  tabs: readonly string[],
  isAlive: (id: string) => boolean | undefined,
): { total: number; alive: number; daemonKnownDead: number; daemonUnknown: number } {
  let alive = 0;
  let daemonKnownDead = 0;
  let daemonUnknown = 0;
  for (const id of tabs) {
    const state = isAlive(id);
    if (state === undefined) daemonUnknown += 1;
    else if (state) alive += 1;
    else daemonKnownDead += 1;
  }
  return { total: tabs.length, alive, daemonKnownDead, daemonUnknown };
}

/** 헤더 한 줄 — ⛔ 「나머지」를 침묵하지 않는다. */
export function tabCountLabel(
  summary: ReturnType<typeof summarizeTabs>,
  daemonListSucceeded: boolean,
): string {
  const head = `${summary.total} terminal${summary.total === 1 ? '' : 's'}`;
  // 데몬 조회가 «성공한 적이 없으면» 0을 「없다」로 말하면 안 된다. 그 0은
  // 「모른다」이고, 둘을 같은 문장으로 내면 이 저장소가 반복해 밟은 «그럴듯한 0» 이 된다.
  if (!daemonListSucceeded) return `${head} · 데몬 상태 미확인`;
  const parts: string[] = [];
  if (summary.alive > 0) parts.push(`${summary.alive} alive`);
  if (summary.daemonKnownDead > 0) parts.push(`${summary.daemonKnownDead} 종료`);
  if (summary.daemonUnknown > 0) parts.push(`${summary.daemonUnknown} 데몬이 모름`);
  return parts.length > 0 ? `${head} · ${parts.join(' · ')}` : head;
}

/** 「정리」가 «지울» 탭 — 데몬이 모르는 것만. ⛔ 활성 탭은 절대 안 지운다.
 *
 *  ⛔ 자동으로 부르지 않는다. 데몬이 모르는 id 에는 두 뜻이 섞여 있다 —
 *  「PTY 가 사라져 유령이 된 것」과 「아직 안 띄운 것(선택하면 spawn)」.
 *  기계가 그 둘을 못 가르므로 «지우는 결정»은 사람이 한다. */
export function tabsCleanableAsUnknown(
  tabs: readonly string[],
  isAlive: (id: string) => boolean | undefined,
  activeId: string,
): string[] {
  return tabs.filter((id) => id !== activeId && isAlive(id) === undefined);
}

/** 들고 있는 ACP 연결을 «버리고 다시 얻어야 하나» 판정.
 *
 *  `null` 은 「아직 안 얻었다」이고 `FAILED`/`CLOSED` 는 「죽었다」다. 셋 다
 *  새로 얻어야 한다. `CONNECTING` 은 «아직 죽지 않았으므로» 버리지 않는다 —
 *  여기서 버리면 첫 핸드셰이크가 끝나기 전에 매 폴마다 연결을 새로 만들어
 *  스스로 폭주한다.
 *
 *  📏 2026-08-17 실측: 데몬 재시작 3.5초 뒤부터 terminal/list 가 15초마다
 *  실패했고 1시간 37분 동안 재획득이 0회였다. 판정하는 자리가 없었다. */
export function shouldReacquireAcp(state: AcpConnectionState | null): boolean {
  return state === null || state === 'FAILED' || state === 'CLOSED';
}

/** 새 탭 id 의 «출처» 판정 — 데몬이 발급했나, 우리가 지어냈나.
 *
 *  WT-B4 — 종전에는 클라이언트가 `preview-N` 을 지어 `terminal/spawn` 에
 *  실어 «통보»했고 데몬은 받아 적기만 했다. 그래서 데몬이 모르는 로컬 id 가
 *  생길 수 있었다. 데몬은 이미 `terminalId` 없는 spawn 을 받아 이름을
 *  발급하고 응답에 싣는다(src/acp/server.ts) — 이 함수는 그 응답을 «쓰는»
 *  쪽의 판정이다.
 *
 *  ⚠️ 데몬 응답이 id 를 안 주면 로컬 이름으로 «내려간다». 탭 추가가 막히는
 *  것이 이름이 로컬인 것보다 나쁘기 때문이다. 대신 내려간 «이유»를 함께
 *  돌려주어 관측이 두 길을 구분할 수 있게 한다 — 「데몬 발급 0건」이
 *  「기능이 없다」인지 「매번 폴백했다」인지가 이 칸으로 갈린다. */
export function resolveNewTabId(
  spawnResponse: unknown,
  existing: readonly string[],
): { id: string; issuedBy: 'daemon' | 'local'; fallbackReason?: string } {
  const terminalId = (spawnResponse as { terminalId?: unknown } | null | undefined)?.terminalId;
  // 공백만 있는 이름은 «받지 않는다» — 탭 라벨로도, terminal/input 의 키로도
  // 쓰이므로 눈에 안 보이는 id 가 목록에 앉으면 사람이 그 탭을 가리킬 수 없다.
  if (typeof terminalId === 'string' && terminalId.trim().length > 0) {
    return { id: terminalId, issuedBy: 'daemon' };
  }
  // ⛔ 사유를 «만들지» 않는다 — 실패가 사유를 실어 왔으면 그것을 쓴다. 종전엔 예외도
  //    `no-response` 라 적어 사실과 달랐다(무인 리뷰 must-fix · 2026-08-18).
  const fallbackReason = isSpawnFailure(spawnResponse)
    ? spawnResponse.spawnFailure
    : spawnResponse === undefined || spawnResponse === null
      ? 'no-response'
      : 'response-without-terminal-id';
  return { id: nextDefaultId(existing), issuedBy: 'local', fallbackReason };
}

type SpawnAcp = {
  send(method: string, params: { sessionId: string }): Promise<unknown>;
};

type TabDebugLog = (category: string, snapshot?: unknown) => void;

/** ⛔ 실패 «사유»를 값으로 나른다 — 종전엔 세 갈래(acp 없음·세션 없음·예외)를 `undefined`
 *  하나로 뭉개서, 예외가 났는데도 화면·관측이 「응답 없음」이라 «사실과 다르게» 말했다
 *  (무인 리뷰 must-fix · 2026-08-18 `#10105`). 「모른다」와 「실패했다」는 다른 칸이다. */
/** ⛔ export 하지 않는다 — 소비자가 «전수 0»(같은 파일 안에서만 쓴다). 게다가 export 하면
 *  tsc 게이트가 「기존 타입에 필수 필드 추가」로 읽어 저장소 전체 검사로 승격하고 무관한 기존
 *  부채 52건으로 FAIL 한다(2026-08-18 실측 · 새 타입엔 깨질 호출자가 없다 · 별건 등재). */
interface SpawnFailure {
  readonly spawnFailure: 'no-acp' | 'no-session' | 'spawn-error';
  /** 예외 문면. 사람이 원인을 좁히는 데 쓴다(관측에만 실린다). */
  readonly detail?: string;
}

function isSpawnFailure(value: unknown): value is SpawnFailure {
  return typeof value === 'object' && value !== null && typeof (value as SpawnFailure).spawnFailure === 'string';
}

/** Records every pre-result state of the explicit new-terminal request. */
export async function spawnNewTerminal(
  acp: SpawnAcp | null,
  sessionId: string | null,
  log: TabDebugLog = debugLog,
): Promise<unknown> {
  log('webterm.tabs.add.start', { hasAcp: Boolean(acp), hasSessionId: Boolean(sessionId) });
  if (!acp || !sessionId) {
    const spawnFailure = acp ? 'no-session' as const : 'no-acp' as const;
    log('webterm.tabs.add.skip', { reason: spawnFailure });
    return { spawnFailure };
  }
  log('webterm.tabs.add.spawn-pending', { sessionId });
  try {
    return await acp.send('terminal/spawn', { sessionId });
  } catch (e) {
    log('webterm.tabs.add.spawn-error', { reason: String(e) });
    return { spawnFailure: 'spawn-error' as const, detail: String(e) };
  }
}

export function TerminalTabs({
  activeId,
  onActiveChange,
  onInitialTerminalState,
  minimized = false,
  onToggleMinimize,
  recording = false,
  peerCount = 0,
  chatDockOpen = true,
  onToggleChatDock,
  tabIntent = null,
  onTabsChange,
  suspendInitialSpawn = false,
}: Props) {
  const { client, sessionId } = useDaemon();
  const [tabs, setTabs] = useState<string[]>(loadTabIds);
  const hiddenTabIdsRef = useRef(new Set(loadHiddenTabIds()));
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const initialSpawnGenerationRef = useRef(0);
  const initialSpawnPendingRef = useRef(false);
  /** ⛔ 이 마운트에서 «발급»을 마쳤나 — 발급한 탭을 아래 effect 가 `restored-tab` 으로 다시
   *  라벨하면 daemon 출처와 실패 사유가 «덮인다»(무인 리뷰 must-fix · 2026-08-18 `#10105`).
   *  ⚠️ 내 하니스에서는 우연히 daemon 이 마지막이었지만 «순서는 계약이 아니다». */
  const initialIssuedRef = useRef(false);
  const [acpReadyGeneration, setAcpReadyGeneration] = useState(0);

  // Long-lived ACP connection used for list/destroy. Gated on sessionId
  // being set so we attach to the same session XtermView established
  // (otherwise daemon would issue us a fresh sessionId and our list
  // call would return [] every time — different session scope).
  const acpRef = useRef<ReturnType<typeof client.connectAcp> | null>(null);

  useEffect(() => {
    // 세대만 올린다 — 날아오던 옛 응답을 버리기 위해서다. 「어느 세션의 지식인가」는
    // daemonKnowledge 가 값으로 들고 있어 렌더 시점에 대조되므로 여기서 비울 필요가 없다.
    listGenerationRef.current += 1;
    initialSpawnGenerationRef.current += 1;
    initialSpawnPendingRef.current = false;
    initialIssuedRef.current = false;
    if (!sessionId) return undefined;
    const acp = client.connectAcp({ sessionId });
    acpRef.current = acp;
    const unlistenState = acp.onState((state) => {
      if (acpRef.current !== acp || state !== 'OPEN') return;
      setAcpReadyGeneration((generation) => generation + 1);
    });
    if (acp.state === 'OPEN') setAcpReadyGeneration((generation) => generation + 1);
    debugLog('webterm.tabs.acp.attach', { sessionId });
    return () => {
      unlistenState();
      // ⛔ 이 effect 가 «연» 연결이 아니라 지금 «들고 있는» 연결을 닫는다.
      //    reacquireIfDead 가 중간에 교체했을 수 있고, 클로저의 옛 연결만
      //    닫으면 새 연결의 lease 가 영원히 안 풀린다.
      const held = acpRef.current ?? acp;
      try { held.close(); } catch { /* ignore */ }
      acpRef.current = null;
    };
  }, [client, sessionId]);

  // P4 — terminal/list 응답 전체를 보관해 탭별 alive/최근활동 상태 표면.
  /** 데몬 지식을 «어느 세션의 것인지»와 함께 들고 다닌다.
   *
   *  ⛔ 종전엔 지식(Map)과 「성공했나」(boolean)가 따로 있었고, 세션이 바뀌면
   *  useEffect 가 그것을 비웠다. 그런데 effect 는 «렌더 뒤»에 돈다 — 그래서 세션
   *  전환 직후 «한 프레임» 동안 옛 세션의 지식이 그대로 쓰였고, 그 프레임에
   *  「데몬이 모른다」와 정리 버튼이 떴다.
   *  ⇒ 세션을 값에 «묶어» 두면 렌더 시점에 대조되므로 그 창이 원리상 없다.
   *  ⛔ 「지식이 없다」와 「다른 세션의 지식이다」를 같은 값으로 두지 않는 것이 요점이다. */
  const [daemonKnowledge, setDaemonKnowledge] = useState<{
    sessionId: string | null;
    entries: Map<string, DaemonListEntry>;
  }>({ sessionId: null, entries: new Map() });
  const [terminalControls, setTerminalControls] = useState<Map<string, {
    action: TerminalControlAction;
    message?: string;
  }>>(new Map());
  const terminalControlGenerationsRef = useRef(new Map<string, number>());
  // 지금 세션의 지식일 때만 믿는다. 아니면 「아직 못 물어봤다」와 같은 취급.
  const daemonListSucceeded = daemonKnowledge.sessionId !== null
    && daemonKnowledge.sessionId === sessionId;
  const daemonInfo = daemonListSucceeded ? daemonKnowledge.entries : EMPTY_DAEMON_INFO;
  /** 세션 전환·연결 재획득마다 오르는 세대 번호. 요청 시점의 세대와 응답 도착
   *  시점의 세대가 다르면 그 응답은 «옛 세계의 것»이라 버린다. 안 버리면 초기화
   *  직후에 늦게 온 옛 응답이 새 상태를 덮어쓴다. */
  const listGenerationRef = useRef(0);

  /** 죽은 연결을 «보고» 새로 얻는다.
   *
   *  daemon-client 의 머리말은 "Reconnect / backoff is the connection's job,
   *  not the consumer's" 라고 적지만, 실측하면 그 재연결은 «어디에도 없다».
   *  소켓이 1006 으로 닫히면 연결은 FAILED/CLOSED 로 가고 그대로 남는다.
   *  이 컴포넌트의 attach 이펙트는 [client, sessionId] 에만 걸려 있어 다시
   *  돌지 않으므로, 한 번 죽으면 폴 루프가 «죽은 소켓에» 영원히 send 한다.
   *
   *  📏 2026-08-17 실측: 데몬 재시작 3.5초 뒤부터 terminal/list 가 15초마다
   *  실패했고 1시간 37분 동안 재연결 시도가 0회였다.
   *
   *  connectAcp 는 캐시된 연결이 terminal 이면 «새» 연결을 준다(isTerminal
   *  분기). 그래서 소비자가 다시 부르기만 하면 살아난다 — 그 「다시 부르는
   *  자리」가 없었을 뿐이다.
   *
   *  ⚠️ 이것은 «증상»을 멈추는 수리이지 머리말의 계약을 지키는 수리가 아니다.
   *  전송층이 스스로 재연결하게 하는 것은 별도 착지다(공용 전송이라 여기서
   *  바꾸면 채팅·보이스까지 함께 흔든다). */
  const reacquireIfDead = useCallback((): ReturnType<typeof client.connectAcp> | null => {
    const current = acpRef.current;
    if (!sessionId) return null;
    if (!shouldReacquireAcp(current ? current.state : null)) return current;
    // ⛔ 「시도」와 「성공」을 다른 줄로 남긴다. 하나로 합치면 connectAcp 가
    //    던졌을 때도 재획득한 것처럼 «보인다» — 관측이 성공을 참칭한다.
    const previousState = current ? current.state : 'none';
    debugLog('webterm.tabs.acp.reacquire.attempt', { sessionId, previousState });
    try { current?.close(); } catch { /* 이미 닫힌 연결을 닫는 것은 무해하다 */ }
    const next = client.connectAcp({ sessionId });
    acpRef.current = next;
    // ⛔ 연결이 바뀌면 옛 데몬 지식을 «버린다». 데몬이 재시작한 뒤일 수 있고,
    //    그 경우 옛 목록으로 「데몬이 안다/모른다」를 단정하면 정리 판단까지 틀린다.
    //    세대를 올려 «날아오던 옛 응답»도 버린다. 리뷰 must-fix 둘.
    listGenerationRef.current += 1;
    setDaemonKnowledge({ sessionId: null, entries: new Map() });
    debugLog('webterm.tabs.acp.reacquire.ok', { sessionId, previousState, state: next.state });
    return next;
  }, [client, sessionId]);

  const refreshFromDaemon = useCallback(async (): Promise<void> => {
    if (!sessionId) return;
    let acp: ReturnType<typeof client.connectAcp> | null;
    try {
      // ⛔ 재획득도 «같은 오류 경로»로 기록한다. connectAcp 는 동기로 던질 수
      //    있고(baseUrl 미설정 등), 그러면 이 폴이 관측 한 줄 없이 조용히
      //    거부된다 — 이 저장소가 반복해 밟은 「그럴듯한 0」이 된다.
      acp = reacquireIfDead();
    } catch (e) {
      debugLog('webterm.tabs.list.error', {
        sessionId,
        connectionState: 'reacquire-failed',
        reason: String(e),
      });
      return;
    }
    if (!acp) return;
    try {
      const generation = listGenerationRef.current;
      const res = await acp.send('terminal/list', { sessionId });
      if (generation !== listGenerationRef.current) {
        // 이 응답이 날아오는 동안 세션이나 연결이 바뀌었다 — 옛 세계의 답이다.
        debugLog('webterm.tabs.list.stale', { sessionId, generation, now: listGenerationRef.current });
        return;
      }
      const parsed = parseTerminalListResponse(res);
      if (!parsed.ok) {
        // ⛔ 「응답이 없다」를 「터미널이 0개다」로 바꾸지 않는다. 그렇게 하면
        //    모든 탭이 「데몬이 모름」이 되어 정리 대상으로 뜬다 — 조회 실패가
        //    탭 전멸로 이어지는 경로다.
        debugLog('webterm.tabs.list.error', {
          sessionId, connectionState: acp.state, reason: `list-${parsed.reason}`,
        });
        return;
      }
      const entries = parsed.entries as DaemonListEntry[];
      const daemonIds = entries.map((t) => t.terminalId);
      const daemonIdSet = new Set(daemonIds);
      for (const id of hiddenTabIdsRef.current) {
        if (!daemonIdSet.has(id)) hiddenTabIdsRef.current.delete(id);
      }
      saveHiddenTabIds([...hiddenTabIdsRef.current]);
      setDaemonKnowledge({ sessionId, entries: new Map(entries.map((t) => [t.terminalId, t])) });
      debugLog('webterm.tabs.list', {
        sessionId,
        local: tabs.length,
        daemon: daemonIds.length,
      });
      // Union: local-known ids stay (may be queued for spawn); daemon
      // ids that aren't local are appended (e.g. another PWA tab
      // spawned them).
      setTabs((prev) => {
        const merged = [...prev];
        for (const id of daemonIds) {
          if (!hiddenTabIdsRef.current.has(id) && !merged.includes(id)) merged.push(id);
        }
        if (merged.length === prev.length) return prev;
        saveTabIds(merged);
        return merged;
      });
    } catch (e) {
      // ⛔ sessionId 와 연결 상태를 «같이» 싣는다. 이 줄이 reason 하나만 담던
      //    동안, 여러 창이 동시에 폴하는 실물에서 「어느 창이 깨졌나」를
      //    로그로 «가릴 수 없었다» — 569건이 전부 같은 문장이었다.
      //    connectionState 는 「소켓이 죽어서 실패」와 「살아 있는데 호출이
      //    실패」를 가른다. 둘은 다른 결함이고 처방도 다르다.
      debugLog('webterm.tabs.list.error', {
        sessionId,
        connectionState: acp.state,
        reason: String(e),
      });
    }
  }, [reacquireIfDead, sessionId, tabs.length]);

  // One reconcile on first attach + P4 상태 폴링(15s) — 데몬이 list 변화를
  // push 하지 않으므로 alive/최근활동 신선도는 폴링으로. 언마운트 시 해제.
  useEffect(() => {
    if (!acpRef.current) return;
    void refreshFromDaemon();
    const h = setInterval(() => { void refreshFromDaemon(); }, STATUS_POLL_MS);
    return () => clearInterval(h);
    // intentional: only run on attach, not on tab list mutations
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acpRef.current]);

  const persist = useCallback((next: string[]): string[] => {
    saveTabIds(next);
    return next;
  }, []);

  useEffect(() => {
    onTabsChange?.(tabs);
  }, [onTabsChange, tabs]);

  const issueInitialTerminal = useCallback(async (acp: SpawnAcp): Promise<void> => {
    if (initialSpawnPendingRef.current || tabsRef.current.length > 0) return;
    initialSpawnPendingRef.current = true;
    const generation = ++initialSpawnGenerationRef.current;
    onInitialTerminalState?.({ status: 'pending' });
    const response = await spawnNewTerminal(acp, sessionId);
    if (generation !== initialSpawnGenerationRef.current || tabsRef.current.length > 0) return;
    const resolved = resolveNewTabId(response, tabsRef.current);
    const next = [resolved.id];
    // ⛔ 표시를 «먼저» 세운다 — setTabs/onActiveChange 가 동기 재렌더를 일으키면 아래 effect 가
    //    이 줄보다 «먼저» 돌아 방금 발급한 탭을 `restored-tab` 으로 라벨한다(실측으로 갈렸다).
    initialIssuedRef.current = true;
    persist(next);
    setTabs(next);
    onActiveChange(resolved.id);
    onInitialTerminalState?.({
      status: 'ready',
      issuedBy: resolved.issuedBy,
      ...(resolved.fallbackReason ? { fallbackReason: resolved.fallbackReason } : {}),
    });
    debugLog('webterm.tabs.initial', {
      id: resolved.id,
      issuedBy: resolved.issuedBy,
      ...(resolved.fallbackReason ? { fallbackReason: resolved.fallbackReason } : {}),
    });
  }, [onActiveChange, onInitialTerminalState, persist, sessionId]);

  useEffect(() => {
    if (suspendInitialSpawn) return;
    if (tabs.length > 0) {
      const issuedThisMount = initialIssuedRef.current;
      initialSpawnPendingRef.current = false;
      if (!activeId) onActiveChange(tabs[0]);
      // ⛔ 「저장된 탭을 복원했다」는 «저장소에서 온» 탭에만 참이다. 방금 발급한 탭에 이 라벨을
      //    붙이면 daemon 출처와 실패 사유가 덮이고 실패 배너가 화면에서 사라진다.
      if (!issuedThisMount) {
        onInitialTerminalState?.({ status: 'ready', issuedBy: 'local', fallbackReason: 'restored-tab' });
      }
      return;
    }
    const acp = acpRef.current;
    if (!acp || acp.state !== 'OPEN') {
      onInitialTerminalState?.({ status: 'pending' });
      return;
    }
    void issueInitialTerminal(acp);
    return () => { initialSpawnGenerationRef.current += 1; };
  }, [acpReadyGeneration, activeId, issueInitialTerminal, onActiveChange, onInitialTerminalState, suspendInitialSpawn, tabs.length]);

  /** WT-B4 — 새 탭의 이름을 «데몬이» 짓는다.
   *
   *  `terminalId` 를 비워 spawn 하면 데몬이 발급해 응답에 싣는다. 그 id 로
   *  탭을 만들면 로컬 목록과 데몬 목록이 «구성상» 어긋날 수 없다.
   *
   *  `preview-1` 은 TUI 프리뷰 페인이 등록하는 약속된 이름이다. 웹의 초기
   *  탭은 이 경로와 같은 데몬 발급을 우선하고, `nextDefaultId` 는 응답 없는
   *  경우에만 로컬 폴백으로 남는다.
   *
   *  ⚠️ 여기서 spawn 한 PTY 는 데몬 기본 크기로 뜬다. XtermView 가 붙으면
   *  같은 (sessionId, terminalId) 로 다시 spawn 하는데 그 경로는 멱등이라
   *  기존 PTY 에 attach 하고, fit() 이 격자를 바꾸면 `terminal/resize` 가
   *  뒤따르므로 크기는 그때 맞춰진다. */
  const onAdd = useCallback(async (): Promise<void> => {
    const response = await spawnNewTerminal(acpRef.current, sessionId);
    setTabs((prev) => {
      const { id, issuedBy, fallbackReason } = resolveNewTabId(response, prev);
      if (hiddenTabIdsRef.current.delete(id)) saveHiddenTabIds([...hiddenTabIdsRef.current]);
      // 데몬이 «이미 아는» id 를 냈다면 목록에 두 번 넣지 않는다.
      if (prev.includes(id)) {
        onActiveChange(id);
        debugLog('webterm.tabs.add.existing', { id, issuedBy, total: prev.length });
        return prev;
      }
      const next = persist([...prev, id]);
      onActiveChange(id);
      debugLog('webterm.tabs.add', {
        id,
        total: next.length,
        issuedBy,
        ...(fallbackReason ? { fallbackReason } : {}),
      });
      return next;
    });
  }, [onActiveChange, persist, sessionId]);

  const onSwitch = useCallback((id: string): void => {
    if (id === activeId) return;
    debugLog('webterm.tabs.switch', { from: activeId, to: id });
    onActiveChange(id);
  }, [activeId, onActiveChange]);

  const removeLocalTab = useCallback((id: string, hideFromDaemon = false): void => {
    terminalControlGenerationsRef.current.set(
      id,
      (terminalControlGenerationsRef.current.get(id) ?? 0) + 1,
    );
    setTerminalControls((current) => {
      if (!current.has(id)) return current;
      const next = new Map(current);
      next.delete(id);
      return next;
    });
    const currentTabs = tabsRef.current;
    if (hideFromDaemon) {
      hiddenTabIdsRef.current.add(id);
      saveHiddenTabIds([...hiddenTabIdsRef.current]);
    }
    if (!currentTabs.includes(id)) return;
    const next = currentTabs.filter((tabId) => tabId !== id);
    persist(next);
    setTabs(next);
    if (id === activeIdRef.current && next.length > 0) onActiveChange(next[0]);
    if (next.length === 0) {
      initialSpawnPendingRef.current = false;
      onInitialTerminalState?.({ status: 'pending' });
    }
  }, [onActiveChange, onInitialTerminalState, persist]);

  const onClose = useCallback((id: string): void => {
    const intent = tabCloseAction('remove-local');
    if (!intent.sendsDestroy) {
      removeLocalTab(id, true);
      debugLog('webterm.tabs.remove-local', { id });
      void refreshFromDaemon();
    }
  }, [refreshFromDaemon, removeLocalTab]);

  const onControlTerminal = useCallback(async (id: string, action: TerminalControlAction): Promise<void> => {
    const current = terminalControls.get(id);
    if (current && !current.message) return;
    const generation = (terminalControlGenerationsRef.current.get(id) ?? 0) + 1;
    terminalControlGenerationsRef.current.set(id, generation);
    setTerminalControls((controls) => {
      const next = new Map(controls);
      next.set(id, { action });
      return next;
    });
    try {
      const result = await client.controlTerminal(id, action);
      if (generation !== terminalControlGenerationsRef.current.get(id) || !tabsRef.current.includes(id)) return;
      const message = terminalControlMessage(action, result);
      setTerminalControls((controls) => {
        const next = new Map(controls);
        next.set(id, { action, message });
        return next;
      });
      debugLog('webterm.tabs.control', { id, action, status: result.status });
      if (result.status === 'success') void refreshFromDaemon();
    } catch (error) {
      if (generation !== terminalControlGenerationsRef.current.get(id) || !tabsRef.current.includes(id)) return;
      setTerminalControls((controls) => {
        const next = new Map(controls);
        next.set(id, { action, message: 'PTY 제어 요청을 전송하지 못했습니다. 네트워크 연결을 확인해 주세요.' });
        return next;
      });
      debugLog('webterm.tabs.control.error', { id, action, reason: String(error) });
    }
  }, [client, refreshFromDaemon, terminalControls]);

  const onTerminate = useCallback(async (id: string, ownerRunUsage: unknown): Promise<void> => {
    const intent = tabCloseAction('terminate');
    const confirmation = terminateConfirmation(ownerRunUsage);
    if (typeof window !== 'undefined' && !window.confirm(`${confirmation.title}\n\n${confirmation.message}`)) return;
    if (!intent.sendsDestroy) return;
    const acp = acpRef.current;
    if (!acp || !sessionId) {
      debugLog('webterm.tabs.destroy.error', { id, reason: 'no-acp-or-session' });
      return;
    }
    try {
      await acp.send('terminal/destroy', { sessionId, terminalId: id });
      debugLog('webterm.tabs.destroyed', { id });
      removeLocalTab(id, true);
      void refreshFromDaemon();
    } catch (e) {
      debugLog('webterm.tabs.destroy.error', { id, reason: String(e) });
    }
  }, [removeLocalTab, refreshFromDaemon, sessionId]);

  // If the active id isn't in the tab list (e.g. localStorage had
  // different ids than the prop default), promote it so the user sees
  // the running terminal in the strip.
  useEffect(() => {
    if (!activeId || hiddenTabIdsRef.current.has(activeId)) return;
    setTabs((prev) => (prev.includes(activeId) ? prev : persist([...prev, activeId])));
  }, [activeId, persist]);

  // Track 2 — apply :tab intent fired by sticky REPL. Effect deps on
  // nonce so re-issuing the same intent re-fires.
  useEffect(() => {
    if (!tabIntent) return;
    if (!activeId || tabs.length === 0) return;
    const i = tabs.indexOf(activeId);
    let next: string | undefined;
    if (tabIntent.intent === 'next') {
      next = tabs[(i + 1) % tabs.length];
    } else if (tabIntent.intent === 'prev') {
      next = tabs[(i - 1 + tabs.length) % tabs.length];
    } else if (typeof tabIntent.intent === 'number') {
      const target = tabIntent.intent - 1; // 1-indexed → 0-indexed
      if (target >= 0 && target < tabs.length) next = tabs[target];
    }
    if (next && next !== activeId) {
      debugLog('webterm.tabs.intent.apply', { intent: tabIntent.intent, from: activeId, to: next });
      onActiveChange(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tabs/activeId snapshot at intent time, nonce is the trigger
  }, [tabIntent?.nonce]);

  const isAliveOf = useCallback(
    (id: string): boolean | undefined => daemonInfo.get(id)?.isAlive,
    [daemonInfo],
  );

  const status = useMemo(() => {
    if (!sessionId) return 'session 미설정';
    return tabCountLabel(summarizeTabs(tabs, isAliveOf), daemonListSucceeded);
  }, [sessionId, tabs, isAliveOf, daemonListSucceeded]);

  const cleanable = useMemo(
    () => (daemonListSucceeded && activeId ? tabsCleanableAsUnknown(tabs, isAliveOf, activeId) : []),
    [daemonListSucceeded, tabs, isAliveOf, activeId],
  );

  /** 데몬이 모르는 탭을 «사람이 눌렀을 때만» 목록에서 뺀다.
   *  ⛔ terminal/destroy 를 부르지 않는다 — 데몬이 모르는 것을 지우라고 보낼 대상이 없다. */
  const onCleanUnknown = useCallback((): void => {
    if (cleanable.length === 0) return;
    // ⛔ updater 는 «순수»하게 둔다. React 가 재실행할 수 있어 그 안에서
    //    저장·로깅을 하면 부작용이 두 번 난다. 리뷰 should-fix.
    const drop = new Set(cleanable);
    const next = tabs.filter((id) => !drop.has(id));
    persist(next);
    debugLog('webterm.tabs.clean-unknown', { removed: cleanable.length, remaining: next.length });
    setTabs(next);
  }, [cleanable, persist, tabs]);

  return (
    <div className="flex items-center gap-1 border-b bg-background/50 px-2 py-1 text-xs">
      <div className="flex flex-1 flex-wrap items-center gap-1">
        {tabs.map((id) => {
          const active = id === activeId;
          // P4 — 데몬 레지스트리 상태: alive(초록) / 데몬에 있으나 죽음(빨강)
          // / 데몬에 없음(회색 — 미기동 또는 exit 후 정리됨).
          const info = daemonInfo.get(id);
          const dotClass = info
            ? info.isAlive ? 'bg-emerald-500' : 'bg-rose-500'
            : 'bg-muted-foreground/40';
          const activityLabel = lastActivityLabel(info?.lastOutputAt);
          const originChip = originChipText(info);
          const originTooltip = originTooltipText(info);
          // ⭐ 칩이 «이게 무엇인지» 말한다 (대표 2026-08-17). 원시 id 는 툴팁에 남는다.
          //   ⛔ preview-1 은 TUI 프리뷰 페인의 «약속된 이름»이라 개명하지 않는다 —
          //     src/dashboard/index.ts:7991 이 그 이름으로 못 박는다.
          const chip = terminalChipLabel(id);
          const terminalControl = terminalControls.get(id);
          const statusTitle = info
            // ⛔ pid 가 없는 판의 데몬도 있다 — 없으면 「pid 없음」이 아니라 그 칸을 «안 쓴다».
            ? `${info.isAlive ? 'alive' : 'exited'}${typeof info.pid === 'number' ? ` · pid ${info.pid}` : ''}${activityLabel ? ` · 마지막 출력 ${activityLabel}` : ''} · ${originTooltip}${info.controller ? ` · 통제: ${info.controller}` : ''}`
            : `데몬 미기동 (선택 시 spawn) · ${originTooltip}`;
          return (
            <span
              key={id}
              className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono ${
                active
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:bg-accent'
              }`}
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`}
                title={statusTitle}
                aria-label={statusTitle}
              />
              <button
                type="button"
                className="cursor-pointer"
                onClick={() => onSwitch(id)}
                title={`${chip.hint} — ${active ? '지금 보는 터미널' : '눌러서 전환'} · ${statusTitle}`}
                aria-label={`switch to ${id}`}
              >
                {chip.text}{originChip ? ` · ${originChip}` : ''}{info?.controller ? ` · 통제: ${info.controller}` : ''}
              </button>
              <button
                type="button"
                className="ml-0.5 rounded text-muted-foreground hover:text-rose-500"
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(id);
                }}
                title={`목록에서 ${id} 탭 빼기 — PTY는 유지합니다`}
                aria-label={`remove ${id} locally`}
              >
                ×
              </button>
              {terminalControlAction(info) && (
                <button
                  type="button"
                  disabled={terminalControl !== undefined && !terminalControl.message}
                  className="rounded text-muted-foreground hover:text-primary disabled:cursor-wait disabled:opacity-60"
                  onClick={(event) => {
                    event.stopPropagation();
                    void onControlTerminal(id, terminalControlAction(info)!);
                  }}
                  title={`${terminalControlLabel(terminalControlAction(info)!)} ${id}`}
                  aria-label={`${terminalControlAction(info)} ${id}`}
                >
                  {terminalControl !== undefined && !terminalControl.message
                    ? '전환 중…'
                    : terminalControlLabel(terminalControlAction(info)!)}
                </button>
              )}
              <button
                type="button"
                className="rounded text-muted-foreground hover:text-rose-500"
                onClick={(event) => {
                  event.stopPropagation();
                  void onTerminate(id, info?.ownerRunUsage);
                }}
                title={`끝내기 ${id}`}
                aria-label={`terminate ${id}`}
              >
                끝내기
              </button>
            </span>
          );
        })}
        <button
          type="button"
          className="rounded-md border border-dashed border-border px-2 py-0.5 text-muted-foreground hover:bg-accent"
          onClick={() => { void onAdd(); }}
          title="new terminal"
        >
          +
        </button>
      </div>
      {[...terminalControls.values()].filter((control) => control.message).map((control, index) => (
        <p key={`${control.action}-${index}`} role="status" className="text-muted-foreground">
          {control.message}
        </p>
      ))}
      {/* Compact status pills surface essential signals when the parent
          panels are hidden (minimized). Stay subtle when expanded so
          they don't compete with the dedicated panels. */}
      {minimized && recording && (
        <span
          className="ml-2 flex items-center gap-1 rounded bg-rose-500/15 px-1.5 py-0.5 font-medium text-rose-600 dark:text-rose-400"
          title="recording in progress"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-rose-500 animate-pulse" aria-hidden />
          REC
        </span>
      )}
      {minimized && peerCount > 1 && (
        <span
          className="ml-1 flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-700 dark:text-amber-400"
          title={`${peerCount} devices on this session`}
        >
          <Users className="h-3 w-3" aria-hidden />
          {peerCount}
        </span>
      )}
      {/* P4 — 혼동 방지 라벨: PTY 는 데몬에 상주. 챗 세션 전환/브라우저
          이탈과 무관하게 유지되고, 재접속 시 재attach + 화면 replay 된다. */}
      <span
        className="ml-2 text-[11px] text-muted-foreground"
        title="터미널 PTY 는 데몬에 상주 — 연결이 끊겨도 유지되고 재접속 시 이어집니다"
      >
        {status}
      </span>
      {cleanable.length > 0 && (
        <button
          type="button"
          className="ml-1 rounded-md border border-dashed border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
          onClick={onCleanUnknown}
          title={`데몬이 모르는 탭 ${cleanable.length}개를 목록에서 뺍니다 — PTY 는 건드리지 않고, 활성 탭은 남깁니다`}
        >
          정리 {cleanable.length}
        </button>
      )}
      {onToggleChatDock && (
        <button
          type="button"
          onClick={onToggleChatDock}
          aria-label={chatDockOpen ? 'hide terminal chat dock' : 'show terminal chat dock'}
          title={chatDockOpen ? 'terminal chat dock 숨기기' : 'terminal chat dock 보이기'}
          className={`ml-1 rounded-md p-1 ${
            chatDockOpen
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
          }`}
        >
          <MessagesSquare className="h-3.5 w-3.5" />
        </button>
      )}
      {onToggleMinimize && (
        <button
          type="button"
          onClick={onToggleMinimize}
          aria-label={minimized ? 'expand panels' : 'collapse panels'}
          title={minimized ? '패널 펼치기' : '패널 접기'}
          className="ml-1 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {minimized ? <Maximize2 className="h-3.5 w-3.5" /> : <Minimize2 className="h-3.5 w-3.5" />}
        </button>
      )}
    </div>
  );
}
