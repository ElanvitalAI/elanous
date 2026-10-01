// NT1 — LLM 예산 알림 «모양» (UX · 대표 2026-09-30 22:30 재요청 · OP 결정 B6 ⊕ NT1).
// 숫자·정책은 TC 의 B6 로더가 채운다(`내부 문서 `RFC-llm-policy-single-file-2026-09-30``) — 이 파일은 문구만 정한다.
//
// 규칙 셋(대표 가 받은 알림이 어긴 것들):
//   ① 한 알림 = 한 결정·한 행동 — 맨 윗줄이 «무엇이 바뀌었나», 마지막 줄이 «할 일».
//   ② 바뀐 게 없으면 침묵 — 같은 상태(key)면 send=false.
//   ③ 모순 금지 — «한도 참»과 «크레딧으로 진행 중»을 한 알림에 같이 쓰지 않는다. 상태 하나만 고른다.
//   ⊕ 내부 낱말 0 — «자»·«판정»·계정 내부 이름 나열을 쓰지 않는다(계정은 «계정 N개»로 센다).

export interface LlmBudgetAccount {
  name: string;
  /** 구독 잔량 %(0~100). 모르면 undefined. */
  subscriptionRemainingPct?: number;
  /** 이 계정의 크레딧 잔액. */
  credits?: number;
  resetInHours?: number;
}

export interface LlmBudgetSnapshot {
  /** ISO 시각(Asia/Seoul 로 날짜를 자른다). */
  at: string;
  credits: {
    total: number;
    usedToday: number;
    /** 하루 목표 소진량(정책 `credits.pace`). */
    paceTarget: number;
    /** ISO 날짜 — 크레딧이 사라지는 날. */
    expiresAt?: string;
    /** 정책이 «크레딧 먼저»인가(`until` 전). */
    useFirst?: boolean;
  };
  accounts: LlmBudgetAccount[];
  selected: { account?: string; reason: 'subscription' | 'credits' | 'fallback' | 'none' };
  fallback?: { provider: string; remainingPct?: number };
}

export interface LlmBudgetAlert {
  send: boolean;
  /** 상태 열쇠 — 다음 호출의 prevKey 로 넘긴다. */
  key: string;
  text: string;
}

const EXPIRY_WARN_DAYS = 7;
/** 공개 알림에 표시할 수 있는 폴백 제공자명. 현재 폴백 체인의 외부 제공자는 grok 뿐이다. */
const PUBLIC_FALLBACK_PROVIDERS = new Set(['grok']);
/** 이 시각(서울) 뒤에야 «오늘 페이스가 느리다»를 말한다 — 아침에 0 인 건 정상이다. */
const PACE_CHECK_HOUR = 18;

const n = (v: number) => Math.round(v).toLocaleString('ko-KR');

function seoulParts(iso: string): { date: string; hour: number } {
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(seoulParts(fromIso).date);
  const b = Date.parse(seoulParts(toIso).date);
  return Math.round((b - a) / 86_400_000);
}

function mmdd(iso: string): string {
  const { date } = seoulParts(iso);
  return `${date.slice(5, 7)}-${date.slice(8, 10)}`;
}

function creditsLine(s: LlmBudgetSnapshot): string {
  const parts = [`오늘 ${n(s.credits.usedToday)} / 목표 ${n(s.credits.paceTarget)}`, `남은 크레딧 ${n(s.credits.total)}`];
  if (s.credits.expiresAt) parts.push(`${mmdd(s.credits.expiresAt)} 만료`);
  return parts.join(' · ');
}

/** 지금 상태 하나를 고른다(위에서부터 먼저 맞는 것). 아무것도 아니면 침묵. */
export function buildLlmBudgetAlert(now: LlmBudgetSnapshot, prevKey?: string): LlmBudgetAlert {
  const { date, hour } = seoulParts(now.at);
  const accounts = now.accounts.length;
  let key = 'ok';
  let lines: string[] = [];

  const expiryDays = now.credits.expiresAt ? daysBetween(now.at, now.credits.expiresAt) : undefined;

  if (now.selected.reason === 'none') {
    key = 'blocked';
    lines = [
      '⛔ LLM 을 쓸 곳이 없어 작업이 멈췄습니다.',
      `구독 계정 ${accounts}개 한도 · 크레딧·대체 모델도 못 씁니다.`,
      '할 일: 크레딧 사용을 허락하거나 대체 모델 키를 확인해 주세요.',
    ];
  } else if (now.selected.reason === 'fallback') {
    const soonest = now.accounts.map((a) => a.resetInHours)
      .filter((h): h is number => typeof h === 'number' && Number.isFinite(h) && h > 0)
      .sort((a, b) => a - b)[0];
    const candidate = now.fallback?.provider?.trim();
    const provider = candidate && PUBLIC_FALLBACK_PROVIDERS.has(candidate) ? candidate : undefined;
    key = `fallback:${provider || 'unknown'}`;
    lines = [
      `⚠️ codex 를 못 써서 ${provider ? `${provider} 로` : '대체 모델로'} 일하고 있습니다${typeof now.fallback?.remainingPct === 'number' ? `(남은 ${Math.round(now.fallback.remainingPct)}%)` : ''}.`,
      soonest !== undefined ? `codex 는 ${Math.ceil(soonest)}시간 뒤 돌아옵니다.` : 'codex 가 언제 돌아오는지 아직 모릅니다.',
      '할 일: 없음 — 참고만 하세요.',
    ];
  } else if (expiryDays !== undefined && expiryDays >= 0 && expiryDays <= EXPIRY_WARN_DAYS && now.credits.total > 0) {
    key = `expiry:${expiryDays}`;
    lines = [
      `💳 크레딧 ${n(now.credits.total)} 이 ${expiryDays === 0 ? '오늘' : `${expiryDays}일 뒤`} 사라집니다.`,
      creditsLine(now),
      '할 일: 만료 전에 크레딧 사용을 확인해 주세요.',
    ];
  } else if (now.credits.useFirst && now.credits.total > 0 && (expiryDays === undefined || expiryDays >= 0) && hour >= PACE_CHECK_HOUR && now.credits.usedToday < now.credits.paceTarget * 0.5) {
    // 하루 한 번만 — 날짜를 열쇠에 넣는다.
    key = `pace-behind:${date}`;
    lines = [
      now.selected.reason === 'credits'
        ? '💳 크레딧을 먼저 쓰는 중인데 오늘 쓴 양이 목표의 절반이 안 됩니다.'
        : '💳 크레딧을 먼저 쓰라는 방침인데 오늘은 구독 계정이 먼저 쓰였습니다.',
      creditsLine(now),
      now.selected.reason === 'credits' ? '할 일: 없음 — 맡긴 일이 적었던 날입니다.' : '할 일: 없음 — 기술 담당이 순서를 고치는 중입니다.',
    ];
  }

  const send = key !== 'ok' && key !== prevKey;
  return { send, key, text: send ? lines.join('\n') : '' };
}
