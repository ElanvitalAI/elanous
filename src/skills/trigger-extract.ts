// ── Skill trigger auto-extraction ──
//
// Pure heuristic that reads a SKILL.md `description:` body and pulls
// out the trigger keyword list the author already embedded in prose.
// Almost every community-authored SKILL.md I've seen contains one of
// these marker phrases followed by a comma-separated / quoted list:
//
//   (EN, forward) "Use when the user ... : A, B, C."
//                 "Use this skill when ... : A, B, C."
//                 "Trigger on: \"A\", \"B\", \"C\"."
//   (KR, backward) "\"A\", \"B\", \"C\" 시 사용."
//                  "\"A\", \"B\", \"C\" 등의 언급 시 이 스킬 사용."
//
// Phase 3 plumbs the extractor into the skill index so none of the
// existing 23 SKILL.md files need frontmatter edits to participate
// in the router — preserving the shared /~/.claude/skills/ folder
// for other agent systems (claude-code / hermes / openclaw / opencode).
//
// Design priorities, in order:
//   1. Precision over recall. A false trigger that fires on unrelated
//      input is worse than a missed trigger. When in doubt, skip.
//   2. Purity + determinism. No I/O, no LLM, no config. Same input
//      always gives same output. That's what makes this testable.
//   3. Conservative scope. Only extract from sentences containing a
//      RECOGNIZED marker phrase. Free-floating comma-lists (e.g.
//      diagram-master's unmarked enumeration) are intentionally
//      skipped — too high a false-positive risk.

/** Tokens that look triggery on their own but carry no routing value. */
const STOPWORDS = new Set<string>([
  'the', 'of', 'a', 'an', 'and', 'or', 'to', 'for', 'in', 'on', 'at', 'by',
  'use', 'this', 'skill', 'when', 'whenever', 'if', 'with', 'from',
  '이', '그', '저', '것', '수', '등', '도', '나', '의', '에', '를', '은', '는',
]);

/** Domain-like token endings we should protect from sentence-splitting.
 *  `youtube.com / youtu.be URL` otherwise splits mid-marker. */
const DOMAIN_ENDINGS = /\b(\w+)\.(com|org|net|io|be|co|ai|dev|app|gg|xyz|me|pdf|py|ts|js|json|md)\b/gi;

/** Marker regex — forward: text AFTER a colon carries the triggers. */
const FORWARD_MARKERS = [
  // "Use when ... : <list>"
  /\buse\s+when\b[^:]{0,200}:\s*/i,
  // "Use this skill when/whenever/if ... : <list>"  — distinct regex so
  // the bare "Use when" doesn't greedily absorb another marker.
  /\buse\s+this\s+skill\s+(?:when|whenever|if)\b[^:]{0,200}:\s*/i,
  // "Trigger on: <list>" / "Triggers on: <list>"
  /\btriggers?\s+on\b\s*:\s*/i,
];

/** Marker regex — backward: text BEFORE the suffix carries the triggers.
 *  Matches "시 사용" / "언급 시 사용" / "등의 언급 시 이 스킬 사용". */
const BACKWARD_MARKER = /(?:등(?:의)?\s*)?(?:언급\s*)?시\s*(?:이?\s*스킬\s*)?사용(?=[\s.,]|$)/;

/** Main entry. Returns a deduped, cleaned list of candidate trigger
 *  keywords. Empty array is a perfectly normal result (description
 *  without any recognized marker). */
export function extractTriggers(description: string): string[] {
  if (typeof description !== 'string' || !description.trim()) return [];

  const segments = extractTriggerSegments(description);
  const items: string[] = [];
  for (const seg of segments) items.push(...extractItems(seg));

  return dedup(items.map(cleanToken).filter(isGoodTrigger));
}

/** Exported for tests — returns the raw text spans between a marker
 *  phrase and the next sentence boundary (forward) or the previous
 *  sentence boundary (backward). */
export function extractTriggerSegments(description: string): string[] {
  const text = description.replace(/\s+/g, ' ').trim();
  const sentences = splitSentences(text);
  const out: string[] = [];
  for (const s of sentences) {
    const seg = detectSegment(s);
    if (seg) out.push(seg);
  }
  return out;
}

// ── internals ──

function splitSentences(text: string): string[] {
  // Mask domain periods so `youtube.com URL` doesn't split between
  // "youtube" and "com URL". We restore them after splitting.
  const SENTINEL = '\x00';
  const masked = text.replace(DOMAIN_ENDINGS, (_m, a, b) => `${a}${SENTINEL}${b}`);
  const parts = masked.split(/\.(?=\s|$)/);
  return parts
    .map(p => p.replace(new RegExp(SENTINEL, 'g'), '.'))
    .map(p => p.trim())
    .filter(Boolean);
}

function detectSegment(sentence: string): string | null {
  for (const re of FORWARD_MARKERS) {
    const m = sentence.match(re);
    if (m && m.index !== undefined) {
      return sentence.slice(m.index + m[0].length);
    }
  }
  // Backward: sentence must END with the marker (possibly with trailing
  // whitespace/punct). If so, the prefix is the trigger block.
  const bw = sentence.match(BACKWARD_MARKER);
  if (bw && bw.index !== undefined) {
    const after = sentence.slice(bw.index + bw[0].length).trim();
    if (after.length === 0) return sentence.slice(0, bw.index);
  }
  return null;
}

function extractItems(segment: string): string[] {
  // Prefer quoted items — authors reach for quotes when listing
  // exact phrases, and they're far less noisy than comma splits.
  const quoted = [...segment.matchAll(/"([^"]+)"|'([^']+)'|「([^」]+)」/g)]
    .map(m => m[1] ?? m[2] ?? m[3] ?? '')
    .filter(Boolean);

  if (quoted.length >= 2) return quoted;

  // Fallback — split on commas / semicolons / pipes. Works for
  // youtube-master's "요약, 정리, 저장, ..." style.
  const commaSplit = segment.split(/[,，;；|]/).map(s => s.trim()).filter(Boolean);
  if (quoted.length === 1) {
    // Mixed — keep the quoted item, plus non-overlapping comma parts.
    const merged = [...quoted];
    for (const p of commaSplit) {
      if (!quoted.some(q => p.includes(q))) merged.push(p);
    }
    return merged;
  }
  return commaSplit;
}

function cleanToken(raw: string): string {
  // Placeholder chars like "analyze ~ for risk" mean the keyword is
  // parameterized. Splitting and keeping the longest fragment turns
  // "analyze ~ for risk" into "analyze" (substring-matchable) rather
  // than "analyze for risk" (only matches that exact phrase).
  let s = raw;
  if (/[~<>\[\]]/.test(s)) {
    // Authors overwhelmingly put the keyword BEFORE the placeholder
    // ("poll N agents on ~", "multi-agent vote: ~"), so taking the
    // first non-empty fragment yields a substring-matchable keyword.
    const parts = s.split(/[~<>\[\]]+/).map(p => p.trim()).filter(Boolean);
    s = parts[0] ?? '';
  }
  return s
    .replace(/^["'「(]+|["'」)]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[:：.]\s*$/, '')
    .trim();
}

function isGoodTrigger(token: string): boolean {
  if (!token) return false;
  const len = token.length;
  if (len < 2 || len > 40) return false;
  if (STOPWORDS.has(token.toLowerCase())) return false;
  // Pure digits — never a useful trigger.
  if (/^\d+$/.test(token)) return false;
  // Sentence fragments, not keywords.
  if ((token.match(/ /g) || []).length > 5) return false;
  // Pure punctuation / whitespace.
  if (/^[\s\p{P}]+$/u.test(token)) return false;
  // Non-CJK tokens below length 3 are too noisy ("ai", "pr", "ui"
  // collide with unrelated prose). CJK 2-char tokens stay — they're
  // often legitimately specific ("수급", "외국인" etc.). We detect
  // CJK by the presence of at least one Han/Hangul/Kana codepoint.
  const hasCJK = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(token);
  if (!hasCJK && len < 3) return false;
  return true;
}

function dedup(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const key = it.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(it);
    }
  }
  return out;
}
