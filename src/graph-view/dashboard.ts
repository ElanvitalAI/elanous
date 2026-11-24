// GRAPH-DASHBOARD — the full-pane look of one graph run in an els tab (대표 11-24 «graph dashboard», demo 11-26).
// Pure render: nodes in → text lines out. Header bar · stages joined by edges (a fan-out of parallel nodes is a grid of
// mini-cards, a join node carries a consensus gauge) · side strip with the last events and a done-over-time sparkline.
// No state here: every number comes from the node list and the clock the caller passes (spinner = `tick`).
// Below DASHBOARD_MIN_COLS × DASHBOARD_MIN_ROWS it returns null and the caller keeps the compact widget.
// Colors are applied after layout (widths never change): truecolor, 256-color fallback, or none. Only foreground
// colors in mid-saturation tones are used so the picture reads on a light and a dark background alike.

export const DASHBOARD_MIN_COLS = 110;
export const DASHBOARD_MIN_ROWS = 24;

export type DashboardColorMode = 'truecolor' | '256' | 'none';
export type DashboardNodeState = 'running' | 'done' | 'failed' | 'blocked';

export interface DashboardNode {
  readonly id: string;
  readonly label: string;
  readonly state: DashboardNodeState;
  readonly startedAt: number;
  readonly endedAt?: number;
  /** Last progress line (or the failure reason). `model=<name>` inside it names the node's model. */
  readonly note: string;
}

export interface DashboardInput {
  readonly name: string;
  readonly status: 'running' | 'done' | 'failed';
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly nodes: readonly DashboardNode[];
  readonly nowMs: number;
  readonly tick: number;
  readonly cols: number;
  readonly rows: number;
  readonly color: DashboardColorMode;
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPARK = ['▁', '▂', '▃', '▅', '▇'];
const STRIP_WIDTH = 38;
const POP_MS = 1000;
const FAN_MIN = 4;
const JOIN_LABEL = /consensus|join|merge|verdict|synth|decid/iu;

const ANSI = /\x1b\[[0-9;]*m/gu;
/** Terminal cells of a string: CJK and fullwidth count 2, escapes 0. */
export function cellWidth(text: string): number {
  let n = 0;
  for (const ch of text.replace(ANSI, '')) {
    const cp = ch.codePointAt(0)!;
    n += (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xff60) ? 2 : 1;
  }
  return n;
}
const clip = (text: string, width: number): string => {
  if (width <= 0) return '';
  if (cellWidth(text) <= width) return text;
  let out = '';
  for (const ch of text) { if (cellWidth(out + ch) > width - 1) break; out += ch; }
  return `${out}…`;
};
const pad = (text: string, width: number): string => { const fitted = clip(text, width); return fitted + ' '.repeat(Math.max(0, width - cellWidth(fitted))); };
const center = (text: string, width: number): string => { const fitted = clip(text, width); const left = Math.floor((width - cellWidth(fitted)) / 2); return ' '.repeat(left) + fitted + ' '.repeat(width - left - cellWidth(fitted)); };
const duration = (ms: number): string => { const s = Math.max(0, Math.floor(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };
const modelOf = (node: DashboardNode): string => /\bmodel[:=]\s*([\w./-]+)/u.exec(node.note)?.[1] ?? '';
const noteOf = (node: DashboardNode): string => node.note.replace(/\bmodel[:=]\s*[\w./-]+\s*·?\s*/u, '').trim();

function mark(node: DashboardNode, input: DashboardInput): string {
  if (node.state === 'running') return SPINNER[input.tick % SPINNER.length]!;
  if (node.state === 'blocked') return '◆';
  if (node.state === 'failed') return '✕';
  return node.endedAt !== undefined && input.nowMs - node.endedAt < POP_MS ? '✔' : '✓';
}

/** Stages: a node belongs to the current stage while some node of that stage is still alive when it starts. */
function stagesOf(nodes: readonly DashboardNode[]): DashboardNode[][] {
  const stages: DashboardNode[][] = [];
  for (const node of [...nodes].sort((a, b) => a.startedAt - b.startedAt)) {
    const last = stages.at(-1);
    const joins = JOIN_LABEL.test(node.label) && (last?.length ?? 0) >= FAN_MIN;
    const overlaps = !joins && last?.some((other) => other.endedAt === undefined || other.endedAt > node.startedAt);
    if (last && overlaps) last.push(node); else stages.push([node]);
  }
  return stages;
}

function card(node: DashboardNode, width: number, input: DashboardInput): string[] {
  const inner = width - 2;
  const model = modelOf(node);
  const head = `${mark(node, input)} ${node.label}`;
  const top = model ? `${pad(head, inner - cellWidth(model) - 1)} ${model}` : pad(head, inner);
  const body = node.state === 'failed' ? `✕ ${noteOf(node) || 'failed'}` : node.state === 'done' ? `  ${noteOf(node) || 'done'} · ${duration((node.endedAt ?? input.nowMs) - node.startedAt)}`
    : node.state === 'blocked' ? '  waiting' : `  ${noteOf(node) || 'working…'}`;
  return [`┌${'─'.repeat(inner)}┐`, `│${pad(top, inner)}│`, `│${pad(body, inner)}│`, `└${'─'.repeat(inner)}┘`];
}

function box(text: string, width: number): string[] {
  const inner = Math.max(8, Math.min(width - 2, cellWidth(text) + 4));
  return [`┌${'─'.repeat(inner)}┐`, `│${center(text, inner)}│`, `└${'─'.repeat(inner)}┘`].map((row) => center(row, width));
}

const gauge = (done: number, total: number, cells = 24): string => {
  const exact = total === 0 ? 0 : (done / total) * cells;
  const full = Math.floor(exact);
  const frac = exact - full;
  const part = full >= cells ? '' : frac >= 0.75 ? '▓' : frac >= 0.4 ? '▒' : '░';
  return '█'.repeat(full) + part + '░'.repeat(Math.max(0, cells - full - part.length));
};

function mainLines(input: DashboardInput, width: number, stages: DashboardNode[][], room: number): string[] {
  const edge = (feeds: boolean): string => center(feeds ? ['│', '┃', '│', '╎'][input.tick % 4]! : '│', width);
  const build = (collapse: boolean): string[] => {
    const lines: string[] = [];
    const joinIndexes = new Set<number>();
    stages.forEach((stage, i) => { if (stage.length === 1 && JOIN_LABEL.test(stage[0]!.label) && (stages[i - 1]?.length ?? 0) >= FAN_MIN) joinIndexes.add(i); });
    let folded: string[] = [];
    const flush = (): void => { if (folded.length) { lines.push(center(folded.join(' ═ '), width)); folded = []; } };
    stages.forEach((stage, i) => {
      const running = stage.some((n) => n.state === 'running');
      if (collapse && stage.length === 1 && stage[0]!.state === 'done' && i < stages.length - 1 && !joinIndexes.has(i)) { folded.push(`${mark(stage[0]!, input)} ${stage[0]!.label}`); return; }
      flush();
      if (lines.length > 0) lines.push(edge(running || stage.some((n) => n.state === 'blocked')));
      if (stage.length >= FAN_MIN) {
        const cols = Math.max(1, Math.min(4, Math.floor((width + 1) / 24)));
        const cardW = Math.floor((width - (cols - 1)) / cols);
        for (let start = 0; start < stage.length; start += cols) {
          const rowCards = stage.slice(start, start + cols).map((node) => card(node, cardW, input));
          for (let r = 0; r < 4; r++) lines.push(pad(rowCards.map((c) => c[r]!).join(' '), width));
        }
      } else if (joinIndexes.has(i)) {
        const fan = stages[i - 1]!;
        const doneN = fan.filter((n) => n.state === 'done').length;
        const failedN = fan.filter((n) => n.state === 'failed').length;
        const node = stage[0]!;
        lines.push(...box(`${mark(node, input)} ${node.label}`, width));
        lines.push(center(`${gauge(doneN, fan.length)} ${doneN}/${fan.length}${failedN ? ` ✕${failedN}` : ''}`, width));
      } else {
        for (const node of stage) lines.push(...box(`${mark(node, input)} ${node.label}${node.state === 'failed' ? ` · ${noteOf(node) || 'failed'}` : node.state === 'running' && noteOf(node) ? ` · ${noteOf(node)}` : ''}`, width));
      }
    });
    flush();
    return lines;
  };
  let lines = build(false);
  if (lines.length > room) lines = build(true);
  return lines.length > room ? [...lines.slice(0, room - 1), center('…', width)] : lines;
}

function stripLines(input: DashboardInput, width: number): string[] {
  type Ev = { at: number; text: string };
  const events: Ev[] = [];
  for (const node of input.nodes) {
    events.push({ at: node.startedAt, text: `▸ ${node.label}` });
    if (node.endedAt !== undefined) events.push({ at: node.endedAt, text: `${node.state === 'failed' ? '✕' : '✓'} ${node.label}${node.state === 'failed' && node.note ? ` · ${noteOf(node)}` : ''}` });
  }
  events.sort((a, b) => a.at - b.at);
  const last = events.slice(-6);
  const lines = ['EVENTS', ...Array.from({ length: 6 }, (_, i) => {
    const ev = last[last.length - 6 + i];
    return ev ? `+${duration(ev.at - input.startedAt).padEnd(6)} ${ev.text}` : '';
  })];
  const cells = Math.min(24, width - 2);
  const end = input.endedAt ?? input.nowMs;
  const span = Math.max(1000, end - input.startedAt);
  const buckets = Array.from({ length: cells }, () => 0);
  for (const node of input.nodes) if (node.state === 'done' && node.endedAt !== undefined) buckets[Math.min(cells - 1, Math.floor(((node.endedAt - input.startedAt) / span) * cells))]!++;
  const peak = Math.max(1, ...buckets);
  const spark = buckets.map((n) => SPARK[n === 0 ? 0 : Math.min(SPARK.length - 1, Math.ceil((n / peak) * (SPARK.length - 1)))]!).join('');
  lines.push('', 'NODES DONE / TIME', spark, `0s${' '.repeat(Math.max(1, cells - 2 - duration(span).length))}${duration(span)}`);
  return lines.map((row) => pad(row, width));
}

const SGR = {
  truecolor: { done: '38;2;46;160;67', fail: '1;38;2;224;60;60', run: '38;2;0;160;190', wait: '38;2;200;140;0', pop: '1;38;2;60;200;90', head: '1' },
  '256': { done: '38;5;34', fail: '1;38;5;160', run: '38;5;38', wait: '38;5;172', pop: '1;38;5;40', head: '1' },
} as const;

function paint(line: string, mode: DashboardColorMode): string {
  if (mode === 'none') return line;
  const t = SGR[mode];
  const wrap = (code: string) => (m: string) => `\x1b[${code}m${m}\x1b[0m`;
  return line
    .replace(/[┌┐└┘─│┃╎┊]+/gu, (m) => `\x1b[2m${m}\x1b[0m`)
    .replace(/✔/gu, wrap(t.pop))
    .replace(/✓/gu, wrap(t.done))
    .replace(/✕[^│┐]*?(?=\s{2,}|│|$)/gu, wrap(t.fail))
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/gu, wrap(t.run))
    .replace(/◆/gu, wrap(t.wait))
    .replace(/[█▓▒]+/gu, wrap(t.run))
    .replace(/░+/gu, (m) => `\x1b[2m${m}\x1b[0m`)
    .replace(/[▁▂▃▅▇]+/gu, wrap(t.run))
    .replace(/^EVENTS|NODES DONE \/ TIME/gu, wrap(t.head));
}

/** The dashboard, or null when the pane is too small (the caller keeps the compact widget). */
export function renderGraphDashboard(input: DashboardInput): string[] | null {
  if (input.cols < DASHBOARD_MIN_COLS || input.rows < DASHBOARD_MIN_ROWS) return null;
  const stages = stagesOf(input.nodes);
  const count = (state: DashboardNodeState) => input.nodes.filter((n) => n.state === state).length;
  const models = new Map<string, number>();
  for (const node of input.nodes) { const m = modelOf(node); if (m) models.set(m, (models.get(m) ?? 0) + 1); }
  const spinner = input.status === 'running' ? SPINNER[input.tick % SPINNER.length]! : input.status === 'done' ? '✓' : '✕';
  const header = [`${spinner} ⎇ ${input.name}`, duration((input.endedAt ?? input.nowMs) - input.startedAt),
    `✓${count('done')} ●${count('running') + count('blocked')} ✕${count('failed')}`, ...(models.size ? [[...models].map(([m, n]) => `${m}×${n}`).join(' ')] : [])].join('  ·  ');
  const bodyRows = input.rows - 2;
  const mainWidth = input.cols - STRIP_WIDTH - 3;
  const main = mainLines(input, mainWidth, stages, bodyRows);
  const strip = stripLines(input, STRIP_WIDTH);
  const lines = [pad(header, input.cols), '━'.repeat(input.cols)];
  for (let i = 0; i < Math.max(main.length, strip.length); i++) lines.push(`${pad(main[i] ?? '', mainWidth)} │ ${strip[i] ?? ' '.repeat(STRIP_WIDTH)}`);
  return lines.slice(0, input.rows).map((row, i) => (i === 0 ? row.replace(/^([^·]*)/u, (m) => (input.color === 'none' ? m : `\x1b[1m${m}\x1b[0m`)) : paint(row, input.color)));
}
