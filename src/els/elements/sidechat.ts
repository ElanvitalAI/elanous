// ELS-SIDECHAT (대표 11-26 17:5x) — the sidechat overlay element: a mini LLM popup on the els z axis for a quick question.
// Input line at the bottom (any UTF-8 text — Korean IME commits arrive as whole syllables), the streamed answer above it
// rendered with the classic markdown renderer, Enter sends, Esc closes (the attach app's layer rule). The server's sidechat
// hub owns the input line AND the turns: a key goes up as one ordered edit (type · back · clear · send), never as the whole
// input, and hydrate re-fills input/turns/status from the hub — so neither a stale push between two keys nor a client's
// stale copy can drop a syllable or overwrite streamed text. The client draws its optimistic `input` until the push lands. No model call, no key and no provider here — the hub (src/els/sidechat-hub.ts)
// does the call on the server.

import { fitAnsi } from '../attach-view.js';
import type { SidechatContext, SidechatEdit, SidechatStatus, SidechatTiming, SidechatTurn } from '../sidechat-hub.js';
import type { ElementDef } from './element.js';
import { renderMarkdownRows, truncateCells, visibleWidth } from './markdown-render.js';
import { hydrateTakeout, takeoutKey, takeoutOf, takeoutRow, type TakeoutState } from './takeout.js';

export interface SidechatProps {
  /** The input line as drawn (server-filled from the hub; the client's optimistic guess until the push lands). */
  readonly input: string;
  /** One edit of the input line (client → server only; hydrate applies it to the hub and drops it). */
  readonly edit?: SidechatEdit;
  /** Server-filled (hydrate): the session's turns and state. */
  readonly turns?: readonly SidechatTurn[];
  readonly status?: SidechatStatus;
  readonly note?: string;
  /** A4: set by the server at start on a layer restored from overlays.json (its session died with the old process). */
  readonly restarted?: true;
  /** A5, server-filled: the typing indicator frame while waiting, and the first-token / total timing. */
  readonly typing?: number;
  readonly timing?: SidechatTiming;
  /** A1: the pane the popup was opened over (open props only — the hub keeps it; never its screen). */
  readonly pane?: string;
  /** A1, server-filled: «include context» is on (label = the pane title; absent = unavailable). */
  readonly context?: SidechatContext;
  /** ELS-TAKEOUT: the ctrl+e chooser row (takeout.ts); `holdEsc` = Esc cancels the row instead of closing (server-set). */
  readonly takeout?: TakeoutState;
  readonly holdEsc?: boolean;
}

// 출처: ELS-SIDECHAT — an input line is one question (the hub caps a question at 2000 chars too).
export const SIDECHAT_MAX_INPUT = 2_000;
// 출처: ELS-SIDECHAT-EDGE A4 (대표 11-26) — the one line a restored sidechat shows after an els restart.
const SIDECHAT_RESTART_NOTE = 'Previous sidechat was closed when els restarted.';
const R = '\u001b[0m';
const FRAME = '\u001b[35m';
const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const RED = '\u001b[31m';

// A5: the typing indicator (title spinner + a dot cycle in the body) and the timing in the title.
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const DOTS = ['•  ', '•• ', '•••', ' ••', '  •', '   '] as const;
const secs = (ms: number): string => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
/** The title: waiting → spinner + «thinking…»; streaming → «answering…» + first-token latency; done → first token · total. */
export function sidechatTitle(status: SidechatStatus, typing: number | undefined, timing: SidechatTiming | undefined): string {
  const first = timing?.firstMs !== undefined ? `${secs(timing.firstMs)} first token` : undefined;
  if (status === 'waiting') return ` Sidechat · ${SPIN[(typing ?? 0) % SPIN.length]} thinking… `;
  if (status === 'streaming') return ` Sidechat · answering… ${first ? `· ${first} ` : ''}`;   // the state first: a narrow title clips the timing
  const total = timing?.totalMs !== undefined ? `${secs(timing.totalMs)} total` : undefined;
  return first || total ? ` Sidechat · ${[first, total].filter(Boolean).join(' · ')} ` : ' Sidechat ';
}
const PANE_REF = /^[A-Za-z0-9._-]{1,64}$/;
const clean = (text: string): string => text.replace(/[\u0000-\u001f\u007f]/g, ' ');

export function sidechatProps(raw: unknown): SidechatProps | undefined {
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) return undefined;
  const value = (raw ?? {}) as Record<string, unknown>;
  const input = typeof value.input === 'string' ? clean(value.input).slice(0, SIDECHAT_MAX_INPUT) : '';
  const edit = editOf(value.edit);
  const pane = typeof value.pane === 'string' && PANE_REF.test(value.pane) ? value.pane : undefined;
  const takeout = takeoutOf(value.takeout);
  return { input, ...(edit ? { edit } : {}), ...(pane ? { pane } : {}), ...(takeout ? { takeout } : {}), ...(value.restarted === true ? { restarted: true as const } : {}) };
}

function editOf(raw: unknown): SidechatEdit | undefined {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  if (!value) return undefined;
  if (value.kind === 'type') { const text = typeof value.text === 'string' ? clean(value.text).slice(0, SIDECHAT_MAX_INPUT) : ''; return text ? { kind: 'type', text } : undefined; }
  return value.kind === 'back' || value.kind === 'clear' || value.kind === 'send' || value.kind === 'context' ? { kind: value.kind } : undefined;
}

/** The transcript as markdown (questions as bold lines, answers as they are, errors as a red line). */
export function sidechatTranscript(turns: readonly SidechatTurn[]): string {
  return turns.map((turn) => [`**› ${turn.q.replace(/\*/g, '\\*')}**`, '', turn.a, ...(turn.error ? ['', `⚠ ${turn.error}`] : [])].join('\n')).join('\n\n');
}

export function renderSidechat(props: SidechatProps, size: { readonly w: number; readonly h: number }, focused: boolean): string[] {
  const { w, h } = size;
  if (w < 4 || h < 3) return [];
  const inner = w - 2;
  const turns = props.turns ?? [];
  const status = props.status ?? 'idle';
  const title = sidechatTitle(status, props.typing, props.timing);
  const help = ' Enter send · Esc close ';
  const top = `${FRAME}╭─${R}${BOLD}${truncateCells(title, Math.max(0, inner - 1))}${R}${FRAME}${'─'.repeat(Math.max(0, inner - 1 - visibleWidth(truncateCells(title, Math.max(0, inner - 1)))))}╮${R}`;
  const bottom = `${FRAME}╰${'─'.repeat(Math.max(0, inner - visibleWidth(help) - 1))}${R}${DIM}${visibleWidth(help) + 1 <= inner ? help : ''}${R}${FRAME}${visibleWidth(help) + 1 <= inner ? '─' : '─'.repeat(Math.min(inner, visibleWidth(help) + 1))}╯${R}`;
  // A1: a dim header row while «include context» is on.
  const header = props.context ? [`${DIM}context: ${props.context.label ?? 'unavailable'}${R}`] : [];
  const bodyH = Math.max(0, h - 4 - header.length);                  // top · [context] · body · rule · input · bottom
  const textW = Math.max(1, inner - 2);
  let body: string[];
  if (!turns.length) body = [...(props.note ? [`${DIM}${props.note}${R}`] : []), `${DIM}Ask anything — a quick answer from a fast model. Nothing here is sent to your panes.${R}`, `${DIM}ctrl+o includes the focused pane's screen as context.${R}`].flatMap((line) => renderMarkdownRows(line, textW));
  else {
    body = renderMarkdownRows(sidechatTranscript(turns), textW);
    const last = turns.at(-1)!;
    if (last.error) body = body.map((row) => row.includes('⚠ ') ? `${RED}${row}${R}` : row);
    if (status === 'waiting') body.push(`${DIM}${DOTS[(props.typing ?? 0) % DOTS.length]}${R}`);
  }
  const shown = body.slice(Math.max(0, body.length - bodyH));         // follow the stream: the newest rows stay in view
  while (shown.length < bodyH) shown.push('');
  // The input line keeps its tail in view (a long question scrolls left), the caret at the end.
  const caret = focused ? '\u001b[7m \u001b[27m' : '';
  let input = props.input;
  const room = Math.max(1, inner - 4);
  while (visibleWidth(input) > room) input = Array.from(input).slice(1).join('');
  const prompt = props.takeout ? takeoutRow(props.takeout, inner - 2) : status === 'idle' ? `${BOLD}›${R} ${input}${caret}` : `${DIM}› ${input || 'wait for the answer…'}${R}`;
  const side = (text: string): string => `${FRAME}│${R}${fitAnsi(` ${text}`, inner)}${FRAME}│${R}`;
  return [top, ...header.map(side), ...shown.map(side), `${FRAME}├${'─'.repeat(inner)}┤${R}`, side(prompt), bottom].slice(0, h);
}

/** The key reducer: text → a `type` edit, Backspace → `back`, ctrl+u → `clear`, Enter → `send`. It returns the optimistic
 *  input to draw now and the ONE edit for the server. Everything else (control keys, arrows, the bracketed-paste markers) is
 *  consumed so it never reaches the pane under the popup. */
export function sidechatKey(props: { readonly input: string; readonly status?: SidechatStatus }, key: string): SidechatProps | 'consumed' {
  if (key === '\r' || (key === '\n' && !props.input)) {
    if (!props.input.trim() || (props.status && props.status !== 'idle')) return 'consumed';
    return { input: '', edit: { kind: 'send' } };
  }
  if (key === '\n') return { input: `${props.input} `.slice(0, SIDECHAT_MAX_INPUT), edit: { kind: 'type', text: ' ' } };   // pasted newline = a space
  if (key === '\u007f' || key === '\b') return props.input ? { input: Array.from(props.input).slice(0, -1).join(''), edit: { kind: 'back' } } : 'consumed';
  if (key === '\u000f') return { input: props.input, edit: { kind: 'context' } };                                            // ctrl+o: include context
  if (key === '\u0015') return props.input ? { input: '', edit: { kind: 'clear' } } : 'consumed';                               // ctrl+u clears
  if (key.startsWith('\u001b') || /^[\u0000-\u001f\u007f]$/.test(key)) return 'consumed';
  const text = clean(key);
  if (!text || props.input.length >= SIDECHAT_MAX_INPUT) return 'consumed';
  return { input: (props.input + text).slice(0, SIDECHAT_MAX_INPUT), edit: { kind: 'type', text } };
}

export const sidechat: ElementDef<SidechatProps> = {
  kind: 'sidechat',
  defaults: { band: 'popup', focus: 'owns' },             // popup band: above the Obsidian float, below toasts
  frames: ['popup', 'tile', 'tab'],
  dress: { chip: '⚡ fast model', chat: true },             // ELS-POPUP-STYLE fancy: the model tier chip · speaker gutters
  props: (raw) => sidechatProps(raw),
  hydrate: (props, context) => {
    const hub = context.sidechat;
    if (!hub) return { ...props, turns: [], status: 'idle', note: 'sidechat runs only in an els server' };
    if (props.pane) hub.edit({ kind: 'pane', pane: props.pane });
    if (props.edit) hub.edit(props.edit);
    const { turns, status, input, typing, timing, context: ctx } = hub.snapshot();
    const takeout = hydrateTakeout(props.takeout, turns, context);
    return { input, turns, status, ...(typing !== undefined ? { typing } : {}), ...(timing ? { timing } : {}), ...(props.restarted && !turns.length ? { note: SIDECHAT_RESTART_NOTE } : {}), ...(ctx ? { context: ctx } : {}), ...(takeout ? { takeout, holdEsc: true } : {}) };
  },
  rect: () => ({ anchor: 'center', w: '70%', h: '70%' }),
  render: (props, size, focused) => renderSidechat(props, size, focused),
  key: (layer, bytes) => {
    const props = layer.props as (SidechatProps & { status?: SidechatStatus }) | undefined;
    if (!props || typeof props.input !== 'string') return 'consumed';
    const out = takeoutKey(props, bytes);
    if (out !== undefined) return out === 'consumed' ? 'consumed' : { update: out };
    const next = sidechatKey(props, bytes);
    return next === 'consumed' ? 'consumed' : { update: next };
  },
};
