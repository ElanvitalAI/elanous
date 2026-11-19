// ── Destructive-action Guardian (AU3) ──
//
// Lightweight static classifier: given a Bash argv / an edit path /
// etc., flag it as "destructive" so callers can insist on user
// approval even when the current approval policy would otherwise
// let it through.
//
// Ported from codex's Guardian layer (core/src/guardian/
// approval_request.rs) adapted to elanous's shell surface. Codex's
// Guardian lives inside core — it can intercept tool calls before
// they reach the shell. Elanous's equivalent lives in the same place
// as the approval policy (src/code-edit/safety.ts and the shell
// approval pipeline) and is pattern-matched on the argv.
//
// Design:
//   • Pattern lists are conservative — prefer false positives
//     ("ask again") over false negatives ("silent rm -rf").
//   • Each match carries a short `reason` the chat log + approval
//     modal can surface.
//   • `severity: 'destructive' | 'escalated'` — future surface for
//     AU6 sandbox-failure escalation.
//   • Disable via env `ELANOUS_GUARDIAN=off`; documented + tested.
//
// r8 (OP #92922 · #38553 원칙 «합집합 · fail-closed»): 판정의 기본은 main 의
// 원문 스캔 결과 그대로이고, «덜 막는» 길은 아주 좁은 예외 하나뿐이다 — 첫 실행
// 토큰이 echo·printf·grep·rg·cat 처럼 데이터만 출력하는 명령이고, 매치 조각이
// 치환($(...)·백틱) 없는 «닫힌» 인용 안의 그 인자이며, 실행위치 스캔(r7) 도 null
// 인 단일 문일 때만 null. 인용 벗기기·운반자 재귀(r7) 는 «더 막는» 방향으로만
// 쓴다(main 이 놓친 «rm» -rf · rm «-rf» · git «reset» --hard 를 추가로 잡는다).
//
// r9 (JUD 20261119-0658 ⓒ): ① 백슬래시 이스케이프 인용(\"…\") 은 인용이 아니라 글자다 —
// 문 나누기·가림·인용 지역 판정 모두에서 인용 취급을 철회한다(이스케이프로 싸인 위험 낱말은
// «닫힌 인용» 예외 없이 차단 — fail-closed). ② 프로세스 치환 >(…)·<(…) 내부는 실행 위치다 —
// 재귀 판정하고, 프린터라도 치환이 섞여 있으면 이스케이프를 풀어 재스캔한다(«더 막는» 쪽 전용).
//
// Not a replacement for approval modal — the Guardian is a SIGNAL
// that the caller uses to, e.g., force `severity: 'destructive'`
// on the modal, or refuse auto-approval even under `unsupervised`
// policy.

export type GuardianSeverity = 'destructive' | 'escalated';

export interface GuardianFinding {
  severity: GuardianSeverity;
  reason: string;
  /** The matched fragment for logging (argv token, path, etc.). */
  matched: string;
}

/** Global kill-switch, env-driven. Tests flip via setGuardianDisabled. */
let sessionDisabled = false;

export function setGuardianDisabled(disabled: boolean): void {
  sessionDisabled = disabled;
}

export function isGuardianDisabled(): boolean {
  if (sessionDisabled) return true;
  const v = (process.env.ELANOUS_GUARDIAN ?? '').toLowerCase();
  return v === 'off' || v === '0' || v === 'false';
}

// ── Pattern library ────────────────────────────────────────────────
//
// Each pattern carries a scan mode (r7):
//   • scan:'statement' — 실행되는 명령의 모양(rm · git push --force · …).
//     문의 판정 텍스트 «처음» 에 걸려야 한다(프로그램 낱말 위치).
//   • scan:'free' (기본값) — 구조·원문 판단(fork bomb · SQL · «| sh»).
//     판정 텍스트 어디에나, 테스트 주입 규칙과의 호환을 위해 어느 모드에서나
//     제한 없이 적용된다.
//
// Caps on reason length so chat-log rendering stays compact.

interface Rule {
  re: RegExp;
  severity: GuardianSeverity;
  reason: string;
  scan?: 'statement' | 'free';
}

const RULES: Rule[] = [
  // Filesystem destruction
  { re: /\brm\b[^|;]*\s-(?:r|R|rf|fr)\b/, severity: 'destructive', reason: 'recursive rm', scan: 'statement' },
  { re: /\brm\b\s+\/($|\s)/, severity: 'destructive', reason: 'rm /', scan: 'statement' },
  { re: /\brm\b[^|;]*\s--no-preserve-root\b/, severity: 'destructive', reason: 'rm --no-preserve-root', scan: 'statement' },
  { re: /\bshred\b/, severity: 'destructive', reason: 'shred (unrecoverable)', scan: 'statement' },
  { re: /\btruncate\b[^|;]*\s-s\s*0\b/, severity: 'destructive', reason: 'truncate to zero', scan: 'statement' },
  { re: /:\(\)\s*\{[^}]*\|\s*\Z?:\s*&[^}]*}\s*;?\s*:/, severity: 'destructive', reason: 'fork bomb' },
  // 구조: 파이프로 셸에 흘려 넣는 텍스트는 실행된다 — 원문(가림 적용)에서 잡는다.
  { re: /\|\s*(?:bash|zsh|dash|ksh|ash|csh|tcsh|sh)\b/, severity: 'destructive', reason: 'piped into a shell' },

  // Disk-level
  { re: /\bdd\b[^|;]*\bof=\/dev\/[^\s]+/, severity: 'destructive', reason: 'dd of=/dev/...', scan: 'statement' },
  { re: /\bmkfs(\.\S+)?\b/, severity: 'destructive', reason: 'filesystem format', scan: 'statement' },
  { re: /\bfdisk\b/, severity: 'destructive', reason: 'partition table edit', scan: 'statement' },

  // Git — history rewrites
  { re: /\bgit\s+push\b[^|;]*(?:\s-f|\s--force(?!\s*-with-lease))/, severity: 'destructive', reason: 'git push --force (no --force-with-lease)', scan: 'statement' },
  { re: /\bgit\s+reset\b[^|;]*\s--hard\b/, severity: 'destructive', reason: 'git reset --hard', scan: 'statement' },
  { re: /\bgit\s+clean\b[^|;]*\s-[dfx]{1,3}\b/, severity: 'destructive', reason: 'git clean -fd(x)', scan: 'statement' },
  { re: /\bgit\s+branch\b[^|;]*\s-D\b/, severity: 'destructive', reason: 'git branch -D (force delete)', scan: 'statement' },
  { re: /\bgit\s+update-ref\b[^|;]*\s-d\b/, severity: 'destructive', reason: 'git update-ref -d', scan: 'statement' },

  // SQL / datastore — free: SQL 문은 클라이언트의 인용 안에 있어도 보인다.
  { re: /\bDROP\s+(?:TABLE|DATABASE|SCHEMA|INDEX)\b/i, severity: 'destructive', reason: 'SQL DROP' },
  { re: /\bTRUNCATE\s+TABLE\b/i, severity: 'destructive', reason: 'SQL TRUNCATE' },
  { re: /\bDELETE\s+FROM\b(?!\s*\S+\s+WHERE\b)/i, severity: 'destructive', reason: 'SQL DELETE without WHERE' },

  // Permission / owner wide changes
  { re: /\bchmod\b[^|;]*\s-R\b[^|;]*\s(?:777|000)\b/, severity: 'destructive', reason: 'chmod -R permissive/null', scan: 'statement' },
  { re: /\bchown\b[^|;]*\s-R\b\s+\/\b/, severity: 'destructive', reason: 'chown -R on /', scan: 'statement' },

  // Package / env wipes
  { re: /\bnpm\s+(?:unpublish)\b/, severity: 'destructive', reason: 'npm unpublish', scan: 'statement' },
  { re: /\byarn\s+(?:unpublish)\b/, severity: 'destructive', reason: 'yarn unpublish', scan: 'statement' },

  // Cloud / sudo escalation (severity: escalated — still gated)
  { re: /\bsudo\b/, severity: 'escalated', reason: 'sudo (root privileges)', scan: 'statement' },
  { re: /\bdoas\b/, severity: 'escalated', reason: 'doas (privilege escalation)', scan: 'statement' },
];

// ── r7: 실행 위치 스캔 (OP #92652) ───────────────────────────────────

/** $(…) 또는 백틱이 있으면 그 문자열은 실행된다 — 데이터가 아니라고 본다. */
const SUBSTITUTION = /\$\(|`/;

interface ScanToken { readonly word: string; readonly quoted: boolean }

/**
 * 문(statement) 나누기 — 인용 밖의 ; · | · & · 줄바꿈이 문을 끊는다(quote-aware).
 * 인용이 안 닫히면 끝까지 한 토큰으로 남는다(보수 — fail-closed).
 */
function splitScanStatements(command: string): ScanToken[][] {
  const statements: ScanToken[][] = [];
  let tokens: ScanToken[] = [];
  let word = '';
  let inWord = false;
  let quoted = false;
  let quote: string | null = null;
  const endWord = (): void => {
    if (inWord) tokens.push({ word, quoted });
    word = '';
    inWord = false;
    quoted = false;
  };
  const endStatement = (): void => {
    endWord();
    if (tokens.length > 0) statements.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote !== null) {
      // r9: 큰따옴표 안의 \\" 는 닫는 인용이 아니라 글자다.
      if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        word += command[i + 1]!;
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      else word += ch;
      continue;
    }
    // r9(JUD 20261119-0658 ⓒ1): 인용 밖 \\"X" 는 인용을 «여는» 게 아니라 글자다 — 구분자도 못 된다.
    if (ch === '\\' && i + 1 < command.length) { word += command[i + 1]!; inWord = true; i += 1; continue; }
    if (ch === '"' || ch === "'") { quote = ch; inWord = true; quoted = true; continue; }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n' || ch === '\r') { endStatement(); continue; }
    if (ch === ' ' || ch === '\t') { endWord(); continue; }
    word += ch;
    inWord = true;
  }
  endStatement();
  return statements;
}

/** 원문에서 인용된 «데이터» 영역을 공백으로 가린다 — 치환이 있는 인용은 그대로 둔다(실행됨). */
function maskQuotedData(command: string): string {
  let out = '';
  let quote: string | null = null;
  let region = '';
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote !== null) {
      if (ch === '\\' && quote === '"' && i + 1 < command.length) { region += command[i + 1]!; i += 1; continue; }
      if (ch === quote) {
        out += SUBSTITUTION.test(region) ? quote + region + quote : ' '.repeat(region.length + 2);
        quote = null;
        region = '';
      } else region += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) { out += command[i + 1]!; i += 1; continue; } // r9: \\"X" 는 글자
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    out += ch;
  }
  if (quote !== null) out += region; // 안 닫힌 인용 — 내용을 그대로 둔다(보수)
  return out;
}

const basename = (word: string): string => (word.includes('/') ? word.slice(word.lastIndexOf('/') + 1) : word);

const SHELL_PROGRAMS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'csh', 'tcsh', 'fish']);
/** -c · -e · -lc 스타일: 다음 인자가 코드 페이로드다. */
const CODE_FLAG = /^-[A-Za-z]{0,2}[ce]$/;
const CODE_CARRIERS = new Set(['python', 'python3', 'node', 'ruby', 'perl', 'php']);
const EVAL_PROGRAMS = new Set(['eval']);
const SSH_PROGRAMS = new Set(['ssh', 'mosh', 'autossh']);
/** ssh 플래그 중 값을 함께 먹는 것들(-p 22 · -i key · -l user · -o opt · -J jump …). */
const SSH_VALUE_FLAGS = /^-[piloDeJS]$/;
const SQL_PROGRAMS = new Set(['sqlite3', 'psql', 'mysql', 'mariadb']);
/** 접두 운반자 — 뒤의 토큰들이 실제 명령이다. */
const PREFIX_CARRIERS = new Set(['sudo', 'doas', 'env', 'nice', 'nohup', 'timeout', 'gtimeout', 'xargs', 'watch', 'stdbuf', 'strace', 'valgrind', 'time']);
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const NUMBER = /^\d+(\.\d+)?[smhd]?$/;

/** 주입 규칙의 g/y 플래그도 안전하게 — 상태 없는 매칭. */
const matches = (re: RegExp, text: string): RegExpExecArray | null =>
  new RegExp(re.source, re.flags.replace(/[gy]/g, '')).exec(text);

const finding = (rule: Rule, m: RegExpExecArray): GuardianFinding => ({
  severity: rule.severity,
  reason: rule.reason,
  matched: m[0].slice(0, 80),
});

/**
 * 실행 위치 텍스트에 규칙표를 적용한다.
 * free 면 모든 규칙이 어디에나(치환·코드 페이로드·SQL — 보수) · 아니면
 * scan:'statement' 규칙은 문 처음(프로그램 낱말) 에만 걸린다.
 */
function matchRules(text: string, free: boolean): GuardianFinding | null {
  if (!text.trim()) return null;
  for (const rule of RULES) {
    const m = matches(rule.re, text);
    if (m !== null && (free || rule.scan !== 'statement' || m.index === 0)) return finding(rule, m);
  }
  return null;
}

/** 구조 규칙(fork bomb · «| sh» · SQL)만 원문(가림 적용)에 적용한다. */
function matchFreeRules(text: string): GuardianFinding | null {
  for (const rule of RULES) {
    if (rule.scan === 'statement') continue;
    const m = matches(rule.re, text);
    if (m !== null) return finding(rule, m);
  }
  return null;
}

/** 한 문(statement)을 판정한다 — 운반자면 페이로드를 먼저 재귀 판정한다. */
function scanStatement(tokens: readonly ScanToken[], depth: number): GuardianFinding | null {
  let start = 0;
  while (start < tokens.length && !tokens[start]!.quoted && ENV_ASSIGN.test(tokens[start]!.word)) start += 1;
  if (start >= tokens.length) return null;
  const program = basename(tokens[start]!.word);
  const substitution = tokens.some(token => SUBSTITUTION.test(token.word));

  // 셸 -c 페이로드: 실행되는 것은 페이로드뿐이다 — 재귀(정밀 판정).
  if (SHELL_PROGRAMS.has(program)) {
    const flagIndex = tokens.findIndex((token, index) => index > start && CODE_FLAG.test(token.word));
    if (flagIndex !== -1) return scanCommand(tokens.slice(flagIndex + 1).map(token => token.word).join(' '), depth + 1);
  }
  // eval — 남은 토큰 전부가 코드다.
  if (EVAL_PROGRAMS.has(program)) {
    const nested = scanCommand(tokens.slice(start + 1).map(token => token.word).join(' '), depth + 1);
    if (nested !== null) return nested;
  }
  // ssh — 원격 셸 명령(호스트 뒤)을 재귀 판정한다. 페이로드 안의 echo 데이터는 안전해진다.
  if (SSH_PROGRAMS.has(program)) {
    let i = start + 1;
    while (i < tokens.length && tokens[i]!.word.startsWith('-') && tokens[i]!.word !== '-') {
      i += SSH_VALUE_FLAGS.test(tokens[i]!.word) ? 2 : 1;
    }
    if (i < tokens.length && i + 1 < tokens.length) {
      const nested = scanCommand(tokens.slice(i + 1).map(token => token.word).join(' '), depth + 1);
      if (nested !== null) return nested;
    }
  }
  // 코드 운반자(python/node -c …) — 코드 문자열은 보수적으로 그대로 보인다(free).
  if (CODE_CARRIERS.has(program)) {
    const flagIndex = tokens.findIndex((token, index) => index > start && CODE_FLAG.test(token.word));
    if (flagIndex !== -1) {
      const hit = matchRules(tokens.map(token => token.word).join(' '), true);
      if (hit !== null) return hit;
    }
  }
  // SQL 클라이언트 — SQL 문은 인용 안에 있어도 보인다(free).
  if (SQL_PROGRAMS.has(program)) {
    const hit = matchRules(tokens.map(token => token.word).join(' '), true);
    if (hit !== null) return hit;
  }
  // 접두 운반자 — 뒤의 실제 명령을 재귀 판정한다. 잡히지 않으면 이 문 자체(sudo 상승)로 내려간다.
  if (PREFIX_CARRIERS.has(program)) {
    const rest: string[] = [];
    let payloadStarted = false;
    for (let i = start + 1; i < tokens.length; i += 1) {
      const word = tokens[i]!.word;
      // 운반자 자기 플래그·값(-u user · env 할당 · timeout 초)은 페이로드가 시작되기 전까지만 건너뛴다.
      if (!payloadStarted) {
        if (word.startsWith('-') && word !== '-') continue;
        if (program === 'env' && ENV_ASSIGN.test(word)) continue;
        if ((program === 'timeout' || program === 'gtimeout' || program === 'nice' || program === 'sleep') && NUMBER.test(word)) continue;
        payloadStarted = true;
      }
      rest.push(word);
    }
    const nested = scanCommand(rest.join(' '), depth + 1);
    if (nested !== null) return nested;
  }

  // 일반 문 — 인용 데이터는 빼고, 프로그램 낱말(basename)부터 판정 텍스트를 만든다.
  const body = tokens.slice(start).filter(token => !token.quoted).map(token => token.word);
  if (body.length > 0) body[0] = basename(body[0]!);
  const text = substitution ? tokens.map(token => token.word).join(' ') : body.join(' ');
  return matchRules(text, substitution);
}

// ── r9: 프로세스 치환은 실행 위치(JUD 20261119-0658 ⓒ2) ────────────────

/** >(…)·<(…) 내부 명령 원문 — 실제 인용 안의 모양은 데이터라 제외, 안 닫힌 괄호는 끝까지(보수). */
function processSubstitutionBodies(cmd: string): string[] {
  const bodies: string[] = [];
  let quote: string | null = null;
  let escaped = false;
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i]!;
    if (escaped) { escaped = false; continue; }
    if (quote !== null) {
      if (ch === '\\' && quote === '"') { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if ((ch === '>' || ch === '<') && cmd[i + 1] === '(') {
      let depth = 1;
      let innerQuote: string | null = null;
      let innerEscaped = false;
      let j = i + 2;
      for (; j < cmd.length && depth > 0; j += 1) {
        const c = cmd[j]!;
        if (innerEscaped) { innerEscaped = false; continue; }
        if (c === '\\') { innerEscaped = true; continue; }
        if (innerQuote !== null) { if (c === innerQuote) innerQuote = null; continue; }
        if (c === '"' || c === "'") { innerQuote = c; continue; }
        if (c === '(') depth += 1;
        else if (c === ')') depth -= 1;
      }
      bodies.push(depth === 0 ? cmd.slice(i + 2, j - 1) : cmd.slice(i + 2));
      i = j - 1;
    }
  }
  return bodies;
}

/** 백슬래시로 갈라진 인용 낱말(r\"m\") 을 한 낱말로 되돌린다 — «더 막는» 재스캔 전용. */
const unescapeQuoteChars = (cmd: string): string => cmd.replace(/\\(['"])/g, '$1');

/** 명령 전체: 각 문을 순서대로 판정하고, 프로세스 치환 내부를 재판정한 뒤 구조 규칙을 가린 원문에 적용한다. */
function scanCommand(command: string, depth = 0): GuardianFinding | null {
  if (depth > 3) return null; // 지나치게 겹친 페이로드 — 바깥 층이 이미 판정 대상이다
  for (const tokens of splitScanStatements(command)) {
    const found = scanStatement(tokens, depth);
    if (found !== null) return found;
  }
  // r9: 프로세스 치환 내부는 실행 위치다 — 명령으로 재판정한다.
  for (const body of processSubstitutionBodies(command)) {
    const nested = scanCommand(body, depth + 1);
    if (nested !== null) return nested;
  }
  return matchFreeRules(maskQuotedData(command));
}

// ── r8 판정 코어: 합집합 · fail-closed (OP #92922) ─────────────────

/** 좁은 예외 대상 — «데이터만 출력하는» 명령(OP #92922 열거). 이 외는 전부 기본(main) 결과를 유지한다. */
const PRINTER_PROGRAMS = new Set(['echo', 'printf', 'grep', 'rg', 'cat']);

/** main 과 같은 원문 스캔 — 모든 규칙을 원문에 그대로(위치 무관) 적용, 규칙표 순서의 첫 매치. */
function mainRawScan(cmd: string): { rule: Rule; match: RegExpExecArray } | null {
  for (const rule of RULES) {
    const m = matches(rule.re, cmd);
    if (m !== null) return { rule, match: m };
  }
  return null;
}

interface QuoteRegion { start: number; end: number; substitution: boolean }

/** 닫힌 인용 영역(열림·닫힘 인용 문자 인덱스). 안 닫힌 인용은 영역에서 뺀다(fail-closed). */
function closedQuoteRegions(cmd: string): QuoteRegion[] {
  const regions: QuoteRegion[] = [];
  let quote: string | null = null;
  let start = -1;
  let region = '';
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i]!;
    if (quote !== null) {
      if (ch === '\\' && quote === '"' && i + 1 < cmd.length) { region += cmd[i + 1]!; i += 1; continue; }
      if (ch === quote) {
        regions.push({ start, end: i, substitution: SUBSTITUTION.test(region) });
        quote = null;
        region = '';
      } else region += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < cmd.length) { i += 1; continue; } // r9: \\"X" 는 인용 지역이 아니다
    if (ch === '"' || ch === "'") { quote = ch; start = i; }
  }
  return regions;
}

/** 매치 조각이 «치환 없는 닫힌 인용» 안에 온전히 들어 있는가. */
function hitInsideInertQuote(cmd: string, hit: RegExpExecArray): boolean {
  return closedQuoteRegions(cmd).some(
    r => !r.substitution && hit.index >= r.start && hit.index + hit[0].length <= r.end + 1,
  );
}

/** 첫 문의 첫 실행 토큰(환경 할당 건너뛴 뒤 프로그램 낱말) — 프린터 판정용. */
function firstProgramWord(cmd: string): string {
  const tokens = splitScanStatements(cmd)[0];
  if (tokens === undefined) return '';
  let s = 0;
  while (s < tokens.length && !tokens[s]!.quoted && ENV_ASSIGN.test(tokens[s]!.word)) s += 1;
  return s < tokens.length ? basename(tokens[s]!.word) : '';
}

/** 인용 부호만 벗긴 원문 — «더 막는» 방향 전용(main 이 놓친 인용 갈라짐을 추가 차단). */
const stripQuoteMarks = (cmd: string): string => cmd.replace(/['"]/g, '');

const toFinding = (hit: { rule: Rule; match: RegExpExecArray }): GuardianFinding => ({
  severity: hit.rule.severity,
  reason: hit.rule.reason,
  matched: hit.match[0].slice(0, 80),
});

/**
 * Inspect an argv or a raw command string. r8(OP #92922) 합집합 · fail-closed:
 *  ① 기본 결과 = main 원문 스캔 그대로(«덜 막는» 회귀 원천 차단).
 *  ② «덜 막음» 은 좁은 예외뿐 — 프린터(echo·printf·grep·rg·cat) 단일 문이고 매치가
 *     치환 없는 닫힌 인용 안이며 실행위치 스캔(r7) 도 null 일 때만 null.
 *     r10: 문 안에 프로세스 치환(>( )·<( ))이 있으면 실행 위치가 있는 것이다 — 예외 없음(JUD 20261119-1204 ⓒ).
 *  ③ 기본이 null 이면 «더 막는» 쪽만 추가 — r7 실행위치 스캔 ∪ 인용 벗긴 원문 스캔.
 *  Guardian 이 꺼져 있거나 비어 있으면 null.
 */
export function classifyDestructive(argvOrCommand: string[] | string): GuardianFinding | null {
  if (isGuardianDisabled()) return null;
  const cmd = Array.isArray(argvOrCommand) ? argvOrCommand.join(' ') : argvOrCommand;
  if (!cmd.trim()) return null;

  const base = mainRawScan(cmd);
  if (base !== null) {
    const printerException =
      PRINTER_PROGRAMS.has(firstProgramWord(cmd)) &&
      splitScanStatements(cmd).length === 1 &&
      processSubstitutionBodies(cmd).length === 0 &&
      hitInsideInertQuote(cmd, base.match) &&
      scanCommand(cmd) === null;
    return printerException ? null : toFinding(base);
  }

  const exec = scanCommand(cmd);
  if (exec !== null) return exec;

  // r9: 프린터라도 프로세스 치환이 섞여 있으면 실행 위치가 있는 것이다 —
  // 이스케이프를 풀고 재스캔한다(«더 막는» 쪽 전용 · JUD 20261119-0658 ⓒ2).
  if (!PRINTER_PROGRAMS.has(firstProgramWord(cmd)) || processSubstitutionBodies(cmd).length > 0) {
    const dequoted = stripQuoteMarks(unescapeQuoteChars(cmd));
    if (dequoted !== cmd) {
      const more = mainRawScan(dequoted);
      if (more !== null) return toFinding(more);
    }
  }
  return null;
}

/** Test hook — flip patterns at runtime. Returns the previous list
 *  for chained restore. Not exported in the barrel; used only by
 *  integration tests that want to inject fixtures. */
export function _overrideRulesForTesting(rules: Rule[] | null): Rule[] {
  const prev = RULES.slice();
  if (rules !== null) {
    RULES.length = 0;
    RULES.push(...rules);
  }
  return prev;
}
