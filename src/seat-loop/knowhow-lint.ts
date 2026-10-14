import { seatPackLeakPatterns } from './seat-pack.js';

/** 필수 칸 — 형식 v2 선언(각 자리 KNOWHOW 머리글)의 공통 아홉. 괄호 수식어(신호(관측) 등)는 정규화해서 비교한다. */
const REQUIRED_FIELDS = ['상황', '신호', '원인', '처방', '재는 명령', '기대', '유효 조건', '검증', '출처'] as const;

/** Only commands whose executable and subcommand are known to be observational are accepted. */
const READ_COMMANDS: Record<string, ReadonlySet<string> | null> = {
  cat: null, echo: null, rg: null, grep: null, head: null, tail: null,
  wc: null, sort: null, uniq: null, cut: null, jq: null, ls: null, stat: null,
  readlink: null, pwd: null, test: null,
  git: new Set(['rev-parse', 'status', 'log', 'show', 'merge-base']),
  eln: new Set(['logs', 'where', 'tasks', 'config', 'release']),
  'bun bin/elanous.mjs': new Set(['logs', 'where', 'release']),
};

/** Git's options are commands too: e.g. show --textconv runs a configured external driver. */
const READ_GIT_OPTIONS: Record<string, ReadonlySet<string>> = {
  'rev-parse': new Set(['--git-dir', '--show-toplevel', '--is-inside-work-tree', '--verify', '--short', '--abbrev-ref', '--show-prefix']),
  status: new Set(['--short', '--porcelain', '--branch', '--untracked-files=all', '--untracked-files=no']),
  log: new Set(['--oneline', '--no-patch', '--stat', '--name-only', '--name-status', '--all', '--decorate']),
  show: new Set(['--no-patch', '--stat', '--name-only', '--name-status', '--oneline']),
  'merge-base': new Set(['--is-ancestor', '--fork-point', '--all']),
};

/** `logs level <value>` changes daemon state. Accept only the top-level query options. */
const LOGS_QUERY_FLAGS = new Set([
  '--follow', '-f', '--list-categories', '--list-events', '--explain', '--top-failures',
  '--json', '--json-data', '--test', '--all', '--include-test', '-r', '--help', '-h',
]);
const LOGS_QUERY_VALUES = new Set([
  '--level', '--surface', '--space', '--category', '--exact-category', '--axis', '--event',
  '--grep', '--rework-recurrence-disagreement', '--since', '--until', '--before',
  '--session', '--limit', '--threshold', '--instance', '--remote',
]);

function readOnlyLogs(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (LOGS_QUERY_FLAGS.has(arg)) continue;
    if (LOGS_QUERY_VALUES.has(arg) && args[i + 1] && !args[i + 1]!.startsWith('-')) { i++; continue; }
    return false;
  }
  return true;
}

function readOnlyGit(rest: string[]): boolean {
  const [subcommand, ...args] = rest;
  const options = READ_GIT_OPTIONS[subcommand ?? ''];
  if (!options) return false;
  return args.every((arg) => !arg.startsWith('-') || options.has(arg)
    || ((subcommand === 'log' || subcommand === 'show')
      && (/^--(?:format|pretty|grep|since|until|max-count)=.+$/u.test(arg) || /^-[1-9][0-9]*$/u.test(arg))));
}

/** Do not execute the measurement here: parse only a small, fail-closed shell subset. */
function readOnlyMeasure(command: string): boolean {
  const source = command.trim().replace(/^`|`$/gu, '');
  const tokens: string[] = [];
  let word = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (char === '\\' || char === '`' || char === '$' || char === '\n') return false;
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/u.test(char)) {
      if (word) { tokens.push(word); word = ''; }
    } else if ('|&;<>()[{}]'.includes(char)) {
      if (word) { tokens.push(word); word = ''; }
      if (char === '|' || char === '&') {
        if (source[i + 1] === char) { tokens.push(char + char); i++; }
        else if (char === '|') tokens.push('|');
        else return false;
      } else if (char === '>') {
        if (source[i + 1] === '>') return false;
        if (source.slice(i + 1, i + 3) === '&1') { tokens.push('>&1'); i += 2; }
        else tokens.push('>');
      } else return false;
    } else word += char;
  }
  if (quote) return false;
  if (word) tokens.push(word);
  if (!tokens.length) return false;
  const segments: string[][] = [[]];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === '>' && tokens[i + 1] === '/dev/null') { i++; continue; }
    if (token === '2' && tokens[i + 1] === '>&1') { i++; continue; }
    if (token === '&&' || token === '||' || token === '|') {
      if (!segments.at(-1)!.length) return false;
      segments.push([]);
    } else if (token === '>' || token === '>&1') return false;
    else segments.at(-1)!.push(token);
  }
  return segments.every((args) => {
    if (!args.length || args.some((arg) => /^(?:--pre|--output|--ext-diff|--exec|--config|--config-env|--write)(?:=|$)/u.test(arg))) return false;
    if (args.some((arg) => /^(?:--output(?:=\S*)?|--replace|--in-place)$/u.test(arg))) return false;
    if (args[0] === 'sort' && args.some((arg) => /^-o\S*|^--compress-program(?:=|$)/u.test(arg))) return false;
    let executable = args[0]!;
    let rest = args.slice(1);
    if (executable === 'bun' && rest[0] === 'bin/elanous.mjs') { executable = 'bun bin/elanous.mjs'; rest = rest.slice(1); }
    if (!Object.hasOwn(READ_COMMANDS, executable)) return false;
    const allowed = READ_COMMANDS[executable]!;
    if (allowed === null) return true;
    if (executable === 'bun bin/elanous.mjs' && rest[0] === '--test') rest = rest.slice(1);
    if (!allowed.has(rest[0] ?? '')) return false;
    if (executable === 'git') return readOnlyGit(rest);
    if ((executable === 'eln' || executable === 'bun bin/elanous.mjs') && rest[0] === 'logs') return readOnlyLogs(rest.slice(1));
    if ((executable === 'eln' || executable === 'bun bin/elanous.mjs') && rest[0] === 'tasks') return rest[1] === 'close' && rest[2] === '--help';
    if ((executable === 'eln' || executable === 'bun bin/elanous.mjs') && rest[0] === 'config') return rest[1] === 'get';
    if ((executable === 'eln' || executable === 'bun bin/elanous.mjs') && rest[0] === 'release') return rest[1] === 'checklist' && rest[2] === 'status';
    return true;
  });
}

/** 비밀 표식 — 팩 스캔 표식(seatPackLeakPatterns)에 실제 자격 모양을 더한 집합. */
const SECRET_SHAPE_PATTERNS: Array<[string, RegExp]> = [
  ['api key', /\b(?:sk|rk)-(?:proj-)?[A-Za-z0-9_-]{16,}\b/u],
  ['github token', /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/u],
  ['slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u],
  ['aws key id', /\bAKIA[0-9A-Z]{12,}\b/u],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/u],
  ['credential assignment', /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9][A-Za-z0-9._/+~-]{11,}/iu],
];

export class KnowhowLintError extends Error {
  constructor(file: string, card: string, reason: string) {
    super(`knowhow lint: ${file} ${card} — ${reason}`);
    this.name = 'KnowhowLintError';
  }
}

interface KnowhowCard {
  id: string;
  lines: Array<[number, string]>;
}

/** 카드 제목 — `## K-<자리>-<번호>` 뒤에는 줄 끝·공백·콜론·em 대시만 온다. */
const CARD_HEADING = /^[ \t]{0,3}##\s+(K-[A-Za-z]+-\d+)(?=$|\s|:|—)/u;
/** 카드처럼 보이는 `##` 제목(예: `## K-OP-7a`) — CARD_HEADING 을 벗어나면 인식 실패로 명시 거부한다. */
const CARD_HEADING_LIKE = /^[ \t]{0,3}##\s*(K-[^\s:]*)/iu;

function parseCards(body: string, file: string): KnowhowCard[] {
  const cards: KnowhowCard[] = [];
  let current: KnowhowCard | null = null;
  let fence: { marker: string; length: number } | null = null;
  for (const [index, line] of body.split(/\r?\n/u).entries()) {
    const fenceLine = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (fence) {
      if (fenceLine && fenceLine[1]![0] === fence.marker && fenceLine[1]!.length >= fence.length
        && /^[ \t]*$/u.test(fenceLine[2]!)) fence = null;
      continue;
    }
    if (fenceLine) {
      fence = { marker: fenceLine[1]![0]!, length: fenceLine[1]!.length };
      continue;
    }
    const heading = line.match(CARD_HEADING);
    if (heading) {
      current = { id: heading[1]!, lines: [] };
      cards.push(current);
      continue;
    }
    if (/^[ \t]{0,3}#/u.test(line)) {
      const like = line.match(CARD_HEADING_LIKE);
      if (like) throw new KnowhowLintError(file, like[1]!, '카드 제목 형식이 K-<자리>-<번호>를 벗어남');
      current = null;
    } else if (current) current.lines.push([index + 1, line]);
  }
  return cards;
}

function parseField(line: string): { label: string; value: string } | null {
  const match = line.match(/^-\s*([^:—]+?)\s*[—:]\s*(.*)$/u);
  if (!match) return null;
  return { label: match[1]!.replace(/\s*\([^)]*\)/gu, '').trim(), value: match[2]!.trim() };
}

/** 자리 KNOWHOW.md 카드를 내보내기 전에 검증한다 — 카드 제목 형식 · 필수 칸 · 읽기 전용 재는 명령(이어 적은 여러 줄 포함) · 비밀 표식. */
export function lintKnowhow(body: string, file: string): void {
  const secrets = [...seatPackLeakPatterns(), ...SECRET_SHAPE_PATTERNS];
  for (const [index, line] of body.split(/\r?\n/u).entries()) {
    for (const [label, pattern] of secrets) {
      if (pattern.test(line)) throw new KnowhowLintError(file, 'file', `비밀 표식 (${label}) — ${file}:${index + 1}`);
    }
  }
  const cards = parseCards(body, file);
  if (!cards.length) throw new KnowhowLintError(file, 'file', '카드가 0개 — 최소 한 개의 K-<자리>-<번호> 카드가 필요함');
  for (const card of cards) {
    const fields = new Map<string, string>();
    const fieldEntries: Array<{ label: string; value: string }> = [];
    let current: { label: string; value: string } | null = null;
    for (const [, line] of card.lines) {
      const field = parseField(line);
      if (field) {
        if (current) fieldEntries.push(current);
        current = { label: field.label, value: field.value };
      } else if (current && /^\s+\S/u.test(line)) {
        current.value += `\n${line.trim()}`;
      } else if (current) {
        fieldEntries.push(current);
        current = null;
      }
    }
    if (current) fieldEntries.push(current);
    for (const field of fieldEntries) {
      if (fields.has(field.label)) throw new KnowhowLintError(file, card.id, `중복 칸: ${field.label}`);
      if ((REQUIRED_FIELDS as readonly string[]).includes(field.label) || field.label === '상태') {
        if (!field.value) throw new KnowhowLintError(file, card.id, `필수 칸 누락: ${field.label}`);
      }
      if (field.label === '재는 명령'
        && !field.value.split('\n').every((command) => readOnlyMeasure(command))) {
        throw new KnowhowLintError(file, card.id, '재는 명령이 읽기 전용이 아님');
      }
      fields.set(field.label, field.value);
    }
    for (const required of REQUIRED_FIELDS) {
      if (!fields.get(required)) throw new KnowhowLintError(file, card.id, `필수 칸 누락: ${required}`);
    }
    const source = fields.get('출처') ?? '';
    const statusInSource = source.match(/(?:^|[· \t])상태[ \t]*[:—][ \t]*([^·\n]*)/u);
    if (!source.slice(0, statusInSource?.index ?? source.length).replace(/[·\s]+$/u, '').trim()) {
      throw new KnowhowLintError(file, card.id, '필수 칸 누락: 출처');
    }
    const combinedStatus = statusInSource?.[1]?.trim();
    if (!fields.get('상태') && !combinedStatus) {
      throw new KnowhowLintError(file, card.id, '필수 칸 누락: 상태');
    }
  }
}
