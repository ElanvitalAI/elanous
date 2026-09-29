// ── anti-ai-slop 린터 시험 — ⛔ 「안 잡는다」와 「없다」를 가르는가 ────────────────
//
// ⭐ 린터의 값은 «통과»가 아니라 «잡는 것»이다. 그래서 시험의 절반이 ***위반을 넣고 잡히는지***다.
// ⛔ 그리고 나머지 절반은 ***위양성이 없는지*** — 잡아선 안 되는 것을 잡으면 사람이 전부 무시한다.

import { describe, expect, test } from 'bun:test';

import { AI_DEFAULT_INDIGO, hueOf, lintArtifact } from './lint-artifact.js';

const clean = { html: '<h1>제목</h1><p>본문</p>', css: 'h1{color:#172d24}' };
const rules = (r: ReturnType<typeof lintArtifact>) => r.findings.map((f) => f.rule);

describe('P0 — ⛔ 위반을 «잡는가»', () => {
  test('① 기본 인디고를 잡는다', () => {
    const r = lintArtifact({ ...clean, css: '.btn{background:#6366f1}' });
    expect(rules(r)).toContain('default-indigo-accent');
    expect(r.p0Count).toBeGreaterThan(0);
  });

  test('① 목록의 «전부»가 걸린다 — 하나만 막으면 나머지로 샌다', () => {
    for (const hex of AI_DEFAULT_INDIGO) {
      expect(rules(lintArtifact({ ...clean, css: `a{color:${hex}}` }))).toContain('default-indigo-accent');
    }
  });

  test('② 2-스톱 보라→파랑 그라디언트를 잡는다', () => {
    const r = lintArtifact({ ...clean, css: '.hero{background:linear-gradient(90deg,#7c3aed,#2563eb)}' });
    expect(rules(r)).toContain('two-stop-trust-gradient');
  });

  test('③ 이모지가 «아이콘 자리»에 오면 잡는다', () => {
    expect(rules(lintArtifact({ ...clean, html: '<button>✨ 시작하기</button>' }))).toContain('emoji-as-icon');
    expect(rules(lintArtifact({ ...clean, html: '<h2>🚀 빠르게</h2>' }))).toContain('emoji-as-icon');
  });

  test('⑤ 라운드 + 좌측 색 보더를 «같은 블록»에서 잡는다', () => {
    const css = '.card{border-radius:8px;border-left:3px solid #07513b;padding:10px}';
    expect(rules(lintArtifact({ ...clean, css }))).toContain('rounded-card-left-accent');
  });

  test('⑥ 지어낸 지표를 잡는다', () => {
    expect(rules(lintArtifact({ ...clean, html: '<p>10× faster than before</p>' }))).toContain('invented-metric');
  });

  test('⑦ 채움말을 잡는다', () => {
    expect(rules(lintArtifact({ ...clean, html: '<p>Lorem ipsum dolor</p>' }))).toContain('filler-copy');
  });

  test('⭐ 지적에 «줄 번호»가 붙는다 — 없으면 못 고친다', () => {
    const r = lintArtifact({ ...clean, css: 'a{b:c}\n.btn{background:#6366f1}' });
    const f = r.findings.find((x) => x.rule === 'default-indigo-accent');
    expect(f?.line).toBe(2);
  });
});

describe('⛔ 위양성이 «없는가» — 잡아선 안 되는 것', () => {
  test('깨끗한 문서는 P0 0건', () => {
    expect(lintArtifact(clean).p0Count).toBe(0);
  });

  test('이모지가 «본문»에 있으면 잡지 않는다 — 아이콘 자리만 본다', () => {
    expect(rules(lintArtifact({ ...clean, html: '<p>오늘 날씨가 좋네요 ✨</p>' }))).not.toContain('emoji-as-icon');
  });

  test('라운드«만» 있으면 잡지 않는다', () => {
    expect(rules(lintArtifact({ ...clean, css: '.card{border-radius:8px}' }))).not.toContain('rounded-card-left-accent');
  });

  test('좌측 보더«만» 있으면 잡지 않는다', () => {
    expect(rules(lintArtifact({ ...clean, css: '.q{border-left:3px solid #07513b}' }))).not.toContain('rounded-card-left-accent');
  });

  test('타원 «그림»(50% · `/` 반경)의 한쪽 선은 카드가 아니다 — E0·E1 커피콩 실물', () => {
    const e0 = '.bean::after{width:31px;height:116px;border-left:4px solid #e7ddd0;border-radius:50%;transform:rotate(18deg)}';
    const e1 = ".bean::before { content: ''; position: absolute; inset: 4% 44%; border-radius: 50%; border-left: 2px solid var(--fg); }";
    const ellipse = '.seed{border-radius:40px / 60px;border-left:2px solid #333}';
    for (const css of [e0, e1, ellipse]) expect(rules(lintArtifact({ ...clean, css }))).not.toContain('rounded-card-left-accent');
  });

  test('작은 퍼센트 모서리의 카드는 여전히 잡는다', () => {
    const css = '.card{border-radius:6%;border-left:4px solid #07513b}';
    expect(rules(lintArtifact({ ...clean, css }))).toContain('rounded-card-left-accent');
  });

  test('⛔ «다른 블록»의 라운드와 보더를 합쳐서 잡지 않는다', () => {
    const css = '.a{border-radius:8px}\n.b{border-left:3px solid #07513b}';
    expect(rules(lintArtifact({ ...clean, css }))).not.toContain('rounded-card-left-accent');
  });

  test('사진 위 단색 셰이드 그라디언트는 잡지 않는다', () => {
    const css = '.hero-shade{background:linear-gradient(100deg,rgba(9,38,28,.82),rgba(9,38,28,.12))}';
    expect(rules(lintArtifact({ ...clean, css }))).not.toContain('two-stop-trust-gradient');
  });
});

describe('⛔ 「못 검사했다」를 «통과»로 접지 않는다', () => {
  test('씨앗에 --font-display 가 없으면 skipped 에 이름이 남는다', () => {
    const r = lintArtifact(clean);
    expect(r.skipped.some((s) => s.startsWith('display-font-mismatch'))).toBe(true);
  });

  test('씨앗이 세리프를 «안» 묶었으면 「해당 없음」으로 남는다 — 위반이 아니다', () => {
    const r = lintArtifact({
      ...clean,
      declaredTokens: [{ name: '--font-display', value: 'Pretendard, sans-serif' }],
    });
    expect(r.skipped.some((s) => s.includes('해당 없음'))).toBe(true);
    expect(rules(r)).not.toContain('display-font-mismatch');
  });

  test('🔴 씨앗이 세리프를 묶었는데 디스플레이가 하드코딩 Inter 면 잡는다', () => {
    const r = lintArtifact({
      html: clean.html,
      css: 'h1{font-family: Inter, sans-serif}',
      declaredTokens: [{ name: '--font-display', value: 'Fraunces, Georgia, serif' }],
    });
    expect(rules(r)).toContain('display-font-mismatch');
    expect(r.skipped).toEqual([]);
  });
});

describe('advisory — ⛔ 위반과 «섞지 않는다»', () => {
  test('기성 섹션 순서는 advisory 지 P0 가 아니다', () => {
    const html = '<div class="hero"></div><div class="features"></div><div class="pricing"></div><div class="faq"></div><div class="cta"></div>';
    const r = lintArtifact({ html, css: 'a{b:c}' });
    const f = r.findings.find((x) => x.rule === 'stock-section-sequence');
    expect(f?.severity).toBe('advisory');
    expect(r.p0Count).toBe(0);
  });

  test('움직임은 있는데 reduced-motion 이 없으면 advisory', () => {
    const r = lintArtifact({ ...clean, css: '@keyframes x{from{opacity:0}}' });
    expect(rules(r)).toContain('motion-without-reduced-motion');
    expect(r.advisoryCount).toBe(1);
  });

  test('reduced-motion 이 있으면 안 뜬다', () => {
    const css = '@keyframes x{from{opacity:0}}@media (prefers-reduced-motion:reduce){*{animation:none}}';
    expect(rules(lintArtifact({ ...clean, css }))).not.toContain('motion-without-reduced-motion');
  });
});

describe('hueOf — 🩸 정규식으로 hex 모양을 «맞히지» 않는다', () => {
  test('보라·파랑·시안의 색상각', () => {
    expect(hueOf('#7c3aed')).toBeGreaterThan(250);   // 보라
    expect(hueOf('#2563eb')).toBeGreaterThan(200);   // 파랑
    expect(hueOf('#2563eb')).toBeLessThan(250);
  });
  test('⛔ 무채색은 null — 0° 로 접지 않는다', () => {
    expect(hueOf('#ffffff')).toBeNull();
    expect(hueOf('#808080')).toBeNull();
  });
  test('모양이 아니면 null', () => {
    expect(hueOf('rgb(1,2,3)')).toBeNull();
    expect(hueOf('#abc')).toBeNull();
  });
  test('⛔ 3스톱 이상은 «의도된» 것으로 보고 안 잡는다', () => {
    const css = '.h{background:linear-gradient(90deg,#7c3aed,#2563eb,#0ea5e9)}';
    expect(lintArtifact({ html: '<p>x</p>', css }).findings.map((f) => f.rule))
      .not.toContain('two-stop-trust-gradient');
  });
});

// ── 🩸 자가 «영어»를 보고 있었다 — advisory 판 ──────────────────────────────
//
// 실측 2026-09-08: 같은 기성품 구성을 영어 절 이름으로 쓰면 물리고(advisory 2),
// ***한글로 쓰면 안 물렸다***(1). P0 셋에서 고친 그 뿌리가 advisory 에도 남아 있었다.
describe('stock-section-sequence — 언어에 «기대지» 않는다', () => {
  const page = (labels: readonly string[]) =>
    `<body>${labels.map((l) => `<section><h2>${l}</h2></section>`).join('')}</body>`;
  const rules = (html: string) => lintArtifact({ html, css: '' }).findings.map((f) => f.rule);

  test('영어 기성품 순서를 문다', () => {
    expect(rules(page(['Hero', 'Features', 'Pricing', 'FAQ', 'CTA']))).toContain('stock-section-sequence');
  });

  test('🩸 «같은 구성»을 한글로 써도 문다 — 그전엔 «안» 물렸다', () => {
    expect(rules(page(['소개', '기능', '요금 안내', '자주 묻는 질문', '지금 시작하기'])))
      .toContain('stock-section-sequence');
  });

  test('⛔ 한 칸이라도 빠지면 «안» 문다 — 순서 전체가 조건이다', () => {
    expect(rules(page(['소개', '기능', '요금 안내', '자주 묻는 질문'])))
      .not.toContain('stock-section-sequence');
  });

  test('⛔ 실제 편집형 구성은 «안» 물린다 — 거짓양성 방지', () => {
    expect(rules(page(['가을의 춘천', '함께하기 위한 안내', '오시는 길'])))
      .not.toContain('stock-section-sequence');
  });
});
