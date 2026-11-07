// ── 세션 자기인지 read-model (제1원칙·PLAN §0.5 · 2026-07-16) ────────────────────
//
// mission-incident-context.ts(buildMissionIncidentContext)의 **세션판 자매** — 봇이
// "이 세션 지금 누가 보고 있어?"/"왜 텔레그램으로 넘어갔어?"에 **결정론 grounded** 답을
// 하게 한다(#3928류 confabulation 방지). 재구현 0 — 영속 SessionMeta(bindings·subscribers)
// + 관측 로그(session.*)만 얇게 조립. 팩에 없으면 "기록 없음"(유사 과거 회수 금지).

import { loadSession, subscriberKey, type SessionSubscriber, type SessionBindings } from './index.js';
import { formatClock } from '../time/clock.js';
import { formatDateTime } from '../time/calendar.js';
import { resolveTimeZone } from '../time/time-zone.js';

/** 세션 자기인지 문맥 — 봇 답변/PWA presence 카드에 주입할 결정론 ground-truth. */
export interface SessionContext {
  /** 세션 실존 여부 — false 면 "기록 없음"만 답. */
  found: boolean;
  sessionId: string;
  title: string;
  /** freshness "as of" 앵커(ISO). */
  asOf: string;
  originInstance?: string;
  /** 지금 이 세션을 구독 중인 서피스(presence 포함). */
  subscribers: SessionSubscriber[];
  /** presence 요약. */
  presence: { active: number; grace: number; left: number };
  /** 채널 바인딩(어디로 도달 가능한가) — 핸드오프 판정용. */
  bindings: {
    cli: boolean;
    telegram?: { chatId: number; threadId?: number };
    discord?: { channelId: string };
  };
  messageCount: number;
  updatedAt: string;
  /** 조립 부분 실패(fail-soft 정직성). */
  degraded: boolean;
}

export interface SessionContextDeps {
  /** 세션 로더(기본 loadSession). 테스트 seam. */
  load?: (sessionId: string) => ReturnType<typeof loadSession>;
  /** freshness 시각(기본 실시간). 테스트 결정론. */
  now?: () => string;
}

function summarizeBindings(b: SessionBindings | undefined): SessionContext['bindings'] {
  return {
    cli: !!b?.cli,
    ...(b?.telegram ? { telegram: { chatId: b.telegram.chatId, ...(b.telegram.threadId != null ? { threadId: b.telegram.threadId } : {}) } } : {}),
    ...(b?.discord ? { discord: { channelId: b.discord.channelId } } : {}),
  };
}

/**
 * 세션 자기인지 문맥 조립(결정론·READ-ONLY·fail-soft). 세션 부재 시 found=false.
 * buildMissionIncidentContext 자매.
 */
export function buildSessionContext(
  sessionId: string,
  deps: SessionContextDeps = {},
): SessionContext {
  const now = (deps.now ?? (() => new Date().toISOString()))();
  let loaded: ReturnType<typeof loadSession>;
  try {
    loaded = (deps.load ?? ((id: string) => loadSession(id)))(sessionId);
  } catch {
    return emptyContext(sessionId, now, true);
  }
  if (!loaded) return emptyContext(sessionId, now, false);

  const m = loaded.meta;
  const subscribers = m.bindings?.subscribers ?? [];
  const presence = {
    active: subscribers.filter(s => s.presence === 'active').length,
    grace: subscribers.filter(s => s.presence === 'grace').length,
    left: subscribers.filter(s => s.presence === 'left').length,
  };
  return {
    found: true,
    sessionId: m.id,
    title: m.title,
    asOf: now,
    ...(m.originInstance ? { originInstance: m.originInstance } : {}),
    subscribers,
    presence,
    bindings: summarizeBindings(m.bindings),
    messageCount: m.messageCount,
    updatedAt: m.updatedAt,
    degraded: false,
  };
}

function emptyContext(sessionId: string, now: string, degraded: boolean): SessionContext {
  return {
    found: false, sessionId, title: '', asOf: now, subscribers: [],
    presence: { active: 0, grace: 0, left: 0 },
    bindings: { cli: false }, messageCount: 0, updatedAt: '', degraded,
  };
}

/** 이 세션에 봇이 답할 만한 '동시성 사건'(2+ 활성 구독자·핸드오프)이 있나 — ambient 게이팅. */
export function hasLiveActivity(ctx: SessionContext): boolean {
  return ctx.found && (ctx.presence.active >= 2 || ctx.presence.grace > 0
    || (ctx.bindings.telegram != null && ctx.bindings.cli)
    || (ctx.bindings.discord != null && ctx.bindings.cli));
}

/**
 * 봇 답변 주입용 결정론 문맥 문자열(anti-confabulation). "누가 보고 있나/어디로 도달 가능한가"를
 * 팩의 사실로만. formatIncidentContext 자매.
 */
export function formatSessionContext(ctx: SessionContext): string {
  if (!ctx.found) {
    return [
      `## 세션 조회 — ${ctx.sessionId}`,
      ctx.degraded ? '⚠️ 문맥 조립 실패(불확실) — 확언 금지.' : '이 세션 기록을 찾지 못함.',
      '규칙: 추측·유사 과거 세션 회수 금지. "해당 세션 기록 없음"이라 답하고 id 확인을 요청하라.',
    ].join('\n');
  }
  const L: string[] = [];
  // 2026-07-24 — 시각을 사용자 시간대로 표시하고 **시간대를 라벨로 명시**한다.
  // 종전엔 `.slice(0,19)` 로 ISO 를 잘라 UTC 를 넣었는데, "결정론"이라는 이름표를
  // 달고 9시간 어긋난 시각이 LLM 프롬프트에 사실로 들어갔다. 라벨이 없으면 모델은
  // 그게 어느 시간대인지 알 방법조차 없다. 계약: src/time/format.ts
  const tz = resolveTimeZone().timeZone;
  L.push(`## 이 세션의 실제 상태 (결정론·as of ${formatDateTime(ctx.asOf, { seconds: true })} ${tz}) — 이 팩으로만 답하라`);
  L.push(`세션: ${ctx.sessionId.slice(0, 12)} · "${ctx.title.slice(0, 48)}"${ctx.originInstance && ctx.originInstance !== 'prod' ? ` [${ctx.originInstance}]` : ''}`);
  L.push(`메시지 ${ctx.messageCount} · 최종 ${formatDateTime(ctx.updatedAt, { seconds: true })}`);
  if (ctx.subscribers.length) {
    L.push(`구독자(지금 보고 있는 서피스) ${ctx.subscribers.length} — 활성 ${ctx.presence.active}·유예 ${ctx.presence.grace}·이탈 ${ctx.presence.left}:`);
    for (const s of ctx.subscribers.slice(0, 8)) {
      L.push(`  · ${subscriberKey(s.surface, s.endpoint)} [${s.role}·${s.presence}] (최종수신 ${formatClock(s.lastSeenAt)})`);
    }
  } else {
    L.push('구독자: 없음(현재 이 세션을 동시 구독 중인 서피스 없음).');
  }
  const reach: string[] = [];
  if (ctx.bindings.cli) reach.push('TUI');
  if (ctx.bindings.telegram) reach.push(`telegram(chat ${ctx.bindings.telegram.chatId})`);
  if (ctx.bindings.discord) reach.push(`discord(ch ${ctx.bindings.discord.channelId})`);
  L.push(`도달 가능(bindings): ${reach.length ? reach.join(', ') : '없음'}`);
  if (ctx.degraded) L.push('⚠️ 일부 조립 실패(불확실) — 그 부분 확언 금지.');
  L.push('─ 규칙: 위에 없는 구독자·서피스를 지어내지 말 것. 없으면 "그 기록 없음"이라 답하라.');
  return L.join('\n');
}
