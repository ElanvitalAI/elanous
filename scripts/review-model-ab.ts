#!/usr/bin/env bun
// 리뷰 «품질»을 두 모델로 가른다 — ***같은 diff · 같은 의도 · 모델만 다르게.***
//
// 🩸 왜 있는가 — 2026-09-23: `#19870`(review tier loaded→best)을 두고 🅢 와 🅣 가 같은 칸을 열어 뒀다:
//   🔲 ***「리뷰 품질이 떨어지나」*** — 되돌릴지 가르는 값인데 둘 다 못 쟀다.
//
// ⛔⭐⭐ 이것은 «관찰»로 못 잰다. 원장의 리뷰 판정들은 ***서로 다른 diff*** 를 본 것이라,
//   모델별로 갈라 평균을 내면 「모델 차이」가 아니라 ***「그날 어떤 PR 이 왔나」***를 재게 된다.
//   ⇒ 같은 입력을 두 모델에 먹이는 A/B 만이 답한다(형태는 `MANUAL-harness-provider-ab-methodology`).
//
// ⛔⭐ **기본은 dry-run 이다** — 이 자는 «돈을 쓴다»(astra 는 건당 ~$0.06 실측). `--run` 없이는 모델을 안 부른다.
// ⛔ 「한 쌍」으로 순위를 매기지 않는다. 산출은 «분포»이고, 판정은 사람이 한다.
//    (그 매뉴얼 §: *"새 축에 「많으면 좋다」를 붙이지 않는다 — 기준선이 없으면 분포만 남긴다"*)
import { execFileSync } from 'node:child_process';
import { reviewPullRequest, type ReviewInput } from '../src/agent-substrate/pr-reviewer.js';
import { lookupLlmTierSpec, type LlmTierProvider } from '../src/model-tier/llm-tier-map.js';

interface Arm { label: string; provider: LlmTierProvider; model: string; effort?: string }

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * `provider/tier[@effort]` 를 푼다. 모델 이름은 ***사다리에서*** 얻는다(손으로 적으면 사다리가 바뀔 때 늙는다).
 *
 * ⭐⭐ `@effort` 는 ***사다리가 «표현하지 못하는» 칸을 재기 위한 것***이다(대표 2026-09-23).
 *   📏 실측: Codex API 가 400 으로 직접 답했다 —
 *     `Supported values are: 'none','minimal','low','medium','high','xhigh','max'` (***일곱***).
 *   그런데 사다리가 쓰는 `ReasoningLevel` 은 `off|low|medium|high` ***넷***뿐이라
 *   ***`xhigh`·`max` 를 가리킬 칸이 아예 없다.***
 * ⛔ 그래서 ***사다리를 고치기 «전에»*** 이 축으로 «재고», 그 결과로 칸 배치를 정한다.
 *   (재기 전에 구조를 바꾸면, 바꾼 것이 옳았는지 물을 자가 사라진다.)
 */
function armOf(spec: string): Arm {
  const at = spec.indexOf('@');
  const base = at < 0 ? spec : spec.slice(0, at);
  const override = at < 0 ? undefined : spec.slice(at + 1);
  const [provider, tier] = base.split('/') as [LlmTierProvider, string];
  const s = lookupLlmTierSpec(provider, tier as never);
  return { label: spec, provider, model: s.model, effort: override ?? s.reasoningLevel };
}

type GitCommandRunner = (args: string[], options: { encoding: 'utf8'; maxBuffer: number; env: NodeJS.ProcessEnv }) => string;

export function diffOf(ref: string, run = false, runGit: GitCommandRunner = (args, options) => execFileSync('git', args, options)): string {
  const options = { encoding: 'utf8' as const, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0' } };
  const unavailable = (reason: string): string => {
    const unmeasured = `UNMEASURED: diff context for ${ref} is unavailable (${reason}).`;
    if (run) throw new Error(`${unmeasured} --run aborted before any model review.`);
    return unmeasured;
  };
  let partialClone = false;
  let partialConfig = '';
  try {
    partialConfig = runGit(['config', '--get-regexp', '^(remote\\..*\\.(promisor|partialclonefilter)|extensions\\.partialclone)$'], options);
    partialClone = partialConfig.trim().length > 0;
  } catch (error) {
    // `git config --get-regexp` exits 1 when no partial-clone key exists.
    const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
    if (status !== 1) throw error;
  }
  if (partialClone) {
    // GIT_NO_LAZY_FETCH is honored by modern Git; older releases ignore it. An empty
    // GIT_ALLOW_PROTOCOL additionally forbids every transport, so local objects remain
    // readable on old Git while a missing object fails closed instead of fetching.
    let raw: string;
    try { raw = runGit(['diff-tree', '--root', '-m', '--no-commit-id', '--raw', '--no-abbrev', '-r', ref], options); }
    catch { return unavailable('local diff objects could not be enumerated without fetching'); }
    for (const line of raw.split('\n')) {
      const match = line.match(/^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) /);
      if (!match || match[1] === '160000' || match[2] === '160000') continue;
      for (const oid of [match[3]!, match[4]!]) {
        if (/^0+$/.test(oid)) continue;
        try { runGit(['cat-file', '-e', oid], options); }
        catch { return unavailable(`diff object ${oid.slice(0, 12)} is absent locally`); }
      }
    }
  }
  try {
    return runGit(['show', '--format=', '--unified=3', ref], options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/could not read Username|could not fetch .* from promisor remote|fatal: (?:bad object|unable to read|could not get object info)|missing blob/i.test(message)) {
      return unavailable('a required diff object is missing locally');
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const ref = arg('ref') ?? 'HEAD';
  const arms = (arg('arms') ?? 'openai-codex/loaded,openai-codex/best').split(',').map(armOf);
  const intent = arg('intent') ?? '이 변경이 그 목적을 달성하는가. 결함이 있으면 must-fix 로 든다.';
  const run = process.argv.includes('--run');

  const diff = diffOf(ref, run);
  if (diff.startsWith('UNMEASURED:')) console.warn(diff);
  console.log(`\n  📏 대상 ${ref} — diff ${diff.length.toLocaleString()}자`);
  console.log(`  ⚖️  ${arms.map((a) => `${a.label} → ${a.model}·${a.effort}`).join('   ↔   ')}`);

  if (!run) {
    console.log(`\n  🔲 ***dry-run*** — 모델을 «부르지 않았다». 실제로 재려면 \`--run\` 을 준다.`);
    console.log(`     ⚠️ 이 자는 돈을 쓴다. 한 팔당 리뷰 1건이고, 위 두 모델의 단가는 «다르다».`);
    return;
  }

  // ⛔ `streamLLM` 의 `provider` 는 «이름 문자열»이 아니라 «객체»다 — `dev-pipeline` 과 같은 방식으로 푼다.
  const { streamLLM, getProvider, inferProviderFromModel } = await import('../src/llm.js');
  const input: ReviewInput = { prDiff: diff, phaseIntent: intent };
  for (const a of arms) {
    const t0 = Date.now();
    const r = await reviewPullRequest(input, async (prompt) =>
      streamLLM([{ role: 'user', content: prompt }], () => {}, {
        model: a.model,
        provider: inferProviderFromModel(a.model) ? getProvider(a.model) : undefined,
        // ⛔ 사다리의 effort 든 `@` 로 덮은 값이든 «그대로» 보낸다 — 지어낸 값은 API 가 400 으로 거부한다(실측).
        reasoningEffort: a.effort as never,
      }));
    // ⛔ 세 칸을 «따로» 낸다 — 합치면 「must 1 + should 5」와 「must 5 + should 1」이 같아 보인다.
    console.log(`\n  ${a.label.padEnd(22)} verdict=${r.verdict}  mustFix=${r.mustFix.length}  shouldFix=${r.shouldFix.length}  reviewed=${r.reviewed}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    for (const m of r.mustFix.slice(0, 5)) console.log(`      ⛔ ${m.slice(0, 150)}`);
  }
  console.log(`\n  ⛔ 한 쌍은 «분포»다 — 순위를 매기지 않는다. 여러 ref 로 돌려 그 분포를 본다.`);
}

if (import.meta.main) await main();
