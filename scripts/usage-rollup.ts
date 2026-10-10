#!/usr/bin/env bun
// 실행 칸(Pod 등)이 사라지기 «전»에 자기 llm.usage 를 한 줄로 요약해 stdout 에 — 슈퍼바이저가 호스트로 가져간다.
// RFC-fleet-supervisor-substrates-benchmark-and-token-accounting §A2·F2 · 2026-09-25.
//   bun scripts/usage-rollup.ts [--since 6h]
//   출력: ELANOUS_USAGE_ROLLUP {"substrate","runId","armId","truncated","rows":[{site,provider,model,calls,inputTokens,outputTokens,cacheReadInputTokens,cacheCreationInputTokens,usdKnown,unknownCostCalls}],"total":{…}}
// ⛔ 의존성 없음(설치본 `elanous` 만 부른다) — clone 에 node_modules 가 없어도 돈다.
// ⛔ 비용을 모르는 호출(cost.kind≠known)은 0 으로 합치지 않고 따로 센다.
// ⛔ `--all --include-test` 로 «그 기계의 모든 우주»를 읽는다 — Pod(자기 스토어뿐)에서는 그것이 곧 그 칸의 사용량이지만,
//    호스트(맥)에서 돌리면 테스트 우주·워크트리·다른 트랙의 런까지 섞인다(📏 09-25: 운영만 16회 vs 전체 124회). 호스트 집계용이 아니다.
import { spawnSync } from 'node:child_process';

export interface UsageRow { site: string; provider: string; model: string; calls: number; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; cacheCreationUnmeasuredCalls: number; usdKnown: number; unknownCostCalls: number; includedCalls: number; apiEquivalentUsd: number }

export function rollup(lines: readonly string[]): { rows: UsageRow[]; truncated: boolean } {
  const by = new Map<string, UsageRow>();
  let truncated = false;
  for (const line of lines) {
    if (/limitReached=true|truncated/.test(line) && !line.startsWith('{')) truncated = true;
    if (!line.startsWith('{')) continue;
    let r: { event?: string; data?: Record<string, unknown> };
    try { r = JSON.parse(line); } catch { continue; }
    if (r.event !== 'llm-usage' || !r.data) continue;
    const d = r.data as { site?: string; provider?: string; billingProvider?: string; model?: string; inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; cost?: { kind?: string; usd?: number } };
    const provider = d.billingProvider ?? d.provider ?? '?';   // ⭐ 과금 주체 우선(B10)
    const key = `${d.site ?? '?'}|${provider}|${d.model ?? '?'}`;
    const row = by.get(key) ?? { site: d.site ?? '?', provider, model: d.model ?? '?', calls: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, cacheCreationUnmeasuredCalls: 0, usdKnown: 0, unknownCostCalls: 0, includedCalls: 0, apiEquivalentUsd: 0 };
    row.calls++;
    row.inputTokens += Number(d.inputTokens ?? 0);
    row.outputTokens += Number(d.outputTokens ?? 0);
    row.cacheReadInputTokens += Number(d.cacheReadInputTokens ?? 0);
    // ⭐ 캐시 «쓰기»(Anthropic cache_creation_input_tokens) — 빠지면 호스트 원장이 0 으로 보고 재매김 $ 가 쓰기 비용을 잃는다.
    row.cacheCreationInputTokens += Number(d.cacheCreationInputTokens ?? 0);
    //   캐시 읽기는 보고했는데 쓰기 칸이 없는 호출은 쓰기량을 «모른다» — 0 으로 접지 않고 따로 센다(호스트 재매김이 이 수를 보고 멈춘다).
    if (d.cacheReadInputTokens !== undefined && d.cacheCreationInputTokens === undefined) row.cacheCreationUnmeasuredCalls++;
    // ⛔ «모름»을 0 으로 접지 않는다 — partial 의 «알려진 몫»은 더하고, 모르는 호출은 따로 센다(BACKLOG C5).
    // ⭐ 구독·local(`included`)은 청구 0 이고 «모름»이 아니다 — 따로 세고 API 환산가는 별도 합(BACKLOG C6).
    if (d.cost?.kind === 'included') { row.includedCalls++; if (typeof (d.cost as { apiEquivalentUsd?: number }).apiEquivalentUsd === 'number') row.apiEquivalentUsd += (d.cost as { apiEquivalentUsd: number }).apiEquivalentUsd; }
    // ⭐ `actual`(provider 보고 청구액 · C7)은 알려진 비용이다.
    else if ((d.cost?.kind === 'known' || d.cost?.kind === 'actual') && typeof d.cost.usd === 'number') row.usdKnown += d.cost.usd;
    else { row.unknownCostCalls++; if (d.cost?.kind === 'partial' && typeof d.cost.usd === 'number') row.usdKnown += d.cost.usd; }
    by.set(key, row);
  }
  return { rows: [...by.values()], truncated };
}

if (import.meta.main) {
  const i = process.argv.indexOf('--since');
  const since = i > 0 ? process.argv[i + 1] ?? '6h' : '6h';
  const r = spawnSync('elanous', ['logs', '--all', '--include-test', '--event', 'llm-usage', '--since', since, '--limit', '50000', '--json', '--json-data'], { encoding: 'utf8', timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
  const { rows, truncated } = rollup(`${r.stdout ?? ''}\n${r.stderr ?? ''}`.split('\n'));
  const total = rows.reduce((t, x) => ({ calls: t.calls + x.calls, inputTokens: t.inputTokens + x.inputTokens, outputTokens: t.outputTokens + x.outputTokens, usdKnown: t.usdKnown + x.usdKnown, unknownCostCalls: t.unknownCostCalls + x.unknownCostCalls }), { calls: 0, inputTokens: 0, outputTokens: 0, usdKnown: 0, unknownCostCalls: 0 });
  // ⭐ 무슨 판이 쟀나 — Pod 의 elanous 는 이미지 판이다(BACKLOG E6).
  const v = spawnSync('elanous', ['--version'], { encoding: 'utf8', timeout: 20_000 });
  const elanousVersion = v.status === 0 ? (v.stdout ?? '').trim().split('\n').pop() ?? null : null;
  // ⭐ 런 출처 칸(🅣 RFC run-origin 이름 그대로) — 호스트 재방출이 그대로 받는다.
  const origin = { podName: process.env.ELANOUS_POD_NAME ?? null, nodeName: process.env.ELANOUS_NODE_NAME ?? null, hostId: process.env.ELANOUS_HOST_ID ?? null, imageCommit: process.env.ELANOUS_IMAGE_COMMIT ?? null };
  console.log(`ELANOUS_USAGE_ROLLUP ${JSON.stringify({ substrate: process.env.ELANOUS_SUBSTRATE ?? null, elanousVersion, ...origin, runId: process.env.ELANOUS_RUN_ID ?? null, armId: process.env.ELANOUS_ARM_ID ?? null, measured: r.status === 0, truncated, rows, total })}`);
}
