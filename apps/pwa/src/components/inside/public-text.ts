const RUN_ID = /\brun-([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ABSOLUTE_PATH = /(?:\/(?:Users|home|private)\/[\w.%@+~/-]+|\b[A-Za-z]:\\(?:[^\\\s,;<>"']+\\)*[^\\\s,;<>"']+)/g;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
// A secret is one long unbroken run (no hyphens) or a known key prefix. Hyphenated words — repo file names like
// `MANUAL-mission-fabric-integration-2026-09-03` — are not secrets and must survive (review must-fix · INSIDE1a).
const TOKEN = /(?<![A-Za-z0-9_-])(?:[A-Za-z0-9_]{40,}|(?:sk|ghp|gho|ghs|github_pat|xox[abpr])[-_][A-Za-z0-9_-]{20,})(?![A-Za-z0-9_-])/g;
const INTERNAL_SEAT = /\b(?:OP|MK|TC|UX)\b/g;
// Machine names (node-b …) — the same mask as the public capture mode (`msbN` → `remote-N`).
const MACHINE = /\bmsb(\d+)\b/gi;
const SEAT_EMOJI = /(?:\u{1F451}|🪑|🅞|🅜|🅣|🅤|🅢|🅕)\uFE0F?/gu;
const SEAT_NAMES: Record<string, string> = { OP: 'COO', MK: 'CMO', TC: 'CTO', UX: 'CXO' };

/** Identify private markers without changing the input; suitable for public-screen assertions. */
export function leaksInternal(s: string): string[] {
  return [RUN_ID, ABSOLUTE_PATH, EMAIL, TOKEN, INTERNAL_SEAT, SEAT_EMOJI, MACHINE]
    .flatMap((pattern) => [...s.matchAll(pattern)].map((match) => match[0]));
}

/** Sanitize each string at the boundary where it becomes public display text. */
export function toPublicText(s: string): string {
  let text = s;
  let previous: string;
  do {
    previous = text;
    text = text
      .replace(RUN_ID, (_, head: string) => `run-${head.slice(0, 6)}`)
      .replace(ABSOLUTE_PATH, '')
      .replace(EMAIL, '')
      .replace(SEAT_EMOJI, '')
      .replace(TOKEN, '')
      .replace(INTERNAL_SEAT, (name) => SEAT_NAMES[name])
      .replace(MACHINE, (_, n: string) => `remote-${n}`);
  } while (text !== previous && leaksInternal(text).length > 0);
  return text;
}
