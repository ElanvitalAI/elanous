// ── PR 코멘트 신분 규약 (순수) ──────────────────────────────────────────────────
//
// [[RFC-pr-as-review-conversation-medium-2026-07-27]] §2B.
//
// Git 계정 하나로 남긴 elanous 코멘트의 생성자·검토자·심판·안전봉투를 HTML 주석 메타로 구분한다.
// 이 규약은 사람 신분 판정을 개선하지 않는다. 사람이 헤더를 직접 쓰지 않을 때의 분류는 계속
// `pr-review-watch`의 author.login + isBotSignal 폴백이 담당하며, 이 모듈은 파일·네트워크·git을
// 건드리지 않는 순수 규약만 제공한다. 게시 seam과 소비자 배선은 다음 착지의 몫이다.

export const PR_COMMENT_ROLES = ['author', 'reviewer', 'judge', 'safety', 'human'] as const;
export type PrCommentRole = typeof PR_COMMENT_ROLES[number];

export interface PrCommentMeta {
  readonly role: PrCommentRole;
  readonly round?: number;
  readonly run?: string;
  readonly model?: string;
  readonly mf?: string;
  readonly replyTo?: string;
  readonly answered?: string;
  readonly unanswered?: string;
}

const KNOWN_KEYS = ['role', 'round', 'run', 'model', 'mf', 'replyTo', 'answered', 'unanswered'] as const;
const KNOWN_KEY_SET = new Set<string>(KNOWN_KEYS);
const ROLE_SET = new Set<string>(PR_COMMENT_ROLES);
const ENCODED_VALUE = /^(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})*$/;

/** RFC §2B의 값 인코딩. encodeURIComponent가 남기는 다섯 문장부호도 규약의 안전 문자집합 밖이면 인코딩한다. */
function encodeValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function decodeValue(value: string): string | null {
  if (!ENCODED_VALUE.test(value)) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** 메타를 본문 첫 줄에 둘 RFC §2B HTML 주석 헤더로 만든다. */
export function format(meta: PrCommentMeta): string {
  const fields: Array<readonly [string, string]> = [['role', meta.role]];
  for (const key of KNOWN_KEYS.slice(1)) {
    const value = meta[key];
    if (value !== undefined) fields.push([key, String(value)]);
  }
  return `<!-- elanous-pr-comment v1 ${fields.map(([key, value]) => `${key}=${encodeValue(value)}`).join(' ')} -->`;
}

/** 본문의 정확한 첫 줄 RFC §2B 메타를 읽는다. 헤더가 없거나 모호·미지원이면 null이다. */
export function parse(body: string): PrCommentMeta | null {
  const firstLineEnd = body.indexOf('\n');
  const firstLine = firstLineEnd === -1 ? body : body.slice(0, firstLineEnd);
  const match = /^<!-- elanous-pr-comment (\S+)(?: (.*))? -->$/.exec(firstLine);
  if (!match || match[1] !== 'v1' || !match[2]) return null;

  const fields = new Map<string, string>();
  for (const token of match[2].split(' ')) {
    const equals = token.indexOf('=');
    if (equals <= 0 || equals !== token.lastIndexOf('=')) return null;
    const key = token.slice(0, equals);
    const encodedValue = token.slice(equals + 1);
    if (fields.has(key)) return null;
    const value = decodeValue(encodedValue);
    if (value === null) return null;
    fields.set(key, value);
  }

  const role = fields.get('role');
  if (!role || !ROLE_SET.has(role)) return null;
  const parsed: { role: PrCommentRole; round?: number; run?: string; model?: string; mf?: string; replyTo?: string; answered?: string; unanswered?: string } = { role: role as PrCommentRole };
  for (const key of KNOWN_KEYS.slice(1)) {
    if (!KNOWN_KEY_SET.has(key)) continue;
    const value = fields.get(key);
    if (value === undefined) continue;
    if (key === 'round') {
      if (/^\d+$/.test(value)) {
        const round = Number(value);
        if (Number.isSafeInteger(round) && round >= 0) parsed.round = round;
      }
    } else if (key === 'run') {
      parsed.run = value;
    } else if (key === 'model') {
      parsed.model = value;
    } else if (key === 'mf') {
      parsed.mf = value;
    } else if (key === 'replyTo') {
      parsed.replyTo = value;
    } else if (key === 'answered') {
      parsed.answered = value;
    } else if (key === 'unanswered') {
      parsed.unanswered = value;
    }
  }
  return parsed;
}

/** 상태 댓글의 details 에 쌓인 라운드 기록을 개별 댓글 본문으로 펼친다. */
export function expandRecords(body: string): string[] {
  if (!/^<!-- elanous:run-status -->(?:\r?\n|$)/.test(body)) return [body];

  const records: string[] = [];
  for (const details of body.matchAll(/<details(?:\s[^>]*)?>([\s\S]*?)<\/details>/g)) {
    const content = details[1];
    const headers: Array<{ index: number; round?: number }> = [];
    for (const header of content.matchAll(/^<!-- elanous-pr-comment v1 [^\r\n]* -->$/gm)) {
      const meta = parse(header[0]);
      if (meta) headers.push({ index: header.index, round: meta.round });
    }
    for (let i = 0; i < headers.length; i++) {
      if (headers[i].round === undefined) continue;
      records.push(content.slice(headers[i].index, headers[i + 1]?.index ?? content.length).replace(/(?:\r?\n)+$/, ''));
    }
  }
  return records.length ? records : [body];
}
