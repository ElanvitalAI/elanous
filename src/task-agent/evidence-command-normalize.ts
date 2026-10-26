import { linesOutsideFencedCode, validateGoalDoneEvidenceCommand } from '../self-implement/goal-author.js';

const EVIDENCE_LINE = /^(\s*(?:[-*]\s*)?완료 경계 증거 명령\s*:\s*)(.*?)(\s*)$/;

/** Remove known result annotations from an evidence command, preserving every other line. */
export function normalizeEvidenceCommandLines(document: string): { text: string; warnings: string[]; unrecognized: string[] } {
  const warnings: string[] = [];
  const unrecognized: string[] = [];
  const replacements: Array<{ start: number; old: string; next: string }> = [];
  for (const line of linesOutsideFencedCode(document)) {
    const match = EVIDENCE_LINE.exec(line.text);
    if (!match) continue;
    const original = match[2].trim();
    if (!original) continue;
    let candidate = original.replace(/\s*(?:→|->)\s*0\s+fail\s*$/i, '')
      .replace(/\s*·\s*typecheck\s+PASS\s*$/i, '').trim();
    // Some cards have both annotations; peel them in either order.
    candidate = candidate.replace(/\s*(?:→|->)\s*0\s+fail\s*$/i, '')
      .replace(/\s*·\s*typecheck\s+PASS\s*$/i, '').trim();
    if (candidate.startsWith('`') && candidate.endsWith('`') && candidate.length > 2)
      candidate = candidate.slice(1, -1).trim();
    if (candidate === original) {
      if (/[`→]|->|·\s*typecheck\b/i.test(original)) {
        warnings.push(`완료 경계 증거 명령 정규화 불가: ${original}`);
        unrecognized.push(original);
      }
      continue;
    }
    // An unrecognized decoration is never silently converted into a shell command.
    if (!validateGoalDoneEvidenceCommand(candidate).command) {
      warnings.push(`완료 경계 증거 명령 정규화 불가: ${original}`);
      unrecognized.push(original);
      continue;
    }
    replacements.push({ start: line.start, old: line.text, next: `${match[1]}${candidate}${match[3]}` });
    warnings.push(`완료 경계 증거 명령 정규화: ${original} → ${candidate}`);
  }
  let text = document;
  for (const replacement of replacements.reverse())
    text = text.slice(0, replacement.start) + replacement.next + text.slice(replacement.start + replacement.old.length);
  return { text, warnings, unrecognized };
}
