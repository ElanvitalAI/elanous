/**
 * I1 — intake 첫 입구의 결정적 판정 표.
 * RFC `내부 문서 `RFC-pwa-intake-front-door-2026-09-26`` 는 이 상수 이름만 가리킨다.
 * LLM·네트워크를 부르지 않는다. 같은 입력 = 같은 출력.
 * 분류기(I2)와 갈래 실행(`submitIntakeWork`)은 이 파일의 대상이 아니다.
 */

export const INTAKE_FRONT_ROUTE_TRACKS = ['absorb', 'tasks', 'graph', 'ask-human'] as const;
export type IntakeFrontRouteTrack = (typeof INTAKE_FRONT_ROUTE_TRACKS)[number];

export const INTAKE_FRONT_ROUTE_DECIDED_BY = ['human', 'rule', 'classifier'] as const;
export type IntakeFrontRouteDecidedBy = (typeof INTAKE_FRONT_ROUTE_DECIDED_BY)[number];

/** 흡수류 낱말 — URL 과 이것만 있으면 absorb. */
export const INTAKE_FRONT_ABSORB_WORDS = [
  '정리', '요약', '흡수', '읽어', '저장', 'summarize', 'save',
] as const;

/** 구현류 낱말 — URL 과 함께면 graph, URL 없이 시작·끝이면 graph. */
export const INTAKE_FRONT_IMPLEMENT_WORDS = [
  '구현', '만들어', '고쳐', '추가해', 'implement', 'build', 'fix',
] as const;

export const INTAKE_FRONT_ROUTE_RULES = {
  tracks: INTAKE_FRONT_ROUTE_TRACKS,
  absorbWords: INTAKE_FRONT_ABSORB_WORDS,
  implementWords: INTAKE_FRONT_IMPLEMENT_WORDS,
  /** 목록으로 보려면 이 줄 수 이상이 `-`·`*`·`[ ]`·`숫자.` 로 시작해야 한다. */
  listMinLines: 3,
  /** 규칙이 답한 갈래의 confidence. hint 만 1. 분류기는 이 골에서 부르지 않는다. */
  ruleConfidence: 0.9,
  /** 규칙이 모르거나 consent 가 없어 사람에게 묻는 갈래의 confidence. */
  unknownConfidence: 0,
  consentRequired: 'route',
  unknownReason: 'rule-unknown',
  missingConsentReason: 'consent-missing',
} as const;

const URL_RE = /https?:\/\/\S+/gi;
const LIST_LINE_RE = /^\s*(?:[-*]|\[[ xX]\]|\d+[.)])\s+\S/;

export interface DecideIntakeFrontRouteInput {
  text: string;
  hint?: string;
  consent?: string;
}

export interface IntakeFrontRouteDecision {
  track: IntakeFrontRouteTrack;
  confidence: number;
  reason: string;
  decidedBy: IntakeFrontRouteDecidedBy;
}

function isTrack(value: string): value is IntakeFrontRouteTrack {
  return (INTAKE_FRONT_ROUTE_TRACKS as readonly string[]).includes(value);
}

function wordPattern(words: readonly string[]): RegExp {
  const body = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`(?:${body})`, 'iu');
}

const ABSORB_RE = wordPattern(INTAKE_FRONT_ABSORB_WORDS);
const IMPLEMENT_RE = wordPattern(INTAKE_FRONT_IMPLEMENT_WORDS);

function stripUrls(text: string): string {
  return text.replace(URL_RE, ' ');
}

function hasUrl(text: string): boolean {
  URL_RE.lastIndex = 0;
  return URL_RE.test(text);
}

function hasWord(re: RegExp, text: string): boolean {
  re.lastIndex = 0;
  return re.test(text);
}

/** 구현류 낱말로 시작하거나 끝난다(명령형 미션). 조사·어미는 낱말 뒤에 붙을 수 있다. */
function isImperativeImplement(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const words = INTAKE_FRONT_IMPLEMENT_WORDS.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const start = new RegExp(`^(?:${words.join('|')})`, 'iu');
  const end = new RegExp(`(?:${words.join('|')})(?:줘|주세요|해|하라|하자)?[.!?…]*$`, 'iu');
  return start.test(trimmed) || end.test(trimmed);
}

function isList(text: string): boolean {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length < INTAKE_FRONT_ROUTE_RULES.listMinLines) return false;
  return lines.every((line) => LIST_LINE_RE.test(line));
}

function ruleDecision(track: IntakeFrontRouteTrack, reason: string): IntakeFrontRouteDecision {
  return {
    track,
    confidence: INTAKE_FRONT_ROUTE_RULES.ruleConfidence,
    reason,
    decidedBy: 'rule',
  };
}

function askHuman(reason: string): IntakeFrontRouteDecision {
  return {
    track: 'ask-human',
    confidence: INTAKE_FRONT_ROUTE_RULES.unknownConfidence,
    reason,
    decidedBy: 'rule',
  };
}

/**
 * 판정만 한다. 순서: hint → 결정적 규칙 → (규칙이 모르면) consent.
 * 규칙은 로컬 계산이라 consent 와 무관하다. 분류기(I2)는 이 함수가 부르지 않는다.
 * 규칙이 모르고 consent 가 'route' 가 아니면 missing-consent, 'route' 면 rule-unknown.
 */
export function decideIntakeFrontRoute(input: DecideIntakeFrontRouteInput): IntakeFrontRouteDecision {
  const hint = typeof input.hint === 'string' ? input.hint.trim() : '';
  if (hint && isTrack(hint)) {
    return { track: hint, confidence: 1, reason: 'hint', decidedBy: 'human' };
  }

  const text = typeof input.text === 'string' ? input.text : '';
  const url = hasUrl(text);
  const prose = stripUrls(text);
  const absorb = hasWord(ABSORB_RE, prose);
  const implement = hasWord(IMPLEMENT_RE, prose);

  if (url && !absorb && !implement && prose.trim().length === 0) {
    return ruleDecision('absorb', 'url-only');
  }
  if (url && absorb && !implement) {
    return ruleDecision('absorb', 'url-absorb');
  }
  if (url && implement) {
    return ruleDecision('graph', 'url-implement');
  }
  if (!url && isImperativeImplement(prose)) {
    return ruleDecision('graph', 'imperative-implement');
  }
  if (isList(text)) {
    return ruleDecision('tasks', 'list');
  }

  if (input.consent !== INTAKE_FRONT_ROUTE_RULES.consentRequired) {
    return askHuman(INTAKE_FRONT_ROUTE_RULES.missingConsentReason);
  }
  return askHuman(INTAKE_FRONT_ROUTE_RULES.unknownReason);
}
