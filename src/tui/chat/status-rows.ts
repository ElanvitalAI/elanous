// TUI-STATUS-3ROW v1 (대표 11-24 «op status 라인 개선»): the bottom status as rows with one job each, instead of one
// crowded line that mixed the turn, the seat and the build (and named the model twice).
//
//   progress (above the input, only while a turn runs)  ⠼ Working (15m 36s • esc to interrupt) · ↑63.7k ↓2.0k
//   row 1 · seat                                       🚗 AUTO · OP · <goal> · gpt-6.1-terra · build 261124_1811·dev
//   row 2 · work                                       ● Turn done · Queue 21 · Bg 17 · ✋ 1
//   row 3 · accounts (≥24 rows)                        codex team 76% · third 57% · default ✗ │ OR $977 left │ mshq 12 · node-b 25⚠
//
// Two footer rows when the screen has STATUS_TWO_ROWS_MIN_HEIGHT rows or more, otherwise one row that keeps
// attention > work > seat. A row that is too wide drops whole fields (lowest priority first, the rightmost of equals) —
// a field is never cut in the middle; only a single remaining field may end in «…».
//
// The progress row keeps the working-row shape `<spinner> <Verb> (<elapsed> • esc to interrupt)` on purpose: els reads
// it (src/els/pane-status.ts TOOL_ROW · src/els/stall-alert.ts ELAPSED) to tell a running pane from an idle one.
//
// Row 3 (대표 11-24 22:4x «LLM 현황은 왜 표시 안하나요?») draws cached numbers only: the LLM account snapshot a background
// `elanous usage status-cache` child writes (src/statusline/sources/llm-usage.ts) and the per-host loads of the fleet
// poller's Nexus answer (src/statusline/sources/machines.ts). Nothing here reads a file or the network.
import type { LlmUsageAccount, LlmUsageSnapshot } from '../../statusline/sources/llm-usage.js';
import { fitLogLine } from './log-view.js';
import { formatWorkingElapsed, workingSpinnerFrame, workingVerb, WORKING_INTERRUPT_HINT, type WorkingPhase } from './working-row.js';

/** 출처: 대표 11-24 TUI-STATUS-3ROW — two footer rows from this screen height; below it one row. */
export const STATUS_TWO_ROWS_MIN_HEIGHT = 20;
/** 출처: 대표 11-24 22:4x row 3 spec — the accounts row from this screen height. */
export const STATUS_THREE_ROWS_MIN_HEIGHT = 24;
// 출처: 대표 11-24 22:4x row 3 spec — a window at or above this used share, or a balance under this many dollars, gets ⚠.
const ACCOUNT_WARN_PERCENT = 80;
const ACCOUNT_WARN_BALANCE_USD = 50;
// 출처: 대표 11-24 22:4x row 3 spec — numbers older than 10 minutes are drawn with «(stale)».
const ACCOUNTS_STALE_MS = 600_000;

export interface AccountsRowInput {
  /** The cached LLM account snapshot; null = no cache yet (no LLM fields). */
  readonly snapshot: LlmUsageSnapshot | null;
  /** Per-host load texts (`mshq 12`, `node-b 25⚠`) from the fleet poller; empty/absent = no host field. */
  readonly hosts?: readonly { readonly text: string }[];
  readonly nowMs: number;
}

export interface StatusRowsTurn {
  readonly phase: WorkingPhase;
  readonly elapsedMs: number;
  /** Provider-measured tokens of this turn; absent = not reported (never guessed). */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** Streamed-characters estimate of the output while the provider has not reported it (shown with «~»). */
  readonly estimatedOutputTokens?: number;
  /** Lines queued behind the running turn. */
  readonly queued?: number;
}

export interface StatusRowsInput {
  readonly width: number;
  readonly height: number;
  /** Present while a turn runs → the progress row; absent/null → no progress row. */
  readonly turn?: StatusRowsTurn | null;
  /** Things the person should act on or read now (a failure, a hint, a turn-end summary while scrolled up). */
  readonly attention?: readonly (string | null | undefined | false)[];
  /** The short turn state (`● Turn done`) — kept in the work row; empty while the progress row says the turn. */
  readonly state?: string;
  /** The autopilot chip as the controller writes it (`🚗 AUTO · <goal> · next ⏰hh:mm` · `🚗 PAUSED · …`). */
  readonly autopilot?: string;
  readonly seat?: string;
  /** The model, shown once (provider prefix already removed by the caller or here). */
  readonly model?: string;
  /** The running build's short label (`261124_1811·dev`). */
  readonly build?: string;
  readonly queued: number;
  readonly steering?: number;
  readonly background: number;
  readonly children?: number;
  /** Open needs-human blocks of this seat (✋); 0/absent = not shown. */
  readonly needsHuman?: number;
  /** Unread seat mail (✉); absent = no live source, not shown. */
  readonly unread?: number;
  /** Row 3 (accounts · host load) — drawn only on a screen of STATUS_THREE_ROWS_MIN_HEIGHT rows or more. */
  readonly accounts?: AccountsRowInput;
}

export interface StatusRows {
  readonly progress: string | null;
  /** Top to bottom: [seat, work] on a tall screen, one combined row otherwise. */
  readonly rows: readonly string[];
  /** Row 3 under `rows`, or null (short screen, nothing cached, or not even one field fits). */
  readonly accounts: string | null;
}

interface Field { readonly text: string; readonly priority: number }

const SEPARATOR = ' · ';
const widthOf = (fields: readonly Field[]): number => Bun.stringWidth(fields.map((field) => field.text).join(SEPARATOR));

/** `63720` → `63.7k` · `2013` → `2.0k` · `812` → `812` · `1_234_567` → `1.2M`. */
export function compactTokenCount(value: number): string {
  const n = Math.max(0, Math.floor(value));
  if (n < 1000) return String(n);
  if (n < 999_950) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function tokenPart(turn: StatusRowsTurn): string {
  const known = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value >= 0;
  const up = known(turn.inputTokens) ? `↑${compactTokenCount(turn.inputTokens)}` : '';
  const down = known(turn.outputTokens) ? `↓${compactTokenCount(turn.outputTokens)}`
    : known(turn.estimatedOutputTokens) ? `↓~${compactTokenCount(turn.estimatedOutputTokens)}` : '';
  return [up, down].filter(Boolean).join(' ');
}

/** The progress row: the working row, then the turn's tokens, then the queue; dropped from the right to fit. */
export function progressRowLine(turn: StatusRowsTurn, columns: number): string {
  const head = `${workingSpinnerFrame(turn.elapsedMs)} ${workingVerb(turn.phase)} (${formatWorkingElapsed(turn.elapsedMs)} • ${WORKING_INTERRUPT_HINT})`;
  const tokens = tokenPart(turn);
  const queued = (turn.queued ?? 0) > 0 ? `${turn.queued} queued` : '';
  for (const candidate of [[head, tokens, queued], [head, tokens], [head]]) {
    const line = candidate.filter(Boolean).join(SEPARATOR);
    if (Bun.stringWidth(line) <= columns) return line;
  }
  return fitLogLine(head, columns);
}

/** Drop whole fields (highest `priority` number first, rightmost of equals) until the row fits `width`. */
export function fitFields(fields: readonly Field[], width: number): string {
  const kept = fields.filter((field) => field.text.trim() !== '');
  while (kept.length > 1 && widthOf(kept) > width) {
    let drop = 0;
    for (let index = 1; index < kept.length; index++) if (kept[index]!.priority >= kept[drop]!.priority) drop = index;
    kept.splice(drop, 1);
  }
  const line = kept.map((field) => field.text).join(SEPARATOR);
  if (Bun.stringWidth(line) <= width) return line;
  // One field left and still too wide: the only cut, marked.
  return width >= 2 ? `${fitLogLine(line, width - 1)}…` : fitLogLine(line, width);
}

const modelOnce = (model: string | undefined): string => {
  const value = (model ?? '').trim();
  return value.includes('/') ? value.slice(value.lastIndexOf('/') + 1) : value;
};

// Priorities (lower = kept longer). Attention first, then the work counters, then the seat facts.
const P = {
  attention: 0, needsHuman: 1, state: 2, unread: 3, queue: 4, background: 5, children: 6,
  autopilot: 10, seat: 11, model: 12, goal: 13, build: 14, next: 15,
} as const;

function seatFields(input: StatusRowsInput): Field[] {
  const chip = (input.autopilot ?? '').split(SEPARATOR).map((part) => part.trim()).filter(Boolean);
  const [chipHead, ...chipRest] = chip;
  const goal = chipRest.filter((part) => !part.startsWith('next '));
  const next = chipRest.filter((part) => part.startsWith('next '));
  const model = modelOnce(input.model);
  return [
    ...(chipHead ? [{ text: chipHead, priority: P.autopilot }] : []),
    ...(input.seat ? [{ text: input.seat, priority: P.seat }] : []),
    ...goal.map((text) => ({ text, priority: P.goal })),
    ...next.map((text) => ({ text, priority: P.next })),
    ...(model ? [{ text: model, priority: P.model }] : []),
    ...(input.build ? [{ text: `build ${input.build}`, priority: P.build }] : []),
  ];
}

function workFields(input: StatusRowsInput): Field[] {
  const queued = Math.max(0, Math.floor(input.queued));
  const steering = Math.min(queued, Math.max(0, Math.floor(input.steering ?? 0)));
  const attention = (input.attention ?? []).filter((text): text is string => typeof text === 'string' && text.trim() !== '');
  return [
    ...attention.map((text) => ({ text, priority: P.attention })),
    ...(input.state ? [{ text: input.state, priority: P.state }] : []),
    ...(steering > 0 ? [{ text: `Steer ${steering}`, priority: P.queue }] : []),
    { text: `Queue ${queued - steering}`, priority: P.queue },
    { text: `Bg ${Math.max(0, Math.floor(input.background))}`, priority: P.background },
    ...((input.children ?? 0) > 0 ? [{ text: `Children ${input.children}`, priority: P.children }] : []),
    ...((input.needsHuman ?? 0) > 0 ? [{ text: `✋ ${input.needsHuman}`, priority: P.needsHuman }] : []),
    ...(input.unread !== undefined && input.unread > 0 ? [{ text: `✉ ${input.unread}`, priority: P.unread }] : []),
  ];
}

export function renderStatusRows(input: StatusRowsInput): StatusRows {
  const width = Math.max(1, Math.floor(input.width));
  const progress = input.turn ? progressRowLine(input.turn, width) : null;
  const seat = seatFields(input);
  const work = workFields(input);
  if (input.height >= STATUS_TWO_ROWS_MIN_HEIGHT) {
    const accounts = input.height >= STATUS_THREE_ROWS_MIN_HEIGHT && input.accounts ? accountsRowLine(input.accounts, width) : null;
    // A screen with no seat facts at all (no autopilot, seat, model or build) keeps the one work row.
    return { progress, rows: seat.length > 0 ? [fitFields(seat, width), fitFields(work, width)] : [fitFields(work, width)], accounts };
  }
  return { progress, rows: [fitFields([...work, ...seat], width)], accounts: null };
}

const PROVIDER_LABEL: Readonly<Record<LlmUsageAccount['provider'], string>> = {
  codex: 'codex', openrouter: 'OR', zai: 'glm', claude: 'claude', grok: 'grok',
};
const PROVIDER_ORDER: readonly LlmUsageAccount['provider'][] = ['codex', 'openrouter', 'zai', 'claude', 'grok'];
const GROUP_SEPARATOR = ' │ ';

/** One provider's items: windows with a used share or a balance, then errors; accounts with no numbers are left out. */
function providerItems(accounts: readonly LlmUsageAccount[]): string[] {
  const named = accounts.length > 1;
  const shown: string[] = [];
  const failed: string[] = [];
  for (const account of accounts) {
    const label = named ? `${account.account.replace(/^plan-/, '')} ` : '';
    if (account.status === 'error') { failed.push(`${label}✗`); continue; }
    if (account.status !== 'ok') continue;
    if (account.leftUsd !== undefined && Number.isFinite(account.leftUsd)) {
      shown.push(`${label}$${Math.floor(account.leftUsd)} left${account.leftUsd < ACCOUNT_WARN_BALANCE_USD ? ' ⚠' : ''}`);
    } else if (account.usedPercent !== null && Number.isFinite(account.usedPercent)) {
      const percent = Math.round(account.usedPercent);
      shown.push(`${label}${percent}%${percent >= ACCOUNT_WARN_PERCENT ? ' ⚠' : ''}`);
    }
  }
  return [...shown, ...failed];
}

/**
 * Row 3: LLM accounts (codex · OpenRouter · GLM · Claude · grok) then host load, e.g.
 * `codex team 76% · third 57% · default ✗ │ OR $977 left │ glm 5h 0% · week 100% ⚠ │ mshq 12 · node-b 25⚠`.
 * Too wide: the host field goes first, then provider fields from the right, then the last provider's accounts from the
 * right; a field is never cut. Nothing fits (or nothing is cached) → null, and the row is not drawn.
 */
export function accountsRowLine(input: AccountsRowInput, columns: number): string | null {
  const width = Math.max(0, Math.floor(columns));
  const accounts = input.snapshot?.accounts ?? [];
  const groups = PROVIDER_ORDER
    .map((provider) => ({ label: PROVIDER_LABEL[provider], items: providerItems(accounts.filter((account) => account.provider === provider)) }))
    .filter((group) => group.items.length > 0);
  const stale = groups.length > 0 && input.snapshot !== null && input.nowMs - input.snapshot.ts > ACCOUNTS_STALE_MS;
  let hosts = (input.hosts ?? []).map((host) => host.text).filter((text) => text.trim() !== '');
  const compose = (): string => {
    const llm = groups.map((group) => `${group.label} ${group.items.join(SEPARATOR)}`).join(GROUP_SEPARATOR);
    const head = llm ? `${llm}${stale ? ' (stale)' : ''}` : '';
    return [head, hosts.join(SEPARATOR)].filter(Boolean).join(GROUP_SEPARATOR);
  };
  for (;;) {
    const line = compose();
    if (line === '') return null;
    if (Bun.stringWidth(line) <= width) return line;
    if (hosts.length > 0) hosts = [];
    else if (groups.length > 1) groups.pop();
    else if (groups[0]!.items.length > 1) groups[0] = { ...groups[0]!, items: groups[0]!.items.slice(0, -1) };
    else return null;
  }
}
