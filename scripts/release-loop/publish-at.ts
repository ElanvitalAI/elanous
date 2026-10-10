// RELEASE-PUBLISH-AT — the one validator for a promised publish time (CLI entry and the publish node share it).

/** `--publish-at` must be an offset-bearing ISO datetime; returns the refusal message, or null when valid. */
export function publishAtError(value: string): string | null {
  const refused = '--publish-at requires an offset-bearing ISO datetime on a real calendar date';
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!m || !Number.isFinite(Date.parse(value))) return refused;
  const [y, mo, d, h, mi, sec = '0', oh = '0', om = '0'] = m.slice(1) as string[];
  // Date.parse rolls 02-30 over into March; a promised publish day must be the day that was written.
  const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (day.getUTCFullYear() !== Number(y) || day.getUTCMonth() !== Number(mo) - 1 || day.getUTCDate() !== Number(d)) return refused;
  if (Number(h) > 23 || Number(mi) > 59 || Number(sec) > 59 || Number(oh) > 23 || Number(om) > 59) return refused;
  return null;
}
