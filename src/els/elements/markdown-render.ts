// ELS-ZAXIS — markdown → styled terminal rows for els elements (대표 11-26 «우리 classic 마크다운 렌더러를 이식»).
// Ported from our own renderer: classic src/render.ts renderMarkdown / applyInlineStyles / renderTable / truncateCells
// (8/31 export, ~/elanous-hq/ref/elanous-classic-20260831 — the descendant still in src/render.ts adds the table maxWidth).
// Changes for els: pure (raw SGR instead of chalk, so output never depends on the terminal's colour detection), every row
// wrapped to the box width by display cells (Bun.stringWidth: CJK, emoji) with a hanging indent, and Obsidian extras —
// frontmatter folded to one dim line, [[wikilinks]] styled, callouts «> [!note] title» as boxed blocks, mermaid fences as a
// «diagram» placeholder, embeds ![[x]] / images as placeholders. No new dependency.

const ESC = '\u001b';
const R = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const ITALIC = `${ESC}[3m`;
const UNDER = `${ESC}[4m`;
const STRIKE = `${ESC}[9m`;
const CYAN = `${ESC}[36m`;
const BLUE = `${ESC}[34m`;
const YELLOW = `${ESC}[33m`;
const GREEN = `${ESC}[32m`;
const RED = `${ESC}[31m`;
const MAGENTA = `${ESC}[35m`;
const CODE = `${ESC}[38;5;180m`;   // classic applyColor(code, 'permission') — a warm tone for inline code

const SGR = /\u001b\[[0-9;]*m/g;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Display width (classic visibleWidth): SGR stripped, Bun.stringWidth for CJK / emoji / VS16. */
export const visibleWidth = (text: string): number => Bun.stringWidth(text.replace(SGR, ''));

/** classic truncateCells: cut to `max` cells keeping styles, «…» when anything was cut. */
export function truncateCells(text: string, max: number): string {
  if (visibleWidth(text) <= max) return text;
  let out = '';
  let used = 0;
  for (const part of text.split(/(\u001b\[[0-9;]*m)/)) {
    if (part.startsWith(`${ESC}[`)) { out += part; continue; }
    for (const { segment } of graphemes.segment(part)) {
      const w = Bun.stringWidth(segment);
      if (used + w > max - 1) return `${out}${R}…`;
      out += segment;
      used += w;
    }
  }
  return out;
}

/** classic applyInlineStyles (code spans stashed first so nothing inside them is touched) ⊕ Obsidian links and embeds. */
export function inlineStyles(source: string): string {
  const stash: string[] = [];
  const save = (rendered: string): string => { stash.push(rendered); return `\u0000C${stash.length - 1}\u0000`; };
  let text = source.replace(/<br\s*\/?>/gi, ' ').replace(/<\/?(?:span|div|p|b|i|u|sup|sub|font|center)[^>]*>/gi, '');
  text = text.replace(/`([^`]+)`/g, (_, code: string) => save(`${CODE}${code}${R}`));
  // Obsidian embeds and images: a placeholder (a terminal cannot show the picture).
  text = text.replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, (_, name: string) => save(`${DIM}🖼 ${name.split('/').pop()}${R}`));
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, alt: string, url: string) => save(`${DIM}🖼 ${alt || url.split('/').pop()}${R}`));
  // Wikilinks [[target|label]] / [[target#heading]] and markdown links [label](url): the label, underlined.
  text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, (_, _t: string, label: string) => save(`${CYAN}${UNDER}${label}${R}`));
  text = text.replace(/\[\[([^\]]+)\]\]/g, (_, target: string) => save(`${CYAN}${UNDER}${target.replace(/#\^?/, ' › ')}${R}`));
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, label: string) => save(`${BLUE}${UNDER}${label}${R}`));
  text = text.replace(/\*\*\*([^*]+)\*\*\*/g, (_, s: string) => `${BOLD}${ITALIC}${s}${R}`);
  text = text.replace(/\*\*([^*]+)\*\*/g, (_, s: string) => `${BOLD}${s}${R}`);
  text = text.replace(/__([^_]+)__/g, (_, s: string) => `${BOLD}${s}${R}`);
  text = text.replace(/\*([^*\s][^*]*)\*/g, (_, s: string) => `${ITALIC}${s}${R}`);
  text = text.replace(/(^|[^_\w])_([^_\n]+?)_(?!_|\w)/g, (_m, pre: string, s: string) => `${pre}${ITALIC}${s}${R}`);
  text = text.replace(/~~([^~]+)~~/g, (_, s: string) => `${STRIKE}${s}${R}`);
  text = text.replace(/==([^=]+)==/g, (_, s: string) => `${ESC}[7m${s}${R}`);   // Obsidian highlight
  text = text.replace(/(^|\s)#([\p{L}\p{N}_/-]+)/gu, (_m, pre: string, tag: string) => `${pre}${MAGENTA}#${tag}${R}`);
  return text.replace(/\u0000C(\d+)\u0000/g, (_m, at: string) => stash[Number(at)] ?? '');
}

/** Wrap one styled line to `width` cells. Continuation rows start with `hang` (spaces or a quote bar); the active SGR is
 *  closed at each row end and re-opened on the next row, so colour never bleeds into the frame. Breaks at spaces when it
 *  can, otherwise mid-word (Korean runs without spaces, long URLs). */
export function wrapStyled(line: string, width: number, hang = ''): string[] {
  if (width <= 0) return [];
  if (visibleWidth(line) <= width) return [line];
  const hangWidth = Math.min(visibleWidth(hang), Math.max(0, width - 4));
  const rows: string[] = [];
  let row = '';
  let used = 0;
  let active = '';
  let lastSpace = -1;          // index in `row` just after a space
  let lastSpaceActive = '';
  let lastSpaceUsed = 0;
  const limit = (): number => rows.length === 0 ? width : width - hangWidth;
  const flush = (cut: number, restUsed: number, restActive: string): void => {
    const head = row.slice(0, cut).replace(/ +$/, '');
    const tail = row.slice(cut);
    rows.push(`${head}${active || restActive ? R : ''}`);
    row = `${restActive}${tail}`;
    used = restUsed;
    lastSpace = -1;
  };
  for (const part of line.split(/(\u001b\[[0-9;]*m)/)) {
    if (part.startsWith(`${ESC}[`)) { row += part; active = part === R ? '' : active + part; continue; }
    for (const { segment } of graphemes.segment(part)) {
      const w = Bun.stringWidth(segment);
      if (used + w > limit()) {
        if (segment === ' ') { flush(row.length, 0, active); continue; }
        if (lastSpace > 0 && lastSpaceUsed > limit() * 0.4) flush(lastSpace, used - lastSpaceUsed, lastSpaceActive);
        else flush(row.length, 0, active);
      }
      row += segment;
      used += w;
      if (segment === ' ') { lastSpace = row.length; lastSpaceActive = active; lastSpaceUsed = used; }
    }
  }
  if (row.replace(SGR, '').trim() || rows.length === 0) rows.push(row);
  return rows.map((one, at) => at === 0 ? one : `${hang.slice(0, hangWidth)}${one}`);
}

/** classic renderTable with maxWidth (box-drawing borders; the widest columns give way, their cells end in «…»). */
export function renderTable(headers: string[], rows: string[][], align: readonly (string | null)[], maxWidth: number): string[] {
  const count = Math.max(headers.length, ...rows.map((row) => row.length));
  const cell = (row: readonly string[], i: number): string => row[i] ?? '';
  const widths = Array.from({ length: count }, (_, i) => Math.max(3, visibleWidth(cell(headers, i)), ...rows.map((row) => visibleWidth(cell(row, i)))));
  const budget = maxWidth - (1 + 3 * count);
  while (widths.reduce((sum, w) => sum + w, 0) > budget) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest]! <= 3) break;
    widths[widest] = widths[widest]! - 1;
  }
  const pad = (text: string, i: number): string => {
    const cut = truncateCells(text, widths[i]!);
    const gap = Math.max(0, widths[i]! - visibleWidth(cut));
    if (align[i] === 'right') return `${' '.repeat(gap)}${cut}`;
    if (align[i] === 'center') return `${' '.repeat(Math.floor(gap / 2))}${cut}${' '.repeat(gap - Math.floor(gap / 2))}`;
    return `${cut}${' '.repeat(gap)}`;
  };
  const border = (l: string, m: string, r: string): string => `${DIM}${l}${widths.map((w) => '─'.repeat(w + 2)).join(m)}${r}${R}`;
  const line = (row: readonly string[], style = ''): string => `${DIM}│${R} ${widths.map((_, i) => `${style}${pad(cell(row, i), i)}${style ? R : ''}`).join(` ${DIM}│${R} `)} ${DIM}│${R}`;
  return [border('┌', '┬', '┐'), line(headers, BOLD), border('├', '┼', '┤'), ...rows.map((row) => line(row)), border('└', '┴', '┘')];
}

const CALLOUT: Readonly<Record<string, { mark: string; color: string }>> = {
  note: { mark: 'ℹ', color: BLUE }, info: { mark: 'ℹ', color: BLUE }, abstract: { mark: '≡', color: CYAN }, summary: { mark: '≡', color: CYAN },
  tldr: { mark: '≡', color: CYAN }, tip: { mark: '✦', color: CYAN }, hint: { mark: '✦', color: CYAN }, important: { mark: '✦', color: CYAN },
  success: { mark: '✓', color: GREEN }, check: { mark: '✓', color: GREEN }, done: { mark: '✓', color: GREEN }, question: { mark: '?', color: YELLOW },
  help: { mark: '?', color: YELLOW }, faq: { mark: '?', color: YELLOW }, warning: { mark: '!', color: YELLOW }, caution: { mark: '!', color: YELLOW },
  attention: { mark: '!', color: YELLOW }, failure: { mark: '✕', color: RED }, fail: { mark: '✕', color: RED }, missing: { mark: '✕', color: RED },
  danger: { mark: '⚡', color: RED }, error: { mark: '⚡', color: RED }, bug: { mark: '✕', color: RED }, example: { mark: '◆', color: MAGENTA },
  quote: { mark: '❝', color: DIM }, cite: { mark: '❝', color: DIM }, todo: { mark: '☐', color: BLUE },
};

const parseRow = (line: string): string[] => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
const isTableRow = (line?: string): boolean => !!line && /^\s*\|.*\|\s*$/.test(line);
const isSeparator = (line?: string): boolean => !!line && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

/** Markdown → rows of at most `width` cells (styled). The classic block rules, each row wrapped with a hanging indent. */
export function renderMarkdownRows(markdown: string, width: number): string[] {
  const lines = markdown.replace(/\r/g, '').replace(/\t/g, '    ').split('\n');
  const out: string[] = [];
  const push = (line: string, hang = ''): void => { out.push(...wrapStyled(line, width, hang)); };
  let at = 0;
  // Obsidian frontmatter: folded to one dim line naming its keys.
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
    if (end > 0) {
      const keys = lines.slice(1, end).flatMap((line) => /^([A-Za-z0-9_\-가-힣]+):/.exec(line)?.[1] ?? []);
      push(`${DIM}⋯ properties: ${keys.join(' · ') || '(none)'}${R}`);
      at = end + 1;
    }
  }
  let fence: { ticks: number; lang: string; shown: number; total: number } | undefined;
  let quoteHang: string | undefined;     // inside a callout block: its bar
  for (; at < lines.length; at++) {
    const line = lines[at]!;
    if (fence) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (closing && closing[1]!.length >= fence.ticks) {
        if (fence.lang === 'mermaid') push(`${DIM}  └ ${fence.total} lines of mermaid (open the note in Obsidian to see the diagram)${R}`);
        fence = undefined;
        continue;
      }
      fence.total++;
      if (fence.lang === 'mermaid' && fence.shown >= 6) continue;   // a diagram placeholder shows its first lines only
      fence.shown++;
      out.push(`${DIM}│${R} ${CODE}${truncateCells(line, Math.max(1, width - 2))}${R}`);   // code is cut, never re-wrapped
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)/.exec(line);
    if (opening) {
      const lang = opening[2]!.toLowerCase();
      fence = { ticks: opening[1]!.length, lang, shown: 0, total: 0 };
      push(lang === 'mermaid' ? `${MAGENTA}◇ diagram${R} ${DIM}(mermaid)${R}` : `${DIM}┌ code${lang ? ` · ${lang}` : ''}${R}`);
      continue;
    }
    // Callouts (> [!type]± title) and plain blockquotes.
    const callout = /^\s*>\s*\[!([A-Za-z-]+)\]([+-]?)\s*(.*)$/.exec(line);
    if (callout) {
      const kind = callout[1]!.toLowerCase();
      const style = CALLOUT[kind] ?? CALLOUT.note!;
      const title = callout[3] || kind.charAt(0).toUpperCase() + kind.slice(1);
      quoteHang = `${style.color}┃${R} `;
      push(`${style.color}┏ ${style.mark} ${BOLD}${inlineStyles(title)}${R}`, quoteHang);
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      const bar = quoteHang ?? `${DIM}▎${R} `;
      const inner = renderMarkdownRows(quote[1]!, Math.max(4, width - 2));
      for (const row of inner) out.push(`${bar}${quoteHang ? row : `${ITALIC}${row}${R}`}`);
      continue;
    }
    quoteHang = undefined;
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const text = inlineStyles(heading[2]!);
      if (out.length && out[out.length - 1] !== '') out.push('');
      push(level === 1 ? `${BOLD}${ITALIC}${UNDER}${CYAN}${text}${R}` : level === 2 ? `${BOLD}${CYAN}${text}${R}` : level === 3 ? `${BOLD}${text}${R}` : `${BOLD}${DIM}${text}${R}`);
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,}|={3,})\s*$/.test(line)) { out.push(`${DIM}${'━'.repeat(Math.max(1, Math.min(width, 40)))}${R}`); continue; }
    const task = /^(\s*)[-*+]\s+\[([ xX/-])\]\s+(.*)$/.exec(line);
    if (task) {
      const done = task[2] !== ' ';
      const pre = `${task[1]}${done ? `${GREEN}☑${R}` : `${DIM}☐${R}`} `;
      push(`${pre}${done ? `${DIM}${inlineStyles(task[3]!)}${R}` : inlineStyles(task[3]!)}`, ' '.repeat(task[1]!.length + 2));
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      const depth = Math.floor(bullet[1]!.length / 2);
      const mark = ['•', '◦', '▪', '▫'][depth % 4];
      push(`${bullet[1]}${DIM}${mark}${R} ${inlineStyles(bullet[2]!)}`, ' '.repeat(bullet[1]!.length + 2));
      continue;
    }
    const numbered = /^(\s*)(\d+)([.)])\s+(.*)$/.exec(line);
    if (numbered) {
      const label = `${numbered[2]}${numbered[3]}`;
      push(`${numbered[1]}${DIM}${label}${R} ${inlineStyles(numbered[4]!)}`, ' '.repeat(numbered[1]!.length + label.length + 1));
      continue;
    }
    if (isTableRow(line) && isSeparator(lines[at + 1])) {
      const header = parseRow(line);
      const align = parseRow(lines[at + 1]!).map((cell) => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left');
      const rows: string[][] = [];
      at += 2;
      while (at < lines.length && isTableRow(lines[at])) rows.push(parseRow(lines[at++]!).map(inlineStyles));
      at--;
      out.push(...renderTable(header.map(inlineStyles), rows, align, width));
      continue;
    }
    if (line.trim() === '') { if (out.length && out[out.length - 1] !== '') out.push(''); continue; }
    push(inlineStyles(line.replace(/^\s+/, (lead) => lead.length >= 4 ? '    ' : '')));
  }
  if (fence?.lang === 'mermaid') push(`${DIM}  └ ${fence.total} lines of mermaid${R}`);
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}
