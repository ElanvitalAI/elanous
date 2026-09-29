import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { debug, redactSecretText } from '../debug/log.js';
import { callJev, resolveJevAccess, type JevRequest, type JevResponse } from './jev.js';

export interface BoundaryShadowConfig {
  enabled?: boolean;
  sampleRate?: number;
  endpoint?: string;
  keyFile?: string;
  model?: string;
  /** «되돌릴 수 없다»로 볼 Jev 확률 하한 — 기본 0.7. */
  threshold?: number;
}

export interface BoundaryShadowDeps {
  random?: () => number;
  callJev?: (request: JevRequest, key: string | undefined, fetchImpl: typeof fetch, endpoint: string) => Promise<JevResponse>;
  fetch?: typeof fetch;
  log?: (category: string, event: string, data: Record<string, unknown>, level?: 'info' | 'warn') => void;
  /** 사용량 원장(`llm.usage`) 기록 — 기본은 llm.ts 의 logAgentTurnUsage(역할 classify · site jev-boundary-shadow). */
  logUsage?: (model: string, usage: { inputTokens?: number; outputTokens?: number }) => void;
  now?: () => number;
}

const MASK = '[REDACTED]';
const SECRET_KEY = /(?:authorization|api[-_]?key|password|passwd|secret|private[-_]?key|(?:access|refresh|session|bot)[-_]?token|token|cookie|credentials)/i;

/** Remove credentials from both structured fields and free-form request text before it leaves the process. */
function maskBoundaryValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    return redactSecretText(value)
      .replace(/\bBearer\s+[^\s"']+/gi, `Bearer ${MASK}`)
      .replace(/("(?:api[-_]?key|password|secret|token|authorization)"\s*:\s*")[^"]*(")/gi, `$1${MASK}$2`)
      .replace(/\b((?:api[-_]?key|password|secret|token|authorization)\s*[:=]\s*)[^\s,"'}]+/gi, `$1${MASK}`)
      .replace(/\bsk-[a-zA-Z0-9_-]{8,}\b/g, MASK)
      // 셸 인자 모양(2026-09-28 🅞 누수 탐침): URL 자격 · -u 사용자:비밀 · --token 값(공백·= 둘 다) · 쿠키 값.
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@'"]+:[^/\s@'"]+@/gi, `$1${MASK}@`)
      .replace(/(\s(?:-u|--user)(?:\s+|=))(['"]?)[^\s'"]+\2/g, `$1${MASK}`)
      .replace(/(\s--?(?:[a-z0-9]+-)*(?:token|api-?key|apikey|password|passwd|secret|auth|cookie|credentials?)(?:\s+|=))(['"]?)[^\s'"]+\2/gi, `$1${MASK}`)
      .replace(/(\s(?:-b|--cookie)\s+)(['"]?)[^'"]*\2/g, `$1${MASK}`);
  }
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '<circular>';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => maskBoundaryValue(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const sensitiveKey = SECRET_KEY.test(key);
    return [sensitiveKey ? MASK : maskBoundaryValue(key),
      sensitiveKey ? MASK : maskBoundaryValue(item, seen)];
  }));
}

/** Advisory only: never changes the code boundary verdict or the response sent to the caller. */
export async function shadowBoundaryDecision<T extends { requestId?: string; requestKind?: string }>(
  request: T,
  verdict: { wouldApprove?: boolean; approve?: boolean; requestKind?: string; evidenceWhy?: string },
  config?: BoundaryShadowConfig,
  deps: BoundaryShadowDeps = {},
): Promise<void> {
  if (config?.enabled !== true || request.requestKind !== 'rejected' || verdict.requestKind !== 'rejected') return;
  const rate = config.sampleRate ?? 1;
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1 || (rate < 1 && (deps.random ?? Math.random)() >= rate)) return;

  const log = deps.log ?? ((category: string, event: string, data: Record<string, unknown>, level?: 'info' | 'warn') => debug.log(category, event, data, level ? { level } : undefined));
  const safeRequestId = maskBoundaryValue(request.requestId) as string | undefined;
  const emit = (event: string, data: Record<string, unknown>, level?: 'info' | 'warn') => {
    try { log('decide.boundary-shadow', event, maskBoundaryValue({ ...data, requestId: safeRequestId }) as Record<string, unknown>, level); } catch { /* observation must not affect the boundary */ }
  };
  const now = deps.now ?? Date.now;
  const startedAt = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const fetchWithAbort = ((input: RequestInfo | URL, init?: RequestInit) =>
    (deps.fetch ?? fetch)(input, { ...init, signal: controller.signal })) as typeof fetch;
  try {
    const access = resolveJevAccess({
      config,
      env: process.env,
      readFile: (path) => { try { return readFileSync(path, 'utf8'); } catch { return undefined; } },
      typesafeCachePath: join(homedir(), '.cache', 'typesafe_api_key'),   // same file as src/index.ts · headless-elanous-driver.ts
    });
    if (!access.ok) { emit('failed', { reason: 'credentials-unavailable' }); return; }
    const state = maskBoundaryValue({ request, verdict: {
      requestKind: verdict.requestKind, evidenceWhy: verdict.evidenceWhy,
    } });
    const response = await Promise.race([
      (deps.callJev ?? callJev)({
        state,
        questions: {
          irreversible: { type: 'noul', instructions: '이 셸 명령을 실행하면 되돌릴 수 없는 변화(파일·브랜치·원격·데이터 삭제나 덮어쓰기, 강제 푸시 등)가 생기는가?', criteria: {
            true: '되돌릴 수 없는 변화가 생긴다', false: '되돌릴 수 있다(읽기·재생성 가능한 산출 등)',
          } },
        },
        ...(access.access.model ? { model: access.access.model } : {}),
      }, access.access.key, fetchWithAbort, access.access.endpoint),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new Error('Jev shadow timeout')); controller.abort(); }, 5_000);
      }),
    ]);
    const jevYes = response.answers.irreversible?.noul;
    if (typeof jevYes !== 'number' || !Number.isFinite(jevYes)) { emit('failed', { reason: 'no-answer' }); return; }
    const threshold = typeof config.threshold === 'number' && config.threshold > 0 && config.threshold < 1 ? config.threshold : 0.7;
    const allowlistApprove = verdict.wouldApprove === true;
    const irreversible = jevYes >= threshold;
    const judged = {
      requestKind: verdict.requestKind, decidingToken: (request as { decidingToken?: string }).decidingToken, evidenceWhy: verdict.evidenceWhy,
      allowlistApprove, jevYes, irreversible, agree: allowlistApprove === !irreversible, threshold,
      confidence: response.answers.irreversible?.confidence, latencyMs: now() - startedAt, model: response.model,
    };
    emit('judged', judged);
    // 핵심 지표: 허용목록이 막았는데 되돌릴 수 있는 명령(오탐 차단) · 반대로 통과시켰는데 되돌릴 수 없는 명령(경고).
    if (!allowlistApprove && !irreversible) emit('safe-but-blocked', judged);
    if (allowlistApprove && irreversible) emit('warn-disagree', judged, 'warn');
    if (response.usage) {
      try {
        const usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
        if (deps.logUsage) deps.logUsage(response.model, usage);
        else {
          const { logAgentTurnUsage } = await import('../llm.js');
          logAgentTurnUsage(response.model, usage, { providerName: 'typesafe', site: 'jev-boundary-shadow', role: 'classify' });
        }
      } catch { /* usage observation must not affect the boundary */ }
    }
  } catch (error) {
    emit('failed', { reason: error instanceof Error && error.message === 'Jev shadow timeout' ? 'timeout' : 'request-failed' });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
