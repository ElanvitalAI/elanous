// ── URL → skill router (deterministic, pre-LLM) ──
//
// PLAN-url-triage-routing-2026-07-22 · P1.
//
// The keyword router (`detectSkillTrigger`) never sees a bare URL as a
// trigger — a raw `https://youtu.be/…` string contains none of a skill's
// trigger tokens, so it scores 0 and the prompt falls through to a normal
// LLM turn. This module adds the missing seam: a pure, deterministic
// URL detector that maps a URL's *kind* (youtube/x/github/web) to the
// skill that should process it, with a context guard so URLs used mid-
// instruction ("이 코드 참고해 <github url>") are NOT auto-fired.
//
// Design constraints (mirror router.ts):
//   - Pure function — no disk, no provider calls. Tests drive it.
//   - Surface-agnostic: TUI + Telegram (the two main channels) share it.
//   - Guard-first: any guard keyword present → return null (defer to LLM).
//     This encodes R8 (혼합 의도 → 가드 확장) and R5 (코드참고 가드).
//   - Never a hard bypass on its own — callers decide auto-fire vs suggest.

/** Config shape consumed here — a structural subset of
 *  user-config `skills.urlRouting`, kept local so this module has no
 *  import cycle with user-config. */
export interface UrlRoutingConfig {
  /** Master switch. Off → detectUrlRoute always returns null. */
  enabled: boolean;
  /** Quick→detailed two-stage composition (orchestrator-level). */
  twoStage: boolean;
  /** Output targets always applied (e.g. ['obsidian']). */
  defaultTargets: string[];
  /** If ANY of these appear alongside a URL, suppress auto-fire and let
   *  the LLM handle it (code-reference / argumentative / build intents). */
  guardKeywords: string[];
  /** youtube URL + any of these → route to the absorb skill (yt-vault)
   *  instead of the summary skill. */
  absorbKeywords: string[];
  /** kind → skill name. */
  map: { youtube: string; x: string; github: string; web: string };
  /** Skill that owns absorb/knowledge-vault work (youtube absorb path). */
  absorbSkill: string;
}

export type UrlKind = 'youtube' | 'x' | 'github' | 'web';

export interface UrlRouteDecision {
  /** The first URL found in the text. */
  url: string;
  /** All URLs found (deduped, in order) — callers may note extras. */
  urls: string[];
  kind: UrlKind;
  /** Resolved skill to run. */
  skill: string;
  /** True when this is the youtube→absorb (yt-vault) path. */
  absorb: boolean;
  /** Quick→detailed composition requested (false on the absorb path,
   *  where absorb is itself the "detailed" endpoint). */
  twoStage: boolean;
  /** Output targets to pass through (e.g. ['obsidian']). */
  targets: string[];
  /** Short human/observability reason. */
  reason: string;
}

// Matches http(s) URLs. Trailing punctuation (].,) is trimmed by
// stripTrailingPunct so "봐 (https://x.com/a). 어때" yields a clean URL.
const URL_RE = /https?:\/\/[^\s<>"'`)\]}]+/gi;

function stripTrailingPunct(u: string): string {
  return u.replace(/[.,;:!?)\]}>'"]+$/, '');
}

/** Extract deduped URLs in first-seen order. Exported for callers that
 *  want to know "does this text contain a URL" without a full decision. */
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(URL_RE)) {
    const u = stripTrailingPunct(m[0]);
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

/** Classify a URL's host into a routing kind. Best-effort host parse —
 *  falls back to 'web' for anything unrecognized or unparseable. */
export function classifyUrl(url: string): UrlKind {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    // Malformed — try a cheap host grab so "https://youtu.be/x" without
    // a strict parse still classifies.
    const m = /^https?:\/\/([^/\s]+)/i.exec(url);
    host = (m?.[1] ?? '').toLowerCase().replace(/^www\./, '');
  }
  if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com')) return 'youtube';
  if (host === 'x.com' || host === 'twitter.com' || host.endsWith('.x.com') || host.endsWith('.twitter.com')) return 'x';
  if (host === 'github.com' || host.endsWith('.github.com')) return 'github';
  return 'web';
}

function containsAny(haystack: string, needles: string[]): string | null {
  for (const n of needles) {
    const t = (n ?? '').toLowerCase().trim();
    if (t && haystack.includes(t)) return n;
  }
  return null;
}

// ── Work-context guard (URL-ROUTE-WORK-CONTEXT-GUARD · 10-22) ──
// Observed: a long n8n work instruction carrying «RSS URL https://hnrss.org/frontpage
// · Limit 5 …» (a value to type into a node) was rewritten into an omni-digest run.
// The config guardKeywords did not stop it, and a user config replaces that list
// wholesale — so this guard lives in code and always applies.

/** «Put this value into a field» phrasing — the URL is data, not a digest target. */
const FIELD_INPUT_WORDS = [
  '입력', '넣어', '넣고', '넣기', '붙여넣', '칸에', '노드에', '필드에', '란에',
  '로 설정', '으로 설정', '에 설정', '설정해',
  'paste into', 'type into', 'fill in', 'into the field', 'enter it',
];
/** Text outside the URLs longer than this is a work instruction, not «summarize this». */
export const WORK_INSTRUCTION_MIN_CHARS = 160;
/** Step separators (`·` `→` `->`, numbered/bulleted lines) that mark a multi-step task. */
const STEP_MARKER_RE = /·|→|->|^\s*(?:\d+[.)]|[-*•])\s+/gmu;

/** A URL written as a labelled value — «RSS URL https://…», «Webhook URL: https://…», «endpoint=https://…».
 *  Matched against the text with each URL replaced by a marker, so a label inside a URL
 *  (`https://a.com/?url=https://b.com`) is never read as one. */
const URL_MARK = '\u0000';
/** Words that ask for a digest of the URL — they exempt the labelled-URL check (not the other guards). */
const DIGEST_REQUEST_WORDS = ['요약', '정리', '분석', 'summar', 'digest', 'tl;dr', 'tldr'];
const LABELLED_URL_RE = /(?:^|[^\p{L}\p{N}])(?:url|uri|endpoint)\s*[:=]?\s*\u0000/iu;

/** Why this URL-bearing text must stay on the LLM path, or null when it may route. */
export function workContextGuardReason(text: string): string | null {
  const rest = text.replace(URL_RE, ' ').replace(/\s+/g, ' ').trim();
  const field = containsAny(rest.toLowerCase(), FIELD_INPUT_WORDS);
  if (field) return `field-input("${field}")`;
  // An explicit digest request («URL https://… 요약해줘») names the URL to summarize, so the label alone does not hold it back.
  if (LABELLED_URL_RE.test(text.replace(URL_RE, URL_MARK)) && !containsAny(rest.toLowerCase(), DIGEST_REQUEST_WORDS)) return 'labelled-url-value';
  if (rest.length > WORK_INSTRUCTION_MIN_CHARS) return `long-instruction(${rest.length})`;
  const steps = text.replace(URL_RE, ' ').match(STEP_MARKER_RE)?.length ?? 0;
  if (steps >= 2) return `multi-step(${steps})`;
  return null;
}

/** Main entry. Returns a routing decision when the text contains a URL
 *  that should be auto-processed, or null when:
 *   - routing disabled,
 *   - no URL present,
 *   - a guard keyword is present (defer to the LLM — R5/R8),
 *   - the URL sits inside a work instruction (`workContextGuardReason`).
 *
 *  Callers (TUI dashboard / Telegram agent) then decide auto-fire vs
 *  suggest, and run the mapped skill (two-stage per P4). */
export function detectUrlRoute(
  text: string,
  cfg: UrlRoutingConfig,
): UrlRouteDecision | null {
  if (!cfg.enabled) return null;
  if (!text || !text.trim()) return null;

  const urls = extractUrls(text);
  if (urls.length === 0) return null;

  const haystack = text.toLowerCase();

  // Guard-first (R5/R8): a URL used mid-instruction ("이 코드 참고해",
  // "반박해봐", "구현해줘") is NOT a digest request — defer to the LLM.
  const guardHit = containsAny(haystack, cfg.guardKeywords);
  if (guardHit) return null;
  if (workContextGuardReason(text)) return null;

  const url = urls[0]!;
  const kind = classifyUrl(url);

  // youtube + absorb intent → knowledge-vault path (yt-vault).
  const absorbHit = kind === 'youtube' ? containsAny(haystack, cfg.absorbKeywords) : null;
  const absorb = absorbHit != null;

  const skill = absorb ? cfg.absorbSkill : cfg.map[kind];

  return {
    url,
    urls,
    kind,
    skill,
    absorb,
    // Absorb is itself the detailed endpoint — no quick→detailed split
    // (a quick brief may still be composed at the orchestrator, but the
    // skill call is single-pass). Summary paths honor cfg.twoStage.
    twoStage: absorb ? false : cfg.twoStage,
    targets: [...cfg.defaultTargets],
    reason: absorb
      ? `youtube+absorb("${absorbHit}") → ${skill}`
      : `${kind} URL → ${skill}`,
  };
}
