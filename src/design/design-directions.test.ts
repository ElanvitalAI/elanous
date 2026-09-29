// ── B5 — 방향은 «도출»이고 사본이 아니다 ──
//
// 이 파일이 무는 것 하나가 나머지보다 중요하다: ***방향 목록에 색값이 없다***.
// 하나라도 손으로 적히면 그것이 테마 목록의 다음 사본이 되고, `B4-1` 이
// 「세 번째 사본」을 지킴이에 넣어 막은 그 문제가 다시 열린다.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DIRECTION_HEADING,
  listDesignDirections,
  listAllDesignDirections,
  parseDeclaredDirection,
  writeDeclaredDirection,
  attemptDirectionFromDesignMd,
  directionFromDesignMd,
} from './design-directions';
import { THEME_REGISTRY } from '../themes/index';
import type { ThemeTokens } from '../theme/tokens';

function fakeTheme(name: string, over: Partial<ThemeTokens> = {}): ThemeTokens {
  return {
    name,
    colors: {
      text: '#111', muted: '#666', dim: '#999', accent: '#0a0',
      success: '#0a0', warning: '#aa0', error: '#a00', info: '#00a', highlight: '#aaf',
    },
    pane: {} as ThemeTokens['pane'],
    modal: {} as ThemeTokens['modal'],
    cursor: {} as ThemeTokens['cursor'],
    widget: {} as ThemeTokens['widget'],
    ...over,
  } as ThemeTokens;
}

describe('listDesignDirections — 정본에서 «도출»한다', () => {
  test('방향 수와 이름이 THEME_REGISTRY 와 «같다»', () => {
    // ⭐ 이것이 이 축의 계약이다. 방향 목록을 손으로 두면 테마가 늘 때
    //    조용히 어긋나고, 그 어긋남은 아무도 «안 묻는다».
    const directions = listDesignDirections();
    expect(directions.map((d) => d.id)).toEqual(THEME_REGISTRY.map((t) => t.name));
  });

  test('테마를 «하나 더» 주면 방향도 하나 는다', () => {
    const registry = [...THEME_REGISTRY, fakeTheme('zz-probe')];
    const directions = listDesignDirections(registry);
    expect(directions).toHaveLength(THEME_REGISTRY.length + 1);
    expect(directions.at(-1)!.id).toBe('zz-probe');
  });

  test('swatch 는 테마 토큰을 «그대로» 쓴다 — 자기 색을 만들지 않는다', () => {
    const [only] = listDesignDirections([fakeTheme('probe')]);
    expect(only!.swatch).toEqual({ text: '#111', accent: '#0a0', muted: '#666' });
  });

  test('mood 는 어둡기·파스텔 두 축에서 «도출»된다', () => {
    const [dark] = listDesignDirections([fakeTheme('d', { isDark: true, isPastel: true })]);
    const [light] = listDesignDirections([fakeTheme('l', { isDark: false, isPastel: false })]);
    expect(dark!.mood).toContain('dark ground');
    expect(dark!.mood).toContain('soft');
    expect(light!.mood).toContain('light ground');
    expect(light!.mood).toContain('saturated');
    // 손으로 쓴 설명이 아니므로 새 테마도 «빠지지 않는다».
    expect(dark!.mood).not.toBe(light!.mood);
  });

  test('isDark / isPastel 이 없는 테마는 false 로 «떨어진다» — undefined 를 흘리지 않는다', () => {
    const [plain] = listDesignDirections([fakeTheme('plain')]);
    expect(plain!.isDark).toBe(false);
    expect(plain!.isPastel).toBe(false);
  });
});

describe('listAllDesignDirections', () => {
  test('keeps six themes, adds system tokens and fonts, and lets a theme win an id collision', () => {
    const root = mkdtempSync(join(tmpdir(), 'all-directions-'));
    try {
      writeFileSync(join(root, 'SOURCE.json'), JSON.stringify({ commit: 'abcdef123456' }));
      for (const [id, bg] of [['web-probe', '#111111'], [THEME_REGISTRY[0]!.name, '#ffffff']]) {
        const dir = join(root, id);
        mkdirSync(dir);
        writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id, name: 'Web Style', category: 'Modern' }));
        writeFileSync(join(dir, 'DESIGN.md'), '# Web Style\n> Category: Modern\n> Web-first direction.\n');
        writeFileSync(join(dir, 'tokens.css'), `:root {\n--bg: ${bg};\n--fg: #eeeeee;\n--accent: #ffcc00;\n--font-display: Display;\n--font-body: Body;\n}`);
      }
      const directions = listAllDesignDirections({ systemsDir: root });
      expect(directions).toHaveLength(THEME_REGISTRY.length + 1);
      expect(directions.slice(0, THEME_REGISTRY.length)).toEqual(listDesignDirections());
      expect(directions.filter((direction) => direction.id === THEME_REGISTRY[0]!.name)).toHaveLength(1);
      expect(directions.find((direction) => direction.id === 'web-probe')).toMatchObject({
        label: 'Web Style', mood: 'Web-first direction.', isDark: true, source: 'design-system',
        swatch: { bg: '#111111', fg: '#eeeeee', accent: '#ffcc00' },
        typography: { display: 'Display', body: 'Body' },
      });
      expect(directions.find((direction) => direction.id === 'web-probe')?.category).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('라이브러리 시스템은 후보에 Custom 으로 붙고 겹치는 id 는 번들이 이긴다', () => {
    const bundled = mkdtempSync(join(tmpdir(), 'all-directions-bundle-'));
    const library = mkdtempSync(join(tmpdir(), 'all-directions-library-'));
    try {
      for (const [root, id, category] of [
        [bundled, 'web-probe', 'Modern'],
        [library, 'my-ink', 'Custom'],
        [library, 'web-probe', 'Custom'],
      ] as const) {
        writeFileSync(join(root, 'SOURCE.json'), JSON.stringify({ commit: category === 'Custom' ? 'custom' : 'abc' }));
        const dir = join(root, id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id, name: id, category }));
        writeFileSync(join(dir, 'DESIGN.md'), `# ${id}\n> Category: ${category}\n> ${id} summary.\n`);
        writeFileSync(join(dir, 'tokens.css'), ':root {\n--bg: #ffffff;\n--fg: #111111;\n--accent: #cc3344;\n--font-display: Display;\n--font-body: Body;\n}');
      }
      const directions = listAllDesignDirections({ systemsDir: bundled, librarySystemsDir: library });
      const custom = directions.find((direction) => direction.id === 'my-ink');
      expect(custom).toMatchObject({ source: 'design-system', category: 'Custom', mood: 'my-ink summary.' });
      expect(directions.filter((direction) => direction.id === 'web-probe')).toHaveLength(1);
      expect(directions.find((direction) => direction.id === 'web-probe')?.category).toBeUndefined();
    } finally {
      rmSync(bundled, { recursive: true, force: true });
      rmSync(library, { recursive: true, force: true });
    }
  });
});

describe('parseDeclaredDirection — 「선언 안 함」과 「못 찾음」을 가른다', () => {
  const available = listDesignDirections([fakeTheme('alpha'), fakeTheme('beta')]);

  test('절이 없으면 둘 다 null', () => {
    expect(parseDeclaredDirection('# Design\n', available)).toEqual({ declared: null, unavailable: null });
  });

  test('알려진 방향은 declared 만 채운다', () => {
    const doc = `# Design\n\n${DIRECTION_HEADING}\n\n- alpha\n`;
    expect(parseDeclaredDirection(doc, available)).toEqual({ declared: 'alpha', unavailable: null });
  });

  test('⭐ 모르는 방향은 declared «와» unavailable 을 «둘 다» 채운다', () => {
    // 「선언 안 했다」와 「선언했는데 못 찾겠다」를 한 값으로 접으면
    // 렌더가 그것을 다시 가를 수 없다 — design-check 이 배운 그대로다.
    const doc = `${DIRECTION_HEADING}\n\n- ghost\n`;
    expect(parseDeclaredDirection(doc, available)).toEqual({ declared: 'ghost', unavailable: 'ghost' });
  });

  test('여러 줄이면 «첫 줄»만 쓴다 — 방향은 하나다', () => {
    const doc = `${DIRECTION_HEADING}\n\n- alpha\n- beta\n`;
    expect(parseDeclaredDirection(doc, available).declared).toBe('alpha');
  });

  test('다음 제목에서 절이 끝난다', () => {
    const doc = `${DIRECTION_HEADING}\n\n## Craft rulebooks\n\n- not-a-direction\n`;
    expect(parseDeclaredDirection(doc, available).declared).toBeNull();
  });
});

describe('writeDeclaredDirection — 다른 절을 «건드리지 않는다»', () => {
  test('절이 없으면 문서 끝에 붙인다', () => {
    const out = writeDeclaredDirection('# Design\n', 'alpha');
    expect(out).toContain(DIRECTION_HEADING);
    expect(out).toContain('- alpha');
    expect(out.startsWith('# Design')).toBe(true);
  });

  test('절이 있으면 그 절만 갈아 끼운다', () => {
    const doc = `# Design\n\n${DIRECTION_HEADING}\n\n- alpha\n\n## Craft rulebooks\n\n- color\n`;
    const out = writeDeclaredDirection(doc, 'beta');
    expect(out).toContain('- beta');
    expect(out).not.toContain('- alpha');
    // ⛔ 핵심 — 규칙집 절이 살아 있어야 한다. 이 함수가 B2 사슬을 깨면
    //    design-check 이 «갑자기» 규칙집 0개를 보고한다.
    expect(out).toContain('## Craft rulebooks');
    expect(out).toContain('- color');
  });

  test('쓰고 다시 읽으면 «같은 값»이 나온다 (왕복)', () => {
    const available = listDesignDirections([fakeTheme('alpha'), fakeTheme('beta')]);
    const once = writeDeclaredDirection('# Design\n', 'beta');
    expect(parseDeclaredDirection(once, available).declared).toBe('beta');
    // 두 번 써도 절이 «늘지» 않는다.
    const twice = writeDeclaredDirection(once, 'alpha');
    expect(twice.split(DIRECTION_HEADING)).toHaveLength(2);
    expect(parseDeclaredDirection(twice, available).declared).toBe('alpha');
  });

  test('실제 scaffold 문서에 써도 규칙집 11개가 «그대로»다', () => {
    // 개설기가 내는 실제 문면으로 왕복한다 — 이 함수의 유일한 진짜 사용처다.
    const scaffold = '# Design\n\n## Craft rulebooks\n\n'
      + THEME_REGISTRY.map(() => '').join('')
      + '- anti-ai-slop\n- accessibility-baseline\n- color\n';
    const out = writeDeclaredDirection(scaffold, 'x');
    const rulebooks = out.split('## Craft rulebooks')[1] ?? '';
    expect(rulebooks).toContain('- anti-ai-slop');
    expect(rulebooks).toContain('- accessibility-baseline');
    expect(rulebooks).toContain('- color');
  });
});

// ── 웹 레퍼런스 → 방향 — 🩸 기전이 «이름»이었다가 «관측된 쌍»으로 바뀐 자리 ─────────
//
// 실측 2026-09-08(본 적 없는 사이트 셋): 이름 기전은 MDN(색 45)에서 null, Vercel(색 177)에서
// «엉망인 값»(글자=분홍·강조=거의 흰색)을 냈다. ⇒ 이름은 문서의 «신고», 쌍은 렌더된 «관측»이다.
describe('directionFromDesignMd', () => {
  // ⛔ 지어낸 픽스처가 아니다 — `templates/event-landing-editorial/DESIGN.md` 의 실제 문면이다.
  const doc = [
    '## Palette', '',
    '- --ground: #ffffff',
    '- --ink: #172d24',
    '- --ink-muted: #606f66',
    '- --brand-deep: #103e2e', '',
    '## Typography', '',
    '- --font-sans: Pretendard, sans-serif', '',
    '## Contrast pairs', '',
    '- --ink on --ground',
    '- --ink-muted on --ground',
    '- --ink on --brand-deep', '',
  ].join('\n');

  test('⭐ «관측된 쌍»에서 값을 옮긴다 — 이 파일은 색값을 적지 않는다', () => {
    const d = directionFromDesignMd(doc, 'ku-golf-2026');
    expect(d?.swatch).toEqual({ text: '#172d24', accent: '#103e2e', muted: '#606f66' });
    expect(d?.source).toBe('document');
  });

  test('⭐ 강조는 «바탕 중 페이지 바탕에서 가장 먼 것» — 이름이 아니라 밝기로 고른다', () => {
    expect(directionFromDesignMd(doc, 'x')?.swatch.accent).toBe('#103e2e');
  });

  test('⭐ 서체를 담는다 — 테마 방향엔 «없는» 축이다', () => {
    expect(directionFromDesignMd(doc, 'x')?.typography?.body).toContain('Pretendard');
    expect(listDesignDirections()[0].typography).toBeUndefined();
  });

  test('🩸 «쌍이 없으면» null — 팔레트가 아무리 커도 (실측: Vercel 색 177개)', () => {
    const noPairs = doc.slice(0, doc.indexOf('## Contrast pairs'));
    const r = attemptDirectionFromDesignMd(noPairs, 'x');
    expect(r.direction).toBeNull();
    expect(r.refusal).toBe('no-observed-pairs');
  });

  test('🩸 «셋이 서로 다르지» 않으면 null — 실측: MDN 이 강조=보조였다', () => {
    const flat = ['## Palette', '', '- --a: #044c9f', '- --b: #51565d', '',
      '## Contrast pairs', '', '- --a on --b', '- --b on --b', ''].join('\n');
    expect(attemptDirectionFromDesignMd(flat, 'x').refusal).toBe('incomplete-swatch');
  });

  test('🩸 팔레트가 «비면» 그 이유를 댄다 — 실측: news.ycombinator.com 은 토큰이 0개다', () => {
    expect(attemptDirectionFromDesignMd('본문뿐', 'x').refusal).toBe('no-palette');
  });

  test('⛔ 빈 id 는 방향이 아니다', () => {
    expect(attemptDirectionFromDesignMd(doc, '   ').refusal).toBe('empty-id');
  });

  test('어두운 바탕을 «잰다»', () => {
    expect(directionFromDesignMd(doc, 'x')?.isDark).toBe(false);
    expect(directionFromDesignMd(doc.replace('- --ground: #ffffff', '- --ground: #101418'), 'x')?.isDark).toBe(true);
  });

  test('⛔ 바탕을 «못 풀면» 방향을 만들지 않는다 — 밝다로 «몰지» 않는다', () => {
    // 강조는 「바탕에서 밝기가 가장 먼 바탕」으로 고른다. 바탕을 못 읽으면 그 고름이 불가능하다.
    // ⇒ isDark 를 false 로 «메우고» 스와치를 내는 대신, 거절하고 이유를 댄다.
    const r = attemptDirectionFromDesignMd(doc.replace('- --ground: #ffffff', '- --ground: var(--x)'), 'x');
    expect(r.direction).toBeNull();
    expect(r.refusal).toBe('incomplete-swatch');
  });

  test('🔑 이 방향을 넘기면 «자기 이름»을 선언할 수 있다 — 그전엔 늘 unavailable 이었다', () => {
    const declared = `${doc}\n## Design direction\n\n- ku-golf-2026\n`;
    expect(parseDeclaredDirection(declared).unavailable).toBe('ku-golf-2026');
    const own = directionFromDesignMd(declared, 'ku-golf-2026')!;
    expect(parseDeclaredDirection(declared, [...listDesignDirections(), own]))
      .toEqual({ declared: 'ku-golf-2026', unavailable: null });
  });
});
