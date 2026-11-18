// STATUSLINE-WIRE (대표 11-17) — the Next TUI footer drawn from the declarative status line (src/statusline).
// entry.ts only creates this once and asks it for the footer text; the facts come from the same input the old footer
// used, plus the working directory and the running build (version + official/dev channel).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { nextTuiShortStatus, type NextTuiStatusLineInput } from '../tui/chat/status-line.js';
import { fitLogLine } from '../tui/chat/log-view.js';
import { renderStatusline, STATUSLINE_SEPARATOR, type StatuslineRenderedSegment, type StatuslineSnapshot } from './evaluate.js';
import { defaultStatuslineDefinition, snapshotFromLegacyStatus } from './legacy-parity.js';
import { locateStatuslineIssue, mergeStatuslineLayers, parseStatuslineYaml, type StatuslineLoadIssue } from './load.js';
import { versionLabel } from '../version/build-stamp.js';
import { machinesSnapshot, type FleetValue } from './sources/machines.js';
import { STATUSLINE_DEFAULT_POSITION, statuslineBreakpoints, statuslineWidthBand, type StatuslineDefinition } from './schema.js';

/** The running build as `runningBuild()` reports it (src/pty-shell/tui-run-state.ts), plus its commit time when known. */
export interface StatuslineBuild {
  readonly version: string;
  readonly sha: string;
  readonly source: 'installed' | 'checkout' | 'unknown';
  /** Committer time of the build commit (epoch seconds) — dev builds show it as yymmdd_hhmm KST. */
  readonly commitTime?: number;
}

// 출처: the md/lg footer keeps the cwd to about a third of an 80-column line; deeper paths keep their tail.
const CWD_MAX_CELLS = 28;
// 출처: the short cwd («줄인 꼴», OP 11-17) is one folder name; a long one is cut so the version keeps its room on narrow
// footers (a 40-column xs line holds a short turn, this and `261117_1925·dev`).
const CWD_LEAF_MAX_CELLS = 16;

function capCells(text: string, max: number): string {
  return Bun.stringWidth(text) <= max ? text : `${fitLogLine(text, max - 1)}…`;
}

/** `~` for the home directory; a long path keeps its tail (`…/repo/src/tui`); `leaf` is the last folder. */
export function displayCwd(cwd: string, home: string = homedir(), maxCells = CWD_MAX_CELLS): { readonly full: string; readonly leaf: string } {
  const homed = home && (cwd === home || cwd.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : cwd;
  const parts = homed.split('/').filter(Boolean);
  const leaf = capCells(parts.at(-1) ?? homed, CWD_LEAF_MAX_CELLS);
  if (Bun.stringWidth(homed) <= maxCells) return { full: homed, leaf };
  let tail = leaf;
  for (let index = parts.length - 2; index >= 0; index--) {
    const next = `${parts[index]}/${tail}`;
    if (Bun.stringWidth(`…/${next}`) > maxCells) break;
    tail = next;
  }
  return { full: `…/${tail}`, leaf };
}

function shortPieces(input: NextTuiStatusLineInput): Record<string, string> {
  const short = nextTuiShortStatus(input);
  return { turn_short: short.turn, exception: short.exception ? 'yes' : 'no', model_short: short.model, rest_short: short.rest };
}

export function nextTuiStatuslineSnapshot(input: NextTuiStatusLineInput, cwd: string, build: StatuslineBuild, home?: string, fleet?: FleetValue): StatuslineSnapshot {
  const legacy = snapshotFromLegacyStatus(input);
  const shown = displayCwd(cwd, home);
  const channel = versionLabel(build, build.commitTime);
  return {
    ...legacy,
    // `facts`: the footer as it was, with its own width fallbacks for the full width (the new segments only take what is left).
    session: { ...legacy.session, ...shortPieces(input), cwd: shown.full, cwd_leaf: shown.leaf },
    build: { label: channel.label, short: channel.short, channel: channel.channel, version: build.version },
    // No poller (or not started yet): no `machines` at all, so the fleet segment is not drawn.
    ...(fleet ? { machines: machinesSnapshot(fleet) } : {}),
  };
}

/** <state>/statusline.yaml — ~/.elanous/statusline.yaml for the installed universe, the isolated root in tests. */
export function statuslineUserPath(stateRoot: string = elanousStateRoot()): string {
  return join(stateRoot, 'statusline.yaml');
}

/**
 * The definition to draw with: the user's statusline.yaml over the default, or the default with a one-line warning
 * when that file cannot be read, does not parse, or does not merge.
 */
export function loadNextTuiStatusline(path: string = statuslineUserPath(), readText: (path: string) => string = (file) => readFileSync(file, 'utf8')): { readonly definition: StatuslineDefinition; readonly warning?: string } {
  const base = defaultStatuslineDefinition();
  const fallback = (why: string) => ({ definition: base, warning: `Status line: ${path} ${why} — using the default` });
  let text: string;
  try { text = readText(path); } catch (error) {
    // Only «no such file» is the quiet default; a permission or other read error is said once.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { definition: base };
    return fallback(`cannot be read (${error instanceof Error ? error.message : String(error)})`);
  }
  const verdict = judgeNextTuiStatusline(text);
  return verdict.ok ? { definition: verdict.definition } : fallback(verdict.why);
}

/**
 * The one judgement of a statusline.yaml text the Next TUI draws with — `loadNextTuiStatusline` and
 * `eln statusline validate` both use it, so validate never passes a file the TUI refuses (#38316 REVIEW-1):
 * parse (issues with their lines) → merge over the default (unknown segment ids) → no two-line layout.
 */
/**
 * A merge refusal as an issue with its place in this file: «merged layout <band> references unknown segment <id>» →
 * that band's row; «merged bands must increase …» → this file's bands: (no line when it has none).
 */
export function mergeIssue(text: string, message: string): StatuslineLoadIssue {
  const band = /merged layout (\S+) /u.exec(message)?.[1];
  const path = message.startsWith('merged bands') ? 'bands' : band ? `layouts.${band}` : 'layouts';
  return locateStatuslineIssue(text, { path, message: `does not merge over the default: ${message}` });
}

export function judgeNextTuiStatusline(text: string):
  | { readonly ok: true; readonly definition: StatuslineDefinition }
  | { readonly ok: false; readonly why: string; readonly issues: readonly StatuslineLoadIssue[] } {
  const parsed = parseStatuslineYaml(text, { partial: true });
  if (!parsed.ok) {
    const first = parsed.issues[0];
    return { ok: false, issues: parsed.issues, why: `has ${parsed.issues.length} error(s)${first ? ` (${first.path}: ${first.message})` : ''}` };
  }
  let merged: StatuslineDefinition;
  try { merged = mergeStatuslineLayers(defaultStatuslineDefinition(), undefined, parsed.definition); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const issue = mergeIssue(text, message);
    return { ok: false, why: `does not merge (${message})`, issues: [issue] };
  }
  // The Next TUI footer is one row; a two-line layout is refused rather than silently cut to its first line.
  const twoLine = merged.layouts.find((layout) => layout.lines === 2);
  if (twoLine) {
    const why = `has a two-line layout (${twoLine.band}), which the Next TUI footer does not draw yet`;
    return { ok: false, why, issues: [locateStatuslineIssue(text, { path: `layouts.${twoLine.band}`, message: 'two-line layouts are not drawn by the Next TUI footer yet' })] };
  }
  return { ok: true, definition: merged };
}

const COLOR_SGR: Readonly<Record<string, string>> = { green: '32', yellow: '33', amber: '33', red: '31', ok: '32', warn: '33', danger: '31' };

/**
 * The footer line for `input`: fitted to `input.width`, then the colored segments (official green · dev yellow)
 * wrapped in SGR. With `color: false` (NO_COLOR) the words alone carry the meaning (`official` / `dev`).
 */
// 출처: OP 11-17 product decision — below 120 columns the footer uses the short turn clause; at 120 and wider the old
// full sentence stays, as long as the cwd and the version still fit after it.
export const WIDE_FOOTER_MIN_COLUMNS = 120;

const keeps = (line: readonly { id: string }[], prefix: string) => line.some((segment) => segment.id.startsWith(prefix));

/**
 * The line to draw. The cwd and the version are never pushed out by the turn sentence (OP 11-17): at 120+ columns the
 * wide layout (lg: the full old footer · cwd · version) is used only while it keeps both; otherwise, and below 120,
 * the short layout of the width (or md when the width is wider) is drawn: turn · cwd · version · model · counters.
 */
/**
 * Turn-shaped session fields: the progress row above the input already says the turn while one runs (DESIGN §2b).
 * Judged by what a segment reads (source session · these fields), never by its id — a user layout may name a segment
 * anything (#38392 REVIEW-1 ②).
 */
const TURN_SESSION_FIELDS: ReadonlySet<string> = new Set(['facts', 'turn_short', 'turn', 'elapsed']);
/** With a replacement in the turn slot (children · a hint): those fields carry it, so only turn-only fields go. */
const TURN_ONLY_SESSION_FIELDS: ReadonlySet<string> = new Set(['elapsed']);

/** The definition with every segment that reads one of `fields` (source session) removed from all layouts. */
function withoutTurnSegments(definition: StatuslineDefinition, fields: ReadonlySet<string>): StatuslineDefinition {
  const turnIds = new Set(definition.segments.filter((segment) => segment.source === 'session' && fields.has(segment.field)).map((segment) => segment.id));
  if (turnIds.size === 0) return definition;
  const keep = (ids: readonly string[] | undefined) => ids?.filter((id) => !turnIds.has(id));
  return {
    ...definition,
    layouts: definition.layouts.map((layout) => ({
      ...layout,
      segments: keep(layout.segments)!,
      ...(layout.secondLine ? { secondLine: keep(layout.secondLine) } : {}),
      ...(layout.drop ? { drop: keep(layout.drop) } : {}),
      ...(layout.shorten ? { shorten: Object.fromEntries(Object.entries(layout.shorten).filter(([from, to]) => !turnIds.has(from) && !turnIds.has(to))) } : {}),
    })),
  };
}

export function chooseFooterLine(definition: StatuslineDefinition, snapshot: StatuslineSnapshot, width: number,
  omitTurn = false, replaced = false): readonly StatuslineRenderedSegment[] {
  if (omitTurn) {
    // #38392 r4: the turn goes FIRST — then the usual layout choice and width fitting see only what will be drawn, so a
    // turn that is not shown can never push the cwd or the version out or send the line to a narrower layout.
    return chooseFooterLine(withoutTurnSegments(definition, replaced ? TURN_ONLY_SESSION_FIELDS : TURN_SESSION_FIELDS), snapshot, width);
  }
  if (width >= WIDE_FOOTER_MIN_COLUMNS) {
    const wide = renderStatusline(definition, snapshot, width, 'lg').lines[0] ?? [];
    // Only segments the wide layout asks for are checked (a user layout without a cwd is not «pushing it out»).
    const asked = definition.layouts.find((layout) => layout.band === 'lg')?.segments ?? [];
    const kept = (prefix: string) => !asked.some((id) => id.startsWith(prefix)) || keeps(wide, prefix);
    if (kept('cwd') && kept('version')) return wide;
  }
  const band = statuslineWidthBand(width, statuslineBreakpoints(definition));
  return cutTurnToFit(renderStatusline(definition, snapshot, width, band === 'lg' ? 'md' : band).lines[0] ?? [], width);
}

/** When the line is still too wide, the turn clause is cut at its end (`…`) so the segments after it keep their room. */
function cutTurnToFit(line: readonly StatuslineRenderedSegment[], width: number): readonly StatuslineRenderedSegment[] {
  const widthOf = (segments: readonly StatuslineRenderedSegment[]) => Bun.stringWidth(segments.map((segment) => segment.text).join(STATUSLINE_SEPARATOR));
  const total = widthOf(line);
  const turn = line.find((segment) => segment.id === 'turn_short');
  if (!turn || total <= width) return line;
  // 출처: main known-fail 2026-11-18 (entry-compact-chrome-pty test 3 · #36661 origin) — the turn slot carries the
  // footer's information (a corrective instruction, an approval outcome); the cwd and then the version give up their
  // room before the clause is cut. Only a clause that cannot fit alone is cut.
  const survivors = (prefixes: readonly string[]) => line.filter((segment) => !prefixes.some((prefix) => segment.id.startsWith(prefix)));
  const withoutCwd = survivors(['cwd']);
  const bare = survivors(['cwd', 'version']);
  const fitted = widthOf(withoutCwd) <= width ? withoutCwd : bare;
  const fittedTotal = widthOf(fitted);
  if (fittedTotal <= width) return fitted;
  const room = Bun.stringWidth(turn.text) - (fittedTotal - width) - 1;
  // 출처: below this the clause says nothing (glyph, space, one letter); the caller's end cut handles that case.
  const MIN_TURN_CELLS = 3;
  if (room < MIN_TURN_CELLS) return line;
  // 출처: #38163/#38292 followup — the welcome hint in the turn slot ends with the exit route (`· Ctrl+Q quit`);
  // a plain end cut at 60 cols drops it. Keep the tail: fit the head into `room - tail - 2` cells and re-attach
  // `…` + ` ` + the tail. When even the tail cannot fit (extremely narrow terminals) the end cut below stays.
  const EXIT_TAIL = 'Ctrl+Q quit';
  const tailCells = Bun.stringWidth(EXIT_TAIL);
  if (turn.text.endsWith(`· ${EXIT_TAIL}`) && room < Bun.stringWidth(turn.text) && room - tailCells - 2 >= MIN_TURN_CELLS) {
    const head = fitLogLine(turn.text.slice(0, -Bun.stringWidth(`· ${EXIT_TAIL}`)), room - tailCells - 2);
    const kept = `${head}… ${EXIT_TAIL}`;
    return line.map((segment) => segment === turn ? { ...segment, text: kept } : segment);
  }
  const cut = `${fitLogLine(turn.text, room)}…`;
  return line.map((segment) => segment === turn ? { ...segment, text: cut } : segment);
}

export function renderNextTuiStatusline(definition: StatuslineDefinition, snapshot: StatuslineSnapshot, width: number, color: boolean,
  omitTurn = false, replaced = false): string {
  const line = chooseFooterLine(definition, snapshot, width, omitTurn, replaced);
  const fitted = fitLogLine(line.map((segment) => segment.text).join(STATUSLINE_SEPARATOR), width);
  if (!color) return fitted;
  let out = fitted;
  for (const segment of line) {
    const sgr = segment.color ? COLOR_SGR[segment.color] : undefined;
    const at = sgr ? out.lastIndexOf(segment.text) : -1;
    if (sgr && at >= 0) out = `${out.slice(0, at)}\x1b[${sgr}m${segment.text}\x1b[39m${out.slice(at + segment.text.length)}`;
  }
  return out;
}

/** Created once by entry.ts: the loaded definition, its warning (shown once), and the footer renderer. */
export function createNextTuiStatusline(options: {
  readonly build: StatuslineBuild; readonly cwd: () => string; readonly userPath?: string; readonly color?: boolean;
  /** Runs once, after the paint that drew the first footer. */
  readonly afterFirstPaint?: () => void;
  /** The fleet value (a poller's last fold); absent = no fleet segment. */
  readonly fleet?: () => FleetValue | undefined;
}) {
  const loaded = loadNextTuiStatusline(options.userPath);
  const color = options.color ?? (!('NO_COLOR' in process.env) || process.env.NO_COLOR === '');
  let build = options.build;
  let rendered = false;
  return {
    warning: loaded.warning,
    /** Where the line sits (DESIGN §2b · STATUSLINE-CONTRACT-V1 `position:`); bottom unless the definition says otherwise. */
    position: loaded.definition.position ?? STATUSLINE_DEFAULT_POSITION,
    /** The commit time is looked up after the first paint (a git call); until then a dev version shows no stamp. */
    /** Returns true when the footer changes (the caller paints again). */
    setCommitTime(commitTime: number | undefined): boolean {
      if (commitTime === undefined || commitTime === build.commitTime) return false;
      build = { ...build, commitTime };
      return true;
    },
    /**
     * `facts`: the old footer text alone, for logic that reads it (compact mode, turn-end swap) — unchanged by the new
     * segments. `plain` / `shown`: the whole drawn line, without / with color (NO_COLOR keeps `shown` plain).
     */
    /** `replace`: text that takes the turn's place this frame (a turn-end summary, a hint); the other segments stay. */
    /** `omitTurn`: draw without the turn clause (the bottom line while a turn runs — the progress row says it). */
    render: (input: NextTuiStatusLineInput, replace?: string, omitTurn = false): { readonly facts: string; readonly plain: string; readonly shown: string } => {
      // The caller's work that must wait for the screen (the build stamp's git call) starts once this first frame,
      // computed synchronously inside the paint, has been written.
      if (!rendered) { rendered = true; if (options.afterFirstPaint) setTimeout(options.afterFirstPaint, 0); }
      const base = nextTuiStatuslineSnapshot(input, options.cwd(), build, undefined, options.fleet?.());
      const marked = omitTurn ? { ...base, session: { ...base.session, turn_hidden: 'yes' } } : base;
      const snapshot = replace === undefined ? marked
        // Every turn-shaped segment carries it: facts (lg), turn_short (default xs/sm/md), turn (user layouts).
        : { ...marked, session: { ...marked.session, facts: replace, turn_short: replace, turn: replace, exception: 'no' } };
      const replaced = replace !== undefined;
      const plain = renderNextTuiStatusline(loaded.definition, snapshot, input.width, false, omitTurn, replaced);
      const facts = String(base.session?.facts ?? '');
      return { facts, plain, shown: color ? renderNextTuiStatusline(loaded.definition, snapshot, input.width, true, omitTurn, replaced) : plain };
    },
  };
}

/**
 * NEXT-TUI-FOOTER-24-ROWS (대표 «CWD·버전 기본 · 밀려나면 안 됨»): the compact screen (rows ≤ compactHeight, so every
 * standard 80×24 terminal) draws the same declarative line as a tall one — cwd and version stay. What only the compact
 * footer said goes into the turn's place: the key hint while the welcome is shown, the attachment hint, and the
 * sub-agent count. The queue is not repeated here: the counters already show it («S1·Q1»).
 * The attachment hint comes FIRST (#38292 REVIEW-1 ①): the turn clause is what gets cut when the line is too wide, so
 * the hint the person needs right now survives on an 80-column line. Nothing special → undefined.
 */
export function compactFooterTurn(input: {
  readonly welcomePending: boolean;
  /** The attachment panel's hint, passed on its own (never glued after the footer sentence). */
  readonly attachmentHint?: string | null;
  /** The short turn clause of this frame (nextTuiShortStatus(...).turn). */
  readonly shortTurn: string;
  readonly activeChildren: number;
}): string | undefined {
  const children = input.activeChildren > 0 ? `Children ${input.activeChildren}` : '';
  if (input.welcomePending) return ['Enter send · Esc cancel · Ctrl+Q quit', children].filter(Boolean).join(' · ');
  if (input.attachmentHint) return [input.attachmentHint, input.shortTurn, children].filter(Boolean).join(' · ');
  // An empty shortTurn (the bottom line while a turn runs, #38392 REVIEW-1 ①) leaves the child count alone.
  return children ? [input.shortTurn, children].filter(Boolean).join(' · ') : undefined;
}
