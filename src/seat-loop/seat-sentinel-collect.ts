// SEAT-IDLE-STALL-SENTINEL 수집기 — 1급 출처만 읽는다(읽기 전용 · 키 입력 0 · 깨움 0):
//   명부     = seat-state/seat-registry.json (readSeatRegistry — msg-wake 와 같은 주소 원장) ∪ 미읽음 우편이 있는 주소
//   상태     = herdr `pane list`(agent_status) ⊕ `pane read`(화면 지문) — 원격은 msg-wake 의 remoteHerdrRunner(SSH) 그대로
//   tmux     = `tmux display-message`·`capture-pane`(명시한 세션만)
//   우편     = msg 원장 읽기 전용(openMsgStoreReadOnly · 커서 뒤 미ack)
//   할 일    = release checklist 의 자기 소유 yellow·red 칸
// 읽지 못한 출처는 «0» 이 아니라 Known{known:false, reason} 으로 남긴다. ⛔ logs.db 를 직접 열지 않는다.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { defaultHerdrCliRunner, type HerdrCliRunner } from '../pty-shell/herdr-prompt.js';
import { remoteHerdrRunner, resolveSeatStateRoot } from '../loops/msg-wake.js';
import { readSeatRegistry, seatRegistryPath, type SeatRegistryEntry, type SeatRegistryRead } from '../loops/seat-registry.js';
import { defaultMsgStorePath, openMsgStoreReadOnly } from '../msg/msg-store.js';
import { checklistDevVersion, listChecklist, ownerMatches } from '../release-loop/checklist.js';
import type { Known, SeatActivitySample, SeatPaneStatus, SeatRoute, SeatUnackedMail } from './seat-sentinel.js';

/** What one tick sees of one seat, before it is joined with the sample history. */
export interface SeatObservation {
  readonly seat: string;
  readonly host: string;
  readonly route: SeatRoute;
  readonly target?: string;
  readonly optIn: boolean;
  readonly statusSource: string;
  readonly sample: SeatActivitySample;
  readonly lastOutputAt?: number;
  readonly openWork: Known<readonly string[]>;
  readonly mail: Known<readonly SeatUnackedMail[]>;
}

export type TmuxRun = (argv: readonly string[]) => { status: number | null; stdout: string };

export interface SeatSentinelCollectDeps {
  readonly readRegistry?: () => SeatRegistryRead;
  /** herdr runner per registry host: `local` → this machine, any other host → SSH (msg-wake 와 같은 규칙). */
  readonly herdrRunFor?: (host: string) => HerdrCliRunner;
  /** Seats that live in a plain tmux session (seat → session). Default none: the registry has no tmux route yet. */
  readonly tmuxSessions?: Readonly<Record<string, string>>;
  readonly tmuxRun?: TmuxRun;
  /** Unacked mail addressed to a seat; null = ledger absent («모름»). */
  readonly unackedMail?: (seat: string) => SeatUnackedMail[] | null;
  /** Addresses with unread mail — mail-only seats (e.g. RES) join the roster through this. */
  readonly unreadAddresses?: () => string[] | null;
  /** Open work ids the seat owns; null = unknown. */
  readonly openWork?: (seat: string) => string[] | null;
  readonly timeoutMs?: number;
}

// 출처: msg-wake WAKE_TIMEOUT_MS(3초)는 주입 마감 — 관측은 SSH 왕복이 끼므로 remoteHerdrRunner ConnectTimeout(3초) ⊕ 여유.
export const SEAT_SENTINEL_OBSERVE_TIMEOUT_MS = 8_000;
// 출처: RES tools/seat-main-liveness.py tmux_idle_since(마지막 18줄) · pane_status(60줄) — 지문은 화면 꼬리만.
const SCREEN_LINES = 60;
// 출처: msg-store listByRecipient 상한(1000) 안 — 한 자리 미ack 우편이 이보다 많으면 이미 수신 누락이다.
const MAIL_SCAN_LIMIT = 200;
// 출처: RES tools/seat-main-liveness.py tmux 호출 timeout=5.
const TMUX_TIMEOUT_MS = 5_000;

// Same markers RES seat-main-liveness.py and OP idle-nudge.sh read (codex · claude · eln TUI).
const ACTIVE_MARKERS = /Working \(|esc to interrupt|ctrl.c to interrupt|Streaming|Compacting context|Making room|Messages to be submitted|Queued follow-up/i;
const EMPTY_PROMPT = /Ask Codex to do anything|^❯\s*$/m;
const COMPLETION = /(?:Worked for [^\n]*?)?[•·]\s*(?:done\s*)?(\d{1,2}):(\d{2})\s*(AM|PM)/g;

/**
 * Screen fingerprint for «did anything change»: drop spinner/status lines and elapsed-time counters,
 * which tick every second while a turn is genuinely stuck, then hash what is left.
 */
export function screenFingerprint(screen: string): string {
  const kept = screen.split('\n')
    .filter((line) => !ACTIVE_MARKERS.test(line) && !/^\s*[⠁-⣿✻✽✢]\s/.test(line))
    .map((line) => line.replace(/\b\d+h\s*\d+m\b|\b\d+m\s*\d+s\b|\b\d+(?:\.\d+)?s\b/g, '').trimEnd())
    .join('\n').trim();
  return createHash('sha256').update(kept).digest('hex').slice(0, 16);
}

/** Status from what the screen shows, for panes whose agent_status is unknown (remote herdr panes are). */
export function screenStatus(screen: string): SeatPaneStatus {
  const tail = screen.split('\n').slice(-18).join('\n');
  if (ACTIVE_MARKERS.test(tail)) return 'running';
  if (EMPTY_PROMPT.test(tail)) return 'idle';
  return 'unknown';
}

/** The last «• HH:MM AM» completion marker on screen as epoch ms (rolled back a day when it would be in the future). */
export function lastCompletionAt(screen: string, now: Date): number | undefined {
  const matches = [...screen.matchAll(COMPLETION)];
  const last = matches.at(-1);
  if (!last) return undefined;
  const hour = Number(last[1]) % 12 + (last[3] === 'PM' ? 12 : 0);
  const at = new Date(now);
  at.setHours(hour, Number(last[2]), 0, 0);
  if (at.getTime() > now.getTime()) at.setDate(at.getDate() - 1);
  return at.getTime();
}

export function herdrStatus(agentStatus: string | undefined): SeatPaneStatus {
  switch (agentStatus?.trim().toLowerCase()) {
    case 'working': return 'running';
    case 'idle': case 'done': return 'idle';
    case 'blocked': return 'blocked';
    case 'dead': case 'exited': case 'closed': case 'stopped': case 'missing': return 'dead';
    default: return 'unknown';
  }
}

type PaneRow = { paneId: string; status?: string };

function parsePaneList(stdout: string): PaneRow[] | null {
  try {
    const panes = (JSON.parse(stdout) as { result?: { panes?: unknown } }).result?.panes;
    if (!Array.isArray(panes)) return null;
    return panes.flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const row = value as Record<string, unknown>;
      const paneId = row.pane_id ?? row.paneId;
      const status = row.agent_status ?? row.pane_status ?? row.status;
      return typeof paneId === 'string' ? [{ paneId, ...(typeof status === 'string' ? { status } : {}) }] : [];
    });
  } catch { return null; }
}

const defaultHerdrRunFor = (host: string): HerdrCliRunner => host === 'local' ? defaultHerdrCliRunner() : remoteHerdrRunner(host);

const defaultTmuxRun: TmuxRun = (argv) => {
  const result = spawnSync('tmux', [...argv], { encoding: 'utf8', timeout: TMUX_TIMEOUT_MS, windowsHide: true });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? '' };
};

function defaultUnackedMail(seat: string): SeatUnackedMail[] | null {
  const path = defaultMsgStorePath();
  if (!existsSync(path)) return null;
  const store = openMsgStoreReadOnly(path);
  try {
    return store.listByRecipient(seat, store.getCursor(seat), MAIL_SCAN_LIMIT)
      .filter((message) => message.to === seat)
      .map((message) => ({ id: message.id, from: message.from, createdAt: Date.parse(message.createdAt) }))
      .filter((message) => Number.isFinite(message.createdAt));
  } finally { store.close(); }
}

function defaultUnreadAddresses(): string[] | null {
  const path = defaultMsgStorePath();
  if (!existsSync(path)) return null;
  const store = openMsgStoreReadOnly(path);
  try { return store.unreadRecipients().filter((row) => row.count > 0).map((row) => row.recipient); }
  finally { store.close(); }
}

/** Open-work reader over one checklist read per tick (not one per seat). */
function defaultOpenWork(): (seat: string) => string[] | null {
  let items: ReturnType<typeof listChecklist>['items'] | null | undefined;
  return (seat) => {
    if (items === undefined) { try { items = listChecklist(checklistDevVersion()).items; } catch { items = null; } }
    return items === null ? null : items
      .filter((item) => (item.status === 'yellow' || item.status === 'red') && ownerMatches(item.owner, seat))
      .map((item) => item.id);
  };
}

function known<T>(read: () => T | null, reason: string): Known<T> {
  try {
    const value = read();
    return value === null ? { known: false, reason } : { known: true, value };
  } catch (error) {
    return { known: false, reason: `${reason}:${error instanceof Error ? error.name : 'error'}` };
  }
}

const SEAT_ADDRESS = /^[A-Z][A-Z0-9_-]{0,63}$/;

/** Observe every seat once. Read-only: herdr `pane list`/`pane read`, tmux capture, msg ledger and checklist reads. */
export async function collectSeatObservations(now: Date, deps: SeatSentinelCollectDeps = {}): Promise<SeatObservation[]> {
  const timeoutMs = deps.timeoutMs ?? SEAT_SENTINEL_OBSERVE_TIMEOUT_MS;
  const registry = (deps.readRegistry ?? (() => readSeatRegistry(seatRegistryPath(resolveSeatStateRoot()))))();
  const entries: SeatRegistryEntry[] = registry.status === 'ready' ? [...registry.registry.seats] : [];
  const tmuxSessions = deps.tmuxSessions ?? {};
  const roster = new Map<string, { host: string; route: SeatRoute; target?: string; optIn: boolean }>();
  for (const entry of entries)
    // A registered pane is observed even when its wake is off (OP); actuation still needs wake=herdr ⊕ optIn.
    roster.set(entry.address, { host: entry.host, route: entry.target ? 'herdr' : 'none',
      ...(entry.target ? { target: entry.target } : {}), optIn: entry.wake === 'herdr' && entry.optIn });
  for (const [seat, session] of Object.entries(tmuxSessions))
    if (!roster.has(seat) || roster.get(seat)!.route === 'none') roster.set(seat, { host: 'local', route: 'tmux', target: session, optIn: false });
  const openWork = deps.openWork ?? defaultOpenWork();
  const unread = known(deps.unreadAddresses ?? defaultUnreadAddresses, 'msg-ledger-absent');
  if (unread.known)
    for (const address of unread.value)
      if (SEAT_ADDRESS.test(address) && !roster.has(address)) roster.set(address, { host: 'unknown', route: 'none', optIn: false });

  // One `pane list` per herdr host (local or SSH), then one `pane read` per seat on that host.
  const herdrRunFor = deps.herdrRunFor ?? defaultHerdrRunFor;
  const hosts = [...new Set([...roster.values()].filter((row) => row.route === 'herdr').map((row) => row.host))];
  const censuses = new Map<string, { run: HerdrCliRunner; panes: PaneRow[] | null; reason?: string }>();
  await Promise.all(hosts.map(async (host) => {
    let run: HerdrCliRunner;
    try { run = herdrRunFor(host); } catch { censuses.set(host, { run: async () => ({ code: null, stdout: '', stderr: '' }), panes: null, reason: 'host-not-allowlisted' }); return; }
    // Same version dance as msg-wake herdrPaneCensus: `--json` first, plain `pane list` only when herdr 0.9.1 rejects the flag.
    let listed = await run(['pane', 'list', '--json'], timeoutMs);
    if (listed.code === 2 && /unknown option[^\n]*--json/i.test(listed.stderr)) listed = await run(['pane', 'list'], timeoutMs);
    const panes = listed.code === 0 ? parsePaneList(listed.stdout) : null;
    censuses.set(host, { run, panes, ...(panes ? {} : { reason: listed.code === 0 ? 'pane-list-unparsed' : 'pane-list-unavailable' }) });
  }));

  const observations = await Promise.all([...roster.entries()].map(async ([seat, row]): Promise<SeatObservation> => {
    let status: SeatPaneStatus = 'unknown';
    let statusSource = 'none';
    let fingerprint: string | undefined;
    let lastOutputAt: number | undefined;
    if (row.route === 'herdr' && row.target) {
      const census = censuses.get(row.host);
      const pane = census?.panes?.find((candidate) => candidate.paneId === row.target);
      if (!census?.panes) statusSource = `herdr:${census?.reason ?? 'pane-list-unavailable'}`;
      else if (!pane) statusSource = 'herdr:pane-not-in-census';
      else {
        status = herdrStatus(pane.status);
        statusSource = `herdr:${pane.status ?? 'none'}`;
        const read = await census.run(['pane', 'read', row.target, '--lines', String(SCREEN_LINES)], timeoutMs);
        if (read.code === 0) {
          fingerprint = screenFingerprint(read.stdout);
          lastOutputAt = lastCompletionAt(read.stdout, now);
          if (status === 'unknown') { status = screenStatus(read.stdout); statusSource = `herdr-screen:${status}`; }
        }
      }
    } else if (row.route === 'tmux' && row.target) {
      const tmuxRun = deps.tmuxRun ?? defaultTmuxRun;
      const pane = tmuxRun(['display-message', '-p', '-t', row.target, '#{pane_dead}']);
      if (pane.status !== 0) statusSource = 'tmux:session-unavailable';
      else if (pane.stdout.trim() === '1') { status = 'dead'; statusSource = 'tmux:pane-dead'; }
      else {
        const screen = tmuxRun(['capture-pane', '-p', '-t', row.target, '-S', `-${SCREEN_LINES}`]);
        if (screen.status === 0) {
          status = screenStatus(screen.stdout);
          statusSource = `tmux-screen:${status}`;
          fingerprint = screenFingerprint(screen.stdout);
          lastOutputAt = lastCompletionAt(screen.stdout, now);
        } else statusSource = 'tmux:capture-unavailable';
      }
    } else statusSource = 'no-route';
    return {
      seat, host: row.host, route: row.route, ...(row.target ? { target: row.target } : {}), optIn: row.optIn, statusSource,
      sample: { at: now.getTime(), status, ...(fingerprint ? { fingerprint } : {}) },
      ...(lastOutputAt !== undefined ? { lastOutputAt } : {}),
      openWork: known(() => openWork(seat), 'checklist-unavailable'),
      mail: known(() => (deps.unackedMail ?? defaultUnackedMail)(seat), 'msg-ledger-absent'),
    };
  }));
  return observations.sort((a, b) => a.seat.localeCompare(b.seat));
}
