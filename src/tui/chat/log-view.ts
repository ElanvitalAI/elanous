import type { SerializedMessage } from '../../session/index.js';
import { redactSecretText } from '../../debug/log.js';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function safeLogText(text: string): string {
  const plain = text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '');
  return redactSecretText(plain);
}

function wrapLine(text: string, columns: number): string[] {
  const width = Math.max(1, columns);
  const lines: string[] = [];
  let line = '';
  let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const cells = Bun.stringWidth(segment);
    if (used > 0 && used + cells > width) {
      lines.push(line);
      line = '';
      used = 0;
    }
    if (cells > width) continue;
    line += segment;
    used += cells;
  }
  lines.push(line);
  return lines;
}

export function fitLogLine(text: string, columns: number): string {
  return wrapLine(safeLogText(text), columns)[0] ?? '';
}

export function safeStatusText(text: string): string {
  return safeLogText(text).replace(/\n/g, ' ');
}

/** Lines moved per wheel notch over the chat log. */
export const WHEEL_SCROLL_LINES = 3;

/**
 * Next log scroll offset after one wheel notch. `scroll` counts lines above the
 * bottom, so 0 keeps following the newest line; `maxScroll` is how far the
 * history can go up (≤ 0 means it all fits and nothing scrolls).
 */
export function wheelScroll(scroll: number, direction: 'up' | 'down', maxScroll: number, step = WHEEL_SCROLL_LINES): number {
  const limit = Math.max(0, maxScroll);
  const next = scroll + (direction === 'up' ? step : -step);
  return Math.max(0, Math.min(limit, next));
}

/** Ephemeral reply preview until the persisted assistant message replaces it. */
export function streamReplyLines(text: string, columns: number): string[] {
  const parts = safeLogText(text).split('\n');
  const lines = parts.flatMap((part, index) => wrapLine(`${index === 0 ? '엘라누스: ' : '  '}${part}`, columns));
  return lines.slice(-80);
}

/** Plain, width-bounded history; no terminal control bytes from stored messages. */
export function logViewLines(messages: readonly SerializedMessage[], columns: number): string[] {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool') continue;
    const label = message.role === 'user' ? '나: ' : message.role === 'tool' ? '도구: ' : '엘라누스: ';
    const content = safeLogText(message.role === 'tool'
      ? `${message.toolName || '실행'} ${typeof message.toolResult === 'string' ? message.toolResult : ''}`
      : message.content);
    const parts = content.split('\n');
    for (let i = 0; i < parts.length; i++) {
      const prefix = i === 0 ? label : '  ';
      lines.push(...wrapLine(prefix + parts[i], columns));
    }
    lines.push('');
  }
  return lines.length > 0 ? lines : ['대화 기록 없음'];
}
