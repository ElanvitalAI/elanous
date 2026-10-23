/**
 * K3 knowledge pack — the coordinator reads OP knowhow from `내부 문서 `KNOWHOW``
 * on every tick, so a doc landing alone (no code deploy) refreshes what is resident.
 *
 * A pack holds only items whose `상태:` is `active` **and** that carry a `재는 명령:`;
 * every item is ordered by id and the pack carries a content hash so a reply can cite
 * exactly which pack it read.
 *
 * The inbox may then *propose* an item's 처방 — it never writes, and it never changes a lock.
 * A measurement command is executed only when it passes the read-only allowlist; when its
 * output contradicts the item's `기대`, the advice is stale and the inbox answers 모름.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { debug } from '../../debug/log.js';

export const KNOWHOW_PACK_VERSION = 'K3';
export const KNOWHOW_DOC_RELATIVE_PATH = 'docs/roles/OP/KNOWHOW.md';

export interface KnowhowItem {
  id: string;
  title: string;
  status: string;
  situation: string;
  signal: string;
  prescription: string;
  command: string;
  expectation: string;
  validWhen: string;
  source: string;
}

export interface KnowhowPack {
  version: string;
  hash: string;
  docPath: string;
  items: KnowhowItem[];
}

export interface KnowhowCommandRun {
  status: number;
  output: string;
  /** Set when the runner refused to execute (placeholder, timeout, spawn failure). */
  skipped?: string;
}

export type KnowhowCommandRunner = (command: string) => KnowhowCommandRun;

export interface KnowhowOptions {
  /** Explicit doc path; otherwise `ELANOUS_KNOWHOW_DOC`, otherwise the repository copy. */
  docPath?: string;
  /** Working directory for measurement commands. */
  cwd?: string;
  /** Measurement seam: replaced by tests, defaults to the guarded read-only runner. */
  runCommand?: KnowhowCommandRunner;
}

export type KnowhowFreshness = 'confirmed' | 'stale' | 'unmeasured' | 'unverifiable';

export interface KnowhowMatch {
  item: KnowhowItem;
  score: number;
  matchedTokens: string[];
}

export interface KnowhowAdvice extends KnowhowMatch {
  packVersion: string;
  packHash: string;
  freshness: KnowhowFreshness;
  detail: string;
}

/** Label → item field. Labels keep their parenthetical form when the doc uses one. */
const FIELD_LABELS: Array<[RegExp, keyof KnowhowItem]> = [
  [/^상황$/i, 'situation'],
  [/^신호(?:\(관측\))?$/i, 'signal'],
  [/^처방(?:\(힐링\))?$/i, 'prescription'],
  [/^재는 명령$/i, 'command'],
  [/^기대$/i, 'expectation'],
  [/^유효 조건$/i, 'validWhen'],
  [/^출처$/i, 'source'],
];

function stripTicks(value: string): string {
  const trimmed = value.trim();
  const match = /^`([\s\S]*)`$/.exec(trimmed);
  return match ? match[1]!.trim() : trimmed;
}

function labeledLine(section: string, field: keyof KnowhowItem): string {
  for (const line of section.split('\n')) {
    const entry = /^-\s+([^:]{1,24}):\s*(.+)$/.exec(line.trim());
    if (!entry) continue;
    const label = entry[1]!.trim();
    if (FIELD_LABELS.some(([pattern, name]) => name === field && pattern.test(label))) return stripTicks(entry[2]!);
  }
  return '';
}

/** Split the markdown inventory into K items. Unknown labels are ignored, not fatal. */
export function parseKnowhowDoc(text: string): KnowhowItem[] {
  const sections = text.split(/^## /m).slice(1);
  const items: KnowhowItem[] = [];
  for (const section of sections) {
    const heading = /^(K-OP-(?:[A-Z]{1,4}-)?\d+)\s+(.*)$/.exec(section.split('\n', 1)[0] ?? '');
    if (!heading) continue;
    const item: KnowhowItem = {
      id: heading[1]!, title: heading[2]!.trim(), status: '', situation: labeledLine(section, 'situation'),
      signal: labeledLine(section, 'signal'), prescription: labeledLine(section, 'prescription'),
      command: labeledLine(section, 'command'), expectation: labeledLine(section, 'expectation'),
      validWhen: labeledLine(section, 'validWhen'), source: labeledLine(section, 'source'),
    };
    const status = /상태:\s*([A-Za-z][A-Za-z-]*)/.exec(item.source);
    if (status) item.status = status[1]!;
    if (item.status !== 'active') continue;
    if (!item.command || /^\(없음/.test(item.command)) continue;
    items.push(item);
  }
  return items.sort((a, b) => a.id.localeCompare(b.id));
}

export function buildKnowhowPack(items: KnowhowItem[], docPath: string): KnowhowPack {
  const body = items.map(item => [item.id, item.title, item.situation, item.signal, item.prescription,
    item.command, item.expectation].join('\n')).join('\n---\n');
  const hash = createHash('sha256').update(`${KNOWHOW_PACK_VERSION}\n${body}`).digest('hex').slice(0, 16);
  return { version: KNOWHOW_PACK_VERSION, hash, docPath, items };
}

/** Marker text for a command that still carries `<...>` placeholders from the doc. */
const PLACEHOLDER_SOURCE = '<[^<>\\n]{1,60}>';
const PLACEHOLDER = new RegExp(PLACEHOLDER_SOURCE, 'g');

function repositoryRoot(): string | null {
  let current = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(current, KNOWHOW_DOC_RELATIVE_PATH))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export function resolveKnowhowDocPath(explicit?: string): string | null {
  if (explicit) return existsSync(explicit) ? explicit : null;
  const fromEnv = process.env.ELANOUS_KNOWHOW_DOC;
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  if (existsSync(join(process.cwd(), KNOWHOW_DOC_RELATIVE_PATH))) return join(process.cwd(), KNOWHOW_DOC_RELATIVE_PATH);
  const root = repositoryRoot();
  return root ? join(root, KNOWHOW_DOC_RELATIVE_PATH) : null;
}

const packCache = new Map<string, { stamp: string; pack: KnowhowPack }>();

/** Resident pack for one tick: re-read whenever the doc's mtime/size changes. */
export function loadKnowhowPack(docPath: string): KnowhowPack | null {
  if (!existsSync(docPath)) return null;
  let stamp: string;
  try {
    const info = statSync(docPath);
    stamp = `${info.mtimeMs}:${info.size}`;
  } catch { return null; }
  const cached = packCache.get(docPath);
  if (cached && cached.stamp === stamp) return cached.pack;
  const pack = buildKnowhowPack(parseKnowhowDoc(readFileSync(docPath, 'utf8')), docPath);
  packCache.set(docPath, { stamp, pack });
  debug.log('loop.knowhow-pack', 'load', { version: pack.version, hash: pack.hash,
    items: pack.items.length, docPath });
  return pack;
}

const STOPWORDS = new Set(['그리고', '그러나', '하지만', '그러면', '어떻게', '무엇', '뭐가', '뭘', '이거', '그거',
  '저거', '지금', '오늘', '내일', '확인', '요청', '질문', '경우', '때문', '때는', '먼저', '다시', '대한', '위해',
  '에서', '으로', '하는', '하지', '한다', '있다', '없다', '같다', '되는', '되나', '됐다', '있나', '인가', '무슨',
  '어느', '이런', '그런', '저런', '좀', '더', '또는', '그게', '이게', '저게', '합니까', '인지', '하는데',
  '보다', '라며', '해도', '하면', '해서', '부터', '까지', '아직', '이미', '모두', '이후', '이전', '동안',
  'the', 'and', 'for', 'you', 'can', 'this', 'that', 'what', 'which', 'how', 'why', 'when', 'with', 'from',
  'are', 'was', 'were', 'has', 'have', 'had', 'not', 'but', 'all', 'any', 'our', 'your', 'its', 'it', 'is',
  'of', 'to', 'in', 'on', 'do', 'does', 'did', 'please', 'anyone']);

const KOREAN_SUFFIXES = ['에서부터', '으로부터', '에서는', '으로는', '이었습니다', '했습니다', '됩니다', '됐습니다',
  '합니까', '했나요', '되나요', '인가요', '에서', '으로', '부터', '까지', '했나', '됐나', '되나', '했지', '하지',
  '됐다', '한다', '된다', '이다', '있다', '없다', '었던', '였던', '라는', '이라', '거나', '면서', '지만',
  '에게', '한테', '보다', '처럼', '만큼', '라고', '하고', '해도', '하면', '인데', '나요', '가요', '세요',
  '은', '는', '을', '를', '이', '가', '의', '에', '와', '과', '로', '도', '만', '라', '며', '서', '나', '고', '면'];

function normalizeToken(raw: string): string {
  let token = raw.toLowerCase();
  for (const suffix of KOREAN_SUFFIXES) {
    if (token.length > suffix.length + 1 && token.endsWith(suffix)) {
      token = token.slice(0, -suffix.length);
      break;
    }
  }
  return token;
}

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of text.toLowerCase().split(/[^0-9a-z가-힣-]+/)) {
    const token = normalizeToken(raw);
    if (token.length < 2 || STOPWORDS.has(raw) || STOPWORDS.has(token)) continue;
    if (/^\d+$/.test(token)) continue;
    tokens.push(token);
  }
  return tokens;
}

function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))) return true;
  return false;
}

const MIN_MATCH_SCORE = 2.2;
const MIN_MATCH_TOKENS = 2;

/**
 * Match a question against the pack item text (title ⊕ 상황 ⊕ 신호) using inverse document
 * frequency, so a word shared by most items ("착지", "PR") cannot carry a match alone.
 */
export function matchKnowhowItem(pack: KnowhowPack, question: string, minScore = MIN_MATCH_SCORE): KnowhowMatch | null {
  const questionTokens = [...new Set(tokenize(question))];
  if (questionTokens.length === 0 || pack.items.length === 0) return null;
  const itemTokens = pack.items.map(item => [...new Set(tokenize(`${item.title} ${item.situation} ${item.signal}`))]);
  const total = pack.items.length;
  const scored = pack.items.map((item, index) => {
    const matched: string[] = [];
    let score = 0;
    for (const token of questionTokens) {
      const hits = itemTokens.filter(tokens => tokens.some(candidate => tokensMatch(token, candidate))).length;
      if (hits === 0 || !itemTokens[index]!.some(candidate => tokensMatch(token, candidate))) continue;
      matched.push(token);
      score += Math.log((total + 1) / (hits + 0.5));
    }
    return { item, score: Number(score.toFixed(3)), matchedTokens: matched };
  }).sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
  const best = scored[0];
  if (!best || best.matchedTokens.length < MIN_MATCH_TOKENS || best.score < minScore) return null;
  return best;
}

const READ_ONLY_BINARIES = new Set(['rg', 'grep', 'cat', 'head', 'tail', 'wc', 'ls', 'jq', 'awk', 'find',
  'sort', 'uniq', 'cut', 'echo', 'pwd', 'stat', 'file', 'date', 'printf', 'true', 'test']);
const GIT_READ_ONLY_SUBCOMMANDS = new Set(['status', 'log', 'show', 'diff', 'rev-parse', 'rev-list',
  'ls-files', 'ls-tree', 'worktree', 'shortlog', 'blame', 'describe', 'branch', 'tag', 'remote', 'config', 'cat-file']);
const GIT_WRITE_ARGS = new Set(['-d', '-D', '-m', '-M', '--delete', '--move', '--force', '--set', '--unset',
  '--add', '--edit', '--prune', 'add', 'commit', 'push', 'merge', 'reset', 'checkout', 'switch', 'clean',
  'rm', 'mv', 'apply', 'stash', 'gc', 'update-ref', 'submodule', 'rebase', 'cherry-pick', 'revert']);
const ELANOUSH_READ_ONLY: Record<string, string[] | null> = {
  logs: null, 'tasks:show': null, 'tasks:list': null,
  release: ['checklist'], decisions: ['list'], msg: ['list'], memory: ['list'],
};

export type ReadOnlyVerdict = { ok: true } | { ok: false; reason: string };

/** Allowlist guard: only commands that cannot mutate the repository or the ledgers run. */
export function isReadOnlyCommand(command: string): ReadOnlyVerdict {
  const stripped = command.replace(PLACEHOLDER, ' ');
  if (!stripped.trim()) return { ok: false, reason: 'empty command' };
  if (/[<>`$]|[;\n]/.test(stripped)) return { ok: false, reason: 'shell redirect, substitution or sequence' };
  const segments = stripped.split(/\s*(?:&&|\|\||\||&)\s*/).map(part => part.trim()).filter(Boolean);
  if (segments.length === 0) return { ok: false, reason: 'empty command' };
  for (const segment of segments) {
    const words = segment.split(/\s+/);
    const binary = words[0]!.replace(/^.*\//, '');
    const args = words.slice(1);
    if (binary === 'git') {
      const sub = args.find(word => !word.startsWith('-'));
      if (!sub) return { ok: false, reason: 'git without subcommand' };
      if (!GIT_READ_ONLY_SUBCOMMANDS.has(sub)) return { ok: false, reason: `git ${sub} is not read-only` };
      if (args.some(word => GIT_WRITE_ARGS.has(word))) return { ok: false, reason: `git ${sub} write flag` };
      continue;
    }
    if (binary === 'eln' || binary === 'elanous') {
      const verbs = args.filter(word => !word.startsWith('-'));
      const [first, second, third] = verbs;
      // `eln tasks show` and `eln release checklist status` name the verb in two words.
      if (first && second && `${first}:${second}` in ELANOUSH_READ_ONLY) {
        const allowed = ELANOUSH_READ_ONLY[`${first}:${second}`];
        if (allowed && (!third || !allowed.includes(third))) {
          return { ok: false, reason: `${binary} ${first} ${second} ${third ?? ''} is not read-only` };
        }
        continue;
      }
      if (!first || !(first in ELANOUSH_READ_ONLY)) return { ok: false, reason: `${binary} ${first ?? ''} is not read-only` };
      const allowed = ELANOUSH_READ_ONLY[first];
      if (allowed && (!second || !allowed.includes(second))) return { ok: false, reason: `${binary} ${first} ${second ?? ''} is not read-only` };
      continue;
    }
    if (!READ_ONLY_BINARIES.has(binary)) return { ok: false, reason: `${binary} is not on the read-only allowlist` };
  }
  return { ok: true };
}

export type ExpectationVerdict = 'confirmed' | 'stale' | 'unverifiable';

/**
 * Compare a measurement output against the item's 기대. Only machine-checkable wordings
 * are judged: `N 줄/건/개` (exact count) and `≥N` / `N 이상` (lower bound).
 */
export function evaluateExpectation(expectation: string, output: string): { verdict: ExpectationVerdict; detail: string } {
  const lines = output.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  const counted = /(\d+)\s*(줄|행|건|개|line)/.exec(expectation);
  if (counted) {
    const expected = Number(counted[1]);
    const ok = lines.length === expected;
    return { verdict: ok ? 'confirmed' : 'stale', detail: `기대 ${expected}${counted[2]} · 실제 ${lines.length}줄` };
  }
  const lower = /(?:[≥>=]\s*(\d+))|(?:(\d+)\s*이상)/.exec(expectation);
  if (lower) {
    const expected = Number(lower[1] ?? lower[2]);
    const numbers = (output.match(/\d+/g) ?? []).map(Number);
    const ok = numbers.length > 0 && numbers.every(value => value >= expected);
    return { verdict: ok ? 'confirmed' : 'stale',
      detail: `기대 ≥${expected} · 실제 ${numbers.length > 0 ? numbers.join(',') : '(수 없음)'}` };
  }
  if (!lines.length) return { verdict: 'stale', detail: '기대 비교 불가 · 재는 명령 출력이 비었다' };
  return { verdict: 'unverifiable', detail: `기대 문면: ${expectation.slice(0, 120)} — 자동 비교 규칙 없음` };
}

/** Default runner: guarded, bounded, and never shells a doc placeholder. */
export function readOnlyRunner(cwd: string): KnowhowCommandRunner {
  return (command: string): KnowhowCommandRun => {
    const verdict = isReadOnlyCommand(command);
    if (!verdict.ok) return { status: -1, output: '', skipped: verdict.reason };
    if (new RegExp(PLACEHOLDER_SOURCE).test(command)) return { status: -1, output: '', skipped: 'placeholder 미치환' };
    const run = spawnSync('bash', ['-c', command], { cwd, encoding: 'utf8', timeout: 15_000, maxBuffer: 1 << 20 });
    if (run.error) return { status: -1, output: '', skipped: run.error.message.slice(0, 120) };
    return { status: run.status ?? -1, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
  };
}

export function measureKnowhowItem(
  item: KnowhowItem, run: KnowhowCommandRunner,
): { freshness: KnowhowFreshness; detail: string } {
  const verdict = isReadOnlyCommand(item.command);
  if (!verdict.ok) return { freshness: 'unmeasured', detail: `재지 못함 — ${verdict.reason} (읽기 전용 허용 목록 밖)` };
  const result = run(item.command);
  if (result.skipped) return { freshness: 'unmeasured', detail: `재지 못함 — ${result.skipped}` };
  if (result.status !== 0) return { freshness: 'unmeasured', detail: `재지 못함 — rc=${result.status}` };
  const judged = evaluateExpectation(item.expectation, result.output);
  return { freshness: judged.verdict, detail: judged.detail };
}

/** The advice the inbox may propose: item ⊕ pack identity ⊕ freshness of its measurement. */
export function knowhowAdvice(question: string, options: KnowhowOptions = {}): KnowhowAdvice | null {
  const docPath = resolveKnowhowDocPath(options.docPath);
  if (!docPath) return null;
  const pack = loadKnowhowPack(docPath);
  if (!pack) return null;
  const match = matchKnowhowItem(pack, question);
  if (!match) return null;
  const run = options.runCommand ?? readOnlyRunner(options.cwd ?? process.cwd());
  const measured = measureKnowhowItem(match.item, run);
  const advice: KnowhowAdvice = { ...match, packVersion: pack.version, packHash: pack.hash,
    freshness: measured.freshness, detail: measured.detail };
  debug.log('loop.knowhow-pack', 'advice', { id: match.item.id, score: match.score,
    freshness: advice.freshness, packHash: pack.hash });
  return advice;
}
