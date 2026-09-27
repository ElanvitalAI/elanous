// ── TUI attachment-summary presentation leaf (RFC §6b · M2) ───────────
//
// Renders the dashboard chat attachment-summary block — one line per
// added attachment (new vs existing), tracks each rendered row → id so a
// left-click can re-open the attachment, and kicks the scratch handler
// for fresh image/file attachments.
//
// TUI-surface presentation leaf — home = src/tui/chat/ (RFC §6b · M2).
// Moved out of dashboard/ (표면-중립 분해): this is pure TUI chat
// presentation over dependency-injected formatters/handlers — no cross-
// surface use. dashboard/attachment-summary.ts is now a re-export shim
// for backward compat until callers migrate.

import type { Attachment } from '../../context.js';

export interface DashboardAttachmentSummaryEntry {
  attachment: Attachment;
  isNew: boolean;
}

export interface DashboardAttachmentSummaryDeps {
  formatNewLine: (attachment: Attachment) => string;
  formatExistingLine: (attachment: Attachment) => string;
  pushLine: (line: string) => number;
  trackRow: (row: number, attachmentId: number) => void;
  setScratchImage?: (sourcePath: string, filename: string) => Promise<void>;
  setScratchFile?: (attachment: Attachment) => void;
}

export function renderDashboardAttachmentSummary(
  added: DashboardAttachmentSummaryEntry[],
  deps: DashboardAttachmentSummaryDeps,
): void {
  const seen = new Set<number>();
  for (const item of added) {
    const attachment = item.attachment;
    const duplicate = seen.has(attachment.id);
    seen.add(attachment.id);
    const row = deps.pushLine(
      item.isNew && !duplicate
        ? deps.formatNewLine(attachment)
        : deps.formatExistingLine(attachment),
    );
    deps.trackRow(row, attachment.id);
    if (!item.isNew || duplicate) continue;
    if (attachment.kind === 'image') {
      void deps.setScratchImage?.(attachment.sourcePath, attachment.filename);
    } else {
      deps.setScratchFile?.(attachment);
    }
  }
}
