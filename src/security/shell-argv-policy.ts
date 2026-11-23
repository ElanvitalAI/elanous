/**
 * 공용 셸 판정 모듈 — ELN-SEAT-APPROVAL-POLICY r4 (PR #38454 · OP 확정 재설계 «Bloom 5» 2026-11-18).
 *
 * 자동 승인은 «argv 가 허용 목록의 한 항목과 정확히 같은 모양»일 때만 나온다:
 *   1. 기본 거부 — 목록에 정확히 일치하지 않으면 자동 승인 없음(거부 또는 OP 승인 요청).
 *   2. 허용 = argv 정확 일치 목록 — 명령+서브명령+인자 모양이 고정된 항목만 허용한다.
 *   3. «안전 명령이니 인자는 자유» 범주는 없다 — argv 가 일치하지 않으면 그 명령은 자동 승인을 못 받는다.
 *   4. 원문 어디에든(인용 안이라도) 셸 메타문자가 하나라도 있으면 자동 승인 없음.
 *   5. 감사는 sha256 — 결정·감사 기록·OP 우편에 인자 원문을 남기지 않는다(결정 이유·명령 이름·해시만).
 *   6. 허용 목록 파일은 단일 작성자 물건 — 단조 증가 version · sha256 lock · 항목 안정 ID · 철회 tombstone.
 * 이 파일의 함수는 전부 순수 함수다: (원문 · argv · 목록) → 결정 { verdict, reason, rule?, name, auditSha256 }.
 */
import { createHash } from 'node:crypto';

/** 셸 메타문자 — 원문 어디에 있든(인용 안이든) 하나라도 보이면 자동 승인 없다. 조항 4. */
const SHELL_META = /[$`;&|<>\n\r\\(){}*?[\]!#~]/;

/** 통과시켜 주는 환경 접두 — NODE_ENV/CI 뿐. 그 외 환경 할당 접두는 그 자체로 OP에게 간다. 조항 4 + r3 동작 계승. */
const ALLOWED_ENV_PREFIXES: ReadonlySet<string> = new Set(['NODE_ENV', 'CI']);

/** simpleArgv 가 뽑은 토큰 하나 — quoted = 그 토큰을 만드는 동안 ' 또는 " 를 만났다(인용 여부). */
interface ArgvToken { readonly word: string; readonly quoted: boolean }

/**
 * 빈칸으로 나누되 '…'·"…"는 지키고 인용 안 빈칸은 한 토큰으로 묶는다(이스케이프 없음 — \ 는 이미 메타문자).
 * 인용 문자가 토큰에 남아 있으면 안 되지만 «인용 여부»는 환경 접두 판정에 필요하므로 함께 뽑는다:
 * 인용·부분 인용이 있는 토큰은 환경 접두가 아니다(«'CI=bin/evil' git status» 는 접두가 아니라 인자).
 * null = 인용이 안 닫힘 — 파싱 자체가 거부(fail-closed)다.
 */
function parseArgvTokens(command: string): ArgvToken[] | null {
  const tokens: ArgvToken[] = [];
  let word = '';
  let inWord = false;
  let quoted = false;
  let quote: '"' | "'" | null = null;
  for (const ch of command) {
    if (quote) { if (ch === quote) quote = null; else word += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; inWord = true; quoted = true; continue; }
    if (ch === ' ' || ch === '\t') { if (inWord) tokens.push({ word, quoted }); word = ''; inWord = false; quoted = false; continue; }
    word += ch; inWord = true;
  }
  if (quote) return null;
  if (inWord) tokens.push({ word, quoted });
  return tokens;
}

/** parseArgvTokens 의 단어만 — 인용 여부가 필요 없는 호출자용. null = 인용이 안 닫힘. */
export function simpleArgv(command: string): string[] | null {
  const tokens = parseArgvTokens(command);
  return tokens === null ? null : tokens.map(token => token.word);
}

/** 인자 원문 대신 남기는 감사 해시(sha256 hex) — 승인·거부·OP 요청 기록과 OP 우편 본문의 원문 대체물. 조항 5. */
export function shellArgvAuditSha256(command: string): string {
  return createHash('sha256').update(command, 'utf8').digest('hex');
}

// ── argv 정확 모양 표 (조항 2·3) ──────────────────────────────────────────────────────────────────────
/** lit: 그 토큰과 정확히 같아야 한다 · slot: 한 토큰이 re 를 만족 · rep: 한 토큰 이상이 각각 re 를 만족. */
export type AllowToken =
  | { readonly lit: string }
  | { readonly slot: string; readonly re: RegExp }
  | { readonly rep: string; readonly re: RegExp };

/** 허용 목록 한 항목: 안정 ID(철회 추적) · 로그에 찍히는 규칙 이름 · 고정 argv 모양. */
export interface AllowShape {
  readonly id: string;
  readonly name: string;
  readonly tokens: readonly AllowToken[];
}

/**
 * SHELL-POLICY-REDACT-EDGE-FU (Terra #38524 ⓑ lastIndex): 호출자가 넘긴 RegExp 에 `g`·`y` 가 있으면 `.test` 가
 * lastIndex 를 바꿔 같은 입력의 판정이 호출마다 달라진다 — 플래그를 뺀 사본으로 무상태 매칭한다.
 */
function wordMatches(re: RegExp, word: string): boolean {
  return new RegExp(re.source, re.flags.replace(/[gy]/g, '')).test(word);
}

/** argv 가 이 모양과 정확히 같은지 — rep 는 필요하면 되돌아가며(greedy→backtrack) 맞춘다. */
function shapeMatches(shape: AllowShape, argv: readonly string[]): boolean {
  const matchFrom = (tokenIndex: number, argvIndex: number): boolean => {
    const token = shape.tokens[tokenIndex];
    if (token === undefined) return argvIndex === argv.length;
    if ('lit' in token) return argv[argvIndex] === token.lit && matchFrom(tokenIndex + 1, argvIndex + 1);
    if ('slot' in token) return argvIndex < argv.length && wordMatches(token.re, argv[argvIndex]!) && matchFrom(tokenIndex + 1, argvIndex + 1);
    for (let count = argv.length - argvIndex; count >= 1; count -= 1) {
      if (argv.slice(argvIndex, argvIndex + count).every(word => wordMatches(token.re, word)) && matchFrom(tokenIndex + 1, argvIndex + count)) return true;
    }
    return false;
  };
  return matchFrom(0, 0);
}

/**
 * 감사·우편에 실는 명령 이름 — argv[0] 와, 목록이 아는 고정 서브명령이면 argv[1] 까지. 인자 원문은 실리지 않는다.
 * (환경 접두 토큰은 이름에서 제외한다 — 접두의 값이 명령 이름에 새어들어가지 않게.)
 */
export function commandNameFromArgv(argv: readonly string[], allow: readonly AllowShape[]): string {
  const head = argv[0];
  if (head === undefined) return '(empty)';
  const second = argv[1];
  if (second !== undefined && allow.some(shape => {
    const [first, secondToken] = shape.tokens;
    return first !== undefined && 'lit' in first && first.lit === head
      && secondToken !== undefined && 'lit' in secondToken && secondToken.lit === second;
  })) return `${head} ${second}`;
  return head;
}

/**
 * 감사·우편에 실는 이름에서는 환경 할당 모양 토큰(NAME=value)의 값을 전부 가린다 — NAME=****.
 * r6 수리: 인용된 환경 접두는 argv 에 인자로 남는데, 그 값이 name → reason 을 타고 OP 요청에
 * 원문으로 흘러들 수 있었다(GITHUB_TOKEN="ghp_…" → «not on the seat allowlist: GITHUB_TOKEN=ghp_…»).
 * 판정·모양 일치는 원문 argv 로 하고 감사 이름에만 이 마스크를 씌운다(조항 5 — 원문을 남기지 않는다).
 * SECRET-REDACT r3 (#38553): tool-activity 의 토큰 층이 이 가림을 그대로 재사용한다 — 합집합 층의
 * 환경 할당 조각(NAME=value 값 가림)으로, 새 정규식 없이 기존 가림을 다시 쓴다.
 */
// SHELL-POLICY-REDACT-EDGE-FU (#38524 r3 must ⓒ): the mask does not depend on the assignment's shape — a regex of
// «valid» names missed «\GITHUB_TOKEN=S» (backslash prefix) and «GITHUB_TOKEN+=S» (append, a real assignment in
// bash/zsh). Any token carried into name/reason keeps only what precedes its first '='; everything after is ****.
export function maskEnvAssignments(argv: readonly string[]): string[] {
  return argv.map(word => word.includes('=') ? `${word.slice(0, word.indexOf('=') + 1)}****` : word);
}

// ── 판정 (조항 1·3·4·5) ──────────────────────────────────────────────────────────────────────────────
export interface ShellArgvPolicyInput {
  /** 원문 명령 문자열 — 메타문자 검사와 감사 해시의 재료. */
  readonly command: string;
  /** simpleArgv 로 파낸 토큰(환경 접두 포함 그대로). */
  readonly argv: readonly string[];
  readonly allow: readonly AllowShape[];
}

/** 순수 판정: verdict · 이유 · (allow 면) 규칙 이름 · 명령 이름 · sha256 감사 해시. verdict 어휘 — allow: 목록 정확 일치 · deny: 구조적 위반(메타문자 · 허용 밖 환경 접두 · 안 닫힌 인용/빈 argv, fail-closed) · ask-op: 모양은 무해하나 목록 밖. */
export interface ShellArgvPolicyDecision {
  readonly verdict: 'allow' | 'deny' | 'ask-op';
  readonly reason: string;
  readonly rule?: string;
  readonly name: string;
  readonly auditSha256: string;
}

/**
 * 핵심 판정 — 명령 일관성 → 환경 접두 → 메타문자 → argv 정확 모양 → 기본 거부.
 * argv 를 이미 가진 호출자용이되, argv 는 신뢰하지 않는다: 반드시 command 를 다시 파싱한 토큰과
 * 정확히 일치해야 한다(«command:'rm -rf /tmp/x', argv:['git','status']» 는 argv 위조 — 거부).
 * 인용('…'/"…")이 있었던 토큰은 환경 접두로 세지 않는다 — «'CI=bin/evil' git status» 의
 * 첫 토큰은 인자여서 argv[0]이 그대로 남고, 그러면 argv 모양이 목록과 어긋나 ask-op(fail-closed)다.
 */
export function classifyShellArgv(input: ShellArgvPolicyInput): ShellArgvPolicyDecision {
  const { command, allow } = input;
  const auditSha256 = shellArgvAuditSha256(command);
  const tokens = parseArgvTokens(command);
  if (tokens === null) return { verdict: 'deny', reason: 'unterminated quote', name: '(unparsed)', auditSha256 };
  const words = tokens.map(token => token.word);
  if (input.argv.length !== words.length || input.argv.some((word, index) => words[index] !== word)) {
    return { verdict: 'deny', reason: 'argv does not match command', name: '(mismatch)', auditSha256 };
  }
  let index = 0;
  while (index < tokens.length && !tokens[index]!.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!.word)) {
    const envName = tokens[index]!.word.slice(0, tokens[index]!.word.indexOf('='));
    if (!ALLOWED_ENV_PREFIXES.has(envName)) return { verdict: 'deny', reason: `environment prefix ${envName}`, name: '(env)', auditSha256 };
    index += 1;
  }
  const argv = words.slice(index);
  // SHELL-POLICY-REDACT-EDGE-FU (Terra #38524 ⓑ empty argv): nothing to run (empty, or only env prefixes like «CI=1»)
  // is refused before any shape is tried — a shape with no tokens must never approve it.
  if (argv.length === 0) return { verdict: 'deny', reason: 'empty command', name: '(empty)', auditSha256 };
  const name = commandNameFromArgv(maskEnvAssignments(argv), allow);
  if (SHELL_META.test(command)) return { verdict: 'deny', reason: 'shell metacharacter', name, auditSha256 };
  for (const shape of allow) {
    if (shapeMatches(shape, argv)) return { verdict: 'allow', reason: `allow shape ${shape.id}`, rule: shape.name, name, auditSha256 };
  }
  return { verdict: 'ask-op', reason: `not on the seat allowlist: ${name}`, name, auditSha256 };
}

// ── 허용 목록 파일 형식 (조항 6) ──────────────────────────────────────────────────────────────────────
export interface ParsedSeatAllowList {
  readonly version: number;
  readonly shapes: readonly AllowShape[];
  /** 철회 기록: 항목 ID → 철회된 버전. 한 번 철회된 ID 가 다시 살아나면 거부된다. */
  readonly tombstones: ReadonlyMap<string, number>;
}

export type SeatAllowListParse
  = { readonly ok: true; readonly list: ParsedSeatAllowList }
  | { readonly ok: false; readonly error: string };

/** 파일 슬롯 문법: `<이름>` 한 토큰 · `<이름...>` 한 토큰 이상(반드시 마지막) — 값은 `-` 로 시작하지 않는 토큰. */
const FILE_VALUE = /^(?!-).+$/;
const SLOT_SYNTAX = /^<([\w-]+)>$/;
const REP_SYNTAX = /^<([\w-]+)\.\.\.>$/;
// Path templates match exactly one argv token. Dynamic segments cannot encode slashes,
// dot traversal, query strings, or options; numeric ids are explicitly typed.
function pathTemplate(word: string): RegExp | null {
  if (!word.includes('/') || !word.includes('<')) return null;
  const parts = word.split('/');
  if (parts.some(part => !/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*|<segment>|<number>)$/.test(part))) return null;
  if (!parts.some(part => part === '<segment>' || part === '<number>')) return null;
  return new RegExp('^' + parts.map(part => part === '<segment>' ? '[A-Za-z0-9_][A-Za-z0-9_.-]*' : part === '<number>' ? '[0-9]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/') + '$');
}
const ITEM_ID = /^[a-z0-9][a-z0-9-]*$/;
const LOCK_HEX_LENGTH = 64; // Source: a SHA-256 digest is 256 bits encoded as two hexadecimal characters per byte.

/**
 * 목록 파일 해석 — 줄 문법(앞뒤 공백 다듬음):
 *   version <단조 증가 정수>      — 목록의 세대. 정확히 한 줄.
 *   allow <항목ID> <argv 모양…>   — 모양: 낱말 그대로 · `<이름>` 슬롯 · `<이름...>` 반복(마지막 토큰만).
 *     경로 토큰은 예: `repos/<segment>/<segment>/pulls/<number>`; segment 는 안전한 단일 구간, number 는 숫자만.
 *   revoke <항목ID> <버전>        — 철회(tombstone). 되살리면 거부.
 *   lock <sha256 64hex>          — 그 외 모든 줄(주석·빈 줄 제외)을 '\n' 으로 이은 것의 sha256. 정확히 한 줄.
 * `#` 줄은 주석. 문법을 벗어나면 목록 전체가 거부된다(ok:false — 읽는 쪽이 무시하고 보고한다).
 */
export function parseSeatAllowList(text: string, fileRuleName = 'seat-file'): SeatAllowListParse {
  const fail = (error: string): SeatAllowListParse => ({ ok: false, error });
  const lines = text.split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'));
  const lockLines = lines.filter(line => /^lock\s/.test(line));
  if (lockLines.length !== 1) return fail('lock line missing or duplicated');
  const lockMatch = new RegExp(`^lock\\s+([0-9a-f]{${LOCK_HEX_LENGTH}})$`).exec(lockLines[0]!);
  if (lockMatch === null) return fail('lock line malformed');
  const canonical = lines.filter(line => !/^lock\s/.test(line)).join('\n');
  if (createHash('sha256').update(canonical, 'utf8').digest('hex') !== lockMatch[1]) return fail('lock mismatch');
  const versionLines = lines.filter(line => /^version\s/.test(line));
  if (versionLines.length !== 1) return fail('version line missing or duplicated');
  const versionMatch = /^version\s+([1-9]\d*)$/.exec(versionLines[0]!);
  if (versionMatch === null) return fail('version line malformed');
  const shapes: AllowShape[] = [];
  const tombstones = new Map<string, number>();
  const seen = new Set<string>();
  for (const line of lines) {
    if (/^lock\s/.test(line) || /^version\s/.test(line)) continue;
    const allowMatch = /^allow\s+([a-z0-9][a-z0-9-]*)\s+(.+)$/.exec(line);
    if (allowMatch !== null) {
      const id = allowMatch[1]!;
      if (!ITEM_ID.test(id)) return fail(`allow id ${id} malformed`);
      if (seen.has(id)) return fail(`duplicate item ${id}`);
      seen.add(id);
      const tokens: AllowToken[] = [];
      let repSeen = false;
      for (const word of allowMatch[2]!.split(/\s+/)) {
        if (repSeen) return fail('repeat slot must be the last token');
        const slotMatch = SLOT_SYNTAX.exec(word);
        const repMatch = REP_SYNTAX.exec(word);
        if (slotMatch !== null) tokens.push({ slot: slotMatch[1]!, re: FILE_VALUE });
        else if (repMatch !== null) { tokens.push({ rep: repMatch[1]!, re: FILE_VALUE }); repSeen = true; }
        else if (word.includes('/') && word.includes('<')) {
          const re = pathTemplate(word);
          if (re === null) return fail('invalid path template');
          tokens.push({ slot: 'path', re });
        } else tokens.push({ lit: word });
      }
      if (tokens.length === 0) return fail(`allow ${id} has no argv shape`);
      // SHELL-POLICY-REDACT-EDGE-FU (Terra #38524 ⓒ allow any): the program is fixed — a slot or repeat in the first
      // position («allow any <cmd> <args...>») would approve any executable.
      if (!('lit' in tokens[0]!)) return fail(`allow ${id} must start with a fixed program name`);
      shapes.push({ id, name: fileRuleName, tokens });
      continue;
    }
    const revokeMatch = /^revoke\s+([a-z0-9][a-z0-9-]*)\s+([1-9]\d*)$/.exec(line);
    if (revokeMatch !== null) {
      const id = revokeMatch[1]!;
      if (!ITEM_ID.test(id)) return fail(`revoke id ${id} malformed`);
      if (seen.has(id)) return fail(`item ${id} revoked and allowed in the same file`);
      seen.add(id);
      tombstones.set(id, Number(revokeMatch[2]!));
      continue;
    }
    return fail(`unknown line: ${line.split(/\s+/)[0]}`);
  }
  return { ok: true, list: { version: Number(versionMatch[1]!), shapes, tombstones } };
}
