import type { MessageBlock } from '../../conv-substrate/message-block.js';
import { safeLogText, safeStatusText } from './log-view.js';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function wrapRawLine(text: string, columns: number, indent = '  '): string[] {
  const width = Math.max(1, columns - Bun.stringWidth(indent));
  const lines: string[] = [];
  let line = '';
  let used = 0;
  for (const { segment } of graphemes.segment(text)) {
    const cells = Bun.stringWidth(segment);
    if (used > 0 && used + cells > width) {
      lines.push(`${indent}${line}`);
      line = '';
      used = 0;
    }
    line += segment;
    used += cells;
  }
  lines.push(`${indent}${line}`);
  return lines;
}

export type TuiDetailLevel = 0 | 1 | 2 | 3;

const kindLabel = (block: MessageBlock): string => {
  switch (block.body.kind) {
    case 'thought': return '생각';
    case 'tool-call': return '도구';
    case 'plan': return '진행';
    case 'status': return '상태';
    case 'error': return '오류';
    case 'assistant': return '답';
    case 'user': return '입력';
  }
};

const blockText = (block: MessageBlock): string => {
  switch (block.body.kind) {
    case 'thought':
    case 'status':
    case 'error':
    case 'assistant':
    case 'user': return block.body.text;
    case 'tool-call': return [block.body.title, block.body.status].filter(Boolean).join(' · ');
    case 'plan': return block.body.ref;
  }
};

const compact = (text: string): string => safeStatusText(text).replace(/\s+/g, ' ').trim();
const wrappedLabel = (label: string, text: string, columns: number): string[] =>
  wrapRawLine(`${label} · ${text || '(내용 없음)'}`, columns, '');
const wrappedStep = (step: string, columns: number): string[] =>
  wrapRawLine(`· ${compact(step)}`, columns, '  ');

function foldedHeader(label: string, summary: string, columns: number): string {
  const prefix = `▸ ${label}`;
  const content = summary ? ` · ${summary}` : '';
  const full = `${prefix}${content}`;
  if (Bun.stringWidth(full) <= columns) return `\x1b[2m${full}\x1b[0m`;
  let clipped = '';
  let used = 0;
  const parts = Array.from(graphemes.segment(full), ({ segment }) => segment);
  for (const segment of parts) {
    const cells = Bun.stringWidth(segment);
    if (used + cells > Math.max(0, columns - 1)) break;
    clipped += segment;
    used += cells;
  }
  if (used < columns && clipped.length < full.length) clipped += '…';
  return `\x1b[2m${clipped}\x1b[0m`;
}

/** Answer and user text keep their ordinary transcript render; non-answer events start at L0. */
export function messageBlockDetailLines(
  block: MessageBlock,
  requested: TuiDetailLevel = 0,
  columns = 80,
  rawText?: string,
): string[] {
  if (block.body.kind === 'assistant' || block.body.kind === 'user') return [];

  const body = compact(blockText(block));
  const summary = compact(block.detail?.summary ?? body);
  const level = Math.min(requested, block.detail?.level ?? 1) as TuiDetailLevel;
  const label = kindLabel(block);
  const l0Body = block.body.kind === 'status' ? '' : summary;
  const shortBody = l0Body.length > 48 ? `${l0Body.slice(0, 47)}…` : l0Body;

  if (level === 0) {
    const foldedSummary = block.body.kind === 'status' ? '' : shortBody;
    return [foldedHeader(label, foldedSummary, columns)];
  }
  if (level === 1) return wrappedLabel(`▾ ${label}`, summary, columns);
  if (level === 2) {
    const steps = block.detail?.steps ?? [];
    return [...wrappedLabel(`▾ ${label}`, summary, columns),
      ...steps.flatMap((step) => wrappedStep(step, columns))];
  }
  const reference = block.detail?.rawRef;
  if (!reference) return messageBlockDetailLines(block, 2, columns);
  const raw = rawText === undefined
    ? `원문 참조 대기 · ${reference.runId}/${reference.blockId}`
    : rawText.split(/\r?\n/).map(safeLogText).join('\n') || '(빈 원문)';
  return [...wrappedLabel(`▾ ${label}`, summary, columns),
    ...(block.detail?.steps ?? []).flatMap((step) => wrappedStep(step, columns)),
    ...raw.split(/\r?\n/).flatMap((line) => wrapRawLine(safeLogText(line), columns))];
}

/** Enter advances one available tier; after the last tier, the block folds back to L0. */
export function nextMessageBlockDetailLevel(block: MessageBlock, current: TuiDetailLevel): TuiDetailLevel {
  const max = block.detail?.level ?? 1;
  return current >= max ? 0 : (current + 1) as TuiDetailLevel;
}
