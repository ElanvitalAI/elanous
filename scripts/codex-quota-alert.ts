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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ensureCronNodePath } from '../src/domains/cron-path.js';
import { registerStandaloneLogSink } from '../src/domains/standalone-log-sink.js';
import { getUserConfig } from '../src/user-config.js';
import { buildLlmBudgetAlert, type LlmBudgetSnapshot } from '../src/notify/llm-budget-alert.js';
import { creditPaceStatus, recordCreditBalances } from '../src/budget/codex-credit-pace.js';
import { loadLlmPolicy } from '../src/policy/llm-policy.js';
import { DEFAULT_FALLBACK_CHAIN } from '../src/oauth/fallback-chain.js';
import {
  codexPolicyAllowsCredits, codexPolicyAllowsFallback, resolveCodexQuotaPolicy,
} from '../src/oauth/codex-quota-policy.js';

const STATE = join(homedir(), '.elanous/conatus/codex_quota_alert_state.json');
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
function loadState(path = STATE): Record<string, string> {
  try { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>; } catch { return {}; }
}
function saveState(s: Record<string, string>, path = STATE): void {
  try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(s, null, 1)); }
  catch { /* 상태 저장 실패가 발송을 막지 않는다 */ }
}

export async function runCodexQuotaAlert(deps: { readUsage?: typeof readUsage; statePath?: string; send?: typeof sendOutbound } = {}): Promise<void> {
const send = deps.send ?? sendOutbound;
const usage = (deps.readUsage ?? readUsage)();
const load = () => loadState(deps.statePath);
const save = (s: Record<string, string>) => saveState(s, deps.statePath);
if ('error' in usage) {
  // ⛔ 「못 쟀다」도 알린다 — 조회가 죽은 채로 조용하면 한도 경고가 «영영» 안 온다.
  const key = 'usage-unreadable';
  const prev = load();
  if (prev[key] !== usage.error && send(`⚠️ **LLM 한도 조회가 실패했습니다** — 경고가 이 상태로는 안 옵니다.\n\n사유: \`${usage.error}\``, 'alert')) {
    save({ ...prev, [key]: usage.error });
  }
  process.exit(0);
}

// 대표 2026-09-28 한도 정책(`llm.codexQuotaPolicy`) — 알림 문구·발송 기준이 «설정된 정책»을 따른다.
let quota = resolveCodexQuotaPolicy(undefined);
let configuredFallback: string[] | undefined;
try {
  const llm = getUserConfig().llm;
  quota = resolveCodexQuotaPolicy(llm);
  configuredFallback = llm.fallbackChain;
} catch { /* 못 읽으면 기본(fallback) */ }
const creditsAllowed = codexPolicyAllowsCredits(quota.policy);
const fallbackAllowed = codexPolicyAllowsFallback(quota.policy);

const codex = usage.rows.filter((r) => r.provider === 'codex');
const others = usage.rows.filter((r) => r.provider !== 'codex');
const unreadableCount = codex.filter((r) => typeof r.subscription?.remainingPercent !== 'number'
  || !Number.isFinite(r.subscription.remainingPercent)).length;
const knownExhausted = codex.filter((r) => typeof r.subscription?.remainingPercent === 'number'
  && Number.isFinite(r.subscription.remainingPercent) && r.subscription.remainingPercent <= 0);
const knownLow = codex.filter((r) => typeof r.subscription?.remainingPercent === 'number'
  && Number.isFinite(r.subscription.remainingPercent) && r.subscription.remainingPercent > 0 && r.subscription.remainingPercent <= 10);
const exhausted = codex.length > 0 && unreadableCount === 0 && knownExhausted.length === codex.length;
const creditAvailable = codex.some((r) => r.credits?.hasCredits === true && typeof r.credits.balance === 'number' && r.credits.balance > 0);
const fallback = fallbackAllowed ? others.find((r) =>
  (configuredFallback ?? DEFAULT_FALLBACK_CHAIN).some((step) => step === r.provider)
  && typeof r.subscription?.remainingPercent === 'number' && Number.isFinite(r.subscription.remainingPercent)
  && r.subscription.remainingPercent > 0) : undefined;

const nowMs = Date.now();
const prevState = load();

const balances: Record<string, string> = {};
const creditBalances: Record<string, number> = {};
for (const r of codex) {
  if (typeof r.credits?.balance === 'number') {
    creditBalances[r.accountName] = r.credits.balance;
    balances[`balance:${r.accountName}`] = String(r.credits.balance);
    // ⭐ 값과 «시각»을 같이 남긴다 — 속도(시간당 얼마)는 두 축이 있어야 나온다.
    balances[`balanceAt:${r.accountName}`] = String(nowMs);
  }
}
try { recordCreditBalances(creditBalances, new Date(nowMs)); }
catch { /* 날짜 원장 저장 실패는 기존 알림의 발송을 막지 않는다 */ }

let policy;
try { policy = loadLlmPolicy({ now: new Date(nowMs) }); }
catch { policy = undefined; }
let pace;
try {
  if (policy?.valid) pace = creditPaceStatus({ policy: policy.policy, balances: creditBalances, now: new Date(nowMs) });
} catch { /* 페이스 조회 실패도 잔액 기록·알림 발송을 막지 않는다 */ }
const resetExpiry = codex.map((r) => r.resetCredits?.status === 'available' ? r.resetCredits.expiresAt : undefined)
  .filter((date): date is string => typeof date === 'string' && Number.isFinite(Date.parse(date)) && Date.parse(date) >= nowMs)
  .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
const expiresAt = [
  ...(policy?.valid ? policy.policy.credits.grants
    .filter((grant) => grant.expires >= new Date(nowMs).toISOString().slice(0, 10))
    .map((grant) => `${grant.expires}T15:00:00Z`) : []),
  ...(resetExpiry ? [resetExpiry] : []),
].sort((a, b) => Date.parse(a) - Date.parse(b))[0];
const snapshot: LlmBudgetSnapshot = {
  at: new Date(nowMs).toISOString(),
  credits: {
    total: codex.reduce((sum, r) => sum + (typeof r.credits?.balance === 'number' && Number.isFinite(r.credits.balance) ? r.credits.balance : 0), 0),
    usedToday: pace?.todaySpent ?? 0,
    paceTarget: pace?.target ?? 0,
    ...(expiresAt ? { expiresAt } : {}),
    ...(policy?.valid && policy.policy.credits.codex === 'use' && policy.policy.credits.pace?.until
      && nowMs < Date.parse(`${policy.policy.credits.pace.until}T15:00:00Z`) ? { useFirst: true } : {}),
  },
  accounts: codex.map((r) => ({
    name: r.accountName,
    subscriptionRemainingPct: r.subscription?.remainingPercent,
    credits: r.credits?.balance,
    resetInHours: hoursUntil(r.subscription?.resetsAt) ?? undefined,
  })),
  selected: { reason: exhausted
    ? creditsAllowed && creditAvailable ? 'credits' : fallback ? 'fallback' : 'none'
    : 'subscription' },
  ...(fallback && exhausted && !(creditsAllowed && creditAvailable) ? { fallback: {
    provider: fallback.provider,
    remainingPct: fallback.subscription?.remainingPercent,
  } } : {}),
};
const knownAlerts = [...knownExhausted, ...knownLow].map((r) =>
  `${r.accountName}:${r.subscription!.remainingPercent}`).sort();
const unreadableAccounts = codex.filter((r) => typeof r.subscription?.remainingPercent !== 'number'
  || !Number.isFinite(r.subscription.remainingPercent)).map((r) => r.accountName).sort();
const unreadableKey = knownAlerts.length > 0
  ? `unreadable:${unreadableAccounts.join(',')}:${knownAlerts.join(',')}`
  : unreadableAccounts.length > 1 ? `unreadable:${unreadableAccounts.join(',')}` : 'unreadable';
const alertKey = unreadableCount > 0 && prevState.nt1Key === unreadableKey ? undefined : prevState.nt1Key;
const budgetAlert = buildLlmBudgetAlert(snapshot, alertKey);
// 정책 밖 지출(리뷰 3라운드 must-fix) — 정책이 크레딧을 허가하지 않는데 직전 관측보다 잔액이 줄었다.
//   NT1 모양의 다른 상태보다 앞선다(행동이 필요한 유일한 «사고»). 같은 날이라도 잔액이 한 단계 더 줄면 다시 알린다.
const offPolicyDraining = creditsAllowed ? [] : codex.filter((r) => {
  const before = Number(prevState[`balance:${r.accountName}`]);
  return typeof r.credits?.balance === 'number' && Number.isFinite(before) && r.credits.balance < before;
});
const offPolicyStep = policy?.valid ? policy.policy.alerts.creditsStep : 5000;
const offPolicyKey = offPolicyDraining.length > 0
  ? `off-policy:${new Date(nowMs + 9 * 3600_000).toISOString().slice(0, 10)}:${Math.floor(snapshot.credits.total / Math.max(1, offPolicyStep))}`
  : undefined;
const offPolicyAlert = offPolicyKey ? {
  send: prevState.nt1Key !== offPolicyKey,
  key: offPolicyKey,
  text: `🚨 정책 밖 지출 — 한도를 넘겼는데 크레딧에서 나가고 있습니다(줄고 있는 계정 ${offPolicyDraining.length}개).\n남은 크레딧 ${Math.round(snapshot.credits.total).toLocaleString('en-US')}.\n할 일: 허가하려면 \`elanous config set llm.codexQuotaPolicy credits\`, 아니면 크레딧 지출을 멈추세요.`,
} : undefined;
const alert = offPolicyAlert ?? (budgetAlert.key !== 'ok' || unreadableCount === 0 ? budgetAlert : {
  send: prevState.nt1Key !== unreadableKey,
  key: unreadableKey,
  text: `⚠️ 일부 codex 계정의 구독 한도를 읽지 못했습니다.${knownExhausted.length > 0 ? ` 확인된 ${knownExhausted.length}개 계정은 한도가 소진됐습니다.` : knownLow.length > 0 ? ` 확인된 ${knownLow.length}개 계정은 잔여가 10% 이하입니다.` : ''}\n할 일: 한도 조회 상태를 확인해 주세요.`,
});
const state = { ...prevState, ...balances };
if (!alert.send) {
  if (alert.key === 'ok') delete state.nt1Key;
  save(state);
  console.log('[codex-quota-alert] NT1 상태 동일 또는 경고 조건 없음 — 무발송');
  return;
}
console.log(alert.text);
if (send(alert.text, 'alert')) {
  save({ ...state, nt1Key: alert.key });
  console.log('\n✅ 텔레그램 발송');
} else {
  save(state);
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
