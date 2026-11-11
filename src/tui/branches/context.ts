import { statSync } from 'node:fs';
import { DEFAULT_LARGE_THRESHOLD_BYTES } from '../../context.js';

export interface NextTuiContextHost {
  readonly chatLines: string[];
  readonly attachments: Map<string, string>;
  readonly attachmentPage: number;
  readonly attachmentPageSize: number;
  setAttachmentPage(value: number): void;
  setAttachmentArea(lines: string[]): void;
  setChatScrollOffset(value: number): void;
}

export function projectNextTuiContextArea(
  attachments: ReadonlyMap<string, string>, attachmentPage: number, attachmentPageSize: number,
): { page: number; lines: string[] } {
  const entries = [...attachments];
  const pageSize = Math.max(1, attachmentPageSize);
  const pageCount = Math.max(1, Math.ceil(entries.length / pageSize));
  const page = Math.max(0, Math.min(attachmentPage, pageCount - 1));
  return {
    page,
    lines: entries.length
      ? [`첨부 ${entries.length}건 · ${page + 1}/${pageCount}쪽`, ...entries.slice(page * pageSize, (page + 1) * pageSize)
          .map(([token, path]) => `  ${token} · ${path}`)]
      : [],
  };
}

function attachmentId(token: string): number | null {
  const match = /^\[attached (\d+): /u.exec(token);
  // Source: src/tui/input/at-picker.ts acceptAtFile emits a decimal ordinal in the token.
  return match ? Number.parseInt(match[1]!, 10) : null;
}

/** Operates on the same token map that Next TUI sends to the shared turn path. */
export function runNextTuiContextBranchRoute(input: string, host: NextTuiContextHost): void {
  const [, subcommand, rawId, ...extra] = input.trim().split(/\s+/u);
  const action = subcommand?.toLowerCase();
  const attachments = host.attachments;
  let attachmentPage = host.attachmentPage;
  const setAttachmentPage = (value: number): void => {
    attachmentPage = value;
    host.setAttachmentPage(value);
  };
  const refreshAttachmentArea = (): void => {
    const projection = projectNextTuiContextArea(attachments, attachmentPage, host.attachmentPageSize);
    if (projection.page !== attachmentPage) setAttachmentPage(projection.page);
    host.setAttachmentArea(projection.lines);
  };
  if (!action) {
    refreshAttachmentArea();
    if (!attachments.size) host.chatLines.push('  /context: (없음)');
  } else if (action === 'clear') {
    if (extra.length || (rawId !== undefined && rawId.toLowerCase() !== 'big')) {
      host.chatLines.push('Usage: /context clear [big]');
    } else if (rawId?.toLowerCase() === 'big') {
      let removed = 0;
      for (const [token, path] of attachments) {
        try {
          if (statSync(path).size > DEFAULT_LARGE_THRESHOLD_BYTES) {
            attachments.delete(token);
            removed++;
          }
        } catch { /* A missing file is retained until the person drops it explicitly. */ }
      }
      host.chatLines.push(`큰 첨부 ${removed}건 삭제`);
      setAttachmentPage(0);
      refreshAttachmentArea();
    } else {
      const removed = attachments.size;
      attachments.clear();
      host.chatLines.push(`첨부 ${removed}건 삭제`);
      setAttachmentPage(0);
      refreshAttachmentArea();
    }
  } else if (action === 'drop') {
    // Source: src/tui/input/at-picker.ts acceptAtFile numbers each attachment token.
    const id = rawId && /^\d+$/u.test(rawId) ? Number.parseInt(rawId, 10) : null;
    if (id === null || extra.length) host.chatLines.push('Usage: /context drop <id>');
    else {
      const token = [...attachments.keys()].find((candidate) => attachmentId(candidate) === id);
      if (token) attachments.delete(token);
      host.chatLines.push(token ? `첨부 #${id} 삭제` : `첨부 #${id} 없음`);
      if (token) setAttachmentPage(0);
      refreshAttachmentArea();
    }
  } else if (action === 'page') {
    const requestedPage = rawId && /^\d+$/u.test(rawId) ? Number.parseInt(rawId, 10) : 0;
    const pageCount = Math.max(1, Math.ceil(attachments.size / host.attachmentPageSize));
    if (!requestedPage || extra.length || requestedPage > pageCount) {
      host.chatLines.push(`Usage: /context page <1-${pageCount}>`);
    } else {
      setAttachmentPage(requestedPage - 1);
      refreshAttachmentArea();
    }
  } else {
    host.chatLines.push(`Unknown subcommand: /context ${action}`);
    host.chatLines.push('Usage: /context | /context page <n> | /context clear [big] | /context drop <id>');
  }
  host.setChatScrollOffset(-1);
}
