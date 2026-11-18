// ── M4 (Phase 4 Bundle 3) — External thinking-tool voice brain lend out ──
//
// HANDOFF Phase 4 / ROADMAP §7 M4: "외부 thinking-tool voice brain lend
// out". A1/B 의 *역방향* — A1 = elanous shell 을 외부 client 가 빌려쓰기.
// M4 = elanous 의 voice + reasoning capability 를 외부 도구가 RPC 로
// 사용 (예: cursor 가 "이 코드 리뷰해" 음성 발화 + Gemini vision +
// reasoning summary 를 elanous 에 위임).
//
// JSON-RPC method 4 종 (acp/voice-brain.* namespace):
//   speak       — 외부에서 elanous 의 TTS 사용
//   listen      — 외부에서 elanous 의 STT 사용
//   ask         — 외부에서 elanous 의 reasoning + voice 응답 사용 (full loop)
//   capabilities — 외부 client 가 가능한 actions 인지

import type { CapabilityGrantStore } from '../conductor/capability-grant-store.js';

// ── Method shapes ──────────────────────────────────────────────────

export interface VoiceBrainSpeakRequest {
  readonly clientId: string;
  readonly sentence: string;
  /** Voice provider hint (host 가 결정). */
  readonly providerHint?: string;
}

export interface VoiceBrainSpeakResponse {
  readonly ok: boolean;
  readonly durationMs?: number;
}

export interface VoiceBrainListenRequest {
  readonly clientId: string;
  /** Listen budget (ms). */
  readonly budgetMs?: number;
}

export interface VoiceBrainListenResponse {
  readonly transcript?: string;
  readonly confidence?: number;
  readonly ok: boolean;
}

export interface VoiceBrainAskRequest {
  readonly clientId: string;
  readonly question: string;
  /** 추가 context — code snippet, screenshot base64, etc. */
  readonly context?: string;
  /** Reasoning provider hint. */
  readonly providerHint?: string;
  /** When true, elanous 가 사용자에게 voice prompt + 사용자 응답 받음 (HITL). */
  readonly hitl?: boolean;
}

export interface VoiceBrainAskResponse {
  readonly answer?: string;
  readonly hitlDecision?: string;
  readonly ok: boolean;
}

export interface VoiceBrainCapabilities {
  readonly supportedActions: readonly ('speak' | 'listen' | 'ask')[];
  readonly providers: { readonly tts?: readonly string[]; readonly stt?: readonly string[]; readonly llm?: readonly string[] };
  readonly serverName: string;
  readonly serverVersion?: string;
}

// ── Policy + Handlers ──────────────────────────────────────────────

export type VoiceBrainAction = 'speak' | 'listen' | 'ask';

export interface VoiceBrainHandlers {
  speak(req: VoiceBrainSpeakRequest): Promise<VoiceBrainSpeakResponse>;
  listen(req: VoiceBrainListenRequest): Promise<VoiceBrainListenResponse>;
  ask(req: VoiceBrainAskRequest): Promise<VoiceBrainAskResponse>;
  capabilities(): Promise<VoiceBrainCapabilities>;
}

export interface VoiceBrainLendDeps {
  /** Server identifier (advertised to clients). */
  serverName: string;
  serverVersion?: string;
  /** Capability gate — clientId 가 해당 action 권한 있는지. T6 store
   *  reuse — caller persona = clientId. */
  grantStore?: CapabilityGrantStore;
  /** Inject TTS — typically dashboardAutoTts.controller.{pushChunk,commit}. */
  speak: (sentence: string, providerHint?: string) => Promise<{ ok: boolean; durationMs?: number }>;
  /** Inject STT — listen for `budgetMs` and return transcript. */
  listen: (opts: { budgetMs: number }) => Promise<{ transcript?: string; confidence?: number; ok: boolean }>;
  /** Inject LLM reasoning. */
  reason: (input: { question: string; context?: string; providerHint?: string }) =>
    Promise<{ answer: string; ok: boolean }>;
  /** Inject HITL escalation (M2). When `ask({ hitl: true })` 호출 시 사용. */
  hitlEscalate?: (input: { question: string }) => Promise<{ decision: string }>;
  /** Default capabilities advertised. */
  defaultCapabilities?: Partial<VoiceBrainCapabilities>;
  logDebug?: (category: string, event: string, data?: unknown) => void;
}

export const VOICE_BRAIN_RPC_METHODS = {
  speak: 'acp/voice-brain.speak',
  listen: 'acp/voice-brain.listen',
  ask: 'acp/voice-brain.ask',
  capabilities: 'acp/voice-brain.capabilities',
} as const;

export class VoiceBrainDeniedError extends Error {
  constructor(public readonly action: VoiceBrainAction, public readonly reason?: 'expired' | 'revoked' | 'absent') {
    super(`Voice brain action denied: ${action}${reason === 'expired' ? ' (expired)' : ''}`);
    this.name = 'VoiceBrainDeniedError';
  }
}

const DEFAULT_LISTEN_BUDGET = 10_000;

export function createVoiceBrainHandlers(
  deps: VoiceBrainLendDeps,
): VoiceBrainHandlers {
  const log = (category: string, event: string, data?: unknown): void => {
    if (deps.logDebug) deps.logDebug(category, event, data);
  };

  const checkGrant = (clientId: string, action: VoiceBrainAction): void => {
    if (!deps.grantStore) return; // No store = open
    const grant = deps.grantStore.checkGrant(clientId, action as never);
    if (!grant.granted) {
      log('voice-brain.denied', action, { clientId, reason: grant.reason });
      throw new VoiceBrainDeniedError(action, grant.reason);
    }
  };

  return {
    async speak(req) {
      checkGrant(req.clientId, 'speak');
      log('voice-brain.speak', req.clientId, { chars: req.sentence.length });
      try {
        return await deps.speak(req.sentence, req.providerHint);
      } catch (err) {
        log('voice-brain.speak-throw', req.clientId, { error: String(err) });
        return { ok: false };
      }
    },

    async listen(req) {
      checkGrant(req.clientId, 'listen');
      const budget = req.budgetMs ?? DEFAULT_LISTEN_BUDGET;
      log('voice-brain.listen', req.clientId, { budgetMs: budget });
      try {
        return await deps.listen({ budgetMs: budget });
      } catch (err) {
        log('voice-brain.listen-throw', req.clientId, { error: String(err) });
        return { ok: false };
      }
    },

    async ask(req) {
      checkGrant(req.clientId, 'ask');
      log('voice-brain.ask', req.clientId, { hitl: req.hitl, qChars: req.question.length });
      try {
        const reasoned = await deps.reason({
          question: req.question,
          ...(req.context !== undefined ? { context: req.context } : {}),
          ...(req.providerHint !== undefined ? { providerHint: req.providerHint } : {}),
        });
        if (!reasoned.ok) return { ok: false };

        // HITL path
        if (req.hitl && deps.hitlEscalate) {
          const hitlOut = await deps.hitlEscalate({ question: reasoned.answer });
          return { ok: true, answer: reasoned.answer, hitlDecision: hitlOut.decision };
        }

        // Speak the reasoning result (non-HITL ask = elanous voice 가 응답)
        try { await deps.speak(reasoned.answer); } catch { /* graceful */ }

        return { ok: true, answer: reasoned.answer };
      } catch (err) {
        log('voice-brain.ask-throw', req.clientId, { error: String(err) });
        return { ok: false };
      }
    },

    async capabilities() {
      return {
        supportedActions: deps.defaultCapabilities?.supportedActions ?? ['speak', 'listen', 'ask'],
        providers: deps.defaultCapabilities?.providers ?? {},
        serverName: deps.serverName,
        ...(deps.serverVersion !== undefined ? { serverVersion: deps.serverVersion } : {}),
      };
    },
  };
}

/** Bind handlers to JSON-RPC method names. */
export function bindVoiceBrainMethods(
  handlers: VoiceBrainHandlers,
): Record<string, (params: unknown) => Promise<unknown>> {
  return {
    [VOICE_BRAIN_RPC_METHODS.speak]: (p) => handlers.speak(p as VoiceBrainSpeakRequest),
    [VOICE_BRAIN_RPC_METHODS.listen]: (p) => handlers.listen(p as VoiceBrainListenRequest),
    [VOICE_BRAIN_RPC_METHODS.ask]: (p) => handlers.ask(p as VoiceBrainAskRequest),
    [VOICE_BRAIN_RPC_METHODS.capabilities]: () => handlers.capabilities(),
  };
}
