#!/usr/bin/env bun
/**
 * SEAT-RETRO-NIGHTLY-NODE — nightly-condense 의 `seat-retro` 노드(record 다음 · 특허 ② 수면 응고의 자리 몫).
 *
 * 무엇: 그날 밤 그래프가 이미 모은 사실(collect 의 이벤트·결정 · record 의 기억 항목)과 retro-daily(22:40)
 * 의 조치 초안을 «자리별»로 묶어
 *   ① 자리 RETRO.md 에 날짜 절 하나(같은 날 재실행 = 그 절만 교체 · 다른 줄은 바이트 그대로)
 *   ② 자리 MEMORY.md 끝에 «기억 후보» 블록(같은 날 = 교체 · 기존 줄은 덮어쓰지 않는다)
 *   ③ ROLE.proposal-<day>.md (ROLE.md 는 절대 고치지 않는다 · 사람 승인 전 제안)
 *   ④ OP 아침 카드 «어젯밤 이은 것» ≤2줄 · 줄마다 근거 링크 — `seatRetroMorningCard()` 로 읽는다
 * 를 만든다.
 *
 * 판정은 구조 필드로만 한다(R-SIG): 이벤트 `refs.seat` · 결정 `raisedBy.track` · 기억 `seat`/`status`/`updatedAt`
 * · retro-daily 조치 `owner`. 문장 정규식·키워드 분기 없음.
 *
 * 모드 = config `context.seatRetro.mode` = shadow(기본) | live. 입력 `mode: 'shadow'` 는 더 안전한 쪽으로만 강제한다.
 *   shadow — 모두 계산하고 이벤트를 내되, 쓰기는 그림자 경로 `<root>/context-memory/seat-retro-<day>.json` 하나뿐(자리 파일 0).
 *   live   — 자리 파일 ①②③ 을 쓰고 같은 day 파일에 `briefing: true` 를 찍어 아침 카드가 싣게 한다.
 *   dry-run(`ELANOUS_GRAPH_DRY_RUN=1`) — 어떤 파일도 쓰지 않는다.
 *
 * 아침 카드 배선점: main 에 OP 아침 카드 입력이 아직 없다(검색: `rg -n 'morning' src/briefing` = 대표 08:30 브리핑만).
 * 그래서 retro-daily 의 `retroBriefingLines()` 와 같은 꼴로 day 파일 ⊕ 읽기 함수 `seatRetroMorningCard(root, day)` ⊕
 * 관측 이벤트 `context.seat-retro morning-card`(debug 로그 · `elanous logs --category context.seat-retro`)를 낸다.
 *
 * 후속(이 노드 밖): 응고(consolidation)·가지치기·승격·먼 기억 잇기.
 */
import { createHash, randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { CoordEvent } from './coord-events.js';
import type { MemoryItem } from './long-term-memory.js';
import type { DecisionEntry } from '../decisions/decision-ledger.js';
import { retroDayFile, type DraftCell } from '../retro/daily.js';
import { prodInstanceRoot } from '../instance/resolve.js';
import { acquireLockAsync } from '../storage/file-lock.js';
import { debug } from '../debug/log.js';

export const SEAT_RETRO_GRAPH_ID = 'nightly-condense';
export const SEAT_RETRO_NODE_ID = 'seat-retro';
export const SEAT_RETRO_CARD_TITLE = '어젯밤 이은 것';
/** 출처: 칸 SEAT-RETRO-NIGHTLY-NODE «OP 아침 카드 최대 2줄». */
export const SEAT_RETRO_MORNING_MAX_LINES = 2;
const LIST_MAX = 5;
/** 새로 만드는 자리 파일·day 파일 권한(자리 기억은 남에게 읽히지 않는다). 있는 파일은 원래 권한을 그대로 둔다. */
const NEW_FILE_MODE = 0o600;
/** 제안 파일 셋째 줄 — 이 노드가 쓴 파일인지(철회해도 되는지) 가르는 자기 표식. */
const PROPOSAL_OWNER_LINE = '상태: 제안 — 사람 승인 전 ROLE.md 에 반영하지 않는다(nightly-condense seat-retro 가 쓴 파일).';
const TEXT_MAX = 120;
const CAS_TRIES = 3;
const SEAT_ADDRESS = /^[A-Z][A-Z0-9_-]{0,63}$/;
const DAY = /^\d{4}-\d\d-\d\d$/;

export type SeatRetroMode = 'shadow' | 'live';
export type SeatRetroFs = Pick<typeof nodeFs, 'existsSync' | 'readFileSync' | 'writeFileSync' | 'renameSync' | 'unlinkSync' | 'mkdirSync'
  | 'readdirSync' | 'statSync' | 'chmodSync' | 'linkSync'>;
export type SeatRetroDeps = {
  now?: Date;
  /** 자리 상태 뿌리(`<SEAT>/ROLE.md` 들이 사는 곳). 없으면 런 우주에서 정한다(prod = ~/elanous-hq/seat-state). */
  seatStateRoot?: string;
  readConfig?: () => unknown;
  fs?: SeatRetroFs;
  acquireLock?: typeof acquireLockAsync;
};
type Ctx = {
  graphId?: string; nodeId?: string; input: Record<string, unknown> | null;
  outputs: Record<string, Record<string, unknown> | null>;
};

export type SeatFacts = {
  seat: string;
  events: Array<{ id: string; at: string; kind: string; text: string; link: string }>;
  decisions: Array<{ id: string; at: string; title: string; link: string }>;
  memory: Array<{ project: string; topic: string; summary: string; link: string }>;
  actions: Array<{ id: string; title: string; verdictLine: string; evidence: string[] }>;
};
export type SeatResult = {
  seat: string; counts: { events: number; decisions: number; memory: number; actions: number };
  retro: 'written' | 'unchanged' | 'shadow' | 'error'; memory: 'written' | 'unchanged' | 'retracted' | 'shadow' | 'none' | 'error';
  proposal: 'written' | 'unchanged' | 'retracted' | 'shadow' | 'none' | 'error'; roleSha256: string | null; error?: string;
};
export type MorningLine = { seat: string; text: string; evidence: string[] };
export type SeatRetroDay = {
  day: string; mode: SeatRetroMode; briefing: boolean; generatedAt: string;
  window: { since: string; until: string }; retroDaily: { day: string; status: 'read' | 'absent' | 'unreadable' };
  seats: SeatResult[]; morningCard: { title: string; lines: MorningLine[] };
};

// ── 작은 도구 ──────────────────────────────────────────────────────────
const rec = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown): string => typeof value === 'string' ? value : '';
/** 한 줄로 · 표식 주석과 겹칠 수 있는 `<!--`/`-->` 를 무력화 · 길이 상한. */
const oneLine = (value: string): string => value.replace(/\s+/g, ' ').split('<!--').join('<!—').split('-->').join('—>').trim().slice(0, TEXT_MAX);
const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
const inWindow = (at: string, window: { since: string; until: string }): boolean => {
  const time = Date.parse(at);
  return Number.isFinite(time) && time >= Date.parse(window.since) && time < Date.parse(window.until);
};
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 200);
const emit = (event: string, data: Record<string, unknown>, level?: 'error'): void => {
  try { debug.log('context.seat-retro', event, data, level ? { level } : undefined); } catch { /* 관측은 노드를 멈추지 않는다 */ }
};

export const seatRetroBeginMarker = (day: string): string => `<!-- seat-retro:${day} -->`;
export const seatRetroEndMarker = (day: string): string => `<!-- /seat-retro:${day} -->`;
export const seatMemoryBeginMarker = (day: string): string => `<!-- seat-retro-candidates:${day} -->`;
export const seatMemoryEndMarker = (day: string): string => `<!-- /seat-retro-candidates:${day} -->`;
/** context-memory 바로 아래 «파일»이다 — 그 아래 «폴더»는 nightly 가 project 기억 원장으로 전수 읽으니(storedItems) 폴더를 만들지 않는다. */
export const seatRetroDayFile = (root: string, day: string): string => join(root, 'context-memory', `seat-retro-${day}.json`);
export const roleProposalName = (day: string): string => `ROLE.proposal-${day}.md`;

export function resolveSeatRetroMode(input: Record<string, unknown>, readConfig: () => unknown): SeatRetroMode {
  if (input.mode === 'shadow') return 'shadow';
  try { return rec(rec(rec(readConfig()).context).seatRetro).mode === 'live' ? 'live' : 'shadow'; } catch { return 'shadow'; }
}

/** 런 우주의 자리 상태 뿌리 — msg-wake `resolveSeatStateRoot` 와 같은 규칙을 «런 원장 우주»로 적용한다. */
export function seatStateRootFor(root: string): string {
  return resolve(root) === resolve(prodInstanceRoot()) ? join(homedir(), 'elanous-hq', 'seat-state') : join(root, 'seat-state');
}

/** 자리 목록 = ROLE.md 가 이미 있는 자리 폴더(주소 꼴만 · 심볼릭 링크 제외). */
export function discoverSeats(seatStateRoot: string, fs: SeatRetroFs = nodeFs): string[] {
  if (!fs.existsSync(seatStateRoot)) return [];
  return fs.readdirSync(seatStateRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && SEAT_ADDRESS.test(entry.name) && fs.existsSync(join(seatStateRoot, entry.name, 'ROLE.md')))
    .map(entry => entry.name).sort();
}

// ── 사실 모으기(구조 필드만) ─────────────────────────────────────────────
export function seatFacts(seat: string, window: { since: string; until: string }, events: readonly CoordEvent[],
  decisions: readonly DecisionEntry[], memoryItems: readonly MemoryItem[], actions: readonly DraftCell[]): SeatFacts {
  return {
    seat,
    events: events.filter(event => event.refs?.seat === seat && inWindow(event.at, window)).map(event => ({
      id: event.id, at: event.at, kind: oneLine(str(event.kind)), text: oneLine(str(event.summary)),
      link: str(event.refs.url) || str(event.refs.source) || `event:${event.id}`,
    })),
    decisions: decisions.filter(decision => decision.raisedBy?.track === seat
      && inWindow(decision.decidedAt ?? decision.raisedAt ?? decision.importedAt ?? '', window)).map(decision => ({
      id: decision.id, at: decision.decidedAt ?? decision.raisedAt ?? decision.importedAt ?? '', title: oneLine(decision.title),
      link: `decision:${decision.id}`,
    })),
    memory: memoryItems.filter(item => item.seat === seat && item.status === 'active' && inWindow(item.updatedAt, window)).map(item => ({
      project: oneLine(item.project), topic: oneLine(item.topic), summary: oneLine(item.summary), link: item.source,
    })),
    actions: actions.filter(action => action.owner === seat).map(action => ({
      id: action.id, title: oneLine(action.title), verdictLine: oneLine(action.verdictLine), evidence: action.evidence.slice(0, LIST_MAX),
    })),
  };
}

const more = (count: number): string[] => count > LIST_MAX ? [`- … 외 ${count - LIST_MAX}건`] : [];

export function retroSection(facts: SeatFacts, day: string, window: { since: string; until: string }, retroDay: string, withProposal: boolean): string {
  const total = facts.events.length + facts.decisions.length + facts.memory.length + facts.actions.length;
  const counts = `이벤트 ${facts.events.length} · 결정 ${facts.decisions.length} · 기억 ${facts.memory.length} · 회고 조치 ${facts.actions.length}`;
  const lines = [seatRetroBeginMarker(day), `## ${day} 밤 정리 (nightly-condense seat-retro · 자동)`];
  if (total === 0) lines.push(`- 사실 없음: ${counts} (창 ${window.since} ~ ${window.until}) — 빈 날을 침묵으로 두지 않는다.`);
  else {
    lines.push(`- 사실: ${counts} (창 ${window.since} ~ ${window.until})`);
    lines.push(...facts.events.slice(0, LIST_MAX).map(e => `- 이벤트 [${e.kind}] ${e.text} — ${e.link}`), ...more(facts.events.length));
    lines.push(...facts.decisions.slice(0, LIST_MAX).map(d => `- 결정 ${d.title} — ${d.link}`), ...more(facts.decisions.length));
    lines.push(...facts.memory.slice(0, LIST_MAX).map(m => `- 기억 ${m.project}/${m.topic}: ${m.summary} — ${m.link}`), ...more(facts.memory.length));
    lines.push(...facts.actions.slice(0, LIST_MAX).map(a => `- 회고 조치(retro-daily ${retroDay}) ${a.id} · ${a.title}`), ...more(facts.actions.length));
  }
  if (withProposal) lines.push(`- 역할 제안: ${roleProposalName(day)} (사람 승인 전 ROLE.md 미반영)`);
  lines.push(seatRetroEndMarker(day));
  return lines.join('\n') + '\n';
}

export function memoryBlock(facts: SeatFacts, day: string): string | null {
  if (facts.memory.length === 0) return null;
  return [seatMemoryBeginMarker(day), `## 기억 후보 ${day} (nightly-condense · 사람 확인 전 후보)`,
    ...facts.memory.slice(0, LIST_MAX).map(m => `- [후보] ${m.project}/${m.topic}: ${m.summary} · 근거 ${m.link}`.slice(0, 200)),
    ...more(facts.memory.length), seatMemoryEndMarker(day)].join('\n') + '\n';
}

export function roleProposal(facts: SeatFacts, day: string, roleSha256: string): string | null {
  if (facts.actions.length === 0) return null;
  return [`# ROLE.md 제안 — ${facts.seat} · ${day}`, '',
    PROPOSAL_OWNER_LINE,
    `기준 ROLE.md sha256: ${roleSha256}`, '', '## §3 상시 일 검토 후보 (retro-daily 조치 초안에서)',
    ...facts.actions.map(a => `- ${a.id} · ${a.title} · 판정선: ${a.verdictLine} · 근거: ${a.evidence.join(', ') || '없음'}`), ''].join('\n');
}

// ── 문서 안 블록 교체(멱등) ────────────────────────────────────────────
type Block = { begin: number; end: number };
function findBlock(text: string, beginMarker: string, endMarker: string): Block | null | 'corrupt' {
  const begin = text.indexOf(beginMarker);
  if (begin < 0) return text.includes(endMarker) ? 'corrupt' : null;
  const endAt = text.indexOf(endMarker, begin);
  if (endAt < 0 || text.indexOf(beginMarker, begin + beginMarker.length) >= 0) return 'corrupt';
  let end = endAt + endMarker.length;
  if (text[end] === '\n') end += 1;
  return { begin, end };
}
const withoutBlock = (text: string, block: Block | null): string => block ? text.slice(0, block.begin) + text.slice(block.end) : text;

/** RETRO.md — 최신이 위: H1 제목 줄 바로 아래(빈 줄 하나 뒤)에 넣는다. 같은 날 절은 제자리 교체. */
export function upsertRetroSection(before: string | undefined, section: string, day: string, seat: string): string {
  const text = before ?? `# ${seat} 자기 회고 (2시간마다 한 절 · 최신이 위)\n`;
  const block = findBlock(text, seatRetroBeginMarker(day), seatRetroEndMarker(day));
  if (block === 'corrupt') throw new Error(`RETRO.md marker for ${day} is unbalanced`);
  if (block) return text.slice(0, block.begin) + section + text.slice(block.end);
  if (text.startsWith('# ')) {
    const eol = text.indexOf('\n');
    const head = eol < 0 ? `${text}\n` : text.slice(0, eol + 1);
    const rest = eol < 0 ? '' : text.slice(eol + 1);
    return `${head}\n${section}${rest.startsWith('\n') ? '' : '\n'}${rest}`;
  }
  return `${section}\n${text}`;
}

/** MEMORY.md — 끝에 덧붙인다(앞 줄 = 색인이라 순서를 건드리지 않는다). 같은 날 블록은 제자리 교체. */
export function upsertMemoryBlock(before: string | undefined, blockText: string | null, day: string): string | undefined {
  const text = before ?? '';
  const block = findBlock(text, seatMemoryBeginMarker(day), seatMemoryEndMarker(day));
  if (block === 'corrupt') throw new Error(`MEMORY.md candidate marker for ${day} is unbalanced`);
  // 같은 날 다시 돌았는데 후보가 0 이면 그날 블록을 철회한다(현재 사실과 모순되는 후보를 남기지 않는다).
  if (blockText === null) return block ? text.slice(0, block.begin) + text.slice(block.end) : before;
  if (block) return text.slice(0, block.begin) + blockText + text.slice(block.end);
  return `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${text === '' ? '' : '\n'}${blockText}`;
}

// ── 원자 쓰기 ⊕ 비교 후 교체 ─────────────────────────────────────────────
const fileMode = (fs: SeatRetroFs, file: string, fallback = NEW_FILE_MODE): number =>
  fs.existsSync(file) ? fs.statSync(file).mode & 0o7777 : fallback;
const tmpName = (file: string): string => `${file}.seat-retro.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
/** temp 를 원래 권한으로 만든다(umask 와 무관하게 chmod) — 0600 파일이 교체 뒤 0644 가 되지 않는다. */
function writeTemp(fs: SeatRetroFs, tmp: string, text: string, mode: number): void {
  fs.writeFileSync(tmp, text, { mode });
  fs.chmodSync(tmp, mode);
}

/** 이 노드가 «소유하는» 파일(제안·day 파일)용: temp → rename. 원래 권한 보존. */
export function writeAtomic(fs: SeatRetroFs, file: string, text: string, newMode = NEW_FILE_MODE): void {
  const tmp = tmpName(file);
  try {
    writeTemp(fs, tmp, text, fileMode(fs, file, newMode));
    fs.renameSync(tmp, file);
  } catch (error) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 원본은 rename 전이라 그대로다 */ }
    throw error;
  }
}

const lineFold = (text: string): string => text.replace(/\n+/g, '\n').replace(/^\n|\n$/g, '');
const readMaybe = (fs: SeatRetroFs, file: string): string | undefined => fs.existsSync(file) ? String(fs.readFileSync(file, 'utf8')) : undefined;

const claimName = (file: string): string => `${file}.seat-retro.claim`;
const isCode = (error: unknown, code: string): boolean => (error as NodeJS.ErrnoException)?.code === code;
export const seatRetroBakDir = (file: string): string => join(dirname(file), '.seat-retro-bak');

/**
 * 원본 바이트는 지우지 않는다(#38211 REVIEW-2 ①). 치운 원본·밀려난 판은 `rename` 으로 `.seat-retro-bak/` 에
 * 시각+임의 이름으로 옮긴다 — 같은 이름을 덮지 않고, 그 inode 를 잡고 쓰던 손 편집도 그 판에 남는다. 정리(가지치기)는 후속.
 */
export function archiveOriginal(fs: SeatRetroFs, file: string, from: string, reason: string): string {
  const dir = seatRetroBakDir(file);
  fs.mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${basename(file)}.${new Date().toISOString().replace(/[:.]/g, '')}.${randomUUID().slice(0, 8)}`);
  fs.renameSync(from, dest);
  emit('original-archived', { file, from, to: dest, reason });
  return dest;
}

/** 줄 단위 «잃지 않는» 합치기: 지금 파일이 원본 줄을 모두(개수까지) 가지면 지금 파일 · 아니면 원본 뒤에 새로 생긴 줄. */
export function mergeKeepingBoth(original: string, current: string): string {
  const pool = new Map<string, number>();
  for (const line of current.split('\n')) pool.set(line, (pool.get(line) ?? 0) + 1);
  const covered = original.split('\n').every(line => {
    const left = pool.get(line) ?? 0;
    if (left === 0) return false;
    pool.set(line, left - 1);
    return true;
  });
  if (covered) return current;
  const have = new Map<string, number>();
  for (const line of original.split('\n')) have.set(line, (have.get(line) ?? 0) + 1);
  const extra = current.split('\n').filter(line => {
    const left = have.get(line) ?? 0;
    if (left > 0) { have.set(line, left - 1); return false; }
    return line !== '';
  });
  if (extra.length === 0) return original;
  return `${original}${original === '' || original.endsWith('\n') ? '' : '\n'}${extra.join('\n')}\n`;
}

/**
 * 치워 둔 원본(claim)이 남아 있으면 — 겨룸 직후든 앞 실행이 죽은 뒤든 — 원본과 지금 파일을 «둘 다 잃지 않게» 합친다.
 *   지금 파일 없음  → 원본을 link 로 되돌리고 claim 이름은 bak 으로 옮긴다.
 *   지금 파일 있음  → 합친 판을 들여놓고, 지금 판과 원본 둘 다 bak 으로 옮긴다(지우는 것 0).
 */
export function settleClaim(fs: SeatRetroFs, file: string): 'none' | 'restored' | 'kept-current' | 'merged' {
  const claim = claimName(file);
  if (!fs.existsSync(claim)) return 'none';
  if (!fs.existsSync(file)) {
    try {
      fs.linkSync(claim, file);
      archiveOriginal(fs, file, claim, 'restored');
      return 'restored';
    } catch (error) { if (!isCode(error, 'EEXIST')) throw error; }
  }
  const original = String(fs.readFileSync(claim, 'utf8'));
  const current = String(fs.readFileSync(file, 'utf8'));
  const merged = mergeKeepingBoth(original, current);
  if (merged === current) {
    archiveOriginal(fs, file, claim, 'superseded');
    return 'kept-current';
  }
  const tmp = tmpName(file);
  writeTemp(fs, tmp, merged, fs.statSync(claim).mode & 0o7777);
  archiveOriginal(fs, file, file, 'contended-current');
  try { fs.linkSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  archiveOriginal(fs, file, claim, 'contended-original');
  emit('contention-merged', { file }, 'error');
  return 'merged';
}

/**
 * 손 편집과 겨루는 자리 파일(RETRO.md·MEMORY.md)용 비교 후 교체. 덮어쓰는 rename 을 쓰지 않는다:
 *   ① 원본을 `.seat-retro.claim` 으로 치운다(rename · 원자) → ② 치운 내용이 읽은 내용과 같은지 본다
 *      (다르면 = 그 사이 손 편집 → settleClaim 으로 되돌리고 다시 만든다) → ③ 새 내용을 `link` 로 들여놓는다
 *      (그 사이 누가 파일을 새로 만들었으면 EEXIST — 덮지 않고 settleClaim 으로 합친 뒤 다시 만든다)
 *   → ④ 치운 원본은 지우지 않고 bak 으로 옮긴다.
 * 지우는 것은 이 노드가 만든 temp 뿐이다. 불변식: 표식 블록 밖의 바이트는 그대로다. 원래 권한을 보존한다.
 */
export function compareAndSwap(fs: SeatRetroFs, file: string, build: (before: string | undefined) => string | undefined,
  outside: (text: string) => string): 'written' | 'unchanged' {
  const claim = claimName(file);
  for (let attempt = 0; attempt < CAS_TRIES; attempt += 1) {
    settleClaim(fs, file);
    const before = readMaybe(fs, file);
    const next = build(before);
    if (next === before || next === undefined) return 'unchanged';
    // 빈 줄 개수만 다를 수 있다(블록 앞뒤 구분 줄). 그 밖의 바이트가 하나라도 빠지면 거부한다.
    if (before !== undefined && lineFold(outside(next)) !== lineFold(outside(before))) throw new Error(`refusing to rewrite outside the seat-retro block: ${file}`);
    const tmp = tmpName(file);
    let claimed = false;
    try {
      writeTemp(fs, tmp, next, fileMode(fs, file));
      if (before !== undefined) {
        try { fs.renameSync(file, claim); } catch (error) { if (isCode(error, 'ENOENT')) { fs.unlinkSync(tmp); continue; } throw error; }
        claimed = true;
        if (String(fs.readFileSync(claim, 'utf8')) !== before) {
          // 읽은 뒤 손 편집이 들어왔다 — 그 판을 되돌려(합쳐) 놓고 그 위에서 다시 만든다.
          fs.unlinkSync(tmp);
          claimed = false;
          settleClaim(fs, file);
          continue;
        }
      }
      try { fs.linkSync(tmp, file); }
      catch (error) {
        if (!isCode(error, 'EEXIST')) throw error;
        // 치운 사이에 누가 파일을 새로 만들었다(예: `>>` 한 줄) — 덮지 않는다. 원본과 그 줄을 합친 뒤 다시 만든다.
        fs.unlinkSync(tmp);
        claimed = false;
        settleClaim(fs, file);
        continue;
      }
      fs.unlinkSync(tmp);
      if (claimed) archiveOriginal(fs, file, claim, 'swapped');
      return 'written';
    } catch (error) {
      // 원본을 치운 채 실패했으면 되돌린다(link · 원본 bak 보관). 못 되돌리면 claim 이 남아 다음 실행의 settleClaim 이 되돌린다.
      try { if (claimed) settleClaim(fs, file); } catch { /* claim 은 그대로 남는다 — 지우지 않는다 */ }
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* temp 는 원본이 아니다 */ }
      throw error;
    }
  }
  throw new Error(`concurrent edits kept changing ${file}`);
}

// ── 아침 카드 ──────────────────────────────────────────────────────────
export function morningLines(results: ReadonlyArray<{ facts: SeatFacts; retroLink: string | null }>): MorningLine[] {
  return results
    .map(({ facts, retroLink }) => ({ facts, retroLink, weight: facts.memory.length + facts.actions.length + facts.decisions.length + facts.events.length }))
    .filter(row => row.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.facts.seat.localeCompare(b.facts.seat))
    .map(({ facts, retroLink }) => {
      const firstFact = facts.memory[0]?.link ?? facts.actions[0]?.evidence[0] ?? facts.decisions[0]?.link ?? facts.events[0]?.link;
      const evidence = [retroLink, firstFact].filter((link): link is string => Boolean(link)).slice(0, 2);
      return { seat: facts.seat, evidence,
        text: `${facts.seat}: 이벤트 ${facts.events.length}·결정 ${facts.decisions.length}·기억 ${facts.memory.length}·회고 조치 ${facts.actions.length} → RETRO 절` };
    })
    .filter(line => line.evidence.length > 0)
    .slice(0, SEAT_RETRO_MORNING_MAX_LINES);
}

/** OP 아침 카드 입력 — live 로 쓴 day 파일만 읽는다(shadow 는 카드에 안 나간다). 줄 ≤2 · 줄마다 근거 링크 ≥1. */
export function seatRetroMorningCard(root: string, day: string, fs: SeatRetroFs = nodeFs): { title: string; lines: MorningLine[] } | null {
  try {
    const file = rec(JSON.parse(String(fs.readFileSync(seatRetroDayFile(root, day), 'utf8'))));
    const card = rec(file.morningCard);
    if (file.briefing !== true || !Array.isArray(card.lines)) return null;
    const lines = card.lines.map(rec).map(line => ({ seat: str(line.seat), text: str(line.text),
      evidence: Array.isArray(line.evidence) ? line.evidence.map(str).filter(Boolean) : [] }))
      .filter(line => line.text && line.evidence.length > 0).slice(0, SEAT_RETRO_MORNING_MAX_LINES);
    return { title: SEAT_RETRO_CARD_TITLE, lines };
  } catch { return null; }
}

// ── 노드 실행 ─────────────────────────────────────────────────────────
/**
 * 사실 창 = collect 가 낸 로컬 하루 창(`window` · #38187 의 nightlyWindow) 그대로. 없으면 null.
 * ⛔ UTC 하루 창으로 대신하지 않는다 — KST 하루를 UTC 로 자르면 KST 00:00~09:00 사실이 조용히 빠진다.
 */
export function collectWindow(collect: Record<string, unknown>): { since: string; until: string } | null {
  const window = rec(collect.window);
  const since = Date.parse(str(window.since));
  const until = Date.parse(str(window.until));
  return Number.isFinite(since) && Number.isFinite(until) && since < until ? { since: str(window.since), until: str(window.until) } : null;
}

function readRetroActions(fs: SeatRetroFs, root: string, retroDay: string): { status: 'read' | 'absent' | 'unreadable'; actions: DraftCell[] } {
  const file = retroDayFile(root, retroDay);
  if (!fs.existsSync(file)) return { status: 'absent', actions: [] };
  try {
    const actions = rec(JSON.parse(String(fs.readFileSync(file, 'utf8')))).actions;
    // 스키마가 어긋나면(조치 배열 없음 · id/owner 없는 조치) 빈 조치로 «조용히» 읽지 않는다.
    if (!Array.isArray(actions) || !actions.every(a => str(rec(a).id) && str(rec(a).owner))) return { status: 'unreadable', actions: [] };
    return { status: 'read', actions: actions.map(rec).map(a => ({
      id: str(a.id), theme: str(a.theme), title: str(a.title), owner: str(a.owner), verdictLine: str(a.verdictLine),
      falsifier: str(a.falsifier), evidence: Array.isArray(a.evidence) ? a.evidence.map(str).filter(Boolean) : [], status: 'draft' as const,
    })) };
  } catch { return { status: 'unreadable', actions: [] }; }
}

export async function runSeatRetroStage(ctx: Ctx, root: string, dryRun: boolean, deps: SeatRetroDeps = {}): Promise<Record<string, unknown>> {
  const fs = deps.fs ?? nodeFs;
  const now = deps.now ?? new Date();
  const input = ctx.input ?? {};
  const collect = ctx.outputs.collect ?? {};
  const record = ctx.outputs.record ?? {};
  const day = str(collect.day) || str(input.day);
  if (!DAY.test(day)) throw new Error('seat-retro: collect day missing');
  if (!Array.isArray(collect.events) || !Array.isArray(collect.decisions)) throw new Error('seat-retro: collect output missing');
  if (!Array.isArray(record.memoryItems)) throw new Error('seat-retro: record output missing');
  const mode = resolveSeatRetroMode(input, deps.readConfig ?? (() => ({})));
  const window = collectWindow(collect);
  if (!window) {
    // 로컬 하루 창을 모르면 사실을 고르지 않는다 — 크게 알리고 아무것도 쓰지 않는다(조용한 0 금지). 다음 노드는 막지 않는다.
    emit('skip', { day, reason: 'collect-window-missing' }, 'error');
    return { outcome: 'ok', day, mode, dryRun, skipped: 'collect-window-missing', file: null, seats: [], failedSeats: [] };
  }
  const seatRoot = deps.seatStateRoot ?? seatStateRootFor(root);
  const retroDay = DAY.test(str(input.retroDay)) ? str(input.retroDay) : day;
  const retro = readRetroActions(fs, root, retroDay);
  // 자리 목록·잠금 실패는 이 노드 안에서 크게 알리고 끝낸다 — 노드 예외로 올리면 그래프가 failed 가 되어
  // 다음 노드(conflict-candidates)까지 막힌다.
  let seats: string[] = [];
  let seatListError: string | undefined;
  try { seats = discoverSeats(seatRoot, fs); } catch (error) { seatListError = errorText(error); }
  const write = mode === 'live' && !dryRun;
  emit('start', { day, mode, dryRun, seatRoot, seats: seats.length, retroDaily: { day: retroDay, status: retro.status } });
  if (retro.status === 'unreadable') emit('retro-daily-unreadable', { day, retroDay, file: retroDayFile(root, retroDay) }, 'error');
  if (seatListError) emit('skip', { day, reason: 'seat-list-unreadable', seatRoot, error: seatListError }, 'error');
  else if (seats.length === 0) emit('skip', { day, reason: 'no-seats-with-role', seatRoot }, 'error');

  let lock: Awaited<ReturnType<typeof acquireLockAsync>> | null = null;
  let lockError: string | undefined;
  if (write && seats.length > 0) {
    try { lock = await (deps.acquireLock ?? acquireLockAsync)(join(seatRoot, '.seat-retro.lock')); }
    catch (error) {
      lockError = errorText(error);
      emit('skip', { day, reason: 'lock-unavailable', seatRoot, error: lockError }, 'error');
    }
  }
  const results: SeatResult[] = [];
  const cardInput: Array<{ facts: SeatFacts; retroLink: string | null }> = [];
  try {
    for (const seat of seats) {
      const facts = seatFacts(seat, window, collect.events as CoordEvent[], collect.decisions as DecisionEntry[],
        record.memoryItems as MemoryItem[], retro.actions);
      const counts = { events: facts.events.length, decisions: facts.decisions.length, memory: facts.memory.length, actions: facts.actions.length };
      const dir = join(seatRoot, seat);
      const retroFile = join(dir, 'RETRO.md');
      const result: SeatResult = { seat, counts, retro: write ? 'unchanged' : 'shadow', memory: 'none', proposal: 'none', roleSha256: null };
      if (counts.events + counts.decisions + counts.memory + counts.actions === 0) emit('seat-empty', { day, seat, window });
      try {
        if (lockError) throw new Error(`seat-retro write lock unavailable: ${lockError}`);
        if (lock && !lock.stillHeld()) throw new Error('seat-retro write lock lost');
        const roleBytes = fs.readFileSync(join(dir, 'ROLE.md'));
        result.roleSha256 = sha256(roleBytes);
        const proposal = roleProposal(facts, day, result.roleSha256);
        const section = retroSection(facts, day, window, retroDay, proposal !== null);
        const memory = memoryBlock(facts, day);
        if (!write) {
          result.memory = memory ? 'shadow' : 'none';
          result.proposal = proposal ? 'shadow' : 'none';
        } else {
          const proposalFile = join(dir, roleProposalName(day));
          const proposalBefore = readMaybe(fs, proposalFile);
          if (proposal) {
            if (proposalBefore === proposal) result.proposal = 'unchanged';
            else {
              // 앞 판(사람이 고쳤을 수도 있다)은 덮지 않고 bak 으로 옮긴 뒤 새 판을 쓴다.
              if (proposalBefore !== undefined) archiveOriginal(fs, proposalFile, proposalFile, 'proposal-replaced');
              writeAtomic(fs, proposalFile, proposal, fileMode(fs, join(dir, 'ROLE.md')));
              result.proposal = 'written';
            }
          } else if (proposalBefore !== undefined && proposalBefore.split('\n')[2] === PROPOSAL_OWNER_LINE) {
            // 같은 날 다시 돌았는데 이 자리 조치가 0 이면 이 노드가 쓴 그날 제안을 철회한다(손으로 쓴 파일은 건드리지 않는다).
            archiveOriginal(fs, proposalFile, proposalFile, 'retracted');
            result.proposal = 'retracted';
          }
          result.retro = compareAndSwap(fs, retroFile, before => upsertRetroSection(before, section, day, seat),
            text => withoutBlock(text, findBlock(text, seatRetroBeginMarker(day), seatRetroEndMarker(day)) as Block | null));
          const memoryWrite = compareAndSwap(fs, join(dir, 'MEMORY.md'), before => upsertMemoryBlock(before, memory, day),
            text => withoutBlock(text, findBlock(text, seatMemoryBeginMarker(day), seatMemoryEndMarker(day)) as Block | null));
          result.memory = memoryWrite === 'unchanged' ? (memory ? 'unchanged' : 'none') : memory ? 'written' : 'retracted';
          if (sha256(fs.readFileSync(join(dir, 'ROLE.md'))) !== result.roleSha256) throw new Error('ROLE.md changed during seat-retro');
        }
        cardInput.push({ facts, retroLink: write ? `file://${retroFile}` : null });
      } catch (error) {
        result.error = errorText(error);
        if (result.retro !== 'written') result.retro = 'error';
        emit('seat-failed', { day, seat, error: result.error }, 'error');
      }
      results.push(result);
    }
  } finally { lock?.release(); }

  const lines = morningLines(cardInput);
  const dayFile: SeatRetroDay = { day, mode, briefing: write, generatedAt: now.toISOString(), window,
    retroDaily: { day: retroDay, status: retro.status }, seats: results, morningCard: { title: SEAT_RETRO_CARD_TITLE, lines } };
  const file = seatRetroDayFile(root, day);
  let dayFileError: string | undefined;
  if (!dryRun) {
    // 자리 파일은 이미 끝났다. day 파일(아침 카드 입력)만 못 쓰면 크게 알리고 다음 노드(conflict-candidates)는 막지 않는다.
    try {
      fs.mkdirSync(join(root, 'context-memory'), { recursive: true });
      writeAtomic(fs, file, JSON.stringify(dayFile, null, 2) + '\n');
    } catch (error) {
      dayFileError = errorText(error);
      emit('day-file-failed', { day, file, error: dayFileError }, 'error');
    }
  }
  emit('morning-card', { day, mode, briefing: write && !dayFileError, title: SEAT_RETRO_CARD_TITLE, lines });
  const failed = results.filter(r => r.error).map(r => r.seat);
  emit('done', { day, mode, dryRun, seats: results.length, failed });
  return { outcome: 'ok', day, mode, dryRun, file: dryRun || dayFileError ? null : file, seats: results, failedSeats: failed,
    ...(dayFileError ? { dayFileError } : {}), ...(seatListError ? { seatListError } : {}), ...(lockError ? { lockError } : {}), retroDaily: dayFile.retroDaily, morningCard: dayFile.morningCard };
}

if (import.meta.main) {
  const path = process.env.ELANOUS_GRAPH_CONTEXT;
  if (!path || process.argv[2] !== SEAT_RETRO_NODE_ID) throw new Error('invalid seat-retro graph stage');
  const ctx = JSON.parse(nodeFs.readFileSync(path, 'utf8')) as Ctx;
  if (ctx.graphId !== SEAT_RETRO_GRAPH_ID || ctx.nodeId !== SEAT_RETRO_NODE_ID) throw new Error('seat-retro graph context mismatch');
  // <root>/graph-runs/<graphId>/<runId>.json.contexts/<n>.json — 런 원장의 우주가 곧 자리 상태의 우주다.
  const root = resolve(path, '..', '..', '..', '..');
  const { getUserConfig } = await import('../user-config/reader.js');
  console.log(JSON.stringify(await runSeatRetroStage(ctx, root, process.env.ELANOUS_GRAPH_DRY_RUN === '1',
    { readConfig: () => getUserConfig().raw })));
}
