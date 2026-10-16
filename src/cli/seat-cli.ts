import type { Command } from 'commander';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactSecretText } from '../debug/log.js';
import { defaultMsgStorePath, readUnreadCount } from '../msg/msg-store.js';
import { parseKnowhowItems, splitKnowhow } from '../seat-loop/seat-knowhow.js';

export const SEAT_ROLES = ['OP', 'TC', 'MK', 'UX'] as const;
export type SeatRole = typeof SEAT_ROLES[number];
export const SEAT_AGENTS = ['codex', 'elanous', 'claude'] as const;
export type SeatAgent = typeof SEAT_AGENTS[number];
export const SEAT_QUICKSTART_MANUAL = join('docs', 'manual', 'MANUAL-seat-agent-quickstart-2026-10-12.md');
export const SEAT_TRUST_LADDER = '신뢰 사다리: 지시 > 코드 > 문서 > 기억 — 어긋나면 앞이 이긴다';
export const SEAT_TACIT_TOP_N = 5;

const MAX_FIELD = 160;
const MAX_ROWS = 12;
const clean = (value: unknown): string => redactSecretText(String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim()).slice(0, MAX_FIELD);
const safeObject = (value: unknown, keys: readonly string[]): Record<string, string> => {
  const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return Object.fromEntries(keys.filter(key => source[key] !== undefined && source[key] !== null).map(key => [key, clean(source[key])]));
};

function isRegularSeatPath(home: string, root: string, path: string): boolean {
  const suffix = relative(root, path);
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || suffix.startsWith(sep)) return false;
  if (!lstatSync(home).isDirectory()) return false;
  let parent = home;
  for (const part of relative(home, dirname(path)).split(sep).filter(Boolean)) {
    parent = join(parent, part);
    if (!lstatSync(parent).isDirectory()) return false;
  }
  return lstatSync(path).isFile();
}

function metadata(home: string, root: string, path: string, kind: 'markdown' | 'tsv' | 'memory'): { source: string; updated: string; rows: string[]; reason?: string } {
  if (!existsSync(path)) return { source: path, updated: '미상', rows: [], reason: '미관측: 파일 없음' };
  try {
    if (!isRegularSeatPath(home, root, path)) return { source: path, updated: '미상', rows: [], reason: '미관측: 일반 경로가 아님' };
    const updated = statSync(path).mtime.toISOString();
    const text = readFileSync(path, 'utf8').slice(0, 256_000);
    let rows: string[] = [];
    if (kind === 'tsv') {
      const headers = (text.split(/\r?\n/, 1)[0] ?? '').split('\t');
      const allowed = kind === 'tsv' && path.endsWith('harvest-claims.tsv') ? ['pr', 'claimer', 'at', 'status'] : ['at', 'what', 'then'];
      const indexes = allowed.map(key => headers.indexOf(key));
      rows = text.split(/\r?\n/).slice(1).filter(Boolean).slice(0, MAX_ROWS).map(line => {
        const cells = line.split('\t');
        return allowed.map((key, i) => indexes[i] < 0 ? '' : `${key}=${clean(cells[indexes[i]])}`).filter(Boolean).join(' · ');
      }).filter(Boolean);
    } else if (kind === 'memory') {
      rows = text.split(/\r?\n/).filter(line => /^#{1,6}\s/.test(line)).slice(0, MAX_ROWS).map(line => clean(line.replace(/^#+\s*/, '')));
    } else {
      rows = text.split(/\r?\n/).filter(line => (/^#{1,6}\s/.test(line) || /^(?:[-*]\s*)?(?:from|발신|시각|at)\s*[:：]/i.test(line)) && !/[`$;|<>]/.test(line)).slice(0, MAX_ROWS).map(line => {
        const from = line.match(/^(?:[-*]\s*)?(?:from|발신)\s*[:：]\s*(OP|TC|MK|UX)\b/i);
        if (/^(?:[-*]\s*)?(?:from|발신)\s*[:：]/i.test(line)) return from ? `From: ${from[1]!.toUpperCase()}` : '';
        return clean(line.replace(/^#{1,6}\s*/, ''));
      }).filter(Boolean);
    }
    return { source: path, updated, rows, ...(rows.length ? {} : { reason: '미관측: 허용된 메타데이터 없음' }) };
  } catch {
    return { source: path, updated: '미상', rows: [], reason: '미관측: 읽기 실패' };
  }
}

function contextFacts(snapshot: unknown): string[] {
  const root = snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot as Record<string, unknown> : {};
  const facts: string[] = [];
  const sourceFacts = Array.isArray(root.facts) ? root.facts as unknown[] : [];
  for (const item of sourceFacts.slice(0, MAX_ROWS)) {
    const value = item !== null && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const keys = value.kind === 'cell' ? ['id', 'status', 'owner', 'version', 'source']
      : value.kind === 'seat' ? ['seat', 'at', 'status', 'id', 'source']
      : value.kind === 'run' ? ['phase', 'elapsed', 'source'] : [];
    const values = safeObject(value, keys);
    if (Object.keys(values).length) facts.push(`${clean(value.kind)}: ${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  }
  const sourceEvents = Array.isArray(root.events) ? root.events as unknown[] : [];
  for (const item of sourceEvents.slice(0, MAX_ROWS)) {
    const values = safeObject(item, ['at', 'kind', 'source', 'summary']);
    if (Object.keys(values).length) facts.push(`event: ${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  }
  return facts.slice(0, MAX_ROWS);
}

export type SeatBootSection = { title: string; source: string; updated: string; rows: readonly string[]; reason?: string };

/** `facts === null` 이면 contextNow 절을 «생략»한다(TUI 부트 카드 — 턴 경로에서 버스를 안 읽는다). */
export function renderSeatBootCard(seat: string, sections: ReadonlyArray<SeatBootSection>, facts: readonly string[] | null, contextUpdated = '미상'): string {
  const out = facts === null
    ? [`# ${seat} 자리 부팅 카드`]
    : [`# ${seat} 자리 부팅 카드`, '', '## 현재 구조화 관측', '출처: elanous://context-now', `갱신: ${clean(contextUpdated)}`, ...(facts.length ? facts.map(row => `- ${clean(row)}`) : ['- 미관측: contextNow 구조화 facts/events 없음'])];
  for (const section of sections) out.push('', `## ${section.title}`, `출처: ${clean(section.source)}`, `갱신: ${clean(section.updated)}`, ...(section.rows.length ? section.rows.map(row => `- ${clean(row)}`) : [`- ${clean(section.reason ?? '미관측')}`]));
  return out.join('\n');
}

/** 자리 카드의 파일·우편 절(동기) — `eln seat boot` 와 TUI 세션 부트(`dashboard/seat-boot-preamble.ts`)가 같이 쓴다. */
export function collectSeatBootSections(seat: string, options: { home: string; msgPath: string }): { sections: SeatBootSection[]; unread: number | null } {
  const root = join(options.home, 'elanous-hq', 'seat-state');
  const seatDir = join(root, seat);
  let unread: number | null = null;
  try { unread = readUnreadCount(seat, options.msgPath); }
  catch { /* unavailable is not a measured zero */ }
  const sections: SeatBootSection[] = [
    { title: 'msg 원장', source: options.msgPath, updated: unread === null ? '미상' : new Date().toISOString(), rows: [`안 읽은 msg ${unread ?? '미관측'} (${seat})`] },
    { title: 'HANDOFF', ...metadata(options.home, root, join(seatDir, 'HANDOFF.md'), 'markdown') },
    { title: 'inbox', ...metadata(options.home, root, join(seatDir, 'inbox.md'), 'markdown') },
    { title: '수확 주장', ...metadata(options.home, root, join(seatDir, 'harvest-claims.tsv'), 'tsv') },
    { title: '예약', ...metadata(options.home, root, join(seatDir, 'scheduled.tsv'), 'tsv') },
    { title: '공통 메모리 색인', ...metadata(options.home, root, join(root, 'memory', 'MEMORY.md'), 'memory') },
  ];
  return { sections, unread };
}

/** 표 줄을 칸으로 — 백틱 안의 `|`(예: `<pass|fail>`)는 칸 경계가 아니다. */
const cells = (line: string): string[] => (line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').match(/(?:`[^`]*`|[^|`])+|(?<=\|)(?=\|)/g) ?? []).map(cell => cell.trim());
const backticked = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map(match => match[1]!);

/** L1 — 빠른 길 매뉴얼의 «무엇을 하려면 → 명령» 표를 고른 에이전트용 한 줄씩으로 접는다. ⚠️ 주석은 다른 에이전트만 이름 대면 뺀다. */
export function assembleSeatQuickPath(manual: string, agent: SeatAgent): string[] {
  const lines = manual.split(/\r?\n/);
  const start = lines.findIndex(line => /^##\s.*무엇.*명령/.test(line));
  if (start < 0) return [];
  const rows: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    if (!line.trim().startsWith('|') || /^\s*\|\s*-/.test(line)) continue;
    const [what = '', command = '', dont = ''] = cells(line);
    if (!what || what === '하려는 것') continue;
    const segments = command.split(' · ').filter(segment => {
      if (!segment.trim().startsWith('⚠️')) return true;
      const named = SEAT_AGENTS.filter(name => new RegExp(`\\b${name}\\b`, 'i').test(segment));
      return named.length === 0 || named.includes(agent);
    });
    const commands = segments.flatMap(segment => segment.trim().startsWith('⚠️') ? [segment.replace(/[`*]/g, '').trim()] : backticked(segment));
    rows.push(`${what.replace(/\*\*/g, '')} → ${commands.join(' · ') || '미관측: 명령 없음'}${dont ? ` ⛔ ${dont.replace(/\*\*/g, '')}` : ''}`);
  }
  return rows;
}

export type SeatMemoryEntry = { title: string; hook: string; updated: string };
type TacitCandidate = { label: string; details?: string[]; updated: string; hits: number; index: number };

const tokens = (text: string): Set<string> => new Set(text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean));
const hitsOf = (text: string, query: Set<string>): number => [...tokens(text)].filter(token => query.has(token)).length;
/** 최근(날짜) 먼저, 같은 날이면 적중(질의 낱말 겹침) 많은 것, 그다음 원래 순서. */
const recentThenHits = (a: TacitCandidate, b: TacitCandidate): number => b.updated.slice(0, 10).localeCompare(a.updated.slice(0, 10)) || b.hits - a.hits || a.index - b.index;

/** 제목 이외의 운영 지침을 보존한다. 상태·검증은 분류에 이미 반영되어 중복 표시하지 않는다. */
function knowhowDetails(text: string, prefix: string): string[] {
  return text.split(/\r?\n/).slice(1)
    .filter(line => line.trim() && !/^\s*-\s*(?:상태|검증)\s*:/.test(line))
    .flatMap(line => (line.trim().match(/.{1,140}/gu) ?? []).map(part => `${prefix} ↳ ${part}`));
}

/** L3 — 최근 문서 상위 5개는 본문까지, 기억은 상위 N을 보인다. 절별 출력 하드 캡은 없다. */
export function assembleSeatTacitKnowledge(input: { seat: string; agent: SeatAgent; knowhow: string; memories: readonly SeatMemoryEntry[]; now: Date; limit?: number }): string[] {
  const limit = Math.max(0, input.limit ?? SEAT_TACIT_TOP_N);
  const query = tokens(`${input.seat} ${input.agent}`);
  const { facts, refs } = splitKnowhow(parseKnowhowItems(input.knowhow, input.seat), input.now);
  const knowhow = [...facts, ...refs].map((item, index): TacitCandidate => {
    const prefix = `[문서${facts.includes(item) ? '' : '·검증 안 됨'}]`;
    const title = (item.text.split('\n', 1)[0] ?? '').replace(/^##\s*/, '');
    return {
      label: `${prefix} ${title}`,
      details: knowhowDetails(item.text, prefix),
      updated: item.verifiedAt?.toISOString() ?? '',
      hits: hitsOf(item.text, query),
      index,
    };
  }).sort(recentThenHits);
  const memories = input.memories.map((entry, index): TacitCandidate => ({
    label: `[기억] ${entry.title}${entry.hook ? ` — ${entry.hook}` : ''} (갱신 ${entry.updated.slice(0, 10) || '미상'})`,
    updated: entry.updated,
    hits: hitsOf(`${entry.title} ${entry.hook}`, query),
    index,
  })).sort(recentThenHits).slice(0, limit);
  const visibleKnowhow = knowhow.slice(0, SEAT_TACIT_TOP_N);
  const omittedKnowhow = knowhow.length - visibleKnowhow.length;
  return [SEAT_TRUST_LADDER,
    ...visibleKnowhow.flatMap(row => [row.label, ...(row.details ?? [])]),
    ...(omittedKnowhow ? [`[문서] 나머지 ${omittedKnowhow}항목은 원문 KNOWHOW 참고`] : []),
    ...memories.map(row => row.label)];
}

/** 저장소 안 일반 파일만 읽는다 — 링크가 저장소 밖을 가리키면 없는 것으로 친다. */
function readRepoDoc(repoRoot: string, path: string): { updated: string; text: string } | null {
  try {
    const suffix = relative(realpathSync(repoRoot), realpathSync(path));
    if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || suffix.startsWith(sep)) return null;
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    return { updated: stat.mtime.toISOString(), text: readFileSync(path, 'utf8').slice(0, 256_000) };
  } catch { return null; }
}

function memoryEntries(home: string, root: string): { entries: SeatMemoryEntry[]; reason?: string } {
  const dir = join(root, 'memory');
  const index = join(dir, 'MEMORY.md');
  try {
    if (!existsSync(index)) return { entries: [], reason: '미관측: 기억 색인 파일 없음' };
    if (!isRegularSeatPath(home, root, index)) return { entries: [], reason: '미관측: 기억 색인이 일반 경로가 아님' };
    const entries = readFileSync(index, 'utf8').slice(0, 256_000).split(/\r?\n/).flatMap(line => {
      const match = line.match(/^-\s*\[([^\]]+)\]\(([^)]+)\)\s*(?:[—-]\s*(.*))?$/);
      if (!match) return [];
      const file = join(dir, match[2]!);
      try {
        if (!existsSync(file) || !isRegularSeatPath(home, root, file)) return [];
        return [{ title: match[1]!, hook: match[3] ?? '', updated: statSync(file).mtime.toISOString() }];
      } catch { return []; }
    });
    return entries.length ? { entries } : { entries, reason: '미관측: 기억 색인에 읽을 항목 없음' };
  } catch { return { entries: [], reason: '미관측: 기억 색인 읽기 실패' }; }
}

/** L1·L3 절 — `--agent` 를 줬을 때만 L0 카드 뒤에 붙는다. */
export function collectSeatLadderSections(seat: string, agent: SeatAgent, options: { home: string; repoRoot: string; now: Date }): SeatBootSection[] {
  const manualPath = join(options.repoRoot, SEAT_QUICKSTART_MANUAL);
  const manual = readRepoDoc(options.repoRoot, manualPath);
  const quick = manual ? assembleSeatQuickPath(manual.text, agent) : [];
  const knowhowPath = join(options.repoRoot, 'docs', 'roles', seat, 'KNOWHOW.md');
  const knowhow = readRepoDoc(options.repoRoot, knowhowPath);
  const root = join(options.home, 'elanous-hq', 'seat-state');
  const memories = memoryEntries(options.home, root);
  const tacit = assembleSeatTacitKnowledge({ seat, agent, knowhow: knowhow?.text ?? '', memories: memories.entries, now: options.now });
  const docs = tacit.filter(row => row.startsWith('[문서'));
  const remembered = tacit.filter(row => row.startsWith('[기억]'));
  const tacitRows = [
    SEAT_TRUST_LADDER,
    ...(docs.length ? docs : [knowhow ? '미관측: KNOWHOW 에 읽을 항목 없음' : '미관측: KNOWHOW 파일 없음']),
    ...(remembered.length ? remembered : [memories.reason ?? '미관측: 기억 없음']),
  ];
  return [
    { title: `L1 빠른 길 (${agent})`, source: manualPath, updated: manual?.updated ?? '미상', rows: quick, ...(quick.length ? {} : { reason: manual ? '미관측: «무엇→명령» 표 없음' : '미관측: 파일 없음' }) },
    { title: `L3 암묵지 (${agent})`, source: `${knowhowPath} ⊕ ${join(root, 'memory', 'MEMORY.md')}`, updated: knowhow?.updated ?? '미상', rows: tacitRows },
  ];
}

export function registerSeatBootCommands(command: Command, options: { home?: () => string; contextNow?: () => unknown; msgPath?: () => string; repoRoot?: () => string; now?: () => Date } = {}): void {
  command.command('boot <seat>').description('현재 자리 카드 — 허용된 메타데이터만 읽기 전용 표시')
    .option('--agent <agent>', '에이전트(codex|elanous|claude) — 주면 L1 빠른 길 ⊕ L3 암묵지를 붙인다')
    .action(async (rawSeat: string, flags: { agent?: string }) => {
      const seat = rawSeat.toUpperCase();
      if (!(SEAT_ROLES as readonly string[]).includes(seat)) { console.error(`seat boot: unknown seat ${rawSeat} (OP|TC|MK|UX)`); process.exitCode = 2; return; }
      const agent = flags.agent?.toLowerCase();
      if (agent !== undefined && !(SEAT_AGENTS as readonly string[]).includes(agent)) { console.error(`seat boot: unknown agent ${flags.agent} (codex|elanous|claude)`); process.exitCode = 2; return; }
      const home = options.home?.() ?? homedir();
      let facts: string[] = [];
      let contextUpdated = '미상';
      try {
        const snapshot = options.contextNow ? options.contextNow() : await (async () => {
          const mod = await import('../context-bus/context-now.js');
          return (mod.contextNow as unknown as (options: { audience: string }) => unknown)({ audience: 'operator' });
        })();
        const context = snapshot !== null && typeof snapshot === 'object' ? snapshot as Record<string, unknown> : {};
        contextUpdated = typeof context.at === 'string' ? clean(context.at) : '시각 미관측';
        facts = contextFacts(snapshot);
      } catch { facts = []; contextUpdated = '미관측: contextNow 조회 실패'; }
      const sections = collectSeatBootSections(seat, { home, msgPath: options.msgPath?.() ?? defaultMsgStorePath() }).sections;
      if (agent !== undefined) sections.push(...collectSeatLadderSections(seat, agent as SeatAgent, { home, repoRoot: options.repoRoot?.() ?? fileURLToPath(new URL('../../', import.meta.url)), now: options.now?.() ?? new Date() }));
      console.log(renderSeatBootCard(seat as SeatRole, sections, facts, contextUpdated));
    });
}

