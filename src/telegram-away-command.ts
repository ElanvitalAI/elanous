import { readPresence, writePresence, type Presence } from './away/presence.js';
import { releaseNowText, releaseWatchTick } from './away/release-watch.js';
import { readReleaseRuns, type ReleaseRunView } from './nexus/api/ops-api.js';

/** AWAY-MODE-1 ③ — 텔레그램 /release: PWA /ops/release 와 같은 원장을 읽어 지금 런·노드를 한 통으로. */
export function telegramReleaseStatus(args: string[], runs: () => ReleaseRunView[] | 'unavailable' = () => readReleaseRuns(null, undefined, { facts: true }), now: () => number = Date.now): string {
  if (args.length) return '사용법: /release';
  return releaseNowText(runs(), now());
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
