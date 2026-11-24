/** Fail-closed classification for consumers of explicit, structured review findings.
 * Legacy strings, malformed findings and mixed failures are never reclassified.
 */
export const SECURITY_CLASSES = ['destructive', 'secret-leak', 'unauth-remote', 'cross-user-data'] as const;
export type SecurityClass = typeof SECURITY_CLASSES[number];
export function isSecurityClass(value: unknown): value is SecurityClass {
  return typeof value === 'string' && (SECURITY_CLASSES as readonly string[]).includes(value);
}

/** Request classification only for explicitly security-only findings joined to real string blockers.
 * This is an observation, not a verdict or gate decision. Ambiguous/mixed reviews remain untouched. */
export function isUncategorizedSecurityHold(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (typeof row.verdict !== 'string' || !['hold', 'fail'].includes(row.verdict.toLowerCase())
      || row.securityClass != null || !Array.isArray(row.mustFix) || !row.mustFix.length
      || !row.mustFix.every((x: unknown) => typeof x === 'string' && x.trim())
      || !Array.isArray(row.securityFindings) || row.securityFindings.length !== row.mustFix.length) return false;
  const blockers = row.mustFix as string[];
  if (new Set(blockers).size !== blockers.length) return false;
  return row.securityFindings.every((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const finding = item as Record<string, unknown>;
    return finding.kind === 'security-only' && typeof finding.text === 'string'
      && blockers.filter(text => text === finding.text).length === 1 && finding.securityClass == null;
  }) && new Set(row.securityFindings.map((item: {text: string}) => item.text)).size === blockers.length;
}

/** Structured, read-only request and audit metadata; the original decision remains authoritative. */
export function classificationAudit(row: Record<string, unknown>): Record<string, unknown> {
  return { version: 1, classificationRequest: isUncategorizedSecurityHold(row) ? 'not-sent' : 'not-requested',
    reason: isUncategorizedSecurityHold(row) ? 'security-only-unclassified' : 'not-eligible' };
}

export interface ReviewFollowUp { text: string; cell?: string }

/** Merge legacy follow-ups without destroying the original fields or silently dropping malformed entries. */
export function mergeReviewFollowUps(result: Record<string, unknown>): ReviewFollowUp[] {
  const out: ReviewFollowUp[] = [];
  for (const field of ['fu', 'edges', 'followUp']) {
    const entries = result[field];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry === 'string' && entry.trim()) out.push({ text: entry });
      else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const obj = entry as Record<string, unknown>;
        if (typeof obj.text === 'string' && obj.text.trim()) {
          out.push({ text: obj.text, ...(typeof obj.cell === 'string' ? { cell: obj.cell } : {}) });
        }
      }
    }
  }
  return out.filter((item, i) => out.findIndex((other) => other.text === item.text && other.cell === item.cell) === i);
}

/** Classification is observational: never alter the verdict or blockers. */
export function normalizeExplicitSecurityHold(result: Record<string, unknown>): { result: Record<string, unknown>; downgraded: boolean } {
  return { result, downgraded: false };
}
