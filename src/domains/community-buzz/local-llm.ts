// ── 로컬 LLM 클라이언트 (2엔드포인트 로드밸런싱) · 버즈 P2a · 2026-07-09 ────────
//
// PLAN §3c. Tier1 전량 판정을 로컬 LLM(본머신 + fleet 의 `llm` 역할 노드)으로 무비용 처리.
// OpenAI 호환 /v1/chat/completions. 라운드로빈 + 페일오버(한 대 다운→다른 대). 둘 다
// 다운이면 throw(호출측 fail-soft). MoE(qwen3.5-35b-a3b) 라 빠름·구독/클라우드 토큰 0.
//
// 엔드포인트 기본 = 본머신 ⊕ ~/.elanous/ssh-hosts.json 에서 `roles: ["llm"]` 인 호스트의 :1234.

import { sshHostsWithRole } from '../../ssh/ssh-hosts.js';
import { llmNetworkFetch } from '../../session-runtime/llm-call-gateway.js';

export interface LocalLlmOpts {
  endpoints?: string[];   // 기본 defaultEndpoints()
  model?: string;
  timeoutMs?: number;
  temperature?: number;
}

/** 본머신 ⊕ fleet 의 `llm` 역할 호스트. (2026-09-25: 한 사람의 기계 이름이 박혀 있던 자리.) */
export function defaultEndpoints(): string[] {
  return ['http://localhost:1234', ...sshHostsWithRole('llm').map((h) => `http://${h.host}:1234`)];
}
// ⚠️ thinking 모델(qwen3/glm)은 max_tokens 를 reasoning 에 다 써 content 가 빔(라이브 실증).
// → 비-thinking instruction 모델(gemma-*-it) 자동 선호. 엔드포인트별 /v1/models 로 해석.
const NON_THINKING_HINT = /gemma.*-it|instruct|-it$/i;
const THINKING_HINT = /qwen3|glm|think|reason|deepseek-r/i;

export interface LocalLlm {
  endpoints: string[];
  /** 라운드로빈 시작 + 페일오버. 전부 실패 시 throw. */
  complete: (messages: Array<{ role: string; content: string }>, opts?: { maxTokens?: number }) => Promise<string>;
}

/** 비-thinking instruction 모델 선호 픽. gemma-*-it > 비-thinking > 첫 모델. */
export function pickModel(ids: string[]): string | null {
  if (ids.length === 0) return null;
  return ids.find(id => NON_THINKING_HINT.test(id))
    ?? ids.find(id => !THINKING_HINT.test(id))
    ?? ids[0]!;
}

export function makeLocalLlm(opts: LocalLlmOpts = {}): LocalLlm {
  const endpoints = opts.endpoints?.length ? opts.endpoints : defaultEndpoints();
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const temperature = opts.temperature ?? 0.2;
  const modelCache = new Map<string, string>(); // base → 해석된 모델
  let rr = 0; // 라운드로빈 커서

  async function resolveModel(base: string): Promise<string> {
    if (opts.model) return opts.model;
    const cached = modelCache.get(base);
    if (cached) return cached;
    const r = await fetch(`${base}/v1/models`);
    const j = await r.json() as { data?: Array<{ id: string }> };
    const picked = pickModel((j.data ?? []).map(m => m.id)) ?? 'default';
    modelCache.set(base, picked);
    return picked;
  }

  async function callOne(base: string, messages: Array<{ role: string; content: string }>, maxTokens: number): Promise<string> {
    const model = await resolveModel(base);
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await llmNetworkFetch(`${base}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: false }),
        signal: ctrl.signal,
      }, { provider: 'local', model, role: 'aux', requestedBy: 'community-buzz', selectionSource: opts.model ? 'explicit' : 'config' });
      if (!resp.ok) throw new Error(`${base} ${resp.status}`);
      const j = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = j?.choices?.[0]?.message?.content;
      if (!content) throw new Error(`${base} 빈 응답`);
      return content;
    } finally { clearTimeout(to); }
  }

  return {
    endpoints,
    complete: async (messages, o = {}) => {
      const start = rr++ % endpoints.length;
      let lastErr: unknown;
      for (let k = 0; k < endpoints.length; k++) {
        const base = endpoints[(start + k) % endpoints.length]!;
        try { return await callOne(base, messages, o.maxTokens ?? 2048); }
        catch (e) { lastErr = e; } // 다음 엔드포인트로 페일오버
      }
      throw new Error(`로컬 LLM 전부 실패: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
    },
  };
}

/** 살아있는 엔드포인트 목록(/v1/models 프로브). */
export async function localLlmAvailable(endpoints: string[] = defaultEndpoints()): Promise<string[]> {
  const checks = await Promise.all(endpoints.map(async (e) => {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(`${e}/v1/models`, { signal: ctrl.signal });
      clearTimeout(to);
      return r.ok ? e : null;
    } catch { return null; }
  }));
  return checks.filter((x): x is string => x !== null);
}

/** LLM 응답에서 JSON 추출 — <think> 추론·코드펜스·주변텍스트 제거 후 첫 배열/객체 균형파싱. */
export function extractJson(raw: string): unknown | null {
  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '');
  const startArr = s.indexOf('['), startObj = s.indexOf('{');
  const start = startArr === -1 ? startObj : startObj === -1 ? startArr : Math.min(startArr, startObj);
  if (start === -1) return null;
  const open = s[start]!, close = open === '[' ? ']' : '}';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}
