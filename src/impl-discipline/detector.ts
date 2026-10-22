// Phase detector for implementation discipline.
//
// Given the current turn's user text, classify into one of four
// phases. The system-prompt builder reads this result to decide
// which discipline guidance (if any) to inject as a system message.
//
// Rules (PLAN §3):
//   plan-loaded         — PLAN-*.md / HANDOFF-*.md / SPEC-*.md file-ref
//                         OR Korean/English doc keyword (핸드오프, 플랜
//                         문서, handoff, plan doc, 스펙 문서).
//   design-first        — implementation request contains an explicit new
//                         project, empty repository, or from-scratch signal.
//   implementation-ready — starts with an implementation verb
//                         (구현/implement/build/포팅/port/만들어) AND
//                         NOT paired with an exploration verb
//                         (설명/분석/리뷰).
//   idle                — everything else.
//
// An explicit new-project request wins over plan-loaded; otherwise the
// existing plan-loaded and implementation-ready precedence is unchanged.

import type { DetectInput, ImplPhase } from './types.js';

// File-ref patterns — deliberately anchored to the naming convention
// used in this repo (PLAN-xxx.md, HANDOFF-xxx.md, SPEC-xxx.md). A bare
// "PLAN.md" or "notes.md" does NOT trigger; the user might be asking
// a generic question about a file that happens to share the name.
const FILE_REF_RE = /\b(?:PLAN|HANDOFF|SPEC)-[\w-]+\.md\b/i;

// Keyword fallback — for cases where the user paraphrases ("핸드오프
// 따라 구현해줘") without spelling out a filename.
const DOC_KEYWORDS = [
  '플랜 문서',
  '핸드오프',
  '스펙 문서',
  'plan doc',
  'handoff',
  'spec doc',
];

const IMPL_VERB_RE = /(^|[\s\u3000])(구현|implement|build|포팅|port|만들어)/i;
const PROJECT_IMPL_VERB_RE = /(^|[\s\u3000])(구현|implement|build|포팅|port|개발|develop|생성|create|만들어)/i;
const NEW_PROJECT_SIGNAL_RE = /(?:새(?:로운)?\s*(?:저장소|프로젝트)|빈\s*저장소|(?:new|empty)\s+(?:repository|repo|project)\b)/i;
const FROM_SCRATCH_RE = /(?:\bfrom\s+scratch\b|처음부터)/i;
const PROJECT_TARGET_RE = /(?:\b(?:project|app|service)\b|프로젝트|앱|서비스|웹앱)/i;
const FUNCTION_TARGET_RE = /(?:함수|function|method)/i;

// Exploration verbs that, when co-occurring with an implementation
// verb, downgrade the turn to idle. "이 함수 구현 방식 분석해줘"
// should not trigger implementation-ready — the user wants analysis,
// not edits.
const EXPLORE_VERB_RE = /(분석|리뷰|설명|review|analyze|explain)/i;

function hasDocKeyword(lower: string): boolean {
  for (const kw of DOC_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) return true;
  }
  return false;
}

export function detectImplPhase(input: DetectInput): ImplPhase {
  const raw = input.text ?? '';
  const trimmed = raw.trim();
  if (!trimmed) return 'idle';
  const lower = trimmed.toLowerCase();

  const explicitProjectScope = NEW_PROJECT_SIGNAL_RE.test(trimmed)
    || (FROM_SCRATCH_RE.test(trimmed) && PROJECT_TARGET_RE.test(trimmed) && !FUNCTION_TARGET_RE.test(trimmed));
  if (explicitProjectScope && PROJECT_IMPL_VERB_RE.test(trimmed)) {
    return 'design-first';
  }

  if (FILE_REF_RE.test(trimmed) || hasDocKeyword(lower)) {
    return 'plan-loaded';
  }

  if (IMPL_VERB_RE.test(trimmed) && !EXPLORE_VERB_RE.test(trimmed)) {
    return 'implementation-ready';
  }

  return 'idle';
}
