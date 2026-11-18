/** Grok search — X/웹/레딧 검색 전용 (채팅은 향후 omni-llm으로 분리) */

import { llmNetworkFetch } from './llm-network-fetch.js';
import { requireEnv, refreshKeysFromCache } from './env.js';
import type { GrokSearchMode, CrawlResult } from './types.js';

const API_URL = 'https://api.x.ai/v1/responses';

const MODELS: Record<string, string> = {
  fast: 'grok-4-1-fast-reasoning',
  light: 'grok-4-1-fast-non-reasoning',
};

function resolveModel(name: string): string { return MODELS[name] || name; }

function buildTools(mode: GrokSearchMode): any[] {
  const tools: any[] = [];
  if (['x', 'both', 'community'].includes(mode)) tools.push({ type: 'x_search' });
  if (['web', 'both'].includes(mode)) tools.push({ type: 'web_search' });
  if (['reddit', 'community'].includes(mode)) tools.push({ type: 'web_search', filters: { allowed_domains: ['reddit.com'] } });
  return tools;
}

export interface GrokSearchOpts {
  query: string;
  mode: GrokSearchMode;
  model?: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
}

export async function searchGrok(opts: GrokSearchOpts): Promise<CrawlResult> {
  const apiKey = requireEnv('XAI_API_KEY');
  const model = resolveModel(opts.model || 'fast');
  const tools = buildTools(opts.mode);

  if (tools.length === 0) throw new Error('검색 모드를 지정해주세요 (x, web, reddit, community, both)');

  const labels: Record<string, string> = { x: 'X', web: '웹', reddit: '레딧', community: 'X+레딧', both: 'X+웹' };
  console.log(`  [grok-${opts.mode}] ${labels[opts.mode] || opts.mode} 검색: "${opts.query.substring(0, 80)}" (model=${model})`);

  const payload: any = { model, input: [{ role: 'user', content: opts.query }], tools };
  if (opts.system) payload.instructions = opts.system;
  if (opts.temperature != null) payload.temperature = opts.temperature;
  if (opts.maxTokens) payload.max_output_tokens = opts.maxTokens;

  // ── 2안: 인증 거절이면 «내 키가 낡았나»를 그 자리에서 가른다 ──────────────
  //
  // ⛔⭐⭐ 2026-08-06 실측 — 403 본문은 *"team … has either used all available credits or
  //   reached its monthly spending limit"* 였고, 그 문면만 보면 «돈이 없다»로 읽힌다.
  //   그런데 진짜 원인은 ***이 프로세스가 «다른 팀»의 낡은 키를 들고 있던 것***이었다
  //   (셸 env = 소진된 팀 · 캐시/`.env` = 살아 있는 팀 · 후자는 200).
  //   ⇒ 그래서 거절을 만나면 **캐시와 대조**해 둘을 «다른 말»로 가른다:
  //     ⓐ 키가 바뀌었다 → 낡은 env 였다. 갱신하고 **한 번만** 재시도한다.
  //     ⓑ 키가 그대로다 → 키는 최신인데 거절당한 것 = 진짜 크레딧/한도 문제.
  //   ⛔ 재시도는 **1회뿐**이다. 무한 재시도는 요금을 쓰면서 같은 답을 받는다.
  const send = (key: string) => llmNetworkFetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(payload),
  }, { provider: 'grok', model, role: 'aux', requestedBy: 'omni-crawl' });
  let res = await send(apiKey);
  if (res.status === 401 || res.status === 403) {
    const changed = refreshKeysFromCache('XAI_API_KEY');
    if (changed.length) {
      console.log(`  [grok] ⚠️ ${res.status} — 이 프로세스의 XAI_API_KEY 가 «낡았다»(캐시와 다름). 갱신 후 1회 재시도.`);
      res = await send(requireEnv('XAI_API_KEY'));
    } else {
      console.log(`  [grok] ⛔ ${res.status} — 키는 캐시와 «같다». 낡은 env 가 아니라 팀 크레딧/한도 문제다.`);
    }
  }
  if (!res.ok) throw new Error(`Grok API ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();

  let text = '';
  const annotations: string[] = [];
  for (const item of data.output || []) {
    if (item.type === 'message') {
      for (const c of item.content || []) {
        if (c.type === 'output_text') {
          text += (c.text || '') + '\n';
          for (const a of c.annotations || []) { if (a.url) annotations.push(a.url); }
        }
      }
    }
  }

  const usage = data.usage || {};
  const usd = usage.cost_in_usd_ticks ? (Number(usage.cost_in_usd_ticks) / 1e10).toFixed(5) : '?';
  console.log(`  [grok-${opts.mode}] 완료 (tokens: ${usage.total_tokens || '?'}, cost: $${usd}, sources: ${annotations.length})`);

  return {
    engine: `grok-${opts.mode}`,
    query: opts.query,
    items: [],
    rawText: text.trim(),
    annotations: [...new Set(annotations)],
    totalItems: annotations.length || (text.trim() ? 1 : 0),
  };
}
