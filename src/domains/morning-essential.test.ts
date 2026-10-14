import { test, expect, describe, beforeAll, afterAll, mock } from 'bun:test';
import { buildEssentialMessage, synthesizeEssentialBrief, type EssentialSynthOpts } from './morning-essential.js';
import * as morningEssentialNs from './morning-essential.js';
import * as morningSynthesisNs from './morning-synthesis.js';
import type { MorningSources } from './morning-synthesis.js';

function fakeSources(over: Partial<MorningSources> = {}): MorningSources {
  return {
    nowIso: '2026-07-10T00:00:00Z', dateKr: '7월 10일 (금)',
    regime: null, regimeSummary: '🟢위험선호 +0.52', regimeRipple: '',
    macro: '', finviz: '', backbone: '', rotation: '', country: '', sector: '', movers13f: '',
    dislocation: '', semis: null, usPulse: { date: '2026-07-09', report: '반도체 섹터 +1.2%\n애플 +0.8%' },
    board: {
      generatedAt: '', regime: null, capstone: null,
      feed: [
        { source: 'buzz', ts: '2026-07-10T00:00:00Z', title: '하이닉스 급부상 x120' },
        { source: 'dig', ts: '2026-07-10T00:00:00Z', title: '🔎 HBM' },
        { source: 'reflection', ts: '2026-07-10T00:00:00Z', title: '🧠 replay 회고' },
      ],
      bySource: {},
    },
    ...over,
  };
}

// ── composeMorningReport 경유 model 전달 관측(SWAP-BENCH-CRON 둘째 조각) ─────────
// 사슬 관측: composeMorningReport(narrate) → synthesizeEssentialBrief(md,{model})
// → providerFor(cfg, model). collectMorningSources 만 가짜 소스로 갈라끊고,
// synthesizeEssentialBrief 는 실물 위에 관측 providerFor 를 얹은 랩으로 대체한다.
// R-TST23: afterAll 의 mock.module 원본 반환으로 레지스트리를 복구한다.
type ComposeProviderFor = NonNullable<EssentialSynthOpts['providerFor']>;
const realMorningEssential = { ...morningEssentialNs };
const realMorningSynthesis = { ...morningSynthesisNs };
const providerForCalls: unknown[][] = [];
const narrFakeText = '[관전] composeMorningReport 가 명시 model 을 전달했다.';
const narrProvider = {
  name: 'fake',
  async *streamChat() { yield { type: 'text' as const, delta: narrFakeText }; },
} as unknown as ReturnType<ComposeProviderFor>;
const recordingSynth = (detailMarkdown: string, opts: EssentialSynthOpts = {}) =>
  realMorningEssential.synthesizeEssentialBrief(detailMarkdown, {
    ...opts,
    available: () => true,
    providerFor: (...args) => { providerForCalls.push(args); return narrProvider; },
  });
afterAll(() => { mock.module('./morning-synthesis.js', () => realMorningSynthesis); });
afterAll(() => { mock.module('./morning-essential.js', () => realMorningEssential); });

describe('morning-essential — buildEssentialMessage', () => {
  test('국면·미국장·버즈·밤샘 + 링크', () => {
    const msg = buildEssentialMessage(fakeSources(), '', { htmlUrl: 'https://s3/x.html', mdUrl: 'https://s3/x.md' });
    expect(msg).toContain('🌅 *Conatus 아침 브리핑*');
    expect(msg).toContain('🟢위험선호 +0.52');
    expect(msg).toContain('🇺🇸 *미국장* (2026-07-09)');
    expect(msg).toContain('반도체 섹터 +1.2%');
    expect(msg).toContain('💬 *커뮤니티 버즈*');
    expect(msg).toContain('하이닉스 급부상 x120');
    expect(msg).toContain('🌙 *밤샘 종합*');
    expect(msg).toContain('[HTML](https://s3/x.html)');
    expect(msg).toContain('[MD](https://s3/x.md)');
  });

  test('LLM 서사는 하단 서사 블록으로', () => {
    const msg = buildEssentialMessage(fakeSources(), '[관전] 반도체 강세.', null);
    expect(msg).toContain('🧭 *서사*');
    expect(msg).toContain('[관전] 반도체 강세.');
    // 서사(하단)는 버즈(위)보다 뒤에 와야 한다(결론-우선).
    expect(msg.indexOf('🧭 *서사*')).toBeGreaterThan(msg.indexOf('💬 *커뮤니티 버즈*'));
  });

  test('업로드 null 이면 링크 없음(fail-soft)', () => {
    const msg = buildEssentialMessage(fakeSources(), '', null);
    expect(msg).not.toContain('상세 리포트');
    expect(msg).toContain('verify+HITL');
  });

  test('extras 없으면 매력도/섹터 블록은 생략(fail-soft·기존 경로 무영향)', () => {
    const msg = buildEssentialMessage(fakeSources(), '', null);
    expect(msg).not.toContain('📊 *매력도 Δ*');
    expect(msg).not.toContain('🗺 *섹터순환*');
    expect(msg).toContain('🎯 *결론*'); // 국면만 있어도 결론 헤더는 나온다
  });

  const heatmap = {
    attractiveness: {
      asOf: '2026-07-16', prevAsOf: '2026-07-15',
      asset: [
        { label: '리츠', score: 66, signal: 'BUY', dir: 'up' },
        { label: '부동산', score: 66, signal: 'BUY', dir: 'up' },
        { label: '미국주식', score: 64.8, signal: 'HOLD', dir: 'up' },
        { label: '크립토', score: 43.1, signal: 'HOLD', dir: 'up' },
        { label: '원자재', score: 55.2, signal: 'SELL', dir: 'down' },
        { label: '금', score: 43.6, signal: 'SELL', dir: 'up' },
      ],
      country: [
        { label: '미국', score: 64.8, signal: 'HOLD', dir: 'up' },
        { label: '한국', score: 58.9, signal: 'SELL', dir: 'up' },
        { label: '일본', score: 61.4, signal: 'HOLD', dir: 'down' },
      ],
      sector: [
        { label: '산업재', score: 67.6, signal: 'HOLD', dir: 'up' },
        { label: '금융', score: 66.6, signal: 'BUY', dir: 'up' },
        { label: '소재', score: 46.2, signal: 'HOLD', dir: 'up' },
      ],
    },
    usSectors: { date: '2026-07-16', sectors: [
      { name: '소재', dayPct: 1.3, streak: 1 }, { name: '필수소비', dayPct: 1.1, streak: 2 },
      { name: '헬스케어', dayPct: -0.8, streak: -3 },
    ], notables: [{ symbol: 'META', dayPct: 6.0 }, { symbol: 'CRWD', dayPct: -5.7 }] },
    krSectors: { date: '2026-07-16', sectors: [
      { name: '은행', dayPct: 0.1, streak: 1 }, { name: '반도체', dayPct: -9.5, streak: -2 },
      { name: '건설', dayPct: -3.2, streak: -1 },
    ] },
    live: null, newsSectors: null, generatedAt: '',
  } as any;
  const capstone = { target: 'CASH_100', label: '🛡️ 약세(비회복) — 스마트현금 100%', samsung: 289000, r3Level: 318000 } as any;

  test('extras 주입 시 결론(캡스톤)·매력도 Δ·섹터순환 블록 렌더', () => {
    const msg = buildEssentialMessage(fakeSources(), '', null, { heatmap, capstone });
    // 결론에 캡스톤
    expect(msg).toContain('🛡️ 캡스톤 *CASH_100*');
    expect(msg).toContain('R3 ₩318,000 회복 시 LONG');
    // 매력도 Δ + 신호 요약
    expect(msg).toContain('📊 *매력도 Δ* (전일 대비 · 2026-07-16)');
    expect(msg).toContain('리츠66▲✅');
    expect(msg).toContain('한국58.9▲⛔');
    expect(msg).toContain('매수 리츠·부동산·금융');
    expect(msg).toContain('매도 원자재·금·한국');
    // 섹터순환 US/KR + 무버
    expect(msg).toContain('🗺 *섹터순환* (2026-07-16 EOD)');
    expect(msg).toContain('소재+1.3');
    expect(msg).toContain('반도체-9.5');
    expect(msg).toContain('급등 META+6');
    // 순서: 결론 → 매력도 → 섹터순환 → 미국장
    expect(msg.indexOf('🎯 *결론*')).toBeLessThan(msg.indexOf('📊 *매력도 Δ*'));
    expect(msg.indexOf('📊 *매력도 Δ*')).toBeLessThan(msg.indexOf('🗺 *섹터순환*'));
    expect(msg.indexOf('🗺 *섹터순환*')).toBeLessThan(msg.indexOf('🇺🇸 *미국장*'));
  });
});

describe('synthesizeEssentialBrief model seam (SWAP-BENCH-CRON 첫 조각)', () => {
  type ProviderFor = NonNullable<EssentialSynthOpts['providerFor']>;
  const fakeProvider = (text: string) => ({
    name: 'fake',
    async *streamChat() { yield { type: 'text' as const, delta: text }; },
  }) as unknown as ReturnType<ProviderFor>;

  test('ⓐ opts.model 이면 주입 providerFor 가 그 model 을 받고 스트림 텍스트가 trim 되어 돌아온다', async () => {
    const seen: (string | undefined)[] = [];
    const out = await synthesizeEssentialBrief('# 상세', {
      model: 'z-ai/glm-5.3-flash',
      available: () => true,
      providerFor: (_cfg, model) => { seen.push(model); return fakeProvider('  [관전] 반도체 강세.  \n'); },
    });
    expect(seen).toEqual(['z-ai/glm-5.3-flash']);
    expect(out).toBe('[관전] 반도체 강세.');
  });

  test('ⓑ model 없으면 providerFor 둘째 인자는 undefined(지금과 같은 기본 경로)', async () => {
    const calls: unknown[][] = [];
    const out = await synthesizeEssentialBrief('# 상세', {
      available: () => true,
      providerFor: (...args) => { calls.push(args); return fakeProvider('서사'); },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toBeUndefined();
    expect(out).toBe('서사');
  });

  test('ⓒ available()=false 면 provider 를 부르지 않고 빈 문자열', async () => {
    let called = 0;
    const out = await synthesizeEssentialBrief('# 상세', {
      model: 'z-ai/glm-5.3-flash',
      available: () => false,
      providerFor: () => { called++; return fakeProvider('x'); },
    });
    expect(out).toBe('');
    expect(called).toBe(0);
  });
});

describe('composeMorningReport model seam (SWAP-BENCH-CRON 둘째 조각)', () => {
  let composeMorningReport: typeof import('./morning-report.js')['composeMorningReport'];

  beforeAll(async () => {
    mock.module('./morning-synthesis.js', () => ({
      ...realMorningSynthesis,
      collectMorningSources: async () => fakeSources(),
    }));
    mock.module('./morning-essential.js', () => ({
      ...realMorningEssential,
      synthesizeEssentialBrief: recordingSynth,
    }));
    ({ composeMorningReport } = await import('./morning-report.js'));
  });

  test('ⓓ narrate·model 지정 시 composeMorningReport 가 명시 model 을 providerFor 둘째 인자로 전달 + 기존 조립 회귀', async () => {
    providerForCalls.length = 0;
    const msg = await composeMorningReport(new Date('2026-07-10T00:00:00Z'), {
      narrate: true, upload: false, model: 'z-ai/glm-5.3-flash',
    });
    expect(providerForCalls).toHaveLength(1);
    expect(providerForCalls[0]![1]).toBe('z-ai/glm-5.3-flash');
    // 조립 회귀: 결정론 에센셜 + 서사(하단) 순서 그대로.
    expect(msg).toContain('🌅 *Conatus 아침 브리핑* — 7월 10일 (금)');
    expect(msg).toContain('💬 *커뮤니티 버즈*');
    expect(msg).toContain('하이닉스 급부상 x120');
    expect(msg).toContain('🧭 *서사*');
    expect(msg).toContain(narrFakeText);
    expect(msg.indexOf('🧭 *서사*')).toBeGreaterThan(msg.indexOf('💬 *커뮤니티 버즈*'));
    expect(msg).toContain('verify+HITL');
  });

  test('ⓔ model 미지정 시 providerFor 둘째 인자는 undefined(기존 기본 경로 보존)', async () => {
    providerForCalls.length = 0;
    const msg = await composeMorningReport(new Date('2026-07-10T00:00:00Z'), { narrate: true, upload: false });
    expect(providerForCalls).toHaveLength(1);
    expect(providerForCalls[0]![1]).toBeUndefined();
    expect(msg).toContain('🧭 *서사*');
    expect(msg).toContain(narrFakeText);
  });
});
