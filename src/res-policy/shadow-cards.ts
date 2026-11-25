// GUARDIAN-FINDINGS-VISIBLE ②③ — shadow with cards, the release-window guard and the Federation Board row (대표 11-25 18:5x).
//
// Situation: the 5-minute patrol ran `--dry-run` and wrote only a /tmp log; it flagged gcp3 (unknown VM) and mshq memory
// for 3.5 h and nobody saw. Shadow must stay action-free, but its findings must reach a person.
//
// 세 얼굴: 관측 = one «[수호자 · RES · 그림자]» card per 30 minutes (RES, OP when dormant) ⊕ the «🛡 Guardian» row on
// `els status-board` ⊕ `res.patrol shadow-card|forced-shadow` log lines / 판단 근거 = patrol findings (warn ⊕ critical)
// and the release schedule / 수복과 인계 = none in shadow — no reaps, no VM commands; the card names `eln res capsule`
// when RES is dormant. During a release window (04:00–06:30 KST, or a scheduled cut→publish in progress) the guardian
// is forced into this mode whatever `res.mode` says.
import type { PatrolFinding, PatrolState } from './patrol.js';

/** Source: 대표 11-25 18:5x «one batched card per 30 min». */
export const SHADOW_CARD_EVERY_MS = 30 * 60_000;
/** Source: 대표 11-25 18:5x «between 04:00 and 06:30 KST». Minutes after KST midnight. */
export const RELEASE_WINDOW_KST = { fromMinute: 4 * 60, toMinute: 6 * 60 + 30 } as const;
/** A scheduled release without publishAt is treated as cut + 2 h; the guard holds 30 min past publish. */
const DEFAULT_CUT_TO_PUBLISH_MS = 2 * 3_600_000;
const AFTER_PUBLISH_MS = 30 * 60_000;
const KST_OFFSET_MS = 9 * 3_600_000;

export interface ReleaseScheduleLike { readonly version: string; readonly cutAt: string; readonly publishAt?: string | null }

/** Why the guardian must stay in shadow right now, or null. `schedules === null` = the schedule could not be read. */
export function releaseWindowGuard(now: Date, schedules: readonly ReleaseScheduleLike[] | null): string | null {
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  const minute = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  if (minute >= RELEASE_WINDOW_KST.fromMinute && minute < RELEASE_WINDOW_KST.toMinute) return 'release-window 04:00–06:30 KST';
  if (schedules === null) return 'release-schedule-unreadable';
  for (const schedule of schedules) {
    const cut = Date.parse(schedule.cutAt);
    if (!Number.isFinite(cut)) continue;
    const publish = schedule.publishAt ? Date.parse(schedule.publishAt) : NaN;
    const end = (Number.isFinite(publish) ? publish : cut + DEFAULT_CUT_TO_PUBLISH_MS) + AFTER_PUBLISH_MS;
    if (now.getTime() >= cut && now.getTime() <= end) return `release ${schedule.version} cut→publish in progress`;
  }
  return null;
}

export interface ShadowCardStep {
  readonly card: { readonly to: string; readonly body: string } | null;
  readonly pending: readonly PatrolFinding[];
  readonly lastCardAt?: string;
  readonly lastCardTo?: string;
}

/** Accumulate fresh findings; flush one batched card when the 30-minute window has passed (the first one goes at once). */
export function shadowCardStep(prev: PatrolState, fresh: readonly PatrolFinding[], activeKeys: ReadonlySet<string>, dormant: boolean, now: Date,
  forcedShadow: string | null): ShadowCardStep {
  const byKey = new Map<string, PatrolFinding>();
  for (const finding of prev.pending ?? []) byKey.set(finding.key, finding);
  for (const finding of fresh) byKey.set(finding.key, finding);
  const pending = [...byKey.values()];
  const last = prev.lastCardAt ? Date.parse(prev.lastCardAt) : NaN;
  const due = !Number.isFinite(last) || now.getTime() - last >= SHADOW_CARD_EVERY_MS;
  const carry = { ...(prev.lastCardAt ? { lastCardAt: prev.lastCardAt } : {}), ...(prev.lastCardTo ? { lastCardTo: prev.lastCardTo } : {}) };
  if (pending.length === 0 || !due) return { card: null, pending, ...carry };
  const rank = (finding: PatrolFinding) => finding.severity === 'critical' ? 0 : 1;
  pending.sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
  const lines = pending.map((finding) => `- ${finding.severity === 'critical' ? '🚨' : '❓'} ${finding.rule} · ${finding.subject} — ${finding.detail}${activeKeys.has(finding.key) ? '' : ' (cleared since)'}`);
  const critical = pending.filter((finding) => finding.severity === 'critical').length;
  const to = dormant ? 'OP' : 'RES';
  const head = `[수호자 · RES · 그림자] 정책 밖 ${pending.length}건 (critical ${critical} · warn ${pending.length - critical}) — shadow: 행동 없음(거두기·VM 0)${forcedShadow ? ` · 강제 그림자: ${forcedShadow}` : ''}`;
  const tail = dormant ? '\n(RES dormant — 판단이 필요하면 `eln res capsule "<질문>"`)' : '\n(다음 묶음은 30분 뒤 · 지금 상태 `eln res patrol --dry-run`)';
  return { card: { to, body: `${head}\n${lines.join('\n')}${tail}` }, pending: [], lastCardAt: now.toISOString(), lastCardTo: to };
}

/** Federation Board row from the patrol state: «🛡 Guardian (shadow) — 2 critical · 1 warn: …». null = no tick yet. */
export function guardianBoardLine(state: PatrolState, now: Date): string | null {
  const tick = state.lastTick;
  if (!tick) return null;
  const ageMin = Math.max(0, Math.round((now.getTime() - Date.parse(tick.at)) / 60_000));
  const stale = ageMin > 15 ? ` · STALE ${ageMin}m` : '';
  const forced = tick.forcedShadow ? ` · forced shadow (${tick.forcedShadow})` : '';
  const card = state.lastCardAt ? ` · last card ${state.lastCardAt.slice(11, 16)}Z→${state.lastCardTo ?? '?'}` : '';
  const alerting = tick.findings.filter((finding) => finding.severity !== 'info');
  if (alerting.length === 0) return `🛡 Guardian (${tick.mode}) — clear · tick ${ageMin}m ago${forced}${stale}${card}`;
  const critical = alerting.filter((finding) => finding.severity === 'critical');
  const shown = [...critical, ...alerting.filter((finding) => finding.severity !== 'critical')].slice(0, 4)
    .map((finding) => `${finding.rule} ${finding.subject}`).join(' · ');
  const more = alerting.length > 4 ? ` +${alerting.length - 4}` : '';
  return `🛡 Guardian (${tick.mode}) — ${critical.length} critical · ${alerting.length - critical.length} warn: ${shown}${more}${forced}${stale}${card}`;
}
