// ⭐ METER-POD-ROLLUP-GAP — scripts/usage-rollup.ts --partial 칸: 부분 롤업 한 줄(partial:true · seq · at)과 전체판 줄의 하위 호환.
// 칸: mk · 0.2.24 · TASK-AGENT(OP 디스패처) · 2026-10-11.
import { describe, expect, test } from 'bun:test';
import { tierModel } from '../src/llm/model-defaults.js';
import { parseRollupArgs, renderRollupLine, rollup } from './usage-rollup.js';

// ⛔ 모델 이름을 박지 않는다 — 사다리에서 파생한다(model-hardcode-gate 규율 · 2026-09-25).
const MODEL = tierModel('balanced', 'openai');

describe('usage-rollup --partial', () => {
  test('인자 없으면 전체판 기본 그대로 — since 6h · partial:false · seq 1', () => {
    expect(parseRollupArgs([])).toEqual({ since: '6h', partial: false, seq: 1 });
  });
  test('--partial 이 부분판을 만들고 --since/--seq 를 받는다; 무효 seq 는 1 로 폴백한다', () => {
    expect(parseRollupArgs(['--partial'])).toEqual({ since: '6h', partial: true, seq: 1 });
    expect(parseRollupArgs(['--since', '12h', '--partial', '--seq', '3'])).toEqual({ since: '12h', partial: true, seq: 3 });
    expect(parseRollupArgs(['--partial', '--seq', 'x'])).toEqual({ since: '6h', partial: true, seq: 1 });
    expect(parseRollupArgs(['--partial', '--seq', '0'])).toEqual({ since: '6h', partial: true, seq: 1 });
    expect(parseRollupArgs(['--since', '12h'])).toEqual({ since: '12h', partial: false, seq: 1 });
  });
  test('전체판 줄은 기존 바이트 그대로다(하위 호환)', () => {
    expect(renderRollupLine({ measured: true, rows: [] }, { partial: false, seq: 1 })).toBe('ELANOUS_USAGE_ROLLUP {"measured":true,"rows":[]}');
  });
  // ⭐ MF-3c0d253e — 재방출된 Pod 사용량 행(podRollupKey)의 downstream dedup: 같은 Pod 버킷은 한 번만 센다.
  test('같은 podRollupKey 두 행(abort PARTIAL ⊕ resume 최종)은 한 번만 센다', () => {
    const mk = (key: string) => JSON.stringify({ event: 'llm-usage', data: { site: 'agent-turn', provider: 'openai', model: MODEL, inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, podRollupKey: key } });
    const r = rollup([mk(`si-1|run-1|pod-rollup:agent-turn|openai|${MODEL}`), mk(`si-1|run-1|pod-rollup:agent-turn|openai|${MODEL}`)]);
    expect(r.rows[0]!.calls).toBe(1);
  });

  test('같은 podRollupKey 면 들어온 순서와 무관하게 최종 행이 부분 행을 이긴다', () => {
    const key = `si-1|run-1|pod-rollup:agent-turn|openai|${MODEL}`;
    const partial = JSON.stringify({ event: 'llm-usage', data: { site: 'agent-turn', provider: 'openai', model: MODEL, inputTokens: 10, outputTokens: 1, podRollupKey: key, partial: true, partialSeq: 3 } });
    const final = JSON.stringify({ event: 'llm-usage', data: { site: 'agent-turn', provider: 'openai', model: MODEL, inputTokens: 100, outputTokens: 9, podRollupKey: key } });
    for (const lines of [[partial, final], [final, partial]]) {
      const r = rollup(lines);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]!.calls).toBe(1);
      expect(r.rows[0]!.inputTokens).toBe(100);
    }
  });

  test('부분 행끼리는 seq 가 큰 쪽이 이긴다(순서 무관)', () => {
    const key = `si-1|run-1|pod-rollup:agent-turn|openai|${MODEL}`;
    const seq = (n: number, tokens: number) => JSON.stringify({ event: 'llm-usage', data: { site: 'agent-turn', provider: 'openai', model: MODEL, inputTokens: tokens, outputTokens: 1, podRollupKey: key, partial: true, partialSeq: n } });
    for (const lines of [[seq(2, 20), seq(5, 50)], [seq(5, 50), seq(2, 20)]]) {
      expect(rollup(lines).rows[0]!.inputTokens).toBe(50);
    }
  });

  test('키가 다른 Pod 는 따로 세고 · 키 없는 기존 행은 종전대로 행마다 센다', () => {
    const mk = (key?: string) => JSON.stringify({ event: 'llm-usage', data: { site: 'agent-turn', provider: 'openai', model: MODEL, inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, ...(key ? { podRollupKey: key } : {}) } });
    const plain = mk();
    const r = rollup([mk(`si-1|run-1|pod-rollup:agent-turn|openai|${MODEL}`), mk(`si-1|run-2|pod-rollup:agent-turn|openai|${MODEL}`), plain, plain]);
    expect(r.rows[0]!.calls).toBe(4);
  });

  test('부분판 줄은 ELANOUS_USAGE_ROLLUP_PARTIAL 로 시작하고 partial:true · seq · ISO at 을 싣는다', () => {
    const line = renderRollupLine({ measured: true, rows: [] }, { partial: true, seq: 4 });
    expect(line.startsWith('ELANOUS_USAGE_ROLLUP_PARTIAL ')).toBe(true);
    const parsed = JSON.parse(line.slice('ELANOUS_USAGE_ROLLUP_PARTIAL '.length)) as { partial?: boolean; seq?: number; at?: string; measured?: boolean; rows?: unknown[] };
    expect(parsed.partial).toBe(true);
    expect(parsed.seq).toBe(4);
    expect(typeof parsed.at).toBe('string');
    expect(parsed.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.measured).toBe(true);
    expect(parsed.rows).toEqual([]);
  });
  test('전체판 굽기 경로는 불변 — site/provider/model 묶음 · 모르는 비용은 따로 센다', () => {
    const rows = [
      JSON.stringify({ event: 'llm-usage', data: { site: 'agent-turn', provider: 'openai', model: MODEL, inputTokens: 100, outputTokens: 5, cost: { kind: 'known', usd: 0.5 } } }),
      JSON.stringify({ event: 'llm-usage', data: { site: 'agent-turn', provider: 'openai', model: MODEL, inputTokens: 50, outputTokens: 1, cost: { kind: 'unknown' } } }),
      JSON.stringify({ event: 'other', data: {} }),
      'elanous logs: result may be truncated (limitReached=true)',
    ];
    const r = rollup(rows);
    expect(r.truncated).toBe(true);
    expect(r.rows).toEqual([{ site: 'agent-turn', provider: 'openai', model: MODEL, calls: 2, inputTokens: 150, outputTokens: 6, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, cacheCreationUnmeasuredCalls: 0, usdKnown: 0.5, unknownCostCalls: 1, includedCalls: 0, apiEquivalentUsd: 0 }]);
  });
});
