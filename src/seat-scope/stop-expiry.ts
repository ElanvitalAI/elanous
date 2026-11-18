/** SCOPE-STOP-EXPIRY — a STOP instruction in seats/<id>/SCOPE.md needs an expiry instant.
 *  A STOP whose expiry is missing or already past is a warning, not a silent hold. */

export type ScopeStopWarning = {
  seat: string;
  path: string;
  reason: 'missing-expiry' | 'unrecognized-expiry' | 'expired';
  expiresAt?: string;
};

/** Uppercase STOP as its own word, including markdown heading, list, and bold forms.
 *  "Stop conditions" and "Stopwatch" are not a STOP. The A-number branch also
 *  requires the uppercase word STOP, so a lowercase "stops" is not a hold. */
const STOP_LINE = /^\s*(?:[-*]\s+)?(?:#{1,6}\s+)?(?:\*\*)?STOP\b/u;
const EXPIRY_MARK = /(?:expires|expiry|만료)\s*[:=]?\s*(\S+)/u;
const EXPIRY_INSTANT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))$/u;

export function scopeStopWarnings(
  files: readonly { seat: string; path: string; text: string }[],
  now: Date,
): ScopeStopWarning[] {
  const warnings: ScopeStopWarning[] = [];
  for (const file of files) {
    for (const line of file.text.split('\n')) {
      if (!STOP_LINE.test(line)) continue;
      const marked = EXPIRY_MARK.exec(line)?.[1];
      const expiry = marked?.match(EXPIRY_INSTANT)?.[1];
      if (!expiry) {
        warnings.push({ seat: file.seat, path: file.path, reason: marked ? 'unrecognized-expiry' : 'missing-expiry' });
        break;
      }
      const expiresAt = Date.parse(expiry);
      if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
        warnings.push({ seat: file.seat, path: file.path, reason: 'expired', expiresAt: expiry });
        break;
      }
    }
  }
  return warnings;
}
