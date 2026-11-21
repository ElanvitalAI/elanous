// DEMO-RESEARCH-MARKET-DATA — a research turn whose plan route says `topic: "market"` asks the market-data capability
// nodes (quote · daily bars · KR investor flow) for numbers BEFORE any number is quoted; web search stays supplementary.
// Evidence carries value · date · provider name only. Every provider attempt leaves a `research.market-data` event
// (complete | skipped | failed) with provider · contract · duration · fixed reason code — never a value, key or error text,
// so «called zero times» and «called but not logged» can be told apart.
import type { ResearchEvidenceEnvelope } from '../auto-research/question-ladder-contract.js';
import { dispatchGraphContract, type GraphCapabilityProviderDeclaration, type GraphCapabilityRegistry } from '../graph-runner/capabilities.js';
import { createDefaultMarketDataRegistry } from '../graph-runner/capability-providers/market-data/registry.js';
import { MissingMarketCredentialError } from '../graph-runner/capability-providers/market-data/market-secrets.js';
import { debug } from '../debug/log.js';

export const MARKET_DATA_SOURCE_KIND_PREFIX = 'market-data:';
export const MARKET_DATA_NO_SOURCE_LINE = '시세·수급 출처를 확보하지 못함 — 숫자 추정 금지';
export const MARKET_DATA_NUMBER_RULE = '숫자는 market-data evidence 에서만 인용 · 웹 snippet 숫자는 미검증 표기';

export interface MarketDataCall {
  provider: string;
  contract: string;
  outcome: 'checked' | 'started' | 'complete' | 'skipped' | 'failed' | 'no-attempt';
  durationMs: number;
  /** Fixed code only (credential-missing · unavailable · invalid_input · provider_failed · unprovided …). */
  reason?: string;
}

export interface MarketEvidenceDeps {
  /** Default: the production registry (constructing it makes no request). Tests inject declarations with fixed fetchers. */
  registry?: GraphCapabilityRegistry;
  dispatch?: typeof dispatchGraphContract;
  now?: () => number;
  signal?: AbortSignal;
  runId?: string;
}

export interface MarketEvidenceResult {
  evidence: ResearchEvidenceEnvelope[];
  calls: MarketDataCall[];
  /** Providers whose availability check was entered, including skipped candidates. */
  checkedProviderIds: string[];
  /** Providers whose invoke function was entered; availability checks alone do not count. */
  invokedProviderIds: string[];
}

const DAY_MS = 86_400_000;
// 출처: #110868 데모 검색 실측 ② — 일봉은 «최근 흐름» 확인용으로 한 달 창이면 충분하다(가격 판단 근거가 아니라 대조용).
const OHLCV_WINDOW_DAYS = 30;
// 출처: #110868 데모 검색 실측 ② — 답에 실을 최근 봉 수; 값 전체를 싣지 않고 대조 가능한 최신 몇 개만 남긴다.
const OHLCV_BARS_SHOWN = 5;
const FIXED_REASON = /^[A-Za-z0-9_-]{1,48}$/;

function isoDay(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }

/** A provider's error string is free text; only a short code-shaped token is kept for the log and the evidence. */
function reasonCode(error: unknown): string {
  return typeof error === 'string' && FIXED_REASON.test(error) ? error : 'provider-error';
}

function marketOf(symbol: string): 'KR' | 'US' { return /^\d{6}$/.test(symbol) ? 'KR' : 'US'; }

function contractsFor(symbol: string): string[] {
  return marketOf(symbol) === 'KR'
    ? ['market.quote@1', 'market.ohlcv@1', 'market.kr-flow@1']
    : ['market.quote@1', 'market.ohlcv@1'];
}

/** Wrap each declaration so dispatch's silent availability skip and each invocation become observable records. */
function observedRegistry(registry: GraphCapabilityRegistry, now: () => number,
  contract: string, record: (call: MarketDataCall) => void, logCheck: (call: MarketDataCall) => void,
  onInvoke: (provider: string, contract: string) => void): GraphCapabilityRegistry {
  const providers = registry.providers.map((provider): GraphCapabilityProviderDeclaration => ({
    ...provider,
    // keyEnv is folded into `available` so a missing credential is recorded instead of skipped silently.
    keyEnv: undefined,
    available: async () => {
      logCheck({ provider: provider.id, contract, outcome: 'checked', durationMs: 0 });
      const envOk = !provider.keyEnv?.length || provider.keyEnv.some((name) => process.env[name]?.trim());
      if (!envOk) { record({ provider: provider.id, contract, outcome: 'skipped', durationMs: 0, reason: 'credential-missing' }); return false; }
      if (!provider.available) return true;
      try {
        if (await provider.available()) return true;
      } catch (error) {
        if (error instanceof MissingMarketCredentialError) {
          record({ provider: provider.id, contract, outcome: 'skipped', durationMs: 0, reason: 'credential-missing' });
          return false;
        }
        record({ provider: provider.id, contract, outcome: 'failed', durationMs: 0, reason: 'availability-error' });
        return false;
      }
      record({ provider: provider.id, contract, outcome: 'skipped', durationMs: 0, reason: 'unavailable' });
      return false;
    },
    invoke: async (context) => {
      const startedAt = now();
      const contract = typeof context.requires === 'string' ? context.requires : provider.provides[0] ?? 'unknown';
      onInvoke(provider.id, contract);
      try {
        const result = await provider.invoke(context);
        record({ provider: provider.id, contract, outcome: result.ok ? 'complete' : 'failed',
          durationMs: Math.max(0, now() - startedAt), ...(result.ok ? {} : { reason: reasonCode(result.error) }) });
        return result;
      } catch (error) {
        record({ provider: provider.id, contract, outcome: 'failed', durationMs: Math.max(0, now() - startedAt), reason: 'provider-error' });
        throw error;
      }
    },
  }));
  return { ...registry, providers };
}

function num(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}

/** Value · date · provider only. Returns undefined when the result lacks the fields the contract guarantees. */
export function marketResultToContent(contract: string, result: unknown): { content: string; provider: string; units?: string } | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const row = result as Record<string, unknown>;
  const provider = typeof row.source === 'string' && row.source.trim() ? row.source.trim() : undefined;
  const symbol = typeof row.symbol === 'string' ? row.symbol : undefined;
  if (!provider || !symbol) return undefined;
  if (contract === 'market.quote@1') {
    const price = num(row.price);
    if (!price || typeof row.asOf !== 'string' || typeof row.currency !== 'string') return undefined;
    return { provider, units: row.currency, content: `${symbol} quote ${price} ${row.currency} · as of ${row.asOf} · provider ${provider}` };
  }
  if (contract === 'market.ohlcv@1') {
    if (!Array.isArray(row.bars) || row.bars.length === 0) return undefined;
    const bars = row.bars.slice(-OHLCV_BARS_SHOWN).flatMap((raw) => {
      const bar = raw as Record<string, unknown>;
      const close = num(bar?.close);
      const volume = num(bar?.volume);
      return typeof bar?.date === 'string' && close && volume ? [`${bar.date} close ${close} volume ${volume}`] : [];
    });
    if (bars.length === 0) return undefined;
    return { provider, content: `${symbol} daily bars (latest ${bars.length}): ${bars.join('; ')} · provider ${provider}` };
  }
  if (contract === 'market.kr-flow@1') {
    const foreign = num(row.foreignNetVolume);
    const institution = num(row.institutionNetVolume);
    if (!foreign || !institution || typeof row.asOf !== 'string') return undefined;
    return { provider, content: `${symbol} investor net volume: foreign ${foreign}, institution ${institution} · as of ${row.asOf} · provider ${provider}` };
  }
  return undefined;
}

function logCall(call: MarketDataCall, runId: string | undefined): void {
  try {
    debug.log('research.market-data', call.outcome, {
      ...(runId ? { runId } : {}), provider: call.provider, contract: call.contract, durationMs: call.durationMs,
      ...(call.reason ? { reason: call.reason } : {}),
    }, call.outcome === 'failed' ? { level: 'warn' } : undefined);
  } catch { /* observation is fail-soft */ }
}

/** Collect market-data evidence for the plan's symbols. Never throws; a provider that is unavailable is recorded, not fatal. */
export async function marketEvidence(
  symbols: readonly string[],
  questionId: string,
  deps: MarketEvidenceDeps = {},
): Promise<MarketEvidenceResult> {
  const now = deps.now ?? Date.now;
  const calls: MarketDataCall[] = [];
  const evidence: ResearchEvidenceEnvelope[] = [];
  const checkedProviders = new Set<string>();
  const invokedProviders = new Set<string>();
  const checkedProviderIds = (): string[] => [...checkedProviders];
  const invokedProviderIds = (): string[] => [...invokedProviders];
  const record = (call: MarketDataCall): void => { calls.push(call); logCall(call, deps.runId); };
  const dispatch = deps.dispatch ?? dispatchGraphContract;
  let base: GraphCapabilityRegistry;
  try { base = deps.registry ?? createDefaultMarketDataRegistry(); }
  catch {
    record({ provider: 'none', contract: 'registry', outcome: 'failed', durationMs: 0, reason: 'registry-unavailable' });
    return { evidence, calls, checkedProviderIds: checkedProviderIds(), invokedProviderIds: invokedProviderIds() };
  }
  const scope = deps.runId ?? 'research-turn';
  const to = now();
  const from = to - OHLCV_WINDOW_DAYS * DAY_MS;
  const jobs = symbols.flatMap((symbol) => contractsFor(symbol).map((contract) => ({ symbol, contract })));
  if (jobs.length === 0) {
    logCall({ provider: 'none', contract: 'market-data', outcome: 'no-attempt', durationMs: 0, reason: 'no-symbols' }, deps.runId);
    return { evidence, calls, checkedProviderIds: checkedProviderIds(), invokedProviderIds: invokedProviderIds() };
  }
  await Promise.all(jobs.map(async ({ symbol, contract }) => {
    const input = { market: marketOf(symbol), symbol, ...(contract === 'market.ohlcv@1' ? { from: isoDay(from), to: isoDay(to) } : {}) };
    const startedAt = now();
    // Per-job observation: concurrent jobs share `calls`, so attempts are counted job-locally.
    let attempts = 0;
    const registry = observedRegistry(base, now, contract, (call) => { attempts++; record(call); },
      (call) => { checkedProviders.add(call.provider); logCall(call, deps.runId); }, (provider, invokedContract) => {
        invokedProviders.add(provider);
        logCall({ provider, contract: invokedContract, outcome: 'started', durationMs: 0 }, deps.runId);
      });
    try {
      const outcome = await dispatch(contract, {
        graphId: scope, runId: scope, nodeId: contract, requires: contract as `${string}.${string}@${number}`,
        input, outputs: {},
      }, registry, { ...(deps.signal ? { signal: deps.signal } : {}) });
      const converted = outcome.ok ? marketResultToContent(contract, outcome.result) : undefined;
      if (converted) {
        evidence.push({
          questionId, sourceKind: `${MARKET_DATA_SOURCE_KIND_PREFIX}${converted.provider}`,
          source: `${converted.provider}:${contract}:${symbol}`, observedAt: new Date(now()).toISOString(),
          ...(converted.units ? { units: converted.units } : {}),
          content: converted.content, outcome: 'complete', truncated: false,
        });
      } else if (attempts === 0) {
        // No provider was even attempted (nothing registered for the contract, every candidate unavailable and silent).
        record({ provider: 'none', contract, outcome: outcome.ok ? 'failed' : 'skipped', durationMs: Math.max(0, now() - startedAt),
          reason: outcome.ok ? 'unusable-result' : reasonCode(outcome.error) });
      } else if (outcome.ok) {
        record({ provider: 'none', contract, outcome: 'failed', durationMs: Math.max(0, now() - startedAt), reason: 'unusable-result' });
      }
    } catch {
      record({ provider: 'none', contract, outcome: 'failed', durationMs: Math.max(0, now() - startedAt), reason: 'dispatch-error' });
    }
  }));
  return { evidence, calls, checkedProviderIds: checkedProviderIds(), invokedProviderIds: invokedProviderIds() };
}

/** Structured attempt summary carried from provider dispatch to the final answer. */
export function formatMarketAttemptSummary(result: MarketEvidenceResult): string {
  const checkedCount = result.checkedProviderIds.length;
  const invokedCount = result.invokedProviderIds.length;
  const reasons = [...new Set(result.calls.filter((call) => call.outcome !== 'complete' && call.reason)
    .sort((a, b) => Number(a.provider === 'none') - Number(b.provider === 'none'))
    .map((call) => `${call.provider}/${call.reason}`))];
  return `시세 공급자 ${checkedCount}곳 검사 · 실제 호출 ${invokedCount}곳 · 실패 이유: ${reasons.join(', ') || (result.calls.length === 0 ? 'no-symbols' : '없음')}`;
}

/** Section appended to the research output so the synthesis sees the numbers' provenance (names · values · dates only). */
export function formatMarketDataSection(result: MarketEvidenceResult, formatLine: (item: ResearchEvidenceEnvelope) => string): string {
  const lines = ['## Market data (market-data capability)', `Rule: ${MARKET_DATA_NUMBER_RULE}.`, formatMarketAttemptSummary(result)];
  if (result.evidence.length === 0) lines.push(MARKET_DATA_NO_SOURCE_LINE);
  for (const item of result.evidence) lines.push(formatLine(item));
  const seen = new Set<string>();
  for (const call of result.calls) {
    if (call.outcome === 'complete') continue;
    const line = `- [${call.outcome === 'skipped' ? '건너뜀' : '실패'}] ${call.provider} · ${call.contract}${call.reason ? ` · ${call.reason}` : ''}`;
    if (!seen.has(line)) { seen.add(line); lines.push(line); }
  }
  return lines.join('\n');
}

const NUMBER_TOKEN = /\d[\d,]*(?:\.\d+)?/g;

function numericTokens(text: string): string[] {
  return (text.replace(/https?:\/\/\S+/gi, ' ').match(NUMBER_TOKEN) ?? []).map((token) => token.replace(/,/g, '').replace(/\.$/, ''));
}

/** A calendar year is a label, not a figure; a bare short integer is a list index or a count word, not a market number. */
function worthChecking(token: string): boolean {
  if (/^(?:19|20)\d{2}$/.test(token)) return false;
  return token.includes('.') || token.length >= 3;
}

/** Numbers in `answer` that match no market-data evidence value or date. Pure; display only, never a block. */
export function findUnverifiedNumbers(answer: string, marketEvidenceTexts: readonly string[]): string[] {
  const known = new Set(marketEvidenceTexts.flatMap(numericTokens).map(Number));
  const unverified: string[] = [];
  for (const token of numericTokens(answer)) {
    if (!worthChecking(token) || known.has(Number(token)) || unverified.includes(token)) continue;
    unverified.push(token);
  }
  return unverified;
}

/** Append one warning line listing unverified numbers. An empty market evidence set still requires an explicit no-source notice. */
export function appendUnverifiedNumberWarning(answer: string, marketEvidenceTexts: readonly string[] | undefined): string {
  if (!marketEvidenceTexts) return answer;
  const checkedAnswer = marketEvidenceTexts.length === 0 && !answer.includes(MARKET_DATA_NO_SOURCE_LINE)
    ? `${answer.trimEnd()}\n\n${MARKET_DATA_NO_SOURCE_LINE}` : answer;
  const unverified = findUnverifiedNumbers(answer, marketEvidenceTexts);
  if (unverified.length === 0) return checkedAnswer;
  const shown = unverified.slice(0, 8).join(', ');
  return `${checkedAnswer.trimEnd()}\n\n> ⚠ 미검증 숫자(market-data 시세·수급 evidence 와 대조되지 않음; 웹 출처 또는 계산값일 수 있음): ${shown}${unverified.length > 8 ? ' 외' : ''}`;
}
