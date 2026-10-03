import type { DaemonClient } from './daemon-client';
import type { MetaResult } from './chat-runtime';
import { cardToSummary, type SessionSummary } from './sessions-service';
import { relativeTime, SessionsStoreApi } from './sessions-store-api';

const DEFAULT_COUNT = 10;
const MAX_COUNT = 30;
const RESUME_USAGE = '쓰는 법: /resume <id 앞자리> (4자 이상)';
const SESSIONS_HINT = '이어가기: /resume <앞자리>';
const LIST_UNAVAILABLE = '대화 목록을 못 읽었습니다';
// Daemon ids all share this prefix (`elanous-session-bjugor`), so «the first characters» are the part after it.
const SESSION_ID_PREFIX = 'elanous-session-';

function shortId(id: string): string {
  return id.startsWith(SESSION_ID_PREFIX) ? id.slice(SESSION_ID_PREFIX.length) : id;
}

export type SessionCommand =
  | { kind: 'sessions'; count: number }
  | { kind: 'resume'; prefix?: string };

export function parseSessionCommand(name: 'sessions' | 'resume', args: readonly string[]): SessionCommand {
  if (name === 'sessions') {
    const count = args.length === 1 && /^[1-9]\d*$/.test(args[0]!)
      ? Math.min(Number(args[0]), MAX_COUNT) : DEFAULT_COUNT;
    return { kind: 'sessions', count };
  }
  return { kind: 'resume', ...(args.length === 1 && args[0]!.length >= 4 ? { prefix: args[0] } : {}) };
}

function displayId(fullId: string, sessions: readonly SessionSummary[]): string {
  const id = shortId(fullId);
  const lower = id.toLowerCase();
  let length = 8;
  for (const other of sessions) {
    if (other.id === fullId) continue;
    const rival = shortId(other.id).toLowerCase();
    let common = 0;
    while (common < lower.length && common < rival.length && lower[common] === rival[common]) common++;
    length = Math.max(length, common + 1);
  }
  return id.slice(0, length);
}

export function formatSessionList(
  sessions: readonly SessionSummary[],
  currentId: string,
  count = DEFAULT_COUNT,
  nowMs = Date.now(),
): string {
  const recent = [...sessions].sort((a, b) =>
    (Date.parse(b.lastTurnAt) || 0) - (Date.parse(a.lastTurnAt) || 0),
  ).slice(0, count);
  const lines = recent.length === 0 ? ['대화가 없습니다'] : recent.map((s) =>
    `${displayId(s.id, sessions)}${s.id === currentId ? ' (지금)' : ''} · ${s.msgCount}개 · ${relativeTime(s.lastTurnAt, nowMs)} · ${(s.lastMsgPreview ?? '').slice(0, 40)}`,
  );
  return [...lines, SESSIONS_HINT].join('\n');
}

export function resolveResume(input: string, sessions: readonly SessionSummary[], currentId: string): MetaResult {
  const prefix = shortId(input).toLowerCase();
  if (prefix.length < 4) return { text: RESUME_USAGE };
  const matches = sessions.filter((s) => shortId(s.id).toLowerCase().startsWith(prefix));
  if (matches.length === 0) return { text: '그런 대화가 없습니다 — /sessions 로 목록' };
  if (matches.length > 1) {
    return { text: `${matches.map((s) => displayId(s.id, sessions)).join(' · ')}\n더 길게 쳐 주세요` };
  }
  const id = matches[0]!.id;
  if (id === currentId) return { text: '이미 이 대화입니다' };
  return { newSessionId: id, text: `${displayId(id, sessions)} 대화로 옮겼습니다` };
}

export async function handleSessionCommand(
  command: SessionCommand,
  ctx: { client: DaemonClient; sessionId: string },
): Promise<MetaResult> {
  if (command.kind === 'resume' && !command.prefix) return { text: RESUME_USAGE };
  try {
    const body = await new SessionsStoreApi(ctx.client).list();
    if (!body.ok || !Array.isArray(body.sessions)) return { text: LIST_UNAVAILABLE };
    const sessions = body.sessions.map(cardToSummary);
    return command.kind === 'sessions'
      ? { text: formatSessionList(sessions, ctx.sessionId, command.count) }
      : resolveResume(command.prefix!, sessions, ctx.sessionId);
  } catch {
    return { text: LIST_UNAVAILABLE };
  }
}
