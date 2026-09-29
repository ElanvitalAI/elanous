import type { DaemonLogEntry, DaemonTerminalLineageResponse, DaemonTerminalsScope, DaemonTerminalSummary } from '@/lib/daemon-client';
import { canonicalPtyItems, terminalListRequest } from '@/components/observatory/subject-list';

/** Returns the canonical PTY rows; display, selection, lineage, and progress remain terminal-only.
 *
 *  ⛔ Deduplicated by ROW key, NOT by id — and therefore not through
 *  `canonicalPtyItems`, whose dedupe is id-only. This list spans manifest roots and
 *  an id is unique only within one, so an id-keyed dedupe drops a real terminal that
 *  merely shares an id with one already seen — silently, on the very screen that
 *  exists to show other universes.
 *  ⚠️ `canonicalPtyItems` keeps that id-only rule for its own single-root caller;
 *  the mismatch is recorded in 내부 문서 `ISSUES` JDG-T41. */
function sortableStartedAt(startedAt: number | null | undefined): number | null {
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return null;
  return Number.isNaN(new Date(startedAt).getTime()) ? null : startedAt;
}

function comparePtyIdentifier(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function ptyTerminalRows(
  terminals: readonly DaemonTerminalSummary[],
): DaemonTerminalSummary[] {
  const seen = new Set<string>();
  const rows: DaemonTerminalSummary[] = [];
  for (const terminal of terminals) {
    const key = ptyRowKey(terminal);
    if (terminal.hasPty === false || seen.has(key)) continue;
    seen.add(key);
    rows.push(terminal);
  }
  return rows.sort((left, right) => {
    const leftStartedAt = sortableStartedAt(left.startedAt);
    const rightStartedAt = sortableStartedAt(right.startedAt);
    if (leftStartedAt !== null && rightStartedAt !== null && leftStartedAt !== rightStartedAt) {
      return rightStartedAt - leftStartedAt;
    }
    if (leftStartedAt !== null && rightStartedAt === null) return -1;
    if (leftStartedAt === null && rightStartedAt !== null) return 1;
    const idOrder = comparePtyIdentifier(left.id, right.id);
    return idOrder !== 0 ? idOrder : comparePtyIdentifier(ptyRowKey(left), ptyRowKey(right));
  });
}

export type PtyScrollbackState =
  | { status: 'unrequested' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; scrollback: string };

export type PtyTerminalViewMode = 'raw' | 'render';

export type PtyFrameState =
  | { status: 'unrequested' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; frame: string; frameAt: number; frameSource: string };

export interface PtyTerminalDisplayModel {
  kind: 'loading' | 'error' | 'empty' | 'content';
  text: string;
  frameInfo: string | null;
  frameMetadata: { frameAt: number; frameSource: string } | null;
}

export interface PtyTerminalViewModel {
  visible: boolean;
  modes: readonly { mode: PtyTerminalViewMode; label: string; selected: boolean }[];
  display: PtyTerminalDisplayModel;
}

export interface PtyTerminalListRowModel {
  terminal: DaemonTerminalSummary;
  selected: boolean;
  scrollback: PtyTerminalDisplayModel | null;
  view: PtyTerminalViewModel | null;
}

export interface PtyTerminalListModel {
  includeAll: boolean;
  scopeSummary: string | null;
  rows: PtyTerminalListRowModel[];
}

export type PtyLineageState =
  | { status: 'unrequested' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; lineage: DaemonTerminalLineageResponse };

export interface PtyTerminalLineageModel {
  kind: 'loading' | 'error' | 'empty' | 'content';
  unreadablePayloadsSummary: string | null;
  groups: Array<{
    joinedBy: string;
    key: string;
    rows: Array<{
      ptyId: string;
      kind: string;
      instance: string;
      alive: boolean;
      startedAt: number;
      closed: boolean;
      selected: boolean;
    }>;
  }>;
}

/** Keeps the shared request contract in the pure terminal model alongside the displayed scope. */
export function ptyTerminalListRequest(includeAll: boolean): { all?: true; includeTest?: true } {
  return terminalListRequest(includeAll);
}

function hiddenDeadSummary(scope: DaemonTerminalsScope | undefined): string | null {
  if (typeof scope?.hiddenDead !== 'number') return null;
  return scope.hiddenDead === 0
    ? '숨긴 종료 PTY가 0개입니다.'
    : `숨긴 종료 PTY가 ${scope.hiddenDead}개입니다.`;
}

function terminatedLiveOwnerSummary(rows: readonly PtyTerminalListRowModel[]): string {
  const count = rows.filter(({ terminal }) => terminal.ownerRunUsage === 'terminated-live-owner').length;
  return `소유 런이 끝났는데 터미널이 남아 있는 행이 ${count}개입니다.`;
}

/** Formats a daemon epoch-millisecond start time for people without exposing the raw value. */
export function ptyTerminalStartedAtLabel(startedAt: number | null | undefined): string {
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || Number.isNaN(new Date(startedAt).getTime())) {
    return '시작 시각 알 수 없음';
  }
  return new Date(startedAt).toLocaleString();
}

/** Names the independent process and output-stream states together without hiding either one. */
export function ptyTerminalProcessOutputStatusLabel(alive: boolean, closed: boolean): string {
  if (alive && !closed) return '프로세스 실행 중 · 출력 스트림 열림';
  if (alive && closed) return '프로세스 실행 중 · 출력 스트림 닫힘';
  if (!alive && !closed) return '프로세스 종료 · 출력 스트림 열림';
  return '프로세스 종료 · 출력 스트림 닫힘';
}

/** Converts daemon lineage into display-only data; it deliberately exposes unknown join values. */
export function ptyTerminalLineageModel(
  selectedId: string | null,
  state: PtyLineageState,
): PtyTerminalLineageModel | null {
  if (selectedId === null) return null;
  if (state.status === 'unrequested' || state.status === 'loading') {
    return { kind: 'loading', unreadablePayloadsSummary: null, groups: [] };
  }
  if (state.status === 'error') return { kind: 'error', unreadablePayloadsSummary: null, groups: [] };
  const { lineage } = state;
  const unreadablePayloadsSummary = lineage.unreadablePayloads === undefined
    ? '읽지 못한 계보 payload 수를 데몬이 알리지 않았습니다.'
    : lineage.unreadablePayloads === 0
      ? '읽지 못한 계보 payload가 0개입니다.'
      : `읽지 못한 계보 payload가 ${lineage.unreadablePayloads}개입니다.`;
  return {
    kind: lineage.groups.length === 0 ? 'empty' : 'content',
    unreadablePayloadsSummary,
    groups: lineage.groups.map((group) => ({
      joinedBy: group.joinedBy,
      key: group.key,
      rows: group.rows.map((row) => ({
        ptyId: row.ptyId,
        kind: row.kind,
        instance: row.instance,
        alive: row.alive,
        startedAt: row.startedAt,
        closed: row.closed === true || row.closedAt !== undefined,
        selected: row.ptyId === selectedId,
      })),
    })),
  };
}

const noFrameMetadata = null;

function displayForRaw(state: PtyScrollbackState): PtyTerminalDisplayModel {
  if (state.status === 'unrequested') return { kind: 'loading', text: '화면 글자를 아직 불러오지 않았습니다.', frameInfo: null, frameMetadata: noFrameMetadata };
  if (state.status === 'loading') return { kind: 'loading', text: '화면 글자를 불러오는 중…', frameInfo: null, frameMetadata: noFrameMetadata };
  if (state.status === 'error') return { kind: 'error', text: '화면 글자를 불러오지 못했습니다.', frameInfo: null, frameMetadata: noFrameMetadata };
  if (state.scrollback.length === 0) return { kind: 'empty', text: '표시할 화면 글자가 없습니다.', frameInfo: null, frameMetadata: noFrameMetadata };
  return { kind: 'content', text: state.scrollback, frameInfo: null, frameMetadata: noFrameMetadata };
}

function displayForFrame(state: PtyFrameState): PtyTerminalDisplayModel {
  if (state.status === 'unrequested') return { kind: 'loading', text: '렌더 화면을 아직 불러오지 않았습니다.', frameInfo: null, frameMetadata: noFrameMetadata };
  if (state.status === 'loading') return { kind: 'loading', text: '렌더 화면을 불러오는 중…', frameInfo: null, frameMetadata: noFrameMetadata };
  if (state.status === 'error') return { kind: 'error', text: '렌더 화면을 불러오지 못했습니다.', frameInfo: null, frameMetadata: noFrameMetadata };
  const [frameInfo, ...bodyLines] = state.frame.split('\n');
  const text = bodyLines.join('\n');
  const frameMetadata = { frameAt: state.frameAt, frameSource: state.frameSource };
  if (text.length === 0) return { kind: 'empty', text: '표시할 렌더 화면이 없습니다.', frameInfo: frameInfo || null, frameMetadata };
  return { kind: 'content', text, frameInfo: frameInfo || null, frameMetadata };
}

/** ⛔ A PTY id is unique only WITHIN a manifest root, and the federated list shows
 *  several roots at once — so two visible rows can carry the same id. Anything that
 *  identifies "which row" must key on the pair; an id alone silently binds to
 *  whichever row happens to come first, which is how a click on one universe's row
 *  ends up requesting another universe's screen. */
export function ptyRowKey(terminal: Pick<DaemonTerminalSummary, 'id'> & { sourceRoot?: { dbPath: string } }): string {
  // ⛔ A visible separator on purpose. A literal NUL here made `rg` classify this
  //    source file as binary and skip it entirely — an invisible byte that blinds
  //    the search tools is worse than the collision it was avoiding. `\u0000` as an
  //    escape keeps the byte out of the file while keeping the key unambiguous.
  return `${terminal.sourceRoot?.dbPath ?? ''}\u0000${terminal.id}`;
}

export type PtyTerminalIdResolution =
  | {
    kind: 'selected';
    terminal: DaemonTerminalSummary;
    terminalKey: string;
    candidates: readonly [DaemonTerminalSummary];
    reason: 'unique-id';
  }
  | {
    kind: 'ambiguous';
    terminal: null;
    terminalKey: null;
    candidates: readonly DaemonTerminalSummary[];
    reason: 'duplicate-id';
  }
  | {
    kind: 'not-found';
    terminal: null;
    terminalKey: null;
    candidates: readonly [];
    reason: 'empty-terminal-list' | 'terminal-id-not-found';
  };

/** Resolves a link's id without guessing which federated row it means.
 * A single id may name one row per manifest root, so only one candidate is selectable. */
export function resolvePtyTerminalId(
  terminalId: string,
  terminals: readonly DaemonTerminalSummary[],
): PtyTerminalIdResolution {
  const candidates = terminals.filter((terminal) => terminal.id === terminalId);
  if (candidates.length === 1) {
    const terminal = candidates[0]!;
    return {
      kind: 'selected',
      terminal,
      terminalKey: ptyRowKey(terminal),
      candidates: [terminal],
      reason: 'unique-id',
    };
  }
  if (candidates.length > 1) {
    return {
      kind: 'ambiguous',
      terminal: null,
      terminalKey: null,
      candidates,
      reason: 'duplicate-id',
    };
  }
  return {
    kind: 'not-found',
    terminal: null,
    terminalKey: null,
    candidates: [],
    reason: terminals.length === 0 ? 'empty-terminal-list' : 'terminal-id-not-found',
  };
}

/** Builds the selected mode's display model without making UI or network decisions.
 *  `selectedKey` is a `ptyRowKey`, not an id — see that function for why. */
export function ptyTerminalListModel(
  terminals: readonly DaemonTerminalSummary[],
  selectedKey: string | null,
  scrollbackByTerminal: ReadonlyMap<string, PtyScrollbackState>,
  viewMode: PtyTerminalViewMode = 'raw',
  frameByTerminal: ReadonlyMap<string, PtyFrameState> = new Map(),
): PtyTerminalListRowModel[] {
  const selectionExists = selectedKey !== null && terminals.some((terminal) => ptyRowKey(terminal) === selectedKey);
  return terminals.map((terminal) => {
    const selected = selectionExists && ptyRowKey(terminal) === selectedKey;
    const scrollback = !selected
      ? null
      : viewMode === 'raw'
        ? displayForRaw(scrollbackByTerminal.get(ptyRowKey(terminal)) ?? { status: 'unrequested' })
        : displayForFrame(frameByTerminal.get(ptyRowKey(terminal)) ?? { status: 'unrequested' });
    const view = scrollback === null ? null : {
      visible: true,
      modes: [
        { mode: 'raw' as const, label: '원시 글자', selected: viewMode === 'raw' },
        { mode: 'render' as const, label: '렌더 화면', selected: viewMode === 'render' },
      ],
      display: scrollback,
    };
    return { terminal, selected, scrollback, view };
  });
}

/** Builds all display data for the list; components only render this result. */
export function ptyTerminalPanelModel(
  includeAll: boolean,
  terminals: readonly DaemonTerminalSummary[],
  scope: DaemonTerminalsScope | undefined,
  selectedKey: string | null,
  scrollbackByTerminal: ReadonlyMap<string, PtyScrollbackState>,
  viewMode: PtyTerminalViewMode = 'raw',
  frameByTerminal: ReadonlyMap<string, PtyFrameState> = new Map(),
): PtyTerminalListModel {
  const rows = ptyTerminalListModel(terminals, selectedKey, scrollbackByTerminal, viewMode, frameByTerminal);
  const summaries = [hiddenDeadSummary(scope), terminatedLiveOwnerSummary(rows)].filter((summary): summary is string => summary !== null);
  return {
    includeAll,
    scopeSummary: summaries.join(' '),
    rows,
  };
}

export type PtyProgressStatus = 'running' | 'complete';

interface PtyProgressFrame {
  ptyId: string;
  runId: string;
  planId: string;
  seq: number;
  humanLine: string;
  observedAt: number;
  logId: number;
}

export interface PtyProgressSummary {
  line: string;
  status: PtyProgressStatus;
  hasMissingFrames: boolean;
}

function asProgressFrame(log: DaemonLogEntry): PtyProgressFrame | null {
  if (log.event !== 'headless.progress-frame' || !log.data || typeof log.data !== 'object') return null;
  const data = log.data as Record<string, unknown>;
  if (
    typeof data.ptyId !== 'string'
    || typeof data.runId !== 'string'
    || typeof data.planId !== 'string'
    || !Number.isSafeInteger(data.seq)
    || (data.seq as number) < 1
    || typeof data.humanLine !== 'string'
  ) return null;
  const observedAt = Date.parse(log.ts);
  return {
    ptyId: data.ptyId,
    runId: data.runId,
    planId: data.planId,
    seq: data.seq as number,
    humanLine: data.humanLine,
    observedAt: Number.isFinite(observedAt) ? observedAt : 0,
    logId: log.id,
  };
}

function compareFrames(a: PtyProgressFrame, b: PtyProgressFrame): number {
  return a.observedAt - b.observedAt || a.logId - b.logId;
}

/** ⛔ 2026-08-14 실측 — 이 자리는 `✓`/`✅` 를 완료 표식으로 봤는데 실물엔 «그 문자가 없다».
 *  `headless.progress-frame` 의 `humanLine` 은 맨 앞에 `◐`(진행 중) 또는 `●`(완료)를 단다.
 *  📏 표본 9 프레임: `◐` 2 · `●` 7 · 그 밖 0.
 *  ⇒ 종전 판정은 «complete 가 원리상 안 나오는» 죽은 가지였다. 실물 두 문자로 가른다. */
function isCompleteLine(line: string): boolean {
  return /^\s*●/.test(line);
}

/**
 * Builds one current activity per PTY from progress-frame log records.
 * The latest observed plan wins, so a newly-created plan's sequence restart
 * cannot be displaced by the prior plan's larger sequence number.
 */
export function ptyProgressByTerminal(
  logs: readonly DaemonLogEntry[],
): ReadonlyMap<string, PtyProgressSummary> {
  const framesByPty = new Map<string, PtyProgressFrame[]>();
  for (const log of logs) {
    const frame = asProgressFrame(log);
    if (!frame) continue;
    const frames = framesByPty.get(frame.ptyId) ?? [];
    frames.push(frame);
    framesByPty.set(frame.ptyId, frames);
  }

  const summaries = new Map<string, PtyProgressSummary>();
  for (const [ptyId, frames] of framesByPty) {
    frames.sort(compareFrames);
    const latest = frames.at(-1)!;
    const seqsByPlan = new Map<string, Set<number>>();
    for (const frame of frames) {
      const planKey = `${frame.runId}\u0000${frame.planId}`;
      const seqs = seqsByPlan.get(planKey) ?? new Set<number>();
      seqs.add(frame.seq);
      seqsByPlan.set(planKey, seqs);
    }
    const hasMissingFrames = [...seqsByPlan.values()].some((seqSet) => {
      const seqs = [...seqSet].sort((a, b) => a - b);
      return seqs.some((seq, index) => (
        (index === 0 && seq !== 1)
        || (index > 0 && seq - seqs[index - 1]! !== 1)
      ));
    });
    summaries.set(ptyId, {
      line: latest.humanLine,
      status: isCompleteLine(latest.humanLine) ? 'complete' : 'running',
      hasMissingFrames,
    });
  }
  return summaries;
}

/** 어느 터미널을 «처음에» 보여줄지 — 그리고 «왜 그것을 골랐는지». */
export interface InitialTerminalSelection {
  terminalId: string;
  reason: 'stored' | 'live-pty' | 'fallback';
}

export interface NoInitialTerminalSelection {
  terminalId: null;
  reason: 'no-terminals';
}

export type InitialTerminalSelectionResult = InitialTerminalSelection | NoInitialTerminalSelection;

type InitialTerminalSelectionInput = {
  storedId: string | null;
  terminals: readonly (Pick<DaemonTerminalSummary, 'id' | 'alive'> & { cmd?: string })[];
};

type InitialTerminalSelectionWithFallbackInput = InitialTerminalSelectionInput & {
  fallbackId: string;
};

type InitialTerminalSelectionWithoutFallbackInput = InitialTerminalSelectionInput & {
  fallbackId?: string | null;
};

/**
 * 첫 화면의 선택을 정한다.
 *
 * ⛔⭐ 왜 (대표 2026-08-17): *"preview-1 같은 아이디가 이제는 의미 없지 않나요?
 * 기존에 pty 체계에 맞춰서 생성이 되어야 할것 같구요."*
 * 📏 그 전 동작 — 초기값이 «클라이언트가 지어낸» 'preview-1' 하드코딩이라,
 *    데몬에 진짜 PTY 가 여럿 살아 있어도 사람은 스크래치 셸을 먼저 봤다.
 *
 * ⭐ 순서: 사람이 마지막에 고른 것 → 살아 있는 실재 PTY → 명시적 폴백 → 선택 없음.
 * ⛔ 저장된 선택은 «그대로 존중»한다 — 사람이 고른 것을 도구가 뒤엎지 않는다.
 * ⛔ 「왜 골랐나」를 값으로 돌려준다 — 화면이 엉뚱해 보일 때 이유를 물을 자리가 있어야 한다.
 */
export function initialTerminalSelection(input: InitialTerminalSelectionWithFallbackInput): InitialTerminalSelection;
export function initialTerminalSelection(input: InitialTerminalSelectionWithoutFallbackInput): InitialTerminalSelectionResult;
export function initialTerminalSelection(input: InitialTerminalSelectionWithoutFallbackInput): InitialTerminalSelectionResult {
  const stored = input.storedId?.trim();
  if (stored) return { terminalId: stored, reason: 'stored' };
  // ⛔ 목록 순서를 «그대로» 쓴다 — 서버가 정한 순서를 클라이언트가 다시 정렬하면
  //   두 자가 갈리고, 「왜 이것이 첫째인가」를 서버에 물을 수 없게 된다.
  // ⛔ 터미널 탭은 «웹 셸»에만 붙는다 — 에이전트 PTY(codex_·self_·pty_…)를 고르면 XtermView 의
  //   `terminal/spawn` 이 그 id 로 «새 셸»을 만들어 에이전트 행과 이름이 겹친다(대표 2026-09-28 실측:
  //   그 뒤 `?pty=` 가 «2개 행과 맞아» 선택을 거부했다). 에이전트 PTY 는 PTY 목록·라이브·나란히가 보여 준다.
  //   08-17 의 동기(«지어낸 preview-1» 금지)는 이제 데몬이 이름을 발급하므로 폴백 쪽이 맡는다.
  const live = input.terminals.find((terminal) => terminal.alive === true && terminal.cmd === 'web-terminal');
  if (live) return { terminalId: live.id, reason: 'live-pty' };
  if (input.fallbackId !== undefined && input.fallbackId !== null) {
    return { terminalId: input.fallbackId, reason: 'fallback' };
  }
  return { terminalId: null, reason: 'no-terminals' };
}
