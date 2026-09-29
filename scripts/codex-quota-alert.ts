#!/usr/bin/env -S npx tsx
// ── Codex/LLM 한도 → 텔레그램 경고 폴러 (2026-09-18) ─────────────────────
//
// 🩸 왜 생겼나: 2026-09-18 에 ***codex 세 계정이 «전부» 100% 소진돼 있었는데 아무도 몰랐다.***
//   `elanous usage` 는 «묻는» 표면이라 사람이 치지 않으면 영영 안 보인다. 미는 경로가 없었다.
//
// 🔥 2026-09-18 «둘째» 발견 — 소진보다 이쪽이 돈이 나가는 자리다:
//   ***주간이 100% 인데 `hasCredits: true` 면 요청이 «안 죽는다».*** 레이트리밋 오류가 안 나니
//   회전도 폴백도 «안 열리고**, 잔액(`credits.balance`)만 조용히 깎인다.
//   📏 그날 실측: default 만 hasCredits=true · balance=4,064.57 / team·third 는 0.
//   ⛔ 그런데 그 잔액을 «시계열로 재는 자»가 저장소에 하나도 없었다
//      (`budget.fetcher.codex` 로그에 balance 를 실은 행: 0). ⇒ 이 폴러가 그 자를 겸한다.
//
// ⛔ 이 폴러가 «세지 않는» 것을 먼저 적는다(경고를 「전부 봤다」로 읽지 않게):
//   - 종량 과금 «달러» — 토큰→달러 자가 아직 없다(`llm.usage` 는 인프로세스 라우터 두 자리뿐).
//     여기서 세는 것은 provider 가 주는 «잔액 숫자»이고 그 단위는 우리가 정한 것이 아니다.
//   - 리셋권 «소비» — 소비 경로도 이벤트도 없다. 여기서는 만료·존재만 본다.
//   - 리셋권 «장수» — ⚠️ `usage --json` 은 계정당 «가장 빠른 만료 하나»만 준다.
//     📏 실측: 표가 「1장」처럼 보였지만 실제로는 default 1 · team 2 · third 2 = «다섯»이었다.
//     세려면 계정 홈마다 `CODEX_HOME=<홈> … reset-credits list` 를 따로 쳐야 한다(여기서는 안 한다).
//
// cron: 0 * * * *  (한 시간마다 · 상태가 «바뀔 때»만 발송 — 같은 상태 반복 발송 금지)
// state: ~/.elanous/conatus/codex_quota_alert_state.json

import { sendOutbound } from '../src/domains/outbound-alert.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ensureCronNodePath } from '../src/domains/cron-path.js';
import { registerStandaloneLogSink } from '../src/domains/standalone-log-sink.js';
import { getUserConfig } from '../src/user-config.js';
import { creditsSummary, formatCreditsSummary } from './codex-quota-alert-format.js';
import {
  CODEX_QUOTA_POLICY_LABEL, codexPolicyAllowsCredits, codexPolicyAllowsFallback, resolveCodexQuotaPolicy,
} from '../src/oauth/codex-quota-policy.js';

const STATE = join(homedir(), '.elanous/conatus/codex_quota_alert_state.json');
/** 잔여가 이 % 이하로 내려간 계정을 «임박»으로 본다. */
const LOW_REMAINING_PERCENT = 10;
/** 리셋권 만료가 이 일수 안이면 알린다. */
const RESET_CREDIT_EXPIRY_DAYS = 7;
/** 정책 `credits`(크레딧 사용이 «허가된» 상태)에서 잔액 보고의 발송 단위 — 이만큼 줄 때마다 한 번.
 *  ⛔ 허가된 지출을 매시 경보로 보내면 진짜 경보(리셋 전 고갈 · 정책 위반)가 묻힌다(대표 2026-09-28 «정책과 안 맞는다»).
 *  허가 «밖»(within-quota·fallback)에서는 종전대로 줄 때마다 보낸다 — 그때는 줄어드는 것 자체가 사고다. */
const CREDITS_REPORT_STEP = 5000;

interface AccountRow {
  provider: string; accountName: string;
  credits?: { usedPercent?: number; periodEnd?: string; balance?: number; hasCredits?: boolean };
  subscription?: { remainingPercent?: number; resetsAt?: number };
  resetCredits?: { status?: string; expiresAt?: string };
}

/** ⛔ 조회가 실패하면 «괜찮다»가 아니라 «못 쟀다»다 — 그 둘을 다른 값으로 돌려준다. */
function readUsage(): { rows: AccountRow[] } | { error: string } {
  try {
    // ⛔ 크론은 pilot 트리에서 돈다 — cwd 를 «박지 않고» 이 스크립트 위치에서 뿌리를 잡는다.
    const repoRoot = join(import.meta.dir, '..');
    // ⭐ 크론은 pilot(리더 트리)에서 도니 그냥 치면 운영 config 를 읽는다.
    //   ⛔ 그런데 «비-리더 트리»에서는 격리 config 로 떨어져 행이 0개가 된다 —
    //   그러면 이 자를 «알려진 양성»에 눌러 볼 수가 없다. 그 문을 하나 낸다(운영은 무변경).
    const configDir = process.env.ELANOUS_QUOTA_ALERT_CONFIG_DIR?.trim();
    const args = ['bin/elanous.mjs', 'usage', '--json', ...(configDir ? ['--config-dir', configDir] : [])];
    const raw = execFileSync('bun', args, {
      cwd: repoRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    });
    const start = raw.search(/[[{]/);
    if (start < 0) return { error: 'usage --json 이 JSON 을 안 냈다' };
    const parsed: unknown = JSON.parse(raw.slice(start));
    // 🩸 산출은 «배열이 아니라» { rows: [...] } 다. 처음엔 통째로 감싸서
    //   ***전 계정 소진인데 「경고 조건 없음」*** 을 냈다(알려진 양성에서 자가 죽었다).
    const rows = Array.isArray(parsed)
      ? parsed
      : (parsed as { rows?: unknown })?.rows && Array.isArray((parsed as { rows: unknown[] }).rows)
        ? (parsed as { rows: unknown[] }).rows
        : [parsed];
    if (rows.length === 0) return { error: 'usage --json 의 rows 가 비었다' };
    return { rows: rows as AccountRow[] };
  } catch (e) {
    return { error: (e as Error)?.message?.slice(0, 200) ?? 'unknown' };
  }
}

function hoursUntil(ms?: number): number | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  return Math.round(((ms - Date.now()) / 3_600_000) * 10) / 10;
}
function daysUntil(iso?: string): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.round(((t - Date.now()) / 86_400_000) * 10) / 10;
}

function loadState(): Record<string, string> {
  try { return JSON.parse(readFileSync(STATE, 'utf8')) as Record<string, string>; } catch { return {}; }
}
function saveState(s: Record<string, string>): void {
  try { mkdirSync(dirname(STATE), { recursive: true }); writeFileSync(STATE, JSON.stringify(s, null, 1)); }
  catch { /* 상태 저장 실패가 발송을 막지 않는다 */ }
}

export async function runCodexQuotaAlert(): Promise<void> {
const usage = readUsage();
if ('error' in usage) {
  // ⛔ 「못 쟀다」도 알린다 — 조회가 죽은 채로 조용하면 한도 경고가 «영영» 안 온다.
  const key = 'usage-unreadable';
  const prev = loadState();
  if (prev[key] !== usage.error) {
    sendOutbound(`⚠️ **LLM 한도 조회가 실패했습니다** — 경고가 이 상태로는 안 옵니다.\n\n사유: \`${usage.error}\``, 'alert');
    saveState({ ...prev, [key]: usage.error });
  }
  process.exit(0);
}

// 대표 2026-09-28 한도 정책(`llm.codexQuotaPolicy`) — 알림 문구·발송 기준이 «설정된 정책»을 따른다.
let quota = resolveCodexQuotaPolicy(undefined);
try { quota = resolveCodexQuotaPolicy(getUserConfig().llm); } catch { /* 못 읽으면 기본(fallback) */ }
const creditsAllowed = codexPolicyAllowsCredits(quota.policy);
const fallbackAllowed = codexPolicyAllowsFallback(quota.policy);

const codex = usage.rows.filter((r) => r.provider === 'codex');
const others = usage.rows.filter((r) => r.provider !== 'codex');

/**
 * 🩸 «못 읽은 계정» — 이 자의 가장 위험한 실패다.
 *   📏 2026-09-19 실측(🅕 관측): `usage --json` 이 ***간헐적으로 전부 null 을 낸다***.
 *   같은 계정을 몇십 초 차로 두 번 쟀는데 한쪽은 `used=100 · hasCredits=true · 잔액 2965`,
 *   다른 쪽은 ***전부 None*** 이었다. 그 틱에 종전 코드는:
 *     exhausted : (rem ?? 100) <= 0          ⇒ null 이 «100» 이 되어 「소진 아님」
 *     burning   : capped && hasCredits       ⇒ capped=false 라 「안 태운다」
 *     low       : typeof rem === 'number'    ⇒ 건너뜀
 *   ⇒ ***세 갈래가 모두 조용해져 「경고 조건 없음」을 낸다 — 자가 눈이 먼 채 「정상」이라 말한다.***
 *   🩹 그래서 「못 읽음」을 «값으로» 센다. ⛔ 「안전」으로도 「소진」으로도 접지 않는다.
 */
const unreadable = codex.filter((r) => {
  const rem = r.subscription?.remainingPercent;
  const used = r.credits?.usedPercent;
  return typeof rem !== 'number' && typeof used !== 'number';
});

// ⛔ 「못 읽음」은 소진 판정에서 «뺀다» — 그것은 별도 갈래이고, 섞으면 둘 다 못 읽는다.
const exhausted = codex.filter((r) => !unreadable.includes(r)
  && (r.subscription?.remainingPercent ?? 100) <= 0);
const low = codex.filter((r) => {
  const rem = r.subscription?.remainingPercent;
  return typeof rem === 'number' && rem > 0 && rem <= LOW_REMAINING_PERCENT;
});
// 🔥 «돈이 나가는 중» — 한도를 넘겼는데 요청이 안 죽는 계정. 소진 경고와 «다른 축»이다:
//   소진은 「멈췄다」이고 이것은 ***「안 멈췄다」***이다. 후자가 과금이다.
const burning = codex.filter((r) => {
  if (unreadable.includes(r)) return false;   // 못 읽은 것은 위 unreadable 이 «따로» 말한다
  const rem = r.subscription?.remainingPercent;
  const used = r.credits?.usedPercent;
  const capped = (typeof rem === 'number' && rem <= 0) || (typeof used === 'number' && used >= 100);
  return capped && r.credits?.hasCredits === true;
});

const expiring = codex.filter((r) => {
  const d = daysUntil(r.resetCredits?.expiresAt);
  return r.resetCredits?.status === 'available' && d !== null && d <= RESET_CREDIT_EXPIRY_DAYS;
});

const nowMs = Date.now();
const prevState = loadState();

/**
 * 🩸 「지금도 나가는 중인가」는 «임계»로 못 잡는다 — 그 자가 한 번 눈이 멀었다.
 *   📏 2026-09-18: 실물 유출이 «분당 -0.33» 이었는데, 종전 서명은 잔액을 50 단위로 접어서
 *   ***한 시간에 -20 이면 구간을 안 넘어 「상태 동일 — 무발송」*** 을 냈다. 즉 «켜져 있는데 안 보였다».
 *   🩹 그래서 임계를 버리고 ***직전 표본 대비 «감소했나»*** 로 바꾼다 — 얼마든 줄면 줄었다고 말한다.
 *   ⛔ 도배되지 않는 이유는 «감소 자체»가 아니라 `burning` 게이트다(한도 100% ⊕ hasCredits=true).
 *     그 상태에서 줄고 있으면 그것은 ***지금 돈이 나가는 중***이고, 매 틱 알리는 것이 옳다.
 *   ⛔ 직전 표본이 «없으면» 「안 준다」가 아니라 「모른다」다 — 첫 틱은 기준선만 적는다.
 */
function drainOf(r: AccountRow): { state: 'draining' | 'flat' | 'unknown'; delta?: number; perHour?: number; windowMin?: number } {
  const now = r.credits?.balance;
  const before = Number(prevState[`balance:${r.accountName}`]);
  const beforeAt = Number(prevState[`balanceAt:${r.accountName}`]);
  if (typeof now !== 'number' || !Number.isFinite(before)) return { state: 'unknown' };
  const delta = now - before;
  if (delta >= 0) return { state: 'flat', delta };
  const hours = Number.isFinite(beforeAt) ? (nowMs - beforeAt) / 3_600_000 : NaN;
  // ⛔ 속도와 ETA 는 «한 구간의 기울기»다 — 창이 짧으면 버스트 하나가 그 기울기를 지배한다.
  //   📏 2026-09-18 실측: 5분 창이 «시간당 -165 · 19시간 뒤 0» 을 냈는데, 직후 187초 실측은
  //   «시간당 -4.2»(33배 차이)였다. 앞의 수는 틀린 게 아니라 ***그 창에서 참***이었고,
  //   읽는 사람이 그것을 「지속 속도」로 읽은 것이 문제다.
  //   🩹 ⇒ 임의 임계로 «막지» 않는다(그 상수를 관례로 채울 근거가 없다).
  //      대신 ***창의 길이를 값으로 같이 낸다*** — 읽는 쪽이 짧은 창을 스스로 깎게 한다.
  return {
    state: 'draining', delta,
    ...(hours > 0 ? { perHour: delta / hours, windowMin: Math.round(hours * 60) } : {}),
  };
}
const drain = new Map((quota.policy === 'credits' ? codex : burning)
  .map((r) => [r.accountName, drainOf(r)] as const));
// 🩸 2026-09-28: 머리줄이 «찬 ⊕ 크레딧 있음» 계정 수(3)를 «나가는 중» 으로 셌다 — 실제로 줄던 것은 default 하나.
//   ⇒ «줄고 있다»(draining)와 «크레딧은 있지만 안 쓰는 중»을 가른다.
const draining = burning.filter((r) => drain.get(r.accountName)?.state === 'draining');
const creditHolders = quota.policy === 'credits'
  ? codex.filter((r) => r.credits?.hasCredits === true)
  : [];
const combinedCredits = creditHolders.length >= 2 ? creditsSummary(creditHolders.map((r) => ({
  name: r.accountName,
  balance: r.credits?.balance,
  perHour: drain.get(r.accountName)?.state === 'flat' ? 0 : drain.get(r.accountName)?.perHour,
  resetInHours: hoursUntil(r.subscription?.resetsAt) ?? undefined,
}))) : null;

// ⭐ 상태를 «문자열 하나»로 접어 두고, 바뀔 때만 보낸다(같은 경고 반복 금지).
const signature = JSON.stringify({
  ex: exhausted.map((r) => r.accountName).sort(),
  low: low.map((r) => `${r.accountName}:${r.subscription?.remainingPercent}`).sort(),
  exp: expiring.map((r) => r.accountName).sort(),
  // ⛔ 「못 읽음」이 서명에 없으면, 자가 눈먼 상태가 「상태 동일」로 조용해진다.
  unread: unreadable.map((r) => r.accountName).sort(),
  policy: quota.policy,
  ...(combinedCredits ? { beforeReset: combinedCredits.beforeReset } : {}),
  // ⛔ 「줄고 있는 중」은 «매 틱» 서명이 달라야 한다 — 돈이 계속 나가는데 한 번만 알리면
  //   두 번째 시간부터는 「상태 동일」로 조용해진다. 그래서 draining 이면 원값을 넣는다.
  //   ⛔ 반대로 멎었으면(flat) 원값을 넣지 «않는다» — 그래야 반복 발송이 멎는다.
  burn: burning.map((r) => {
    const d = drain.get(r.accountName);
    if (d?.state !== 'draining') return `${r.accountName}:${d?.state ?? 'unknown'}`;
    const b = r.credits?.balance;
    // 허가된 크레딧 지출은 «단위»로 접는다 — 단 «리셋 전에 바닥난다»로 바뀌면 단위와 무관하게 서명이 바뀐다.
    const resetH = hoursUntil(r.subscription?.resetsAt);
    const etaH = d.perHour && d.perHour < 0 && typeof b === 'number' ? b / -d.perHour : null;
    const risk = !combinedCredits && etaH !== null && (resetH === null || etaH < resetH) ? ':before-reset' : '';
    return `${r.accountName}:${creditsAllowed ? b === undefined ? 'balance-unknown' : `step${Math.floor(b / CREDITS_REPORT_STEP)}${risk}` : String(b ?? 0)}`;
  }).sort(),
});
const prev = prevState;
// ⭐ 잔액은 «경고와 무관하게» 매 틱 적어 둔다 — 안 적으면 델타의 기준선이 영영 안 생긴다.
//   ⛔ 다만 signature 는 «발송에 성공했을 때만» 전진한다(그 규율은 아래 그대로다).
const balances: Record<string, string> = {};
for (const r of codex) {
  if (typeof r.credits?.balance === 'number') {
    balances[`balance:${r.accountName}`] = String(r.credits.balance);
    // ⭐ 값과 «시각»을 같이 남긴다 — 속도(시간당 얼마)는 두 축이 있어야 나온다.
    balances[`balanceAt:${r.accountName}`] = String(nowMs);
  }
}

if (prev.signature === signature) {
  saveState({ ...prev, ...balances });
  console.log(`[codex-quota-alert] 상태 동일 — 무발송 (소진 ${exhausted.length} · 임박 ${low.length})`);
  process.exit(0);
}

if (exhausted.length === 0 && low.length === 0 && expiring.length === 0 && burning.length === 0
    && unreadable.length === 0 && !combinedCredits) {
  console.log('[codex-quota-alert] 경고 조건 없음');
  saveState({ ...prev, ...balances, signature });
  process.exit(0);
}

const lines: string[] = [];
lines.push(`🧭 정책: **${CODEX_QUOTA_POLICY_LABEL[quota.policy]}** (\`llm.codexQuotaPolicy=${quota.policy}\`${quota.source === 'legacy-credits' ? ' · 옛 codexCreditsAllowed 에서' : quota.source === 'default' ? ' · 기본값' : quota.source === 'invalid' ? ' · ⚠️ 모르는 값이라 기본값' : ''})`);
lines.push('');
// ⛔ 「못 읽음」을 맨 위에 둔다 — 아래 판정들이 «그만큼 눈이 먼» 상태임을 먼저 말해야 한다.
if (unreadable.length > 0) {
  lines.push(`⚠️ **계정 ${unreadable.length}개를 «못 읽었습니다»** — 아래 판정은 그만큼 눈이 멉니다.`);
  for (const r of unreadable) lines.push(`  • \`${r.accountName}\` — 사용률·잔여가 «둘 다» 없습니다`);
  lines.push('⛔ 이것은 「정상」이 아니라 「모름」입니다. 다음 틱에 값이 돌아오면 그때 판정이 바뀝니다.');
  lines.push('');
}
// 🔥 돈이 나가는 축을 «맨 위»에 둔다 — 소진은 멈춘 것이고 이것은 안 멈춘 것이다.
if (burning.length > 0 || combinedCredits) {
  if (creditsAllowed) {
    lines.push(burning.length > 0
      ? `💳 **크레딧으로 진행 중 — 줄고 있는 계정 ${draining.length}개** (크레딧 보유 ${burning.length}개 · 정책상 허가된 지출)`
      : '💳 **크레딧 보유 계정**');
    if (combinedCredits) lines.push(formatCreditsSummary(combinedCredits));
    if (burning.length > 0) lines.push(combinedCredits
      ? `잔액이 ${CREDITS_REPORT_STEP} 단위로 줄 때마다 한 번 알립니다. 리셋 전 고갈은 합계로 판정합니다.`
      : `잔액이 ${CREDITS_REPORT_STEP} 단위로 줄 때마다 한 번 알립니다. 🚨 표시가 있으면 리셋 전에 바닥납니다.`);
  } else {
    lines.push(`🚨 **정책 밖 지출 — 한도를 넘겼는데 크레딧에서 나가고 있습니다 (줄고 있는 계정 ${draining.length}개 · 크레딧 보유 ${burning.length}개)**`);
    lines.push(`정책이 «${CODEX_QUOTA_POLICY_LABEL[quota.policy]}» 인데 레이트리밋 오류가 안 나 회전·폴백이 안 열립니다. 크레딧을 허가하려면 \`elanous config set llm.codexQuotaPolicy credits\`.`);
  }
  for (const r of burning) {
    const now = r.credits?.balance;
    const nowText = typeof now === 'number' ? now.toFixed(2) : '미상';
    const d = drain.get(r.accountName);
    let tail: string;
    if (!d || d.state === 'unknown') tail = ' (직전 관측 없음 — 이번이 첫 표본입니다)';
    else if (d.state === 'flat') tail = ' · 크레딧 보유 · 직전 관측 이후 «안 썼습니다»';
    else {
      // ⛔ 남은 시간은 «속도를 실제로 쟀을 때만» 말한다 — 지어내면 사람이 그 수로 계획을 세운다.
      const rate = d.perHour;
      // 🩸 그리고 「N시간 뒤 0」만 내면 «겁만 준다» — 한도 창이 «먼저» 리셋되면 고갈은 «안 온다».
      //   📏 2026-09-18 실측: 고갈 예상 144시간 vs 리셋 22.5시간 ⇒ 리셋이 먼저다(고갈 안 된다).
      //   그 비교 없이 내면 사람이 「145시간 뒤 0」을 읽고 «긴급»으로 오독한다.
      //   ⇒ 「나가는 중」(늘 말할 값)과 「고갈된다」(진짜 긴급)를 «가른다».
      const etaH = rate && rate < 0 && typeof now === 'number' ? now / -rate : null;
      const resetH = hoursUntil(r.subscription?.resetsAt);
      let eta = '';
      if (etaH !== null && !combinedCredits) {
        const h = Math.max(0, Math.round(etaH));
        if (resetH !== null && resetH > 0 && resetH < etaH) {
          // 리셋이 먼저 온다 — 이 창에서 탈 양까지 «수»로 말한다.
          const burnLeft = Math.round(-(rate as number) * resetH);
          eta = ` · ⏳ 리셋(${resetH}시간 뒤)이 «먼저» 옵니다 — 이 창에서 약 ${burnLeft} 더 타고 고갈은 «안 됩니다»`;
        } else if (resetH === null) {
          eta = ` · 이 속도면 약 ${h}시간 뒤 0 (⚠️ 리셋 시각을 못 읽어 «어느 쪽이 먼저인지» 모릅니다)`;
        } else {
          eta = ` · 🚨 이 속도면 약 ${h}시간 뒤 0 — 리셋(${resetH}시간 뒤)«보다 먼저»입니다`;
        }
      }
      // ⭐ 창을 «값으로» 낸다 — 「시간당 -165」가 5분 창의 것인지 한 시간 창의 것인지가 갈린다.
      const win = d.windowMin !== undefined ? `${d.windowMin}분 창 · ` : '';
      tail = ` · 직전 대비 **${d.delta?.toFixed(2)}**`
        + (rate ? ` (${win}시간당 ${rate.toFixed(1)})` : ' (경과를 못 재 속도는 미상)') + eta;
    }
    lines.push(`  • \`${r.accountName}\` — 잔액 ${nowText}${tail}`);
  }
  lines.push('');
}
if (exhausted.length === codex.length && codex.length > 0) {
  lines.push(`${creditsAllowed ? '💳' : '🚨'} **codex 구독 한도가 «전부» 찼습니다 (${codex.length}/${codex.length})**`);
  if (creditsAllowed) lines.push('정책 «크레딧까지» — codex 를 크레딧으로 계속 씁니다. 크레딧까지 떨어지면 폴백 체인으로 갑니다.');
  else if (fallbackAllowed) lines.push(`정책 «자동 폴백» — 폴백 체인(\`llm.fallbackChain\`)으로 갑니다. 폴백 대상의 한도도 같이 보십시오.`);
  else lines.push('정책 «한도 안에서만» — codex 작업은 리셋까지 «멈춥니다»(폴백·크레딧 없음).');
} else if (exhausted.length > 0) {
  lines.push(`⚠️ **codex 계정 ${exhausted.length}/${codex.length} 한도 참** — 남은 계정으로 회전합니다`);
}
for (const r of exhausted) {
  const h = hoursUntil(r.subscription?.resetsAt);
  lines.push(`  • \`${r.accountName}\` — 잔여 0% · 리셋 ${h === null ? '시각 미상' : `${h}시간 뒤`}`);
}
for (const r of low) {
  const h = hoursUntil(r.subscription?.resetsAt);
  lines.push(`  • \`${r.accountName}\` — 잔여 ${r.subscription?.remainingPercent}% · 리셋 ${h === null ? '미상' : `${h}시간 뒤`}`);
}
if (expiring.length > 0) {
  lines.push('');
  lines.push(`💳 **리셋권 만료 임박 (${RESET_CREDIT_EXPIRY_DAYS}일 이내)**`);
  for (const r of expiring) lines.push(`  • \`${r.accountName}\` — ${daysUntil(r.resetCredits?.expiresAt)}일 뒤`);
}
if (others.length > 0 && fallbackAllowed) {
  lines.push('');
  lines.push(creditsAllowed ? '폴백 대상(크레딧까지 떨어진 뒤):' : '폴백 대상:');
  for (const r of others) {
    const rem = r.subscription?.remainingPercent;
    const used = r.credits?.usedPercent;
    lines.push(`  • \`${r.provider}/${r.accountName}\` — ${rem !== undefined ? `잔여 ${rem}%` : used !== undefined ? `사용 ${used}%` : '미상'}`);
  }
}
lines.push('');
lines.push('⛔ 잔액 숫자는 provider 가 준 값 그대로입니다 — 토큰을 달러로 바꾸는 자는 아직 없습니다.');

const msg = lines.join('\n');
console.log(msg);
if (sendOutbound(msg, 'alert')) {
  saveState({ ...prev, ...balances, signature });
  console.log('\n✅ 텔레그램 발송');
} else {
  // ⛔ 발송 실패면 signature 를 «저장하지 않는다» — 다음 틱에 다시 시도해야 한다.
  // 🩸 그런데 «잔액은 저장한다». 종전엔 여기서 통째로 안 저장해서, 발송이 막힌 동안
  //   ***델타의 기준선이 얼어붙고 「직전 대비」가 「마지막 성공 발송 대비」로 «조용히» 둔갑***했다.
  //   📏 실측 2026-09-18: 50초 간격 두 번에 -12.41 → -12.55 로 «거의 안 움직였고» 속도는 영영 「미상」이었다.
  //   ⇒ 이 파일 머리의 규율(「잔액은 경고와 무관하게 매 틱 적는다」)이 «이 갈래에만» 안 걸려 있었다.
  saveState({ ...prev, ...balances });
  console.error('발송 실패(/v1/outbound + 텔레그램 직접 모두 실패) — 잔액 기준선은 갱신했다');
  process.exit(1);
}
}

export async function main(
  dependencies: {
    ensureCronNodePath?: () => void;
    registerStandaloneLogSink?: (surface: string) => Promise<boolean>;
    runCodexQuotaAlert?: () => void | Promise<void>;
    error?: (line: string) => void;
  } = {},
): Promise<void> {
  (dependencies.ensureCronNodePath ?? ensureCronNodePath)();
  try {
    if (!await (dependencies.registerStandaloneLogSink ?? registerStandaloneLogSink)('codex-quota-alert')) {
      (dependencies.error ?? console.error)('⚠️ registerStandaloneLogSink(codex-quota-alert) failed; continuing quota poll');
    }
  } catch (sinkError) {
    (dependencies.error ?? console.error)(`⚠️ registerStandaloneLogSink(codex-quota-alert) failed; continuing quota poll: ${sinkError instanceof Error ? sinkError.message : String(sinkError)}`);
  }
  await (dependencies.runCodexQuotaAlert ?? runCodexQuotaAlert)();
}

if (import.meta.main) await main();
