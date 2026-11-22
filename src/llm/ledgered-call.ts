// LLM-CALL-COST-LEDGER (OP #132226 · #132275) — "모든 LLM 호출이 llm.usage 원장(logAgentTurnUsage)에 행을 남긴다".
//
// streamLLM 래퍼 경로는 이미 기록한다(llm.ts:5205 성공 usage · 5228 실패 unmeasured ·
// 10074 완료됐으나 usage 없는 턴 = 명시적 unmeasured 행). 이 모듈은 그 «명시적 행»
// 패턴을 래퍼 밖 경로로 일반화한다:
//   • streamChatLedgered — provider.streamChat 을 직접 소비하는 곁가지(domains 7종)용.
//     제너레이터가 소비되기 전엔 행이 없고, 정상 종료·예외·조기 break 모두에서
//     정확히 1행. 스트림에 usage 이벤트가 실려 오면 그 실측치로, 아니면
//     unmeasured(unknown 비용 — 절대 $0 이 아님)로.
//   • logUnmeteredRow — raw fetch(llmNetworkFetch/llmNetworkSend/fetchImpl) 지점용
//     1행 래퍼. 실패 경로는 missingReason 'provider-call-failed'.
// ⛔ 팩토리(getProvider/getProviderForConfig) wrap 금지 — streamLLM 이 내부적으로
//   provider.streamChat 을 쓰므로 정상 턴마다 행이 2배가 된다. 명시적 경로만.
import { logAgentTurnUsage } from '../llm.js';
import type { LLMProvider, LLMMessage, LLMOpts, LLMStreamEvent } from '../llm.js';
import type { LLMUsage } from '../prompt-cache/types.js';

export interface LedgerSite {
  /** llm.usage 행의 site 칸 — 호출 지점 식별(예: 'domain-dart-disclosure'). */
  site: string;
  jobKind?: string;
}

/** provider.streamChat 위임 + 원장 1행 보장. 소비되기 전엔 행 없음(제너레이터 지연 실행). */
export async function* streamChatLedgered(
  provider: LLMProvider,
  messages: LLMMessage[],
  opts: LLMOpts | undefined,
  ledger: LedgerSite,
): AsyncGenerator<LLMStreamEvent, void, unknown> {
  const stream = provider.streamChat?.bind(provider);
  if (!stream) return; // 호출이 일어나지 않았다 — 원장 행도 없다(호출측은 streamChat 가능성을 검사한 뒤 쓴다).
  const model = opts?.model ?? provider.defaultModel;
  let usage: LLMUsage | undefined;
  let failed = false;
  // streamChat 생성 동기 throw 도 원장 1행으로 (JUD-B mustFix ③) — iterator 취득을 try 안으로.
  let iterator: AsyncIterator<LLMStreamEvent, void, unknown>;
  try {
    iterator = stream(messages, opts)[Symbol.asyncIterator]();
  } catch (err) {
    failed = true;
    logAgentTurnUsage(model, 'unmeasured', {
      providerName: provider.name,
      site: ledger.site,
      ...(ledger.jobKind !== undefined ? { jobKind: ledger.jobKind } : {}),
      missingReason: 'provider-call-failed' as const,
    });
    throw err;
  }
  let completedNaturally = false;
  try {
    while (true) {
      const r = await iterator.next();
      if (r.done) { completedNaturally = true; break; }
      // usage 이벤트는 여기서 소비(마지막 것 우선) — 재발행하지 않는다: 하류 소비자이
      // 스스로 usage 를 세고 있으면 이중 계상이 된다. textOnly() 와 같은 실용상 무해.
      if (r.value.type === 'usage') { usage = r.value.usage; continue; }
      yield r.value;
    }
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    // 소비자 조기 break(for-await 탈출)·예외 = 자연 완료 아님 → 원본 iterator 를 닫아
    // 자원을 정리한다(JUD-B mustFix ③). 이미 완료된 제너레이터의 return 은 no-op.
    if (!completedNaturally) {
      try { await iterator.return?.(undefined as unknown as void); } catch { /* 원본 정리 실패는 턴에 영향 없음 */ }
    }
    // finally = 정상 종료·예외·소비자 조기 break 모두. logAgentTurnUsage 자체가
    // try/catch 로 감싸져 있어 원장 실패가 턴을 바꾸지 않는다(llm.ts:8591).
    logAgentTurnUsage(model, usage ?? 'unmeasured', {
      providerName: provider.name,
      site: ledger.site,
      ...(ledger.jobKind !== undefined ? { jobKind: ledger.jobKind } : {}),
      ...(failed && usage === undefined ? { missingReason: 'provider-call-failed' as const } : {}),
    });
  }
}

/** raw fetch 지점용 1행 래퍼 — 요청 1회당 1회 호출. 실패 경로는 missingReason. */
export function logUnmeteredRow(
  model: string,
  ledger: { providerName: string; site: string; jobKind?: string; missingReason?: 'provider-call-failed' },
): void {
  // logAgentTurnUsage 내부 try/catch — 원장 throw 가 호출측 폴백을 바꾸지 않는다.
  logAgentTurnUsage(model, 'unmeasured', {
    providerName: ledger.providerName,
    site: ledger.site,
    ...(ledger.jobKind !== undefined ? { jobKind: ledger.jobKind } : {}),
    ...(ledger.missingReason !== undefined ? { missingReason: ledger.missingReason } : {}),
  });
}
