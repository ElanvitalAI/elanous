#!/usr/bin/env bun
// 실행 칸(Pod 등)이 사라지기 «전»에 자기 llm.usage 를 한 줄로 요약해 stdout 에 — 슈퍼바이저가 호스트로 가져간다.
// RFC-fleet-supervisor-substrates-benchmark-and-token-accounting §A2·F2 · 2026-09-25.
//   bun scripts/usage-rollup.ts [--since 6h] [--partial [--seq N]]
//   출력: ELANOUS_USAGE_ROLLUP {"substrate","runId","armId","truncated","rows":[{site,provider,model,calls,inputTokens,outputTokens,cacheReadInputTokens,cacheCreationInputTokens,usdKnown,unknownCostCalls}],"total":{…}}
// ⛔ 의존성 없음(설치본 `elanous` 만 부른다) — clone 에 node_modules 가 없어도 돈다.
// ⛔ 비용을 모르는 호출(cost.kind≠known)은 0 으로 합치지 않고 따로 센다.
// ⛔ `--all --include-test` 로 «그 기계의 모든 우주»를 읽는다 — Pod(자기 스토어뿐)에서는 그것이 곧 그 칸의 사용량이지만,
//    호스트(맥)에서 돌리면 테스트 우주·워크트리·다른 트랙의 런까지 섞인다(📏 09-25: 운영만 16회 vs 전체 124회). 호스트 집계용이 아니다.
import { spawnSync } from 'node:child_process';

export interface UsageRow { site: string; provider: string; model: string; calls: number; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; cacheCreationUnmeasuredCalls: number; usdKnown: number; unknownCostCalls: number; includedCalls: number; apiEquivalentUsd: number;
  /** OR-BYOK-COST — BYOK 호출 수 ⊕ 그중 상류 청구액 합(알려진 것만) ⊕ 상류를 모르는 호출 수. BYOK 를 본 행에만 있다(종전 행 바이트 불변). */
  byokCalls?: number; byokUpstreamUsd?: number; byokUpstreamUnknownCalls?: number }

type UsageData = { site?: string; provider?: string; billingProvider?: string; model?: string; inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; cost?: { kind?: string; usd?: number }; podRollupKey?: string; partial?: boolean; partialSeq?: number; partialAt?: string };

/** 같은 podRollupKey 두 행 중 어느 쪽이 더 완전한가 — 최종 > 부분 · 부분끼리는 seq 큰 쪽 · 같으면 at 늦은 쪽. 완전히 같으면 앞 행을 둔다. */
function rollupRowBeats(next: UsageData, kept: UsageData): boolean {
  const nextFinal = next.partial !== true;
  const keptFinal = kept.partial !== true;
  if (nextFinal !== keptFinal) return nextFinal;
  if (nextFinal) return false;
  const nextSeq = Number(next.partialSeq ?? 0);
  const keptSeq = Number(kept.partialSeq ?? 0);
  if (nextSeq !== keptSeq) return nextSeq > keptSeq;
  return String(next.partialAt ?? '') > String(kept.partialAt ?? '');
}

export function rollup(lines: readonly string[]): { rows: UsageRow[]; truncated: boolean } {
  const by = new Map<string, UsageRow>();
  // ⭐ MF-3c0d253e — 같은 Pod 사용량의 재방출(부분 ⊕ 최종 · abort ⊕ resume)은 podRollupKey 로 한 번만 센다(이중계상 방지).
  //   들어온 순서가 아니라 «더 완전한 행»을 남긴다(최종 > 부분 · seq · at — rollupRowBeats).
  //   키가 없는 행(기존 경로 전부)은 종전과 동작·바이트 그대로다.
  let truncated = false;
  const entries: UsageData[] = [];
  const keptIndexByPodRollupKey = new Map<string, number>();
  for (const line of lines) {
    if (/limitReached=true|truncated/.test(line) && !line.startsWith('{')) truncated = true;
    if (!line.startsWith('{')) continue;
    let r: { event?: string; data?: Record<string, unknown> };
    try { r = JSON.parse(line); } catch { continue; }
    if (r.event !== 'llm-usage' || !r.data) continue;
    const d = r.data as UsageData;
    if (typeof d.podRollupKey === 'string') {
      const keptIndex = keptIndexByPodRollupKey.get(d.podRollupKey);
      if (keptIndex !== undefined) {
        if (rollupRowBeats(d, entries[keptIndex]!)) entries[keptIndex] = d;
        continue;
      }
      keptIndexByPodRollupKey.set(d.podRollupKey, entries.length);
    }
    entries.push(d);
  }
  for (const d of entries) {
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
    // OR-BYOK-COST — BYOK 비용은 위에서 이미 usdKnown(actual)·unknownCostCalls(partial)로 갈렸다. 여기선 출처만 따로 나른다.
    const c = d.cost as { byok?: unknown; upstreamUsd?: unknown } | undefined;
    if (c?.byok === true) {
      row.byokCalls = (row.byokCalls ?? 0) + 1;
      if (typeof c.upstreamUsd === 'number' && Number.isFinite(c.upstreamUsd)) row.byokUpstreamUsd = (row.byokUpstreamUsd ?? 0) + c.upstreamUsd;
      else row.byokUpstreamUnknownCalls = (row.byokUpstreamUnknownCalls ?? 0) + 1;
    }
    by.set(key, row);
  }
  return { rows: [...by.values()], truncated };
}

/** METER-POD-ROLLUP-GAP — 인자 해석: `--partial`(⊕ `--seq N`)면 부분 롤업 한 줄로 바꾼다. 전체판(기본)은 불변. */
export function parseRollupArgs(argv: readonly string[]): { since: string; partial: boolean; seq: number } {
  const sinceAt = argv.indexOf('--since');
  const seqAt = argv.indexOf('--seq');
  const seqRaw = seqAt >= 0 ? Number(argv[seqAt + 1] ?? 1) : 1;
  return { since: sinceAt >= 0 ? argv[sinceAt + 1] ?? '6h' : '6h', partial: argv.includes('--partial'), seq: Number.isInteger(seqRaw) && seqRaw > 0 ? seqRaw : 1 };
}

/** 한 줄 표현 — 전체판 줄은 기존 바이트와 동일, 부분판은 partial:true ⊕ seq ⊕ at 만 얹는다. */
export function renderRollupLine(payload: Record<string, unknown>, opts: { partial: boolean; seq: number }): string {
  if (opts.partial) return `ELANOUS_USAGE_ROLLUP_PARTIAL ${JSON.stringify({ ...payload, partial: true, seq: opts.seq, at: new Date().toISOString() })}`;
  return `ELANOUS_USAGE_ROLLUP ${JSON.stringify(payload)}`;
}

if (import.meta.main) {
  const { since, partial, seq } = parseRollupArgs(process.argv);
  const r = spawnSync('elanous', ['logs', '--all', '--include-test', '--event', 'llm-usage', '--since', since, '--limit', '50000', '--json', '--json-data'], { encoding: 'utf8', timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
  const { rows, truncated } = rollup(`${r.stdout ?? ''}\n${r.stderr ?? ''}`.split('\n'));
  const total = rows.reduce((t, x) => ({ calls: t.calls + x.calls, inputTokens: t.inputTokens + x.inputTokens, outputTokens: t.outputTokens + x.outputTokens, usdKnown: t.usdKnown + x.usdKnown, unknownCostCalls: t.unknownCostCalls + x.unknownCostCalls }), { calls: 0, inputTokens: 0, outputTokens: 0, usdKnown: 0, unknownCostCalls: 0 });
  // ⭐ 무슨 판이 쟀나 — Pod 의 elanous 는 이미지 판이다(BACKLOG E6).
  const v = spawnSync('elanous', ['--version'], { encoding: 'utf8', timeout: 20_000 });
  const elanousVersion = v.status === 0 ? (v.stdout ?? '').trim().split('\n').pop() ?? null : null;
  // ⭐ 런 출처 칸(🅣 RFC run-origin 이름 그대로) — 호스트 재방출이 그대로 받는다.
  const origin = { podName: process.env.ELANOUS_POD_NAME ?? null, nodeName: process.env.ELANOUS_NODE_NAME ?? null, hostId: process.env.ELANOUS_HOST_ID ?? null, imageCommit: process.env.ELANOUS_IMAGE_COMMIT ?? null };
  console.log(renderRollupLine({ substrate: process.env.ELANOUS_SUBSTRATE ?? null, elanousVersion, ...origin, runId: process.env.ELANOUS_RUN_ID ?? null, armId: process.env.ELANOUS_ARM_ID ?? null, measured: r.status === 0, truncated, rows, total }, { partial, seq }));
}
