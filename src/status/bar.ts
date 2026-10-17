// ── Status bar (Claude-Code-style) ──
//
// Pure-render layer for the per-session status summary that appears
// above the chat input. Inspired by Claude Code's CLI header:
//
//   📁 temp  no git  Opus 4.6 (1M context)  🕐 0s
//   CTX [████████] 100% remain (0k/1000k)  💰 $0.00  ⚡ 5h: --  🚀 --t/s
//
// Scope for MVP (priority per user):
//   1. Working directory (basename pill, blue)     ← must-have
//   2. Active LLM model (provider/model pill, pink) ← must-have
//   3. Git state (basic "no git" / branch name)    ← stub, free bytes
//
// Future-work slots (stubbed, return '' so callers can always render):
//   - ctxBar(used, max) — horizontal █/░ bar + "N% remain (used/max)"
//   - elapsedTime(seconds)
//   - costUsd(dollars)
//   - hourlyBurn(tokensThisHour)
//   - tokensPerSec(avg)
//
// Keeping this module pure (no disk I/O, no process state) so both
// the dashboard HUD and any one-shot `elanous status-bar` CLI can share
// one set of renderers.

import { basename } from 'node:path';
import chalk from 'chalk';
import { C, ctp, visibleWidth } from '../tui.js';
import type { ActiveProviderInfo } from '../provider-summary.js';
import { DEFAULT_THEME_TOKENS, type ThemeTokens } from '../theme/tokens.js';
import { renderStatusModule } from '../expression/index.js';
import { sizeStr } from '../panes/file-icons.js';

// ── Building blocks ─────────────────────────────────────────────────
//
// Visual design philosophy:
//   • ONLY the "anchor" segments carry a filled background pill — the
//     session working directory (peach) and the active model (pink).
//     They establish visual identity and stay where the eye expects
//     them on any terminal theme.
//   • Every other segment (git state, elapsed time, cost, speed, PTY
//     shell count) renders as flat COLORED TEXT — no background noise.
//     Background pills on a dark TUI with varied theme contrast look
//     muddy at worst and distracting at best; flat-text lets the
//     Catppuccin foreground palette do the signalling.
//   • Colors encode meaning:
//       teal      — calm, positive (git on a clean branch)
//       yellow    — dirty / active (dirty working tree, live shells)
//       peach     — divergence (ahead / behind upstream)
//       subtext1  — muted-but-readable neutral (time, cost, speed)
//       overlay2  — even more muted (detached HEAD, "no git")
//
// Two render helpers live below: pill() for the anchor segments,
// text() for every flat segment. A tone type stays shared so both
// helpers accept the same vocabulary.

type StatusTone = 'blue' | 'pink' | 'dim' | 'green' | 'yellow' | 'peach'
  | 'teal' | 'subtext' | 'overlay' | 'mauve';

export interface StatusBarRenderOptions {
  theme?: ThemeTokens;
  /** 2026-05-05 — narrow-width mode. When true, segments may
   *  aggressively truncate. Currently only `modelSegment` honours
   *  this flag: model id is cut at the first parameter-size marker
   *  (e.g. `qwen3.6-35b-a3b-ud-mlx` → `qwen3.6-35b`,
   *  `qwen2.5-72b-instruct` → `qwen2.5-72b`). Caller decides the
   *  threshold (typically `termCols < 100`). */
  compact?: boolean;
}

export const STATUS_SEGMENT_SEPARATOR = `${chalk.hex(ctp.overlay1)(' │ ' )}`;

/** Filled pill — for anchor segments only. Background is a named
 *  palette color; foreground is ctp.base (near-black) so the pill
 *  reads the same on any terminal theme. Bold keeps the pill text
 *  from disappearing on low-contrast background tiles. */
function pill(label: string, tone: StatusTone, opts: StatusBarRenderOptions = {}): string {
  const inner = ` ${label} `;
  if (opts.theme) {
    const bg = statusToneColor(tone, opts.theme);
    return chalk.bgHex(bg).hex(ctp.base).bold(inner);
  }
  const base = ctp.base;
  switch (tone) {
    case 'blue':   return chalk.bgHex(ctp.teal).hex(base).bold(inner);
    case 'pink':   return chalk.bgHex(ctp.pink).hex(base).bold(inner);
    case 'green':  return chalk.bgHex(ctp.green).hex(base).bold(inner);
    case 'yellow': return chalk.bgHex(ctp.yellow).hex(base).bold(inner);
    case 'peach':  return chalk.bgHex(ctp.peach).hex(base).bold(inner);
    case 'teal':   return chalk.bgHex(ctp.teal).hex(base).bold(inner);
    case 'mauve':  return chalk.bgHex(ctp.mauve).hex(base).bold(inner);
    case 'subtext':
    case 'overlay':
    case 'dim':
    default:       return chalk.hex(ctp.subtext1)(inner);  // filled path fallback: flat
  }
}

/** Flat-text segment renderer — colored foreground, no background.
 *  The visual foundation of the status bar after the 2026-04-17
 *  refresh: anchor pills + flat-colored text, everything else gone. */
function text(label: string, tone: StatusTone, opts: StatusBarRenderOptions = {}): string {
  if (opts.theme) {
    return chalk.hex(statusToneColor(tone, opts.theme))(label);
  }
  switch (tone) {
    case 'blue':    return chalk.hex(ctp.blue)(label);
    case 'teal':    return chalk.hex(ctp.teal)(label);
    case 'green':   return chalk.hex(ctp.green)(label);
    case 'yellow':  return chalk.hex(ctp.yellow)(label);
    case 'peach':   return chalk.hex(ctp.peach)(label);
    case 'pink':    return chalk.hex(ctp.pink)(label);
    case 'mauve':   return chalk.hex(ctp.mauve)(label);
    case 'subtext': return chalk.hex(ctp.subtext1)(label);
    case 'overlay': return chalk.hex(ctp.overlay2)(label);
    case 'dim':
    default:        return chalk.hex(ctp.subtext1)(label);
  }
}

/** Strong-text renderer for primary status anchors. Same palette as
 *  `text()` but bold so the line reads closer to Claude Code's header
 *  hierarchy without reintroducing filled backgrounds. */
function strongText(label: string, tone: StatusTone, opts: StatusBarRenderOptions = {}): string {
  if (opts.theme) {
    return chalk.hex(statusToneColor(tone, opts.theme)).bold(label);
  }
  switch (tone) {
    case 'blue':    return chalk.hex(ctp.blue).bold(label);
    case 'teal':    return chalk.hex(ctp.teal).bold(label);
    case 'green':   return chalk.hex(ctp.green).bold(label);
    case 'yellow':  return chalk.hex(ctp.yellow).bold(label);
    case 'peach':   return chalk.hex(ctp.peach).bold(label);
    case 'pink':    return chalk.hex(ctp.pink).bold(label);
    case 'mauve':   return chalk.hex(ctp.mauve).bold(label);
    case 'subtext': return chalk.hex(ctp.text).bold(label);
    case 'overlay': return chalk.hex(ctp.subtext0).bold(label);
    case 'dim':
    default:        return chalk.hex(ctp.text).bold(label);
  }
}

function statusToneColor(tone: StatusTone, theme: ThemeTokens): string {
  const t = theme ?? DEFAULT_THEME_TOKENS;
  switch (tone) {
    case 'blue': return t.colors.info;
    case 'pink': return t.colors.highlight;
    case 'green': return t.colors.success;
    case 'yellow': return t.colors.warning;
    case 'peach': return t.colors.accent;
    case 'teal': return t.colors.info;
    case 'mauve': return t.colors.highlight;
    case 'subtext': return t.colors.text;
    case 'overlay':
    case 'dim':
    default: return t.colors.muted;
  }
}

// ── Individual segment renderers ────────────────────────────────────

/** Working-dir pill — folder icon + basename. Pass an absolute path;
 *  we trim to basename(path) so pill stays compact even deep in a
 *  tree. Home directory collapses to "~". */
export function workingDirSegment(cwd: string, opts: StatusBarRenderOptions = {}): string {
  const home = process.env.HOME ?? '';
  const short = home && cwd === home ? '~'
    : home && cwd.startsWith(home + '/') ? basename(cwd) || '~'
    : basename(cwd) || cwd;
  return pill(`📁 ${short}`, 'blue', opts);
}

/** Session working-directory pill — full ~-collapsed path with a
 *  `swd:` prefix so the user can distinguish it from the browser
 *  pane's basename at a glance. Peach tone sits between the blue
 *  browser-wd pill (if any caller still uses one) and the pink model
 *  pill, signalling "this is the active build/edit target".
 *
 *  Middle-elides when the collapsed path exceeds `maxLen` (default
 *  48) so the status bar stays one-line on a standard 120-col term. */
export function sessionCwdSegment(cwd: string, opts: StatusBarRenderOptions = {}, maxLen = 48): string {
  let short = compactPathLabel(cwd);
  if (short.length > maxLen) {
    const parts = short.split('/');
    if (parts.length > 2) short = `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }
  const [parent, current] = splitCompactPathLabel(short);
  const bg = opts.theme ? '#4a4f63' : ctp.surface1;
  const iconFg = opts.theme ? '#b8c0dc' : ctp.subtext1;
  const parentFg = opts.theme ? '#c4cbe4' : ctp.subtext1;
  const slashFg = opts.theme ? '#8f96af' : ctp.overlay1;
  const currentFg = opts.theme ? '#dde3f7' : ctp.text;
  return [
    chalk.bgHex(bg).hex(iconFg).bold(' 📁 '),
    chalk.bgHex(bg).hex(parentFg).bold(parent),
    current ? chalk.bgHex(bg).hex(slashFg).bold('/') : '',
    current ? chalk.bgHex(bg).hex(currentFg).bold(current) : '',
    chalk.bgHex(bg)(' '),
  ].join('');
}

/** Git status surface the pill renders. Branch is the sync value
 *  (cheap FS read); dirty / aheadBehind are optional async probes.
 *  All fields optional so callers can render a partial view during
 *  the first draw before the probe completes. */
export interface GitSegmentState {
  branch?: string | null;
  /** Detached HEAD — caller passes the 7-char SHA; pill shows "HEAD@abcd123". */
  detachedSha?: string | null;
  /** Total count of dirty entries (modified + staged + untracked).
   *  0 = clean → dim tone. >0 → yellow tone with "*N" suffix. */
  dirtyTotal?: number;
  /** Commits ahead of upstream. Non-zero → peach tone with "+N". */
  ahead?: number;
  /** Commits behind upstream. Non-zero → peach tone with "-N". */
  behind?: number;
  /** Optional axis label after the glyph (e.g. `트리`) — set when a
   *  running-build pill sits next to it so the two SHAs are not confused. */
  label?: string;
}

/** Git state — flat colored text. No pill background.
 *
 *     no git             — cwd is outside any repo (overlay, very muted)
 *     ⌥ main             — clean branch (teal, calm accent)
 *     ⌥ main *3          — 3 dirty entries (yellow)
 *     ⌥ main +2          — 2 commits ahead of upstream (peach)
 *     ⌥ main -1          — 1 commit behind upstream (peach)
 *     ⌥ main *3 +2       — both dirty and ahead (yellow — dirty wins)
 *     ⌥ HEAD@abcd123     — detached HEAD (overlay)
 *
 *  Backwards-compat: the legacy 2-arg form `gitSegment(cwd, 'main')`
 *  still works — the second arg is coerced into { branch }. */
export function gitSegment(
  cwd: string,
  stateOrBranch?: GitSegmentState | string | undefined,
  opts: StatusBarRenderOptions = {},
): string {
  const state: GitSegmentState = typeof stateOrBranch === 'string'
    ? { branch: stateOrBranch }
    : (stateOrBranch ?? {});

  if (!state.branch && !state.detachedSha) return text('no git', 'overlay', opts);

  const head = state.branch
    ? truncateGitHead(state.branch, 20)
    : `HEAD@${(state.detachedSha ?? '').slice(0, 7)}`;
  const parts: string[] = [state.label ? `⌥ ${state.label} ${head}` : `⌥ ${head}`];
  const dirty = Math.max(0, state.dirtyTotal ?? 0);
  if (dirty > 0) parts.push(`*${dirty}`);
  if ((state.ahead ?? 0) > 0) parts.push(`+${state.ahead}`);
  if ((state.behind ?? 0) > 0) parts.push(`-${state.behind}`);

  const tone: StatusTone = state.detachedSha
    ? 'overlay'
    : dirty > 0
      ? 'yellow'
      : (state.ahead ?? 0) > 0 || (state.behind ?? 0) > 0
        ? 'peach'
        : 'teal';

  return tone === 'overlay'
    ? text(parts.join(' '), tone, opts)
    : strongText(parts.join(' '), tone, opts);
}

/** The code this TUI process loaded at boot (not the session tree HEAD). */
export interface RunningBuildState {
  /** Boot commit (full or short); '' = unknown (rendered as `?`). */
  sha: string;
  /** True when the installed/checkout code moved after boot — a relaunch runs the new build.
   *  null = could not compare (not the same as «not stale»). */
  stale: boolean | null;
  /** The commit a relaunch would run, when known. */
  currentSha?: string;
}

/** Running-build pill.
 *
 *     ▶ 실행 5c0f98f                         — boot build matches current code (overlay)
 *     ▶ 실행 5c0f98f ⟳ 재기동 필요 → 1a2b3c4  — code moved after boot (yellow, bold)
 *     ▶ 실행 5c0f98f ?                        — could not compare (overlay)
 *     ▶ 실행 ?                                — boot build unknown (overlay) */
export function runningBuildSegment(state: RunningBuildState | null | undefined, opts: StatusBarRenderOptions = {}): string {
  if (!state) return '';
  if (!state.sha) return text('▶ 실행 ?', 'overlay', opts);
  const label = `▶ 실행 ${state.sha.slice(0, 7)}`;
  if (state.stale === null) return text(`${label} ?`, 'overlay', opts);
  if (!state.stale) return text(label, 'overlay', opts);
  const target = state.currentSha ? ` → ${state.currentSha.slice(0, 7)}` : '';
  return strongText(`${label} ⟳ 재기동 필요${target}`, 'yellow', opts);
}

/** Truncate a model id at the first parameter-size marker (e.g.
 *  `qwen3.6-35b-a3b-ud-mlx` → `qwen3.6-35b`). The marker pattern
 *  matches one or more digits followed by `b`/`B` (e.g. `7b`, `35b`,
 *  `72b`, `120B`). Returns the input unchanged when no marker is
 *  present (e.g. `claude-opus-4-6`, `grok-4.3`). 2026-05-05. */
function truncateAtParamSize(model: string): string {
  const m = model.match(/^(.*?\d+[bB])(?=[^a-zA-Z0-9]|$)/);
  return m ? m[1]! : model;
}

/** Current active LLM model pill. Pink matches Claude Code's palette.
 *
 *  2026-05-05 — provider name omitted (cloud) / `<node>:<model>` for
 *  local. Node name (e.g. `local`, `node-b`) doubles as the local-LLM
 *  indicator (cloud entries have no `<node>:` prefix). When
 *  `opts.compact` is true (caller decides via terminal width), the
 *  model id portion truncates at the first parameter-size marker.
 *
 *  Render shape examples:
 *   - Cloud:                       `claude-opus-4-6`, `grok-4.3`
 *   - Local (multi-node spec):     `local:qwen3.6-35b-a3b-ud-mlx`
 *                                  `node-b:qwen2.5-72b-instruct`
 *   - Local (legacy `local:<m>`):  `local:llama-3-8b` (unchanged)
 *   - Local (bare model):          `local:tinyllama-1b`
 *   - No model:                    bare provider name fallback.
 *  With `compact: true`:
 *   - `local:qwen3.6-35b-a3b-ud-mlx` → `local:qwen3.6-35b`
 *   - `node-b:qwen2.5-72b-instruct`    → `node-b:qwen2.5-72b`
 *   - `claude-opus-4-6`              → unchanged (no `\d+b` marker) */
export function modelSegment(info: Pick<ActiveProviderInfo, 'provider' | 'model'>, opts: StatusBarRenderOptions = {}): string {
  if (!info.model || info.model === '(none)') {
    return strongText(info.provider, 'pink', opts);
  }
  // Step 1 — derive the display string with node prefix when local.
  let display: string;
  let model = info.model;
  if (model.startsWith('local-llm:')) {
    const rest = model.slice('local-llm:'.length);
    display = rest.includes(':') ? rest : `local:${rest}`;
  } else if (model.startsWith('local:')) {
    display = model;
  } else if (info.provider === 'local') {
    display = `local:${model}`;
  } else {
    display = model;
  }
  // Step 2 — apply compact truncation. For `<node>:<modelId>` format
  // the truncation rule applies to the model portion only; the node
  // prefix stays so local-vs-cloud distinction survives.
  if (opts.compact) {
    const colonIdx = display.indexOf(':');
    if (colonIdx >= 0) {
      const node = display.slice(0, colonIdx);
      const modelPart = display.slice(colonIdx + 1);
      display = `${node}:${truncateAtParamSize(modelPart)}`;
    } else {
      display = truncateAtParamSize(display);
    }
  }
  return strongText(display, 'pink', opts);
}

export function contextUsageSegment(usedTokens: number, opts: StatusBarRenderOptions = {}): string {
  const safe = Math.max(0, usedTokens | 0);
  return strongText(`ctx ${formatTokenK(safe)}`, 'teal', opts);
}

export function tmuxSegment(tmuxLabel: string | null | undefined, opts: StatusBarRenderOptions = {}): string {
  if (!tmuxLabel) return '';
  return strongText(`🪟 ${tmuxLabel}`, 'mauve', opts);
}

export function sshSegment(sshLabel: string | null | undefined, opts: StatusBarRenderOptions = {}): string {
  if (!sshLabel) return '';
  return strongText(`↔ ${sshLabel}`, 'yellow', opts);
}

export function hostSegment(host: string | null | undefined, opts: StatusBarRenderOptions = {}): string {
  if (!host) return '';
  return text(`🖥 ${host}`, 'teal', opts);
}

export function attachmentContextSizeSegment(totalBytes: number, opts: StatusBarRenderOptions = {}): string {
  const safe = Math.max(0, totalBytes | 0);
  return text(`attach ${sizeStr(safe)}`, 'overlay', opts);
}

/** Context-bar: visual indicator of how much of the token budget
 *  the current conversation uses. 20-column bar by default. */
export function ctxBarSegment(used: number, max: number, width = 20): string {
  if (max <= 0) return '';
  const ratio = Math.max(0, Math.min(1, used / max));
  const filled = Math.round(ratio * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const pctRemain = Math.round((1 - ratio) * 100);
  const usedK = `${(used / 1000).toFixed(1)}k`;
  const maxK = `${(max / 1000).toFixed(0)}k`;
  return `CTX [${bar}] ${pctRemain}% remain (${usedK}/${maxK})`;
}

/** Elapsed-time — "3s" / "2m 14s" / "1h 03m". Flat subtext color.
 *
 *  2026-04-28 (PR-5 of expression Tier S+A migrations) — internal
 *  rendering switched to expression `renderStatusModule`. Visual
 *  identity preserved by passing the icon inside the `text` field
 *  (renderStatusModule's inline style only inserts a separator when
 *  BOTH icon and text are non-empty). The `style.fg` carries the
 *  resolved subtext color so legacy + theme-aware paths converge on
 *  one renderer that emits raw SGR (chalk-environment-deterministic).
 */
export function elapsedSegment(seconds: number, opts: StatusBarRenderOptions = {}): string {
  let label: string;
  if (seconds < 60) {
    label = `⏱ ${Math.round(seconds)}s`;
  } else if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    label = `⏱ ${m}m ${s}s`;
  } else {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    label = `⏱ ${h}h ${String(m).padStart(2, '0')}m`;
  }
  const fg = opts.theme
    ? statusToneColor('subtext', opts.theme)
    : ctp.subtext1;
  return renderStatusModule(
    { kind: 'status-module', id: 'elapsed', text: label, style: { fg } },
    'truecolor',
    { style: 'inline' },
  );
}

/** Rough USD cost — formatted to two decimals. Flat subtext.
 *
 *  2026-04-28 (Pick A PR-S1 of expression callsite migration) — internal
 *  rendering switched to expression `renderStatusModule`, mirroring the
 *  elapsedSegment pattern (PR #911). Icon stays inside the text field so
 *  inline-style emits no extra separator; `style.fg` carries the resolved
 *  subtext color (raw SGR · chalk-environment-deterministic). */
export function costSegment(usd: number, opts: StatusBarRenderOptions = {}, unpricedTurns = 0): string {
  // ⭐ BACKLOG C9 — 단가를 모르는 턴이 있으면 합계는 «하한»이다: `+?` 로 드러낸다(모름을 0 으로 숨기지 않는다).
  const label = `💰 $${usd.toFixed(2)}${unpricedTurns > 0 ? '+?' : ''}`;
  const fg = opts.theme
    ? statusToneColor('subtext', opts.theme)
    : ctp.subtext1;
  return renderStatusModule(
    { kind: 'status-module', id: 'cost', text: label, style: { fg } },
    'truecolor',
    { style: 'inline' },
  );
}

/** Tokens-per-second average over the last turn (or '--' when n/a).
 *  Flat subtext.
 *
 *  2026-04-28 (Pick A PR-S1) — `renderStatusModule` migration (same
 *  pattern as costSegment / elapsedSegment). */
export function speedSegment(tps: number | null, opts: StatusBarRenderOptions = {}): string {
  const tail = tps == null || !Number.isFinite(tps) ? '--t/s' : `${tps.toFixed(1)}t/s`;
  const label = `🚀 ${tail}`;
  const fg = opts.theme
    ? statusToneColor('subtext', opts.theme)
    : ctp.subtext1;
  return renderStatusModule(
    { kind: 'status-module', id: 'speed', text: label, style: { fg } },
    'truecolor',
    { style: 'inline' },
  );
}

/** Prompt-cache hit-rate segment — `💾 78%` / `💾 --`. Color follows
 *  the hit threshold: ≥70% green (cache paying off), 30–69% subtext
 *  (in-between), <30% yellow (warming up or something wrong). */
export function cacheSegment(pct: number | null, opts: StatusBarRenderOptions = {}): string {
  const label = pct === null ? '💾 --' : `💾 ${pct}%`;
  const tone: StatusTone =
    pct === null ? 'subtext'
    : pct >= 70 ? 'green'
    : pct >= 30 ? 'subtext'
    : 'yellow';
  return text(label, tone, opts);
}

/** VW-U1 — Virtual-window indicator.
 *
 *  Shape: `🪟 win:N·P/T` (mauve flat text).
 *    N  — foreground window id
 *    P  — 1-based index of focused pane within the window
 *    T  — total pane count in the window
 *  When `zoomed` is true the payload becomes `win:N·[zoomed P/T]` so
 *  the user sees a single pane has been expanded. When there's exactly
 *  one window with exactly one pane the segment collapses to '' — no
 *  useful signal, don't waste status-bar cells. Pass `windowTotal > 1`
 *  if you want to keep the indicator visible even in a single-pane
 *  scenario (e.g. to convey "there are 3 windows, you're on win:2"). */
export interface VwSummary {
  windowId: number;
  paneIdx: number;     // 1-based
  paneTotal: number;
  windowTotal: number;
  zoomed?: boolean;
}

/** P4 follow-up — current operating mode (general / sync / control).
 *  Rendered as a flat colored text segment (not a filled pill) so it
 *  sits between workingDir and model without competing for the
 *  anchor-pill aesthetic: teal for sync, mauve for control, subtext
 *  for general (muted when it's the default).
 *
 *  `'general'` returns '' so callers can freely splice. `'sync'` and
 *  `'control'` render `◆ sync` / `◆ control`. Click handling is wired
 *  in dashboard-mouse-wiring — this renderer stays pure. */
export function modeSegment(
  mode: 'general' | 'sync' | 'control',
  opts: StatusBarRenderOptions = {},
): string {
  if (mode === 'general') return '';
  const tone: StatusTone = mode === 'sync' ? 'teal' : 'mauve';
  return text(`◆ ${mode}`, tone, opts);
}

/** PR-S1V.5 (2026-04-29) — Voice cost telemetry segment.
 *
 *  Renders the month-to-date STT/TTS USD spend so the user sees a
 *  running total above the chat input. `usdMonth <= 0` returns ''
 *  (typical when voice mode is unused this month) so the secondary
 *  status row stays uncluttered. Mauve flat text — same family as
 *  `voiceSegment` so the voice-related pills cluster visually.
 *
 *  Reference: PLAN-pr-s1v5-pwa-voice-wiring-2026-04-29.md §4.3.3.
 */
export function voiceCostSegment(
  usdMonth: number,
  opts: StatusBarRenderOptions = {},
): string {
  if (!Number.isFinite(usdMonth) || usdMonth <= 0) return '';
  const formatted = usdMonth < 0.01 ? '<$0.01' : `$${usdMonth.toFixed(2)}`;
  return text(`🎙 ${formatted}/mo`, 'mauve', opts);
}

/** PR-S1V.4-wiring (2026-04-29) — Voice mode indicator segment.
 *
 *  Receives a label such as "🎙 Voice mode" / "🔴 Recording" /
 *  "✨ Transcribing" / "✖ send failed" already chosen by the dashboard
 *  (which owns the voiceInputHost.onIndicatorChange subscription) and
 *  renders it as flat colored text. `null` / empty string → returns ''
 *  so the caller can splice into the pill row unconditionally and the
 *  segment disappears when voice mode is idle.
 *
 *  Tone choice: mauve text — same family as the `vw` pill so voice +
 *  vw read as "runtime activity" cluster. The `✖ send failed` label is
 *  intentionally rendered in the same tone as the rest of the segment;
 *  the X glyph carries the "something went wrong" signal without us
 *  reaching for a red background that would clash with the rest of the
 *  status row's flat-text aesthetic.
 */
export function voiceSegment(
  label: string | null | undefined,
  opts: StatusBarRenderOptions = {},
): string {
  if (!label) return '';
  return text(label, 'mauve', opts);
}

/** Running child-agent count. Hidden when no agents are running so the
 * status line only spends space on active background work. */
export function runningAgentsSegment(
  running: number,
  opts: StatusBarRenderOptions = {},
): string {
  if (!Number.isFinite(running) || running <= 0) return '';
  const count = Math.floor(running);
  return renderStatusModule(
    {
      kind: 'status-module',
      id: 'running-agents',
      text: `◇ ${count} agent${count === 1 ? '' : 's'}`,
      style: { fg: opts.theme ? statusToneColor('peach', opts.theme) : ctp.peach },
    },
    'truecolor',
    { style: 'inline' },
  );
}

/** External controller identity. Hidden when the process is not externally controlled. */
export function controllerSegment(
  controller: string | null | undefined,
  opts: StatusBarRenderOptions = {},
): string {
  const trimmed = controller?.trim();
  if (!trimmed) return '';
  const label = trimmed.length > 24 ? `${trimmed.slice(0, 23)}…` : trimmed;
  return renderStatusModule(
    {
      kind: 'status-module',
      id: 'controller',
      text: `⛭ ${label}`,
      style: { fg: opts.theme ? statusToneColor('mauve', opts.theme) : ctp.mauve },
    },
    'truecolor',
    { style: 'inline' },
  );
}

export function vwSegment(summary: VwSummary | null, opts: StatusBarRenderOptions = {}): string {
  if (!summary) return '';
  if (summary.windowTotal <= 1 && summary.paneTotal <= 1) return '';
  const body = summary.zoomed
    ? `win:${summary.windowId}·[zoomed ${summary.paneIdx}/${summary.paneTotal}]`
    : `win:${summary.windowId}·${summary.paneIdx}/${summary.paneTotal}`;
  return text(`🪟 ${body}`, 'mauve', opts);
}

/** Background PTY shell count — `⚡ N shell(s)`. Returns '' when live
 *  is 0 so callers can freely splice into the pill row without checking
 *  first. Mirrors codex `unified_exec_footer` — always-visible so the
 *  user knows what's running even if the LLM forgot to surface it.
 *  Yellow flat text: "activity" signal without shouting. */
export function ptyShellCountSegment(live: number, opts: StatusBarRenderOptions = {}): string {
  if (live <= 0) return '';
  const label = `⚡ ${live} shell${live > 1 ? 's' : ''}`;
  // 2026-04-28 (Pick A PR-S1) — `renderStatusModule` migration. Yellow
  // tone resolves through `statusToneColor('yellow', theme)` (= warning)
  // for theme-aware path; legacy fallback uses `ctp.yellow` directly.
  const fg = opts.theme
    ? statusToneColor('yellow', opts.theme)
    : ctp.yellow;
  return renderStatusModule(
    { kind: 'status-module', id: 'pty-shell-count', text: label, style: { fg } },
    'truecolor',
    { style: 'inline' },
  );
}

/** SP-B — ShellRegistry rollup summary. Reads BackgroundSurface's
 *  aggregate counts and renders one flat-text segment next to the
 *  PTY shell pill:
 *
 *      🐚 2▶ 1⏸     — 2 running, 1 backgrounded
 *      🐚 1▶        — just 1 running
 *      🐚 3⏸        — 3 bg, none running
 *      (empty)     — no live shell-runner handles
 *
 *  Completed handles are deliberately NOT shown — they stay for 30s
 *  inside BackgroundSurface for tail-read but don't deserve status-bar
 *  real estate. Caller should pass the `BgRollup` via the surface's
 *  onUpdate callback (keeps renderer pure). */
export interface ShellRollupSummary {
  running: number;
  backgrounded: number;
}

export function shellRollupSegment(
  rollup: ShellRollupSummary,
  opts: StatusBarRenderOptions = {},
): string {
  const running = Math.max(0, rollup.running | 0);
  const bg = Math.max(0, rollup.backgrounded | 0);
  if (running === 0 && bg === 0) return '';
  const parts: string[] = [];
  if (running > 0) parts.push(`${running}▶`);
  if (bg > 0) parts.push(`${bg}⏸`);
  // Running has primary signal weight → yellow. Pure-bg only → peach
  // (same "activity" family but less shouty since nothing's live).
  const tone: StatusTone = running > 0 ? 'yellow' : 'peach';
  return text(`🐚 ${parts.join(' ')}`, tone, opts);
}

/** TUI-BG-JOB-VISIBILITY (#71) — 턴이 끝난 뒤에도 남는 백그라운드 일을 상태줄에서 보이게 한다.
 *
 *  🚨 10-16 07:3x OPT 가 «남은 리뷰 4건 실행 중 · 다음 점검 = …» 로 턴을 «✔ 완료» 로 끝내자
 *     바깥에선 «12분 유휴» 로 보였다.
 *
 *      ⧗ 백그라운드 2   — 등록된(ShellRegistry) 백그라운드 일 2개가 돈다
 *      (빈 문자열)       — 0 · 끝나면 사라진다
 *
 *  `background` = 살아 있는 bg 모드 핸들 ⊕ backgrounded(인라인 전경 실행은 안 셈 — 그건 🐚 몫).
 *  명령 안 `&`·`nohup` 으로 떼어 낸 프로세스는 등록되지 않아 여기 안 잡힌다.
 *  깨우기(끝나면 턴을 여는 것)는 이 세그먼트 몫이 아니다 — TUI-AGENT-IDLE-WAKE 칸.
 *  `runningAgentsSegment` 와 같은 꼴 · 같은 색 계열(peach). */
export interface BackgroundJobsSummary {
  background: number;
}

export function backgroundJobsSegment(
  summary: BackgroundJobsSummary | null | undefined,
  opts: StatusBarRenderOptions = {},
): string {
  if (!summary) return '';
  const live = Number.isFinite(summary.background) ? Math.max(0, Math.floor(summary.background)) : 0;
  if (live <= 0) return '';
  return text(`⧗ 백그라운드 ${live}`, 'peach', opts);
}

export type DockStripDensity = 'full' | 'compact' | 'count-only';

export interface DockStripSegmentOptions extends StatusBarRenderOptions {
  density?: DockStripDensity;
  maxLabelWidth?: number;
  dormantCount?: number;
}

export interface ConversationPopupSummary {
  liveCount: number;
  minimizedCount?: number;
  layoutMode?: 'cascade' | 'tile' | 'stack';
}

/** U6 Bundle B — compact dock strip shell summary.
 *
 *  Shape:
 *    🗂 2 docked
 *    🗂 3 docked · Model
 *
 *  Meant to be a compact shell, not the full strip. It gives the
 *  user a stable "there are parked windows here" affordance on the
 *  status bar, while the actual restore UI lives behind the click.
 */
export function dockStripSegment(
  dockedCount: number,
  firstLabel?: string | null,
  opts: DockStripSegmentOptions = {},
): string {
  const dormantCount = Math.max(0, opts.dormantCount ?? 0);
  const total = dockedCount + dormantCount;
  if (total <= 0) return '';
  const density = opts.density ?? 'full';
  const summary = density === 'count-only'
    ? `🗂 ${total}`
    : density === 'compact'
      ? `🗂 ${total} parked`
      : `🗂 ${dockStripDetail(dockedCount, dormantCount)}`;
  const hint = density === 'full' && firstLabel
    ? ` · ${truncateDockLabel(firstLabel, opts.maxLabelWidth ?? 16)}`
    : '';
  return text(summary + hint, 'peach', opts);
}

export function workspaceDockDensityForCols(cols: number): DockStripDensity {
  if (cols < 80) return 'count-only';
  if (cols < 120) return 'compact';
  return 'full';
}

export function conversationPopupSegment(
  summary: ConversationPopupSummary | null | undefined,
  opts: StatusBarRenderOptions = {},
): string {
  if (!summary) return '';
  const live = Math.max(0, summary.liveCount);
  const minimized = Math.max(0, summary.minimizedCount ?? 0);
  const total = live + minimized;
  if (total <= 0) return '';
  const detail = minimized > 0 ? ` ${live}+${minimized}` : ` ${live}`;
  const mode = summary.layoutMode ? `·${summary.layoutMode}` : '';
  return text(`💬${detail}${mode}`, 'mauve', opts);
}

/** PR-CL4 (B.4) — ACP submit lifecycle pill. `summary.active` counts
 *  in-flight `clientSessionSend` calls across every ACP pane; the
 *  `degraded` flag flips when rolling p95 of submit→first-update
 *  exceeds 1.5s (production gate). Renders as flat-text in the same
 *  style family as `shellRollupSegment`. */
export interface AcpSendingSegmentInput {
  active: number;
  degraded: boolean;
}

export function acpSendingSegment(
  input: AcpSendingSegmentInput | null | undefined,
  opts: StatusBarRenderOptions = {},
): string {
  if (!input) return '';
  const active = Math.max(0, input.active | 0);
  if (active <= 0) return '';
  // peach when the rolling p95 says the fleet is slow — same tone we
  // use for the pty shell rollup's "running" lane to keep the hint
  // language consistent. Fast/healthy state stays mauve so it reads
  // as "informational, not alarming".
  const tone: StatusTone = input.degraded ? 'peach' : 'mauve';
  return text(`acp:${active}⏳`, tone, opts);
}

function truncateDockLabel(label: string, maxWidth: number): string {
  const trimmed = label.trim();
  if (!trimmed) return '';
  if (visibleWidth(trimmed) <= maxWidth) return trimmed;
  if (maxWidth <= 1) return '…';
  let out = '';
  for (const ch of trimmed) {
    if (visibleWidth(out + ch) > maxWidth - 1) break;
    out += ch;
  }
  return `${out}…`;
}

function dockStripDetail(dockedCount: number, dormantCount: number): string {
  const parts: string[] = [];
  if (dockedCount > 0) parts.push(`${dockedCount} docked`);
  if (dormantCount > 0) parts.push(`${dormantCount} dormant`);
  return parts.join(' · ');
}

// ── Composite ───────────────────────────────────────────────────────

export interface StatusBarState {
  cwd: string;
  providerInfo: ActiveProviderInfo;
  gitBranch?: string;
  contextUsedTokens?: number;
  tmuxLabel?: string | null;
  sshLabel?: string | null;
  host?: string | null;
  /** When defined, rendered as a CTX bar on a secondary line. */
  ctx?: { used: number; max: number };
  /** Turn elapsed seconds (optional). */
  elapsedSec?: number;
  /** Cumulative session cost in USD (optional). */
  costUsd?: number;
  /** Recent tokens/second average (optional). */
  tokensPerSec?: number | null;
}

/** Render the primary status line — the must-have (swd + git + model)
 *  plus optional stats when the caller passes them. One long string
 *  with space separators; caller is responsible for truncation.
 *
 *  WD2 — `state.cwd` is now understood as the session working
 *  directory (SWD). Callers pass `getSessionCwd()` here; the pill
 *  renders the full ~-collapsed path (peach tone) instead of just
 *  the basename. */
export function renderPrimaryStatus(state: StatusBarState, opts: StatusBarRenderOptions = {}): string {
  const parts = [
    sessionCwdSegment(state.cwd, opts),
    gitSegment(state.cwd, state.gitBranch, opts),
    modelSegment(state.providerInfo, opts),
  ];
  if (typeof state.contextUsedTokens === 'number') parts.push(contextUsageSegment(state.contextUsedTokens, opts));
  if (state.host) parts.push(hostSegment(state.host, opts));
  if (state.tmuxLabel) parts.push(tmuxSegment(state.tmuxLabel, opts));
  else if (state.sshLabel) parts.push(sshSegment(state.sshLabel, opts));
  if (typeof state.elapsedSec === 'number') parts.push(elapsedSegment(state.elapsedSec, opts));
  return parts.join(STATUS_SEGMENT_SEPARATOR);
}

/** Render the secondary line (CTX bar + money + speed). Returns ''
 *  when no stats are provided — caller should then skip drawing this
 *  row entirely. */
export function renderSecondaryStatus(state: StatusBarState, opts: StatusBarRenderOptions = {}): string {
  const parts: string[] = [];
  if (state.ctx) parts.push(ctxBarSegment(state.ctx.used, state.ctx.max));
  if (typeof state.costUsd === 'number') parts.push(costSegment(state.costUsd, opts));
  if (state.tokensPerSec !== undefined) parts.push(speedSegment(state.tokensPerSec, opts));
  return parts.join('  ');
}

/** Both lines as an array. Empty lines filtered. Useful for HUD-style
 *  multi-line rendering. */
export function renderStatusLines(state: StatusBarState, opts: StatusBarRenderOptions = {}): string[] {
  const primary = renderPrimaryStatus(state, opts);
  const secondary = renderSecondaryStatus(state, opts);
  return [primary, secondary].filter(Boolean);
}

function compactPathLabel(cwd: string): string {
  const home = process.env.HOME ?? '';
  if (home && cwd === home) return '~';
  const normalized = home && cwd.startsWith(home + '/')
    ? `~${cwd.slice(home.length)}`
    : cwd;
  const parts = normalized.split('/').filter(Boolean);
  if (normalized.startsWith('~/')) {
    if (parts.length <= 2) return normalized;
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }
  if (parts.length === 0) return '/';
  if (parts.length === 1) return normalized.startsWith('/') ? `/${parts[0]}` : parts[0]!;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function splitCompactPathLabel(label: string): [string, string] {
  const idx = label.lastIndexOf('/');
  if (idx <= 0 || idx === label.length - 1) return [label, ''];
  return [label.slice(0, idx), label.slice(idx + 1)];
}

function formatTokenK(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${Math.round(tokens / 1000)}k`;
}

function truncateGitHead(head: string, maxLen = 28): string {
  if (head.length <= maxLen) return head;
  if (maxLen <= 1) return '…';
  return `${head.slice(0, maxLen - 1)}…`;
}
