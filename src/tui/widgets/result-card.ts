/** ResultCard — a boxed answer: title, subtitle, headed sections, numbered evidence [n], disclaimer. */
import { cells, clean, fit, wrap } from './text.js';

export interface ResultSection { readonly heading: string; readonly lines: readonly string[] }
export interface Evidence { readonly n: number; readonly label: string; readonly url?: string }
export interface ResultCardProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly sections: readonly ResultSection[];
  readonly evidence?: readonly Evidence[];
  readonly disclaimer?: string;
}

/** The box spans the width (at most 100 cells); text wraps inside it. */
export function renderResultCard(props: ResultCardProps, width: number): string[] {
  const w = Math.max(8, Math.min(100, width));
  const inner = w - 4;
  const row = (text: string) => `│ ${text}${' '.repeat(Math.max(0, inner - cells(text)))} │`;
  const body: string[] = [];
  const block = (lines: string[]) => { if (body.length) body.push(''); body.push(...lines); };
  if (props.subtitle) block(wrap(props.subtitle, inner));
  for (const section of props.sections) {
    block([fit(clean(section.heading), inner), ...section.lines.flatMap((line) => wrap(line, inner - 2).map((l) => `  ${l}`))]);
  }
  if (props.evidence?.length) {
    block(['Evidence', ...props.evidence.flatMap((e) => {
      const tag = `[${e.n}] `;
      const lines = wrap(`${clean(e.label)}${e.url ? ` — ${clean(e.url)}` : ''}`, inner - 2 - tag.length);
      return lines.map((l, i) => `  ${i === 0 ? tag : ' '.repeat(tag.length)}${l}`);
    })]);
  }
  if (props.disclaimer) block(wrap(props.disclaimer, inner));
  const title = fit(clean(props.title), w - 6);
  const top = `╭─ ${title} ${'─'.repeat(Math.max(0, w - 5 - cells(title)))}╮`;
  return [top, ...body.map(row), `╰${'─'.repeat(w - 2)}╯`];
}
