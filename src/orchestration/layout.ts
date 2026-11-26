// GOAL-ORCHESTRATION-NL — tile layout control by voice or text. «타일 3x3으로» · «리스크 탭 확대» · «다음 페이지» ·
// «전체 스페이스 보여줘» → one LayoutCommand → appended to the run's stage feed as `layout` (with a rising seq);
// the attached `els tile --stage --feed` view applies it on its next poll. Every feed line carries the whole
// layout state, because the view reads only the newest line.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface LayoutCommand {
  readonly grid?: 'auto' | '2x2' | '3x3' | '4x3';
  readonly page?: 'next' | 'prev' | number;
  readonly level?: 'all' | 'spaces' | 'space';
  /** Spotlight (zoom) a tab by title or worker id; '' clears. */
  readonly zoom?: string;
}
export interface LayoutState extends LayoutCommand { readonly seq: number }

const GRID_RE = /\b([1-4])\s*[x×*]\s*([1-4])\b/u;

/** Plain words → layout command; undefined when the words are not a layout request. */
export function parseLayoutCommand(text: string): LayoutCommand | undefined {
  const t = text.trim().toLowerCase();
  if (!t) return undefined;
  const g = GRID_RE.exec(t);
  if (g) { const spec = `${g[1]}x${g[2]}`; return { grid: (['2x2', '3x3', '4x3'].includes(spec) ? spec : 'auto') as LayoutCommand['grid'] }; }
  if (/auto\s*(grid|layout)|자동\s*(배치|타일)/u.test(t)) return { grid: 'auto' };
  if (/next\s*page|다음\s*(페이지|장)/u.test(t)) return { page: 'next' };
  if (/prev(ious)?\s*page|이전\s*(페이지|장)/u.test(t)) return { page: 'prev' };
  if (/(all|every|전체)\s*(spaces?|스페이스|공간)|스페이스\s*(전체|모두)/u.test(t)) return { level: 'spaces' };
  if (/(all|every|전체|모든)\s*(tabs?|panes?|탭)|show\s+all|모두\s*보여/u.test(t)) return { level: 'all' };
  if (/(this|current|이)\s*(space|스페이스)\s*(only|만)?/u.test(t)) return { level: 'space' };
  if (/(unzoom|zoom\s*out|축소|원래대로|되돌려)/u.test(t)) return { zoom: '' };
  const z = /(?:zoom(?:\s+in)?(?:\s+on)?|spotlight|focus(?:\s+on)?|enlarge)\s+(?:the\s+)?(.+?)(?:\s+tab)?$/u.exec(t)
    ?? /^(.+?)\s*(?:탭|창)?\s*(?:을|를)?\s*(?:확대|크게|스포트라이트|집중)/u.exec(t);
  if (z?.[1]) return { zoom: z[1].trim() };
  return undefined;
}

export function lastLayout(feedText: string | undefined): LayoutState {
  const lines = (feedText ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const raw = JSON.parse(lines[i]!) as { layout?: LayoutState }; if (raw && typeof raw === 'object') return raw.layout ?? { seq: 0 }; } catch { /* skip */ }
  }
  return { seq: 0 };
}

/** A feed file writer: every event keeps the newest layout; layout() appends a command with seq+1. */
export function feedWriter(path: string): { emit(event: Record<string, unknown>): void; layout(cmd: LayoutCommand): LayoutState } {
  mkdirSync(dirname(path), { recursive: true });
  const read = (): string | undefined => existsSync(path) ? readFileSync(path, 'utf8').slice(-32_768) : undefined;
  let lastEvent: Record<string, unknown> = {};
  return {
    emit(event) {
      lastEvent = event;
      const layout = lastLayout(read());
      appendFileSync(path, `${JSON.stringify({ ...event, ...(layout.seq ? { layout } : {}), at: new Date().toISOString() })}\n`);
    },
    layout(cmd) { return applyLayout(path, cmd, lastEvent); },
  };
}

/** Append a layout command to a feed file (used by the ElsLayout tool from another process). */
export function applyLayout(path: string, cmd: LayoutCommand, base?: Record<string, unknown>): LayoutState {
  mkdirSync(dirname(path), { recursive: true });
  const text = existsSync(path) ? readFileSync(path, 'utf8').slice(-32_768) : '';
  const prev = lastLayout(text);
  let last: Record<string, unknown> = base ?? {};
  if (!base) { const line = text.trim().split('\n').at(-1); try { last = line ? JSON.parse(line) as Record<string, unknown> : {}; } catch { last = {}; } }
  const { page: _page, zoom: _zoom, ...sticky } = prev;   // page/zoom are one-shot; grid/level stick
  const next: LayoutState = { ...sticky, ...cmd, seq: prev.seq + 1 };
  const { layout: _drop, at: _at, ...carried } = last as { layout?: unknown; at?: unknown; spotlightPane?: unknown; spotlightMs?: unknown };
  // Unzoom clears the carried spotlight too, or the view would re-apply it on the next poll.
  const rest = cmd.zoom === '' ? (({ spotlightPane: _p, spotlightMs: _m, ...others }) => others)(carried) : carried;
  appendFileSync(path, `${JSON.stringify({ ...rest, ...(cmd.zoom ? { spotlightPane: cmd.zoom, spotlightMs: 60_000 } : {}), layout: next, at: new Date().toISOString() })}\n`);
  return next;
}
