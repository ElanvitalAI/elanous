/** Recover the exact must-fix text from the captured self-review stdout. */
import { isNoneSentinelFinding } from '../agent-substrate/pr-reviewer.js';
import { createHash } from 'node:crypto';

const SHA40 = /^[0-9a-f]{40}$/i;
export const repairReviewDigest = (text: string): string => createHash('sha256').update(text).digest('hex');

export function repairMustFixFromReview(text: string, pr: number, head: string): string[] | null {
  if (!Number.isSafeInteger(pr) || pr < 1 || !SHA40.test(head)) return null;
  for (const line of text.split(/\r?\n/).reverse()) {
    if (!line.trimStart().startsWith('{')) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    const foundPr = typeof v.pr === 'number' ? v.pr : typeof v.pr === 'string' ? Number(v.pr.replace(/^#/, '')) : NaN;
    if (foundPr !== pr || typeof v.headCommit !== 'string' || v.headCommit.toLowerCase() !== head.toLowerCase()
      || v.reviewed !== true || (v.verdict !== 'fail' && v.verdict !== 'pass' && v.verdict !== 'warn')
      || typeof v.error === 'string' || !Array.isArray(v.mustFix)
      || !v.mustFix.every((item) => typeof item === 'string')) return null;
    return v.mustFix.filter((item): item is string => typeof item === 'string' && !isNoneSentinelFinding(item) && !!item.trim());
  }
  return null;
}
