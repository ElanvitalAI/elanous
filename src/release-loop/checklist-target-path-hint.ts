export interface TargetPathHintLine {
  readonly fragments: readonly string[];
  readonly labelMissing: boolean;
}

/** Parse the first declared target-path line shared by checklist storage and ask preflight. */
export function parseTargetPathHintLine(text: string): TargetPathHintLine {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim() !== '');
  if (firstLine === undefined) return { fragments: [], labelMissing: true };
  const match = /^\s*(?:대상\s*경로|target\s*paths?)\s*[:：]\s*(.*)$/i.exec(firstLine);
  if (!match) return { fragments: [], labelMissing: true };
  return { fragments: match[1]!.split(/[·,;]/), labelMissing: false };
}
