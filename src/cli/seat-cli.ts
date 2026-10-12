import type { Command } from 'commander';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { redactSecretText } from '../debug/log.js';
import { defaultMsgStorePath, readUnreadCount } from '../msg/msg-store.js';

export const SEAT_ROLES = ['OP', 'TC', 'MK', 'UX'] as const;
export type SeatRole = typeof SEAT_ROLES[number];

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

export function renderSeatBootCard(seat: SeatRole, sections: ReadonlyArray<{ title: string; source: string; updated: string; rows: readonly string[]; reason?: string }>, facts: readonly string[], contextUpdated = '미상'): string {
  const out = [`# ${seat} 자리 부팅 카드`, '', '## 현재 구조화 관측', '출처: elanous://context-now', `갱신: ${clean(contextUpdated)}`, ...(facts.length ? facts.map(row => `- ${clean(row)}`) : ['- 미관측: contextNow 구조화 facts/events 없음'])];
  for (const section of sections) out.push('', `## ${section.title}`, `출처: ${clean(section.source)}`, `갱신: ${clean(section.updated)}`, ...(section.rows.length ? section.rows.map(row => `- ${clean(row)}`) : [`- ${clean(section.reason ?? '미관측')}`]));
  return out.join('\n');
}

export function registerSeatBootCommands(command: Command, options: { home?: () => string; contextNow?: () => unknown; msgPath?: () => string } = {}): void {
  command.command('boot <seat>').description('현재 자리 카드 — 허용된 메타데이터만 읽기 전용 표시')
    .action(async (rawSeat: string) => {
      const seat = rawSeat.toUpperCase();
      if (!(SEAT_ROLES as readonly string[]).includes(seat)) { console.error(`seat boot: unknown seat ${rawSeat} (OP|TC|MK|UX)`); process.exitCode = 2; return; }
      const home = options.home?.() ?? homedir();
      const root = join(home, 'elanous-hq', 'seat-state');
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
      const seatDir = join(root, seat);
      const msgPath = options.msgPath?.() ?? defaultMsgStorePath();
      let unread: number | null = null;
      try { unread = readUnreadCount(seat, msgPath); }
      catch { /* unavailable is not a measured zero */ }
      const sections = [
        { title: 'msg 원장', source: msgPath, updated: unread === null ? '미상' : new Date().toISOString(), rows: [`안 읽은 msg ${unread ?? '미관측'} (${seat})`] },
        { title: 'HANDOFF', ...metadata(home, root, join(seatDir, 'HANDOFF.md'), 'markdown') },
        { title: 'inbox', ...metadata(home, root, join(seatDir, 'inbox.md'), 'markdown') },
        { title: '수확 주장', ...metadata(home, root, join(seatDir, 'harvest-claims.tsv'), 'tsv') },
        { title: '예약', ...metadata(home, root, join(seatDir, 'scheduled.tsv'), 'tsv') },
        { title: '공통 메모리 색인', ...metadata(home, root, join(root, 'memory', 'MEMORY.md'), 'memory') },
      ];
      console.log(renderSeatBootCard(seat as SeatRole, sections, facts, contextUpdated));
    });
}

