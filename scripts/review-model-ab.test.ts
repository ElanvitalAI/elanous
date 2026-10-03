// `review-model-ab` 의 계약 — ⛔ 「돈을 안 쓴다」가 «기본»인가.
//
// 🩸 이 자는 유료 모델을 부른다. 그래서 무는 것은 산출 모양이 아니라 ***「부르지 않았나」***다.
import { setDefaultTimeout, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { lookupLlmTierSpec } from '../src/model-tier/llm-tier-map.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(240_000);

const SCRIPT = new URL('./review-model-ab.ts', import.meta.url).pathname;

function run(args: string[]): { out: string; code: number } {
  // ⛔ 자격증명을 «지우고» 돌린다 — 실수로 모델을 불렀다면 여기서 터져야 한다(조용히 성공하면 안 된다).
  const env = { ...process.env, OPENAI_API_KEY: '', XAI_API_KEY: '', ANTHROPIC_API_KEY: '' };
  const r = spawnSync('bun', [SCRIPT, ...args], { encoding: 'utf8', env, timeout: 120_000 });
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, code: r.status ?? -1 };
}

describe('review-model-ab — 기본은 «돈을 안 쓴다»', () => {
  it('⛔ `--run` 없이는 dry-run 이고, 그 사실을 «말한다»', () => {
    const { out, code } = run(['--ref', 'HEAD']);
    expect(code).toBe(0);
    expect(out).toContain('dry-run');
    expect(out).toContain('모델을 «부르지 않았다»');
  });

  it('⛔ dry-run 산출에 리뷰 «판정»이 없다 — 있으면 어딘가에서 모델을 부른 것이다', () => {
    const { out } = run(['--ref', 'HEAD']);
    expect(out).not.toContain('verdict=');
    expect(out).not.toContain('mustFix=');
  });

  it('⭐ 팔의 모델 이름은 «사다리»에서 온다 — 손으로 적힌 이름이 아니다', () => {
    const { out } = run(['--ref', 'HEAD', '--arms', 'openai-codex/loaded,openai-codex/best']);
    const loaded = lookupLlmTierSpec('openai-codex', 'loaded').model;
    const best = lookupLlmTierSpec('openai-codex', 'best').model;
    expect(out).toContain(loaded);
    expect(out).toContain(best);
    // 자가 무는지 — 둘이 같으면 이 시험은 «아무 말도 안 한다»(grok 사다리가 실제로 그렇다).
    expect(loaded).not.toBe(best);
  });

  it('⭐ `@effort` 는 사다리의 effort 를 «덮는다» — 사다리에 없는 칸(xhigh·max)을 재기 위한 축', () => {
    const { out, code } = run(['--ref', 'HEAD', '--arms', 'openai-codex/best,openai-codex/best@xhigh']);
    expect(code).toBe(0);
    const best = lookupLlmTierSpec('openai-codex', 'best');
    expect(out).toContain(`${best.model}·${best.reasoningLevel}`);
    expect(out).toContain(`${best.model}·xhigh`);
    expect(best.reasoningLevel).not.toBe('xhigh');   // 자가 무는지 — 같으면 위 두 줄이 한 줄을 두 번 본다
  });
});
