import { renderNextTuiLogFrame, safeLogText } from './render.js';

const shellApprovalSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function shellApprovalCommandLines(command: string, columns: number): string[] {
  const width = Math.max(1, columns - 2);
  const lines: string[] = [];
  for (const sourceLine of safeLogText(command).split(/\r?\n/)) {
    let line = '';
    let used = 0;
    for (const { segment } of shellApprovalSegmenter.segment(sourceLine)) {
      const cells = Bun.stringWidth(segment);
      if (used > 0 && used + cells > width) {
        lines.push(`  ${line}`);
        line = '';
        used = 0;
      }
      if (cells > width) continue;
      line += segment;
      used += cells;
    }
    lines.push(`  ${line}`);
  }
  return lines.length ? lines : ['  '];
}

export function shellApprovalCommandViewport(
  command: string,
  terminalColumns: number,
  sidetabWidth: number,
  rows: number,
  scroll: number,
): { readonly lines: readonly string[]; readonly pageSize: number; readonly scroll: number } {
  const chatColumns = Math.max(1, terminalColumns - (sidetabWidth > 0 ? sidetabWidth + 1 : 0));
  const lines = shellApprovalCommandLines(command, chatColumns);
  const pageSize = Math.max(1, Math.min(8, rows - 6));
  return { lines, pageSize, scroll: Math.min(Math.max(0, scroll), Math.max(0, lines.length - pageSize)) };
}

/** Render the main Next TUI transcript frame from the entry-owned view model. */
export function renderNextTuiEntryFrame(
  frameInput: Parameters<typeof renderNextTuiLogFrame>[0],
  prepareHistory: Parameters<typeof renderNextTuiLogFrame>[1],
): ReturnType<typeof renderNextTuiLogFrame> {
  return renderNextTuiLogFrame(frameInput, prepareHistory);
}
