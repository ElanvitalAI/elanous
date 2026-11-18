// ── A2 (Phase 2 Bundle 3) — Gemini vision provider for Screenshot 분석 ──
//
// HANDOFF Phase 2 §5 A2 / ROADMAP §5: "Gemini vision 으로 Screenshot
// 분석". X7 (Phase 1) 의 `visionProvider` 슬롯을 채우는 첫 production
// adapter. Gemini 1.5 / 2.0 의 multimodal API 에 PNG + 사용자 transcript
// 를 보내고 description 을 받는다.
//
// Provider-agnostic shape — VisionScreenQueryDeps['visionProvider'] 에
// 그대로 conform 한다. Claude vision / OpenAI vision adapter 는 같은
// shape 으로 future arc 에서 추가.
//
// Pure adapter — 실제 fetch 호출은 주입된 `httpFetch` 통과. tests 가
// fake fetch 로 검증.

import type { ScreenshotPayload } from '../vision-screen-query.js';
import { llmNetworkSend } from '../../session-runtime/llm-call-gateway.js';

export interface GeminiVisionDeps {
  /** Gemini API key. Production: pull from env or user-config. */
  apiKey: string;
  /** Model id — defaults to 'gemini-2.0-flash-exp'. */
  model?: string;
  /** Inject fetch (for tests / proxy). Defaults to global fetch. */
  httpFetch?: typeof fetch;
  /** Default response language — drives the system prompt's lang
   *  hint. 'ko' / 'en'. Default 'ko'. */
  lang?: 'ko' | 'en';
  /** Optional system prompt prefix override. */
  systemPrompt?: string;
  logDebug?: (category: string, event: string, data?: unknown) => void;
}

export interface GeminiVisionInput {
  transcript: string;
  screenshot: ScreenshotPayload;
}

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const DEFAULT_SYSTEM_KO = '당신은 터미널 화면을 분석하는 비전 어시스턴트입니다. 사용자 질문에 대해 화면에 보이는 가장 핵심적인 정보를 1-3 문장으로 답하세요. 한국어로 자연스럽게.';
const DEFAULT_SYSTEM_EN = 'You are a vision assistant analyzing a terminal screen. Answer the user question with the most important details in 1-3 sentences in natural English.';

export interface GeminiVisionProvider {
  /** Conforms to VisionScreenQueryDeps['visionProvider']. */
  describe(input: GeminiVisionInput): Promise<string | null>;
}

export function createGeminiVisionProvider(
  deps: GeminiVisionDeps,
): GeminiVisionProvider {
  const model = deps.model ?? 'gemini-2.0-flash-exp';
  const lang = deps.lang ?? 'ko';
  const fetchFn = deps.httpFetch ?? fetch;
  const system = deps.systemPrompt ?? (lang === 'ko' ? DEFAULT_SYSTEM_KO : DEFAULT_SYSTEM_EN);

  const log = (category: string, event: string, data?: unknown): void => {
    if (deps.logDebug) deps.logDebug(category, event, data);
  };

  return {
    async describe({ transcript, screenshot }) {
      if (!deps.apiKey) {
        log('vision.gemini.no-api-key', '');
        return null;
      }
      const url = `${GEMINI_BASE}/${model}:generateContent?key=${deps.apiKey}`;
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{
          role: 'user',
          parts: [
            { text: transcript || (lang === 'ko' ? '이 화면을 분석해줘' : 'Analyze this screen') },
            {
              inlineData: {
                mimeType: screenshot.mimeType,
                data: screenshot.bodyBase64,
              },
            },
          ],
        }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 256,
        },
      };

      let response: Response;
      try {
        const init: RequestInit = {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        };
        response = await llmNetworkSend(url, init,
          { provider: 'gemini', model, role: 'aux', requestedBy: 'voice-vision' },
          () => fetchFn(url, init));
      } catch (err) {
        log('vision.gemini.fetch-throw', '', { error: String(err) });
        return null;
      }
      if (!response.ok) {
        log('vision.gemini.http-error', String(response.status));
        return null;
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (err) {
        log('vision.gemini.parse-throw', '', { error: String(err) });
        return null;
      }
      const text = extractGeminiText(payload);
      if (!text) {
        log('vision.gemini.empty-response', '');
        return null;
      }
      log('vision.gemini.ok', '', { chars: text.length });
      return text.trim();
    },
  };
}

/** Extract the first text candidate from a Gemini generateContent
 *  response. Exported for test introspection. */
export function extractGeminiText(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const candidates = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const first = candidates[0];
  if (typeof first !== 'object' || first === null) return null;
  const content = (first as { content?: unknown }).content;
  if (typeof content !== 'object' || content === null) return null;
  const parts = (content as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return null;
  for (const p of parts) {
    if (typeof p === 'object' && p !== null) {
      const t = (p as { text?: unknown }).text;
      if (typeof t === 'string' && t.length > 0) return t;
    }
  }
  return null;
}
