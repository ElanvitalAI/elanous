import { readPresence, writePresence, type Presence } from './away/presence.js';
import { releaseWatchTick } from './away/release-watch.js';
import { telegramNowSlash } from './context-bus/context-now-surfaces.js';
import type { ContextNowDeps } from './context-bus/context-now.js';

/** Telegram /release and /away read the same release-status fact as TUI and context_now. */
export function telegramReleaseStatus(args: string[], deps?: ContextNowDeps): string {
  if (args.length) return '사용법: /release';
  return telegramNowSlash(['발행 상황'], deps);
}

export interface AwaySlashDeps {
  read?: () => Presence;
  write?: (away: boolean, by: string) => Presence;
  tick?: () => unknown;
  release?: () => string;
}

/** AWAY-MODE-1 ① — 텔레그램 /away on|off|status. 답은 이 대화로 돌아오므로 따로 발송하지 않는다. */
export function telegramAwaySlash(args: string[], deps: AwaySlashDeps = {}): string {
  const read = deps.read ?? (() => readPresence());
  const write = deps.write ?? ((away: boolean, by: string) => writePresence(away, by));
  const tick = deps.tick ?? (() => releaseWatchTick());
  const release = deps.release ?? (() => telegramReleaseStatus([]));
  const sub = (args[0] ?? 'status').toLowerCase();
  if (args.length > 1 || !['on', 'off', 'status'].includes(sub)) return '사용법: /away on | off | status';
  if (sub === 'on') {
    write(true, 'telegram');
    tick();
    return `🚶 외출 모드 켬 — 발행 노드 전이·막힘·60분 생존 줄을 여기로 보낸다(끄기: /away off)\n${release()}`;
  }
  if (sub === 'off') {
    write(false, 'telegram');
    tick();
    return '🏠 외출 모드 끔 — 발행 알림은 평소대로';
  }
  const presence = read();
  return `${presence.away ? '🚶 외출 중' : '🏠 자리에 있음'}${presence.since ? ` · ${presence.since}` : ''}\n${release()}`;
}
