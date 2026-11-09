import { afterAll, expect, test as bunTest } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyIntake } from '../src/ad-pipeline/intake.js';
import { simCli } from '../src/ux-sim/in-process-cli.js';
import {
  CLI_CHILD_ONCE_ADOPTION_FILES,
  evaluateCliChildAdoption,
  type CliChildEvent,
  withCliChildRun,
} from '../src/ux-sim/in-process-cli-539-file-adoption-sim.js';
import type { PageFacts } from '../src/product-grounding/checklist.js';
import { AD_GATES, GROUNDING_COLLECTOR_MISSING, PRODUCTION_STEPS, parseGroundingFacts, createAdPipelineDeps, createAdPipelinePlan, runAdPipeline, type AdPipelinePlan, type GroundingOutcome } from '../src/ad-pipeline/run.js';

/** ⛔ 지어내지 않는다 — `PageFacts` 의 «실제» 서명을 그대로 채운다. */
const SAMPLE_FACTS: PageFacts = {
  url: 'https://example.com/p',
  title: '샘플 제품',
  nameCandidates: ['샘플 세럼'],
  priceCandidates: ['29,000원'],
  specRows: { '기능성 여부': '해당없음' },
  images: [{ src: 'https://example.com/a.png', w: 1200, h: 1600 }],
};

async function runAdCli(args: readonly string[], mode: 'in-process' | 'spawn' = 'in-process') {
  const result = await simCli(['ad', ...args], { allowPaths: [['ad']], mode });
  return { code: result.exitCode, out: result.stdout, text: `${result.stdout}\n${result.stderr}` };
}

const cliChildAdoptionRun = {
  runId: `ad-intake-${randomUUID()}`,
  sourceFile: CLI_CHILD_ONCE_ADOPTION_FILES[0],
  events: [] as CliChildEvent[],
};
function test(name: string, action: () => void | Promise<void>, timeout?: number): void {
  bunTest(name, async () => {
    await withCliChildRun(cliChildAdoptionRun, async () => { await action(); });
  }, timeout);
}

afterAll(() => {
  expect(evaluateCliChildAdoption([{
    sourceFile: cliChildAdoptionRun.sourceFile,
    runId: cliChildAdoptionRun.runId,
  }], cliChildAdoptionRun.events)).toEqual({
    ok: true, targetFiles: 1, realChildren: 1, findings: [],
  });
});

test('classifies URL, text brief, and real image inputs', () => {
  expect(classifyIntake({ values: ['https://www.coupang.com/vp/products/0'] })).toEqual({
    ok: true, intake: { kind: 'url', url: 'https://www.coupang.com/vp/products/0' },
  });
  expect(classifyIntake({
    values: ['https://www.coupang.com/vp/products/0'],
    brief: '겨울 건조함을 겨냥한 숏폼',
  })).toEqual({
    ok: true,
    intake: {
      kind: 'url',
      url: 'https://www.coupang.com/vp/products/0',
      brief: '겨울 건조함을 겨냥한 숏폼',
    },
  });
  expect(classifyIntake({ values: ['A lightweight skincare video for a summer launch.'] })).toEqual({
    ok: true, intake: { kind: 'text', brief: 'A lightweight skincare video for a summer launch.' },
  });
  expect(classifyIntake({ imagePaths: ['/tmp/product.jpg'], brief: 'Show the product detail.' })).toEqual({
    ok: true, intake: { kind: 'image', paths: ['/tmp/product.jpg'], brief: 'Show the product detail.' },
  });
});

test('distinguishes missing, ambiguous, and unreadable input rejections', () => {
  const missing = classifyIntake({});
  const ambiguous = classifyIntake({ values: ['sku123'] });
  const unreadable = classifyIntake({ imagePaths: ['/missing.jpg'], unreadableImagePaths: ['/missing.jpg'] });
  expect(missing).toMatchObject({ ok: false, code: 'missing-input' });
  expect(ambiguous).toMatchObject({ ok: false, code: 'unresolved-url-vs-text' });
  expect(unreadable).toMatchObject({ ok: false, code: 'unreadable-image-path', paths: ['/missing.jpg'] });
  if (missing.ok || ambiguous.ok || unreadable.ok) throw new Error('rejections must not classify as intake');
  expect(new Set([missing.code, ambiguous.code, unreadable.code]).size).toBe(3);
});

test('plans generated text and real URL/image sources with all four gates', () => {
  expect(createAdPipelinePlan({ kind: 'text', brief: 'A new product launch.' })).toMatchObject({
    provenance: 'generated', stages: AD_GATES,
  });
  expect(createAdPipelinePlan({ kind: 'url', url: 'https://example.com/product' }).provenance).toBe('real');
  expect(createAdPipelinePlan({ kind: 'image', paths: ['/tmp/product.jpg'] }).provenance).toBe('real');
});

test('AdPipelinePlan accepts the existing GroundingOutcome while non-URL plans omit it', () => {
  const grounding: GroundingOutcome = { status: 'not-collected', reason: 'collector unavailable' };
  const urlPlan: AdPipelinePlan = {
    ...createAdPipelinePlan({ kind: 'url', url: 'https://example.com/p' }),
    grounding,
  };
  const textPlan: AdPipelinePlan = createAdPipelinePlan({ kind: 'text', brief: 'A new product launch.' });

  expect(urlPlan.grounding).toBe(grounding);
  expect(textPlan.grounding).toBeUndefined();
});

test('stops immediately at the rejected approval gate', async () => {
  const approvals: string[] = [];
  const stages: string[] = [];
  const result = await runAdPipeline({ kind: 'text', brief: 'A product launch.' }, {
    approve: (gate) => {
      approvals.push(gate);
      return false;
    },
    stage: (gate) => { stages.push(gate); },
    onGrounding: () => {},
  });
  expect(result).toMatchObject({ status: 'rejected', stoppedGate: 'BRIEF_OK' });
  expect(approvals).toEqual(['BRIEF_OK']);
  expect(stages).toEqual([]);
});

test('runs stages in gate order and exposes the optional unprobed clip-beats contract after every approval', async () => {
  const calls: string[] = [];
  const result = await runAdPipeline({ kind: 'image', paths: ['/tmp/product.jpg'] }, {
    approve: (gate) => { calls.push(`approve:${gate}`); return true; },
    stage: (gate) => { calls.push(`stage:${gate}`); },
    onGrounding: () => {},
  });
  expect(result.status).toBe('gates-approved');
  if (result.status !== 'gates-approved') throw new Error('게이트 통과 상태여야 한다');
  // ⭐ 「만들었다」가 아니다 — 아직 «안 부른» 제작 단계를 이름으로 돌려준다.
  expect(result.unwiredProduction.length).toBeGreaterThan(0);
  expect(result.unwiredProduction).toContain('render');
  const unprobedClipBeats: readonly number[] | undefined = result.unprobedClipBeats;
  expect(unprobedClipBeats).toBeUndefined();
  expect(calls).toEqual(AD_GATES.flatMap((gate) => [`approve:${gate}`, `stage:${gate}`]));
});

// ── 리뷰 must-fix 수리분 (2026-09-10) ────────────────────────────────
// ⛔ 「주입한 콜백이 불렸다」는 「실행 경로가 그 콜백을 «준다»」가 아니다.
//    표면이 실제로 쓰는 배선 자체를 무는 시험을 여기 둔다.

test('표면 공용 배선이 stage 와 onGrounding 을 «반드시» 준다', () => {
  const deps = createAdPipelineDeps({ ask: () => true, report: () => {} });
  expect(typeof deps.stage).toBe('function');
  expect(typeof deps.onGrounding).toBe('function');
  expect(deps.collectPageFacts).toBeUndefined();
});

test('URL 갈래에서 수집기가 없으면 「못 쟀다」로 남는다 — 「깨끗하다」로 접히지 않는다', async () => {
  const lines: string[] = [];
  const result = await runAdPipeline({ kind: 'url', url: 'https://example.com/p' }, createAdPipelineDeps({
    ask: () => true,
    report: (line) => { lines.push(line); },
  }));
  // ⛔ 「못 쟀다」면 «멈춘다» — completed 라는 값 자체가 없다.
  expect(result.status).toBe('blocked');
  expect(result.grounding?.status).toBe('not-collected');
  if (result.grounding?.status !== 'not-collected') throw new Error('접지 상태가 not-collected 여야 한다');
  expect(result.grounding.reason).toBe(GROUNDING_COLLECTOR_MISSING);
  expect(result.plan.grounding).toBe(result.grounding);
  expect(result.grounding.reason.length).toBeGreaterThan(0);
  expect(lines.some((l) => l.includes(GROUNDING_COLLECTOR_MISSING))).toBe(true);
});

test('URL 갈래에 수집기를 주면 기존 접지 체크리스트가 «실제로» 불린다', async () => {
  const facts = SAMPLE_FACTS;
  let asked = 0;
  const result = await runAdPipeline({ kind: 'url', url: 'https://example.com/p' }, createAdPipelineDeps({
    ask: () => { asked += 1; return true; },
    report: () => {},
    collectPageFacts: () => facts,
  }));
  expect(result.status).toBe('gates-approved');
  expect(result.grounding?.status).toBe('evaluated');
  if (result.grounding?.status !== 'evaluated') throw new Error('접지가 평가돼야 한다');
  expect(result.grounding.summary.length).toBeGreaterThan(0);
  expect(result.plan.grounding).toBe(result.grounding);
  expect(asked).toBe(AD_GATES.length);
});

test('승인자는 «첫 게이트부터» 접지 판정을 본다 — 실행 뒤에 붙이면 늦다', async () => {
  // ⛔ 실행 «뒤»에 result.plan 을 보는 단언은 「루프 뒤에 붙이는」 구현도 통과시킨다(Goodhart).
  //    ⇒ approve 콜백 «안»에서, 매 호출마다 값을 붙잡아 단언한다.
  const seen: { gate: string; grounding?: GroundingOutcome }[] = [];
  const result = await runAdPipeline({ kind: 'url', url: 'https://example.com/p' }, createAdPipelineDeps({
    ask: (gate, plan) => { seen.push({ gate, ...(plan.grounding ? { grounding: plan.grounding } : {}) }); return true; },
    report: () => {},
    collectPageFacts: () => SAMPLE_FACTS,
  }));

  expect(result.status).toBe('gates-approved');
  expect(seen).toHaveLength(AD_GATES.length);
  // 🔑 «첫» 호출부터 있어야 한다 — 하나라도 비면 루프 중간·뒤에 붙인 것이다.
  expect(seen.filter((entry) => entry.grounding === undefined)).toEqual([]);
  const first = seen[0]?.grounding;
  if (first?.status !== 'evaluated') throw new Error('첫 승인 시점에 평가된 접지가 실려야 한다');
  expect(first.verdict.passed).toBe(false);
  expect(first.summary.length).toBeGreaterThan(0);
});

test('텍스트 브리프의 승인자에게는 접지 칸이 «없다» — 「안 쟀다」와 「재서 통과」를 섞지 않는다', async () => {
  const seen: (GroundingOutcome | undefined)[] = [];
  await runAdPipeline({ kind: 'text', brief: 'A new product launch.' }, createAdPipelineDeps({
    ask: (_gate, plan) => { seen.push(plan.grounding); return true; },
    report: () => {},
  }));

  expect(seen).toHaveLength(AD_GATES.length);
  expect(seen.every((entry) => entry === undefined)).toBe(true);
});

test('두 접지 상태는 «서로 다른 값»이다 — 한 값으로 접히면 실패한다', async () => {
  const facts = SAMPLE_FACTS;
  const withCollector = await runAdPipeline({ kind: 'url', url: 'https://example.com/p' }, createAdPipelineDeps({
    ask: () => true, report: () => {}, collectPageFacts: () => facts,
  }));
  const without = await runAdPipeline({ kind: 'url', url: 'https://example.com/p' }, createAdPipelineDeps({
    ask: () => true, report: () => {},
  }));
  expect(withCollector.grounding?.status).not.toBe(without.grounding?.status);
});

// ── 2라운드 리뷰 수리분 ────────────────────────────────────────────
// 🔑 이 결함의 «방향»이 위험하다: URL 이 섞인 입력이 text 로 접히면 출처가 real → generated 로
//    뒤집혀, 판매 중 제품을 「생성물」로 다루게 된다. 그래서 애매하면 «거부»가 안전한 쪽이다.

test('주소가 섞였는데 «단독 URL 이 아니면» 거부한다 — 텍스트로 접지 않는다', () => {
  const mixed = classifyIntake({ values: ['https://www.coupang.com/vp/products/0 여름 캠페인'] });
  const twoUrls = classifyIntake({ values: ['https://a.example/1', 'https://b.example/2'] });
  const bare = classifyIntake({ values: ['coupang.com/vp/1'] });
  for (const result of [mixed, twoUrls, bare]) {
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('URL 이 섞인 입력은 거부돼야 한다');
    expect(result.code).toBe('unresolved-url-vs-text');
  }
  // ⛔ 그리고 «출처가 뒤집히지» 않는다 — 거부이므로 계획 자체가 안 생긴다.
  expect(classifyIntake({ values: ['https://www.coupang.com/vp/products/0'] })).toMatchObject({
    ok: true, intake: { kind: 'url' },
  });
  expect(classifyIntake({ values: ['프리미엄 세럼 신제품 컨셉 영상'] })).toMatchObject({
    ok: true, intake: { kind: 'text' },
  });
});

test('URL 과 위치인자 텍스트를 거부하고 --brief 경로를 안내한다', () => {
  const result = classifyIntake({ values: ['https://shop.example/p', '이걸로 숏폼 만들어줘'] });
  expect(result).toMatchObject({ ok: false, code: 'unresolved-url-vs-text' });
  if (result.ok) throw new Error('URL 과 위치인자 텍스트는 통과하면 안 된다');
  expect(result.message).toContain('--brief');
});

test('모호한 URL/text와 이미지 혼합 거부는 모두 --brief 경로를 안내한다', () => {
  const unresolved = classifyIntake({ values: ['https://shop.example/p', '이걸로 숏폼 만들어줘'] });
  const mixed = classifyIntake({ imagePaths: ['/tmp/p.png'], values: ['이걸로 숏폼 만들어줘'] });
  if (unresolved.ok || mixed.ok) throw new Error('두 입력 모두 거부돼야 한다');
  expect(unresolved.message).toContain('--brief');
  expect(mixed.message).toContain('--brief');
});

test('거부 «문면» 셋도 서로 다르다 — code 만 다르고 message 가 같으면 표면이 못 가른다', () => {
  const missing = classifyIntake({});
  const ambiguous = classifyIntake({ values: ['sku123'] });
  const unreadable = classifyIntake({ imagePaths: ['/missing.jpg'], unreadableImagePaths: ['/missing.jpg'] });
  if (missing.ok || ambiguous.ok || unreadable.ok) throw new Error('셋 다 거부여야 한다');
  expect(new Set([missing.message, ambiguous.message, unreadable.message]).size).toBe(3);
});

test('in-process CLI — --image 는 «읽을 수 있는 파일»만 실사로 받는다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ad-intake-'));
  const real = join(dir, 'packshot.png');
  writeFileSync(real, 'x');
  try {
    const ok = await runAdCli(['--plan', '--image', real]);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out)).toMatchObject({ intake: { kind: 'image' }, provenance: 'real' });

    const missing = await runAdCli(['--plan', '--image', join(dir, 'nope.png')]);
    expect(missing.code).toBe(1);

    const directory = await runAdCli(['--plan', '--image', dir]);   // ⛔ 디렉토리는 «읽을 수 있어도» 실사가 아니다
    expect(directory.code).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });   // ⛔ 실패해도 남기지 않는다
  }
}, 60_000);

test('이미지와 «본문 입력»이 같이 오면 거부한다 — 판매 URL 을 조용히 버리지 않는다', () => {
  const mixed = classifyIntake({ imagePaths: ['/tmp/p.png'], values: ['https://shop.example/p'] });
  expect(mixed.ok).toBe(false);
  if (mixed.ok) throw new Error('혼합 입력은 거부돼야 한다');
  expect(mixed.code).toBe('mixed-image-and-values');
  if (mixed.code !== 'mixed-image-and-values') throw new Error('코드가 갈려야 한다');
  expect(mixed.values).toEqual(['https://shop.example/p']);   // ⭐ 버린 것을 «이름으로» 돌려준다
  // ⛔ 네 거부 사유가 서로 다른 값이다
  const missing = classifyIntake({});
  const ambiguous = classifyIntake({ values: ['sku123'] });
  const unreadable = classifyIntake({ imagePaths: ['/m.jpg'], unreadableImagePaths: ['/m.jpg'] });
  if (missing.ok || ambiguous.ok || unreadable.ok) throw new Error('넷 다 거부여야 한다');
  expect(new Set([missing.code, ambiguous.code, unreadable.code, mixed.code]).size).toBe(4);
  expect(new Set([missing.message, ambiguous.message, unreadable.message, mixed.message]).size).toBe(4);
  // ⭐ --brief 로 주면 통과한다 — 「금지」에 «길»이 붙어 있다
  expect(classifyIntake({ imagePaths: ['/tmp/p.png'], brief: '여름 캠페인' })).toMatchObject({
    ok: true, intake: { kind: 'image', brief: '여름 캠페인' },
  });
});

test('실물 CLI — 필수 실물 관측 둘을 «회귀로» 못 박는다', async () => {
  const help = await runAdCli(['--help']);
  expect(help.code).toBe(0);
  expect(help.out).toContain('--plan');

  const plan = await runAdCli(['--plan', 'https://www.coupang.com/vp/products/0'], 'spawn');
  expect(plan.code).toBe(0);
  const parsed = JSON.parse(plan.out);
  expect(parsed).toMatchObject({ intake: { kind: 'url' }, provenance: 'real' });
  for (const gate of AD_GATES) expect(parsed.stages).toContain(gate);

  const withBrief = await runAdCli(['--plan', 'https://www.coupang.com/vp/products/0', '--brief', '겨울 건조함을 겨냥한 숏폼']);
  expect(withBrief.code).toBe(0);
  expect(JSON.parse(withBrief.out)).toMatchObject({
    intake: { kind: 'url', brief: '겨울 건조함을 겨냥한 숏폼' },
    provenance: 'real',
  });
  expect(evaluateCliChildAdoption([{
    sourceFile: cliChildAdoptionRun.sourceFile,
    runId: cliChildAdoptionRun.runId,
  }], cliChildAdoptionRun.events)).toEqual({
    ok: true, targetFiles: 1, realChildren: 1, findings: [],
  });
}, 60_000);


test('adoption rejects a second unannotated real child in an isolated run', async () => {
  const faultRun = {
    runId: 'ad-intake-fault-' + randomUUID(),
    sourceFile: cliChildAdoptionRun.sourceFile,
    events: [] as CliChildEvent[],
  };
  await withCliChildRun(faultRun, async () => {
    expect((await runAdCli(['--help'], 'spawn')).code).toBe(0);
    expect((await runAdCli(['--help'], 'spawn')).code).toBe(0);
  });
  const verdict = evaluateCliChildAdoption([{
    sourceFile: faultRun.sourceFile,
    runId: faultRun.runId,
  }], faultRun.events);
  expect(verdict.ok).toBe(false);
  expect(verdict.realChildren).toBe(2);
  expect(verdict.findings).toContain(faultRun.sourceFile + ' run=' + faultRun.runId + ': expected 1 child start, got 2');
}, 60_000);

// ── 4라운드: GOODHART 방어 ─────────────────────────────────────────
// 🩸 앞 라운드 시험은 `classifyIntake` 에 «이미 갈라진» values/imagePaths 를 주어
//    Commander 파싱 결함을 «가렸다». 여기서는 전체 argv 를 Commander 에 전달한다.
//    ⛔ `--image <path...>` 는 가변이라 뒤따르는 URL 을 삼킨다 — 그 경로가 이 시험의 표적이다.

test('in-process Commander argv — `--image` 가 삼킨 URL 도 «혼합 입력»으로 가른다 (양쪽 순서)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ad-argv-'));
  const img = join(dir, 'pack.png');
  writeFileSync(img, 'x');
  try {
    // ⛔ 이 순서가 앞 라운드에 «깨져 있었다» — URL 이 image 목록으로 삼켜져
    //    「경로를 못 읽는다」는 «틀린 이유»가 나왔다.
    const swallowed = await runAdCli(['--plan', '--image', img, 'https://shop.example/p']);
    expect(swallowed.code).toBe(1);
    expect(swallowed.text).toContain('--brief');
    expect(swallowed.text).not.toContain('unreadable');

    const before = await runAdCli(['--plan', 'https://shop.example/p', '--image', img]);
    expect(before.code).toBe(1);
    expect(before.text).toContain('--brief');

    // ⭐ 「금지」에 붙인 «길»이 실제로 통한다
    const viaBrief = await runAdCli(['--plan', '--image', img, '--brief', '여름 캠페인']);
    expect(viaBrief.code).toBe(0);
    expect(JSON.parse(viaBrief.text.split('\n\n')[0] || viaBrief.text.trim()))
      .toMatchObject({ intake: { kind: 'image', brief: '여름 캠페인' }, provenance: 'real' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 90_000);

test('⛔ 「완료」라는 값이 «없다» — 게이트 통과는 「만들었다」가 아니다', async () => {
  const result = await runAdPipeline({ kind: 'text', brief: '신제품 컨셉 영상' }, createAdPipelineDeps({
    ask: () => true, report: () => {},
  }));
  expect(result.status).toBe('gates-approved');
  expect(JSON.stringify(result)).not.toContain('completed');
  if (result.status !== 'gates-approved') throw new Error('상태가 갈려야 한다');
  // ⭐ 안 부른 제작 단계를 «전부» 이름으로 낸다 — 「무엇이 남았나」를 사람이 읽는다.
  expect([...result.unwiredProduction]).toEqual([...PRODUCTION_STEPS]);
});

test('URL 접지를 못 쟀으면 게이트를 «묻지도» 않는다 — 사람의 승인을 헛되이 쓰지 않는다', async () => {
  let asked = 0;
  const result = await runAdPipeline({ kind: 'url', url: 'https://example.com/p' }, createAdPipelineDeps({
    ask: () => { asked += 1; return true; },
    report: () => {},
  }));
  expect(result.status).toBe('blocked');
  expect(asked).toBe(0);
});

// ── 6라운드: 내가 4라운드에 «낸» 회귀 ──────────────────────────────
// 🩸 삼킨 URL 을 되돌리려고 만든 자가 «너무 느슨해» 진짜 이미지 경로를 URL 로 오인했다.
//    경로에 점이 든 디렉토리(`/tmp/shop.example/pack.png`)면 거부됐다.

test('in-process Commander argv — 점(.)이 든 «진짜» 이미지 경로를 URL 로 오인하지 않는다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ad-dot-'));
  const dotted = join(root, 'shop.example');
  mkdirSync(dotted, { recursive: true });
  const img = join(dotted, 'pack.png');
  writeFileSync(img, 'x');
  try {
    const result = await runAdCli(['--plan', '--image', img]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ intake: { kind: 'image', paths: [img] }, provenance: 'real' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test('오류 «우선순위»가 의도다 — 혼합 입력이 「경로를 못 읽는다」보다 «먼저»다', () => {
  // ⛔ 둘 다 참일 때 경로 오류를 먼저 내면, 사람이 경로를 고쳐도 안 풀린다.
  const both = classifyIntake({
    imagePaths: ['/m.jpg'], unreadableImagePaths: ['/m.jpg'], values: ['https://shop.example/p'],
  });
  expect(both).toMatchObject({ ok: false, code: 'mixed-image-and-values' });
  // 혼합이 «아니면» 경로 오류가 나온다
  expect(classifyIntake({ imagePaths: ['/m.jpg'], unreadableImagePaths: ['/m.jpg'] }))
    .toMatchObject({ ok: false, code: 'unreadable-image-path' });
});

// ── 7라운드: «가변 옵션»이라는 뿌리를 뽑고, 사람 칸에 «길»을 냈다 ──────

test('in-process Commander argv — `--image` 는 뒤따르는 텍스트·URL 을 «삼키지 않는다»', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ad-swallow-'));
  const img = join(dir, 'pack.png');
  writeFileSync(img, 'x');
  try {
    for (const trailing of ['summer campaign', 'https://shop.example/p']) {
      const r = await runAdCli(['--plan', '--image', img, trailing]);
      expect(r.code).toBe(1);
      expect(r.text).toContain('--brief');
      // ⛔ «가짜» 경로 오류가 나오면 실패한다 — 사람이 경로를 고치러 간다.
      expect(r.text).not.toContain('unreadable');
    }
    // ⭐ 반복 가능한 단일 값이라 이미지 여럿도 받는다
    const two = await runAdCli(['--plan', '--image', img, '--image', img]);
    expect(two.code).toBe(0);
    expect(JSON.parse(two.text.trim()).intake.paths).toHaveLength(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 90_000);

test('실물 argv — `--facts` 로 접지를 «건네주면» blocked 가 풀리고 게이트가 열린다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ad-facts-'));
  const factsPath = join(dir, 'facts.json');
  writeFileSync(factsPath, JSON.stringify(SAMPLE_FACTS));
  const cwd = join(import.meta.dir, '..');
  const spawn = async (args: string[], stdin: string) => {
    const proc = Bun.spawn(['bun', 'bin/elanous.mjs', 'ad', ...args], {
      cwd, stdin: new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe',
    });
    const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code, text: `${out}\n${err}` };
  };
  try {
    // ⛔ 접지를 «안 주면» 게이트를 묻지도 않고 막힌다
    const blocked = await spawn([SAMPLE_FACTS.url], '');
    expect(blocked.code).toBe(1);
    expect(blocked.text).toContain('blocked');
    expect(blocked.text).not.toContain('Approve BRIEF_OK');

    // ✅ 주면 «진짜» 체크리스트가 돌고 게이트가 열린다
    const wired = await spawn([SAMPLE_FACTS.url, '--facts', factsPath], 'y\ny\ny\ny\n');
    expect(wired.text).toContain('Approve BRIEF_OK');
    expect(wired.text).not.toContain('blocked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

// ── 8라운드: «다른 상품의 사실»로 접지하면 허위 표시가 된다 ─────────
test('접지 사실은 «같은 주소»의 것이어야 한다 — 다른 상품의 사실을 거절한다', () => {
  const good = parseGroundingFacts(SAMPLE_FACTS, SAMPLE_FACTS.url);
  expect(good.ok).toBe(true);

  const otherProduct = parseGroundingFacts({ ...SAMPLE_FACTS, url: 'https://other.example/z' }, SAMPLE_FACTS.url);
  expect(otherProduct.ok).toBe(false);
  if (otherProduct.ok) throw new Error('다른 주소의 사실은 거절돼야 한다');
  expect(otherProduct.reason).toContain('다른 주소');

  // ⛔ 모양이 안 맞으면 체크리스트가 «런타임 예외»로 죽기 전에 이름을 대고 거절한다
  for (const broken of [null, 'x', {}, { url: SAMPLE_FACTS.url }, { ...SAMPLE_FACTS, images: 'no' },
                        { ...SAMPLE_FACTS, specRows: [] }, { ...SAMPLE_FACTS, nameCandidates: 1 }]) {
    const r = parseGroundingFacts(broken, SAMPLE_FACTS.url);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('망가진 사실은 거절돼야 한다');
    expect(r.reason.length).toBeGreaterThan(0);
  }
});

test('in-process Commander argv — 망가진/다른 주소의 facts 는 «명확한 입력 오류»다 (비정상 종료가 아니다)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ad-badfacts-'));
  const write = (name: string, body: string) => { const p = join(dir, name); writeFileSync(p, body); return p; };
  try {
    const malformed = await runAdCli([SAMPLE_FACTS.url, '--facts', write('bad.json', '{not json')]);
    expect(malformed.code).toBe(1);
    expect(malformed.text).toContain('접지 사실 JSON');
    expect(malformed.text).not.toContain('SyntaxError:');   // ⛔ 스택 트레이스면 실패다

    const wrongUrl = await runAdCli([SAMPLE_FACTS.url, '--facts',
      write('other.json', JSON.stringify({ ...SAMPLE_FACTS, url: 'https://other.example/z' }))]);
    expect(wrongUrl.code).toBe(1);
    expect(wrongUrl.text).toContain('다른 주소');
    expect(wrongUrl.text).not.toContain('Approve BRIEF_OK');   // ⛔ 게이트를 열면 안 된다

    const shapeless = await runAdCli([SAMPLE_FACTS.url, '--facts',
      write('shape.json', JSON.stringify({ url: SAMPLE_FACTS.url }))]);
    expect(shapeless.code).toBe(1);
    expect(shapeless.text).not.toContain('Approve BRIEF_OK');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

// ── 9라운드: 검증이 «모든 실행 모드»에 걸리나 ⊕ «원소»까지 보나 ────
test('접지 사실 검증은 «원소»까지 본다 — 「배열이다」는 「문자열 배열이다」가 아니다', () => {
  const bad: unknown[] = [
    { ...SAMPLE_FACTS, nameCandidates: [1] },
    { ...SAMPLE_FACTS, priceCandidates: [{}] },
    { ...SAMPLE_FACTS, images: [null] },
    { ...SAMPLE_FACTS, images: [{ src: 'x', w: '1200', h: 1600 }] },
    { ...SAMPLE_FACTS, images: [{ src: 'x', w: Number.NaN, h: 1600 }] },
    { ...SAMPLE_FACTS, specRows: { x: 1 } },
  ];
  for (const raw of bad) {
    const r = parseGroundingFacts(raw, SAMPLE_FACTS.url);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('원소가 틀린 사실은 거절돼야 한다');
  }
  expect(parseGroundingFacts(SAMPLE_FACTS, SAMPLE_FACTS.url).ok).toBe(true);
});

test('in-process Commander argv — `--plan` 도 facts 검증을 «건너뛰지 않는다»', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ad-planfacts-'));
  const write = (name: string, body: string) => { const p = join(dir, name); writeFileSync(p, body); return p; };
  const good = write('good.json', JSON.stringify(SAMPLE_FACTS));
  try {
    // ⛔ 텍스트 갈래에 --facts 는 뜻이 없다 — 계획 모드에서도 거절한다
    const wrongBranch = await runAdCli(['--plan', '신제품 컨셉 영상', '--facts', good]);
    expect(wrongBranch.code).toBe(1);
    expect(wrongBranch.text).toContain('--facts');

    // ⛔ 다른 주소의 facts 도 계획 모드에서 «미리» 걸린다
    const wrongUrl = await runAdCli(['--plan', SAMPLE_FACTS.url, '--facts',
      write('other.json', JSON.stringify({ ...SAMPLE_FACTS, url: 'https://other.example/z' }))]);
    expect(wrongUrl.code).toBe(1);
    expect(wrongUrl.text).toContain('다른 주소');

    // ✅ 맞는 facts 면 계획이 나온다
    const ok = await runAdCli(['--plan', SAMPLE_FACTS.url, '--facts', good]);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.text.trim())).toMatchObject({ intake: { kind: 'url' }, provenance: 'real' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

// ── 10라운드: 계획도 «한 일보다 많이 주장»하면 안 된다 ─────────────
test('계획이 «실행 전제»를 말한다 — 「이대로 돌겠구나」로 읽히지 않는다', () => {
  const urlPlan = createAdPipelinePlan({ kind: 'url', url: 'https://shop.example/p' });
  expect(urlPlan.prerequisites.length).toBeGreaterThan(0);
  expect(urlPlan.prerequisites[0]).toContain('--facts');
  // ⭐ 접지를 이미 갖고 있으면 전제가 비고, 그때만 실행이 blocked 되지 않는다
  expect(createAdPipelinePlan({ kind: 'url', url: 'https://shop.example/p' }, { hasGroundingFacts: true }).prerequisites)
    .toHaveLength(0);
  // ⛔ 그리고 «안 부른» 제작 단계를 계획 단계에서부터 이름으로 말한다
  expect([...urlPlan.unwiredProduction]).toEqual([...PRODUCTION_STEPS]);
  // 텍스트·이미지 갈래는 접지 전제가 없다
  expect(createAdPipelinePlan({ kind: 'text', brief: 'x' }).prerequisites).toHaveLength(0);
  expect(createAdPipelinePlan({ kind: 'image', paths: ['/a.png'] }).prerequisites).toHaveLength(0);
});

test('in-process Commander argv — `--plan` 산출이 실행 전제를 «보여 준다»', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ad-prereq-'));
  const factsPath = join(dir, 'facts.json');
  writeFileSync(factsPath, JSON.stringify(SAMPLE_FACTS));
  try {
    const bare = await runAdCli(['--plan', SAMPLE_FACTS.url]);
    expect(bare.code).toBe(0);
    const bareJson = JSON.parse(bare.out);
    expect(bareJson.prerequisites.join(' ')).toContain('--facts');
    expect(bareJson.unwiredProduction).toContain('render');

    const withFacts = await runAdCli(['--plan', SAMPLE_FACTS.url, '--facts', factsPath]);
    expect(JSON.parse(withFacts.out).prerequisites).toHaveLength(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 90_000);
