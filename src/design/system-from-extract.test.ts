import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contrastRatio, promoteExtractToSystem, promotePaletteToSystem } from './system-from-extract.js';
import { BUNDLED_TOKEN_SCHEMA } from './system-schema.js';

const withVars = {
  customProperties: {
    '--primary': 'rgb(20, 90, 200)',
    '--font-body': 'Source Sans, sans-serif',
  },
  paintedColors: {
    backgrounds: [
      { value: 'rgb(10, 12, 16)', count: 40 },
      { value: 'rgba(10, 12, 16, 0.4)', count: 12 },
      { value: 'rgb(24, 28, 36)', count: 9 },
    ],
    text: [
      { value: 'rgb(240, 240, 236)', count: 30 },
      { value: 'rgb(180, 180, 176)', count: 11 },
      { value: 'rgb(90, 90, 90)', count: 4 },
    ],
    strokes: [{ value: 'rgb(60, 64, 72)', count: 7 }],
  },
  roles: {
    body: { 'font-family': 'Body Face, sans-serif', 'font-size': '17px', 'line-height': '1.6', color: 'rgb(240, 240, 236)' },
    h1: { 'font-family': 'Display Face, serif', 'font-size': '48px' },
    button: { 'background-color': 'rgb(200, 40, 40)' },
    link: { color: 'rgb(20, 90, 200)' },
  },
  typeScale: [
    { size: 17, weight: '400', count: 20 },
    { size: 48, weight: '700', count: 2 },
    { size: 32, weight: '600', count: 3 },
  ],
};

const paintedOnly = {
  customProperties: {},
  paintedColors: {
    backgrounds: [
      { value: 'rgb(255, 252, 245)', count: 36 },
      { value: 'rgba(0, 0, 0, 0)', count: 8 },
    ],
    text: [{ value: 'rgb(20, 20, 18)', count: 22 }],
    strokes: [],
  },
  roles: {
    body: { 'font-family': 'Georgia, serif', 'font-size': '16px', 'line-height': '1.5' },
    h1: { 'font-family': 'Georgia, serif' },
  },
  typeScale: [{ size: 16, weight: '400', count: 10 }, { size: 28, weight: '700', count: 1 }],
};

function tokenLine(css: string, name: string): string | undefined {
  return css.split('\n').find((line) => line.includes(`--${name}:`) && !line.includes(`--${name}: 원본`));
}

function declaredNames(css: string): string[] {
  return css.split('\n').flatMap((line) => {
    const match = /^\s*--([a-z0-9-]+)\s*:/.exec(line);
    return match ? [match[1]!] : [];
  });
}

describe('promoteExtractToSystem', () => {
  test('CSS 변수가 있으면 그 값이 이기고 출처가 이름이다', () => {
    const system = promoteExtractToSystem(withVars, { id: 'linearish', name: 'Linearish', sourceUrl: 'https://linear.app' });
    expect(system.manifest).toEqual({ id: 'linearish', name: 'Linearish', category: 'Custom' });
    expect(tokenLine(system.tokensCss, 'accent')).toContain('rgb(20, 90, 200)');
    expect(tokenLine(system.tokensCss, 'accent')).toContain('/* --primary */');
    expect(tokenLine(system.tokensCss, 'font-body')).toContain('Source Sans, sans-serif');
    expect(tokenLine(system.tokensCss, 'bg')).toContain('rgb(10, 12, 16)');
    expect(tokenLine(system.tokensCss, 'bg')).toContain('painted bg #1 · 40회');
    expect(tokenLine(system.tokensCss, 'surface')).toContain('rgb(24, 28, 36)');
    expect(tokenLine(system.tokensCss, 'fg')).toContain('rgb(240, 240, 236)');
    expect(tokenLine(system.tokensCss, 'muted')).toContain('rgb(180, 180, 176)');
    expect(tokenLine(system.tokensCss, 'border')).toContain('rgb(60, 64, 72)');
    expect(tokenLine(system.tokensCss, 'font-display')).toContain('Display Face, serif');
    expect(tokenLine(system.tokensCss, 'font-display')).toContain('roles.h1');
    expect(tokenLine(system.tokensCss, 'text-base')).toContain('17px');
    expect(tokenLine(system.tokensCss, 'leading-body')).toContain('1.6');
    expect(tokenLine(system.tokensCss, 'text-lg')).toContain('32px');
    expect(tokenLine(system.tokensCss, 'text-xl')).toContain('48px');
    expect(system.tokensCss).not.toContain('--text-1:');
    expect(system.tokensCss).not.toContain('--text-2:');
    expect(system.tokensCss).not.toContain('--text-3:');
    expect(declaredNames(system.tokensCss)).toEqual([...BUNDLED_TOKEN_SCHEMA]);
    expect(system.designMd.startsWith('# Linearish\n')).toBe(true);
    expect(system.designMd).toContain('잰 칸');
    expect(system.designMd).toContain('base ');
    expect(system.designMd).toContain('> Category: Custom');
    expect(system.designMd).toContain('https://linear.app 에서 잰 값으로 만든 시스템');
    expect(system.designMd).toContain('참고이지 복제가 아니다.');
    expect(system.provenance.find((row) => row.token === 'accent')).toEqual({
      token: 'accent', value: 'rgb(20, 90, 200)', from: '--primary',
    });
  });

  test('CSS 변수가 없으면 painted 첫째 값이고 못 읽은 칸은 주석만 남는다', () => {
    const system = promoteExtractToSystem(paintedOnly, { id: 'graham', name: 'Graham', sourceUrl: 'https://paulgraham.com' });
    expect(tokenLine(system.tokensCss, 'bg')).toContain('rgb(255, 252, 245)');
    expect(tokenLine(system.tokensCss, 'bg')).toContain('painted bg #1 · 36회');
    expect(tokenLine(system.tokensCss, 'fg')).toContain('rgb(20, 20, 18)');
    expect(tokenLine(system.tokensCss, 'fg')).toContain('painted text · 대비 최대');
    for (const missing of ['surface', 'muted', 'border', 'accent']) {
      expect(tokenLine(system.tokensCss, missing)).toContain('/* base:minimal */');
      expect(system.provenance.find((row) => row.token === missing)?.from).toBe('base:minimal');
    }
    expect(system.tokensCss).not.toContain('원본에서 못 읽었다');
    expect(declaredNames(system.tokensCss)).toEqual([...BUNDLED_TOKEN_SCHEMA]);
    expect(tokenLine(system.tokensCss, 'space-1')).toContain('/* base:minimal */');
  });

  test('투명 버튼 배경은 강조색이 아니다 — 링크 색으로 넘어간다 (09-28 bluebottle 실측)', () => {
    const system = promoteExtractToSystem({
      paintedColors: { backgrounds: [{ value: 'rgb(255, 255, 255)', count: 2 }], text: [{ value: 'rgb(0, 0, 0)', count: 9 }] },
      roles: {
        body: { color: 'rgb(0, 0, 0)' },
        button: { 'background-color': 'rgba(0, 0, 0, 0)' },
        link: { color: 'rgb(30, 90, 200)' },
      },
    }, { id: 'clear-button', name: 'Clear Button', sourceUrl: 'https://example.com' });
    expect(tokenLine(system.tokensCss, 'accent')).toContain('rgb(30, 90, 200)');
    expect(system.provenance.find((row) => row.token === 'accent')?.from).toBe('roles.link.color');
  });

  test('바탕과 같은 색도 투명 채움도 강조색으로 고르지 않는다 — 없으면 비워 둔다', () => {
    const system = promoteExtractToSystem({
      paintedColors: {
        backgrounds: [{ value: 'rgb(255, 255, 255)', count: 5 }, { value: 'rgba(255, 0, 0, 0.1)', count: 3 }],
        text: [{ value: 'rgb(0, 0, 0)', count: 9 }],
      },
      roles: { body: { color: 'rgb(0, 0, 0)' }, button: { 'background-color': 'rgb(255, 255, 255)' } },
    }, { id: 'no-accent', name: 'No Accent', sourceUrl: 'https://example.com' });
    expect(system.provenance.find((row) => row.token === 'accent')?.from).toBe('base:minimal');
  });

  test('가장 많이 칠해진 배경이 본문과 안 읽히면 캔버스로 — 칩·배지가 많은 사이트 (09-28 MDN 부류)', () => {
    const system = promoteExtractToSystem({
      paintedColors: { backgrounds: [{ value: 'rgb(81, 86, 93)', count: 164 }, { value: 'rgb(247, 247, 248)', count: 7 }], text: [{ value: 'rgb(0, 0, 0)', count: 50 }] },
      roles: { body: { color: 'rgb(0, 0, 0)', 'background-color': 'rgba(0, 0, 0, 0)' } },
    }, { id: 'chips', name: 'Chips', sourceUrl: 'https://example.com' });
    expect(tokenLine(system.tokensCss, 'bg')).toContain('rgb(255, 255, 255)');
    expect(system.provenance.find((row) => row.token === 'bg')?.from).toContain('canvas');
    expect(system.warnings).toEqual([]);
  });

  test('어두운 바탕이 본문과 잘 읽히면 그대로 둔다 — 감싸는 요소에 바탕이 있는 사이트 (09-28 discord 부류)', () => {
    const system = promoteExtractToSystem({
      paintedColors: { backgrounds: [{ value: 'rgb(35, 39, 42)', count: 30 }], text: [{ value: 'rgb(255, 255, 255)', count: 40 }] },
      roles: { body: { color: 'rgb(255, 255, 255)', 'background-color': 'rgba(0, 0, 0, 0)' } },
    }, { id: 'dark-wrap', name: 'Dark Wrap', sourceUrl: 'https://example.com' });
    expect(tokenLine(system.tokensCss, 'bg')).toContain('rgb(35, 39, 42)');
    expect(system.provenance.find((row) => row.token === 'bg')?.from).toContain('painted bg #1');
  });

  test('칠해진 불투명 배경이 없고 body 가 투명이면 캔버스를 바탕으로 적는다 (09-28 apnews·danluu 부류)', () => {
    const system = promoteExtractToSystem({
      paintedColors: { backgrounds: [{ value: 'rgba(255, 255, 255, 0.8)', count: 1 }], text: [{ value: 'rgb(34, 34, 34)', count: 20 }] },
      roles: { body: { color: 'rgb(34, 34, 34)', 'background-color': 'rgba(0, 0, 0, 0)' } },
    }, { id: 'no-bg', name: 'No Bg', sourceUrl: 'https://example.com' });
    expect(tokenLine(system.tokensCss, 'bg')).toContain('rgb(255, 255, 255)');
    expect(system.provenance.find((row) => row.token === 'bg')?.from).toContain('canvas');
  });

  test('가장 많이 칠해진 글자색이 보조여도 --fg 는 roles.body 다', () => {
    const system = promoteExtractToSystem({
      paintedColors: {
        backgrounds: [{ value: 'rgb(8, 9, 10)', count: 40 }],
        text: [
          { value: 'rgb(138, 143, 152)', count: 180 },
          { value: 'rgb(247, 248, 248)', count: 40 },
        ],
      },
      roles: {
        body: { color: 'rgb(247, 248, 248)' },
        h1: { color: 'rgb(247, 248, 248)' },
        link: { color: 'rgb(138, 143, 152)' },
      },
    }, { id: 'linear', name: 'Linear', sourceUrl: 'https://linear.app' });
    expect(tokenLine(system.tokensCss, 'fg')).toContain('rgb(247, 248, 248)');
    expect(tokenLine(system.tokensCss, 'fg')).toContain('roles.body');
    expect(system.provenance.find((row) => row.token === 'fg')?.from).toBe('roles.body');
    expect(system.warnings).toEqual([]);
  });

  test('연회색이 더 많이 칠해져도 본문이 검정이면 --fg 는 검정이다', () => {
    const system = promoteExtractToSystem({
      paintedColors: {
        backgrounds: [{ value: 'rgb(255, 255, 255)', count: 20 }],
        text: [
          { value: 'rgb(221, 221, 221)', count: 58 },
          { value: 'rgb(0, 0, 0)', count: 48 },
        ],
      },
      roles: { body: { color: 'rgb(0, 0, 0)' } },
      typeScale: [
        { size: 13, weight: '400', count: 40 },
        { size: 13, weight: '700', count: 8 },
      ],
    }, { id: 'graham', name: 'Graham', sourceUrl: 'https://paulgraham.com/greatwork.html' });
    expect(tokenLine(system.tokensCss, 'fg')).toContain('rgb(0, 0, 0)');
    expect(tokenLine(system.tokensCss, 'fg')).toContain('roles.body');
    const sized = system.tokensCss.split('\n').filter((line) => /--text-(?:xs|sm|base|lg|xl|2xl|3xl|4xl):/.test(line) && line.includes('typeScale'));
    expect(sized.every((line) => !line.includes('13px'))).toBe(true);
    expect(system.tokensCss).not.toContain('--text-1:');
    expect(system.warnings).toEqual([]);
  });

  test('roles.body 가 없으면 --bg 대비가 가장 높은 글자색이다', () => {
    const system = promoteExtractToSystem({
      paintedColors: {
        backgrounds: [{ value: 'rgb(255, 255, 255)', count: 10 }],
        text: [
          { value: 'rgb(221, 221, 221)', count: 90 },
          { value: 'rgb(0, 0, 0)', count: 4 },
        ],
      },
      roles: {},
    }, { id: 'plain', name: 'Plain', sourceUrl: 'https://example.com' });
    expect(tokenLine(system.tokensCss, 'fg')).toContain('rgb(0, 0, 0)');
    expect(tokenLine(system.tokensCss, 'fg')).toContain('painted text · 대비 최대');
  });

  test('본문 대비가 4.5:1 미만이면 값은 그대로 두고 warnings 한 줄을 남긴다', () => {
    const system = promoteExtractToSystem({
      paintedColors: {
        backgrounds: [{ value: 'rgb(255, 255, 255)', count: 10 }],
        text: [{ value: 'rgb(221, 221, 221)', count: 8 }],
      },
      roles: { body: { color: 'rgb(221, 221, 221)' } },
    }, { id: 'faint', name: 'Faint', sourceUrl: 'https://example.com/faint' });
    expect(tokenLine(system.tokensCss, 'fg')).toContain('rgb(221, 221, 221)');
    expect(system.warnings).toHaveLength(1);
    expect(system.warnings[0]).toContain('⚠️ 본문 대비');
    expect(system.warnings[0]).toContain('WCAG AA(4.5:1) 미만');
    expect(system.tokensCss.startsWith(`/* ${system.warnings[0]} */`)).toBe(true);
    expect(system.designMd).toContain(system.warnings[0]!);
  });

  test('contrastRatio 는 검정과 흰색을 21 로 잰다', () => {
    expect(contrastRatio('#000', '#fff')).toBe(21);
  });

  test('간격·반경을 모르는 tokens.json 을 base 없이 승격하면 스키마 이름이 모두 있고 --space-1 은 base:minimal 이다', () => {
    const system = promoteExtractToSystem({
      paintedColors: {
        backgrounds: [{ value: 'rgb(250, 248, 244)', count: 12 }],
        text: [{ value: 'rgb(20, 18, 16)', count: 8 }],
      },
      roles: { body: { color: 'rgb(20, 18, 16)', 'font-size': '16px' } },
    }, { id: 'sparse', name: 'Sparse', sourceUrl: 'https://example.com/sparse' });
    expect(declaredNames(system.tokensCss)).toEqual([...BUNDLED_TOKEN_SCHEMA]);
    expect(declaredNames(system.tokensCss)).toHaveLength(BUNDLED_TOKEN_SCHEMA.length);
    expect(tokenLine(system.tokensCss, 'space-1')).toContain('/* base:minimal */');
    expect(system.provenance.find((row) => row.token === 'space-1')?.from).toBe('base:minimal');
    expect(system.coverage.missing).toBe(0);
    expect(system.coverage.base).toBeGreaterThan(0);
    expect(system.designMd.split('\n')[2]).toMatch(/^잰 칸 \d+ · 파생 \d+ · base \d+\(minimal\)$/);
  });

  test('base 를 주면 못 잰 칸의 출처가 그 id 다', () => {
    const root = mkdtempSync(join(tmpdir(), 'promote-named-base-'));
    try {
      const base = join(root, 'editorial');
      mkdirSync(base);
      writeFileSync(join(base, 'tokens.css'), ':root {\n  --space-1: 9px;\n  --radius-sm: 3px;\n}\n');
      const system = promoteExtractToSystem(paintedOnly, {
        id: 'graham', name: 'Graham', sourceUrl: 'https://paulgraham.com', base: 'editorial', systemsDir: root,
      });
      expect(tokenLine(system.tokensCss, 'space-1')).toContain('9px');
      expect(tokenLine(system.tokensCss, 'space-1')).toContain('/* base:editorial */');
      expect(tokenLine(system.tokensCss, 'radius-sm')).toContain('/* base:editorial */');
      expect(tokenLine(system.tokensCss, 'bg')).toContain('rgb(255, 252, 245)');
      expect(tokenLine(system.tokensCss, 'bg')).not.toContain('base:');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('surface-warm 은 bg·surface 와 ΔE>5 인 다음 불투명 배경이다', () => {
    const system = promoteExtractToSystem({
      paintedColors: {
        backgrounds: [
          { value: 'rgb(255, 255, 255)', count: 40 },
          { value: 'rgb(250, 250, 250)', count: 12 },
          { value: 'rgb(232, 214, 186)', count: 6 },
        ],
        text: [{ value: 'rgb(20, 16, 12)', count: 20 }],
      },
      roles: { body: { color: 'rgb(20, 16, 12)' } },
    }, { id: 'warm', name: 'Warm', sourceUrl: 'https://example.com/warm' });
    expect(tokenLine(system.tokensCss, 'surface')).toContain('rgb(250, 250, 250)');
    expect(tokenLine(system.tokensCss, 'surface-warm')).toContain('rgb(232, 214, 186)');
    expect(tokenLine(system.tokensCss, 'surface-warm')).toContain('ΔE>5');
  });

  test('surface-warm 은 bg·surface 중 한쪽만 가까우면 고르지 않는다', () => {
    const system = promoteExtractToSystem({
      paintedColors: {
        backgrounds: [
          { value: 'rgb(255, 255, 255)', count: 40 },
          { value: 'rgb(20, 20, 20)', count: 12 },
          { value: 'rgb(250, 250, 250)', count: 8 },
          { value: 'rgb(180, 70, 40)', count: 4 },
        ],
        text: [{ value: 'rgb(20, 16, 12)', count: 20 }],
      },
      roles: { body: { color: 'rgb(20, 16, 12)' } },
    }, { id: 'warm-both', name: 'Warm Both', sourceUrl: 'https://example.com/warm-both' });
    expect(tokenLine(system.tokensCss, 'surface')).toContain('rgb(20, 20, 20)');
    expect(tokenLine(system.tokensCss, 'surface-warm')).toContain('rgb(180, 70, 40)');
    expect(tokenLine(system.tokensCss, 'surface-warm')).toContain('ΔE>5');
    expect(tokenLine(system.tokensCss, 'surface-warm')).not.toContain('rgb(250, 250, 250)');
  });

  test('fg-2 는 fg 와 다르고 바탕 대비 4.5 이상인 글자색 중 가장 많이 쓰인 것이다', () => {
    const system = promoteExtractToSystem({
      paintedColors: {
        backgrounds: [{ value: 'rgb(255, 255, 255)', count: 20 }],
        text: [
          { value: 'rgb(10, 10, 10)', count: 30 },
          { value: 'rgb(210, 210, 210)', count: 40 },
          { value: 'rgb(70, 70, 70)', count: 9 },
          { value: 'rgb(90, 90, 90)', count: 4 },
        ],
      },
      roles: { body: { color: 'rgb(10, 10, 10)' } },
    }, { id: 'fg2', name: 'Fg2', sourceUrl: 'https://example.com/fg2' });
    expect(tokenLine(system.tokensCss, 'fg-2')).toContain('rgb(70, 70, 70)');
    expect(tokenLine(system.tokensCss, 'fg-2')).toContain('대비≥4.5');
  });

  test('meta 는 바탕 대비 3 이상인 글자색 중 가장 옅은 것이다', () => {
    const system = promoteExtractToSystem({
      paintedColors: {
        backgrounds: [{ value: 'rgb(255, 255, 255)', count: 20 }],
        text: [
          { value: 'rgb(10, 10, 10)', count: 30 },
          { value: 'rgb(80, 80, 80)', count: 8 },
          { value: 'rgb(140, 140, 140)', count: 3 },
          { value: 'rgb(230, 230, 230)', count: 12 },
        ],
      },
      roles: { body: { color: 'rgb(10, 10, 10)' } },
    }, { id: 'meta', name: 'Meta', sourceUrl: 'https://example.com/meta' });
    expect(tokenLine(system.tokensCss, 'meta')).toContain('rgb(140, 140, 140)');
    expect(tokenLine(system.tokensCss, 'meta')).toContain('가장 옅음');
  });

  test('border-soft 는 border 와 다른 다음 선 색이다', () => {
    const system = promoteExtractToSystem({
      paintedColors: {
        backgrounds: [{ value: 'rgb(255, 255, 255)', count: 8 }],
        text: [{ value: 'rgb(0, 0, 0)', count: 8 }],
        strokes: [
          { value: 'rgb(40, 40, 40)', count: 6 },
          { value: 'rgb(40, 40, 40)', count: 2 },
          { value: 'rgb(210, 210, 210)', count: 3 },
        ],
      },
      roles: { body: { color: 'rgb(0, 0, 0)' } },
    }, { id: 'stroke', name: 'Stroke', sourceUrl: 'https://example.com/stroke' });
    expect(tokenLine(system.tokensCss, 'border')).toContain('rgb(40, 40, 40)');
    expect(tokenLine(system.tokensCss, 'border-soft')).toContain('rgb(210, 210, 210)');
  });

  test('텍스트 눈금은 body 보다 작은 쪽·큰 쪽으로 갈리고 크기가 겹치지 않는다', () => {
    const system = promoteExtractToSystem({
      paintedColors: {
        backgrounds: [{ value: 'rgb(255, 255, 255)', count: 4 }],
        text: [{ value: 'rgb(0, 0, 0)', count: 4 }],
      },
      roles: { body: { color: 'rgb(0, 0, 0)', 'font-size': '16px' } },
      typeScale: [
        { size: 12, count: 2 },
        { size: 14, count: 3 },
        { size: 16, count: 10 },
        { size: 18, count: 4 },
        { size: 24, count: 2 },
        { size: 32, count: 1 },
        { size: 48, count: 1 },
        { size: 72, count: 1 },
        { size: 96, count: 1 },
      ],
    }, { id: 'scale', name: 'Scale', sourceUrl: 'https://example.com/scale' });
    expect(tokenLine(system.tokensCss, 'text-base')).toContain('16px');
    expect(tokenLine(system.tokensCss, 'text-sm')).toContain('14px');
    expect(tokenLine(system.tokensCss, 'text-xs')).toContain('12px');
    expect(tokenLine(system.tokensCss, 'text-lg')).toContain('18px');
    expect(tokenLine(system.tokensCss, 'text-xl')).toContain('24px');
    expect(tokenLine(system.tokensCss, 'text-2xl')).toContain('32px');
    expect(tokenLine(system.tokensCss, 'text-3xl')).toContain('48px');
    expect(tokenLine(system.tokensCss, 'text-4xl')).toContain('72px');
    const sized = ['text-xs', 'text-sm', 'text-base', 'text-lg', 'text-xl', 'text-2xl', 'text-3xl', 'text-4xl']
      .map((name) => tokenLine(system.tokensCss, name) ?? '');
    const values = sized.map((line) => /:\s*([^;]+);/.exec(line)?.[1]?.trim());
    expect(new Set(values).size).toBe(values.length);
    expect(tokenLine(system.tokensCss, 'text-4xl')).not.toContain('96px');
  });

  test('accent-on 은 accent 위 흰/검 중 대비가 큰 쪽이고 출처가 derived 다', () => {
    const dark = promoteExtractToSystem({
      paintedColors: { backgrounds: [{ value: 'rgb(255, 255, 255)', count: 2 }], text: [{ value: 'rgb(0, 0, 0)', count: 2 }] },
      roles: { body: { color: 'rgb(0, 0, 0)' }, button: { 'background-color': 'rgb(20, 40, 160)' } },
    }, { id: 'on-dark', name: 'On Dark', sourceUrl: 'https://example.com/on' });
    expect(tokenLine(dark.tokensCss, 'accent-on')).toContain('#ffffff');
    expect(tokenLine(dark.tokensCss, 'accent-on')).toContain('derived:contrast(accent)');
    expect(dark.coverage.derived).toBeGreaterThanOrEqual(1);
    const light = promoteExtractToSystem({
      paintedColors: { backgrounds: [{ value: 'rgb(10, 10, 10)', count: 2 }], text: [{ value: 'rgb(255, 255, 255)', count: 2 }] },
      roles: { body: { color: 'rgb(255, 255, 255)' }, button: { 'background-color': 'rgb(255, 220, 80)' } },
    }, { id: 'on-light', name: 'On Light', sourceUrl: 'https://example.com/on2' });
    expect(tokenLine(light.tokensCss, 'accent-on')).toContain('#000000');
    const on = contrastRatio('#000000', 'rgb(255, 220, 80)');
    const off = contrastRatio('#ffffff', 'rgb(255, 220, 80)');
    expect(on).not.toBeNull();
    expect(off).not.toBeNull();
    expect(on!).toBeGreaterThan(off!);
  });

  test('accent-hover 와 accent-active 는 색을 지어내지 않고 base 값이다', () => {
    const system = promoteExtractToSystem(withVars, { id: 'linearish', name: 'Linearish', sourceUrl: 'https://linear.app' });
    expect(tokenLine(system.tokensCss, 'accent-hover')).toContain('/* base:minimal */');
    expect(tokenLine(system.tokensCss, 'accent-active')).toContain('/* base:minimal */');
    expect(tokenLine(system.tokensCss, 'accent-hover')).not.toContain('color-mix(in oklab, rgb');
  });

  test('font-mono 는 customProperties 의 --font-mono 또는 --font-code 다', () => {
    const system = promoteExtractToSystem({
      customProperties: { '--font-code': 'IBM Plex Mono, monospace' },
      paintedColors: { backgrounds: [{ value: 'rgb(255, 255, 255)', count: 2 }], text: [{ value: 'rgb(0, 0, 0)', count: 2 }] },
      roles: { body: { color: 'rgb(0, 0, 0)' } },
    }, { id: 'mono', name: 'Mono', sourceUrl: 'https://example.com/mono' });
    expect(tokenLine(system.tokensCss, 'font-mono')).toContain('IBM Plex Mono, monospace');
    expect(tokenLine(system.tokensCss, 'font-mono')).toContain('/* --font-code */');
  });

  test('base 는 못 읽은 칸만 채우고 읽은 칸은 그대로다', () => {
    const root = mkdtempSync(join(tmpdir(), 'promote-base-'));
    try {
      const base = join(root, 'minimal');
      mkdirSync(base);
      writeFileSync(join(base, 'tokens.css'), [
        ':root {',
        '  --bg: #ffffff;',
        '  --surface: #fafafa;',
        '  --fg: #111111;',
        '  --muted: #777777;',
        '  --border: #e2e2e2;',
        '  --accent: #111111;',
        '  --font-display: Inter, sans-serif;',
        '  --font-body: Inter, sans-serif;',
        '}',
      ].join('\n'));
      const system = promoteExtractToSystem(paintedOnly, {
        id: 'graham', name: 'Graham', sourceUrl: 'https://paulgraham.com', base: 'minimal', systemsDir: root,
      });
      expect(tokenLine(system.tokensCss, 'bg')).toContain('rgb(255, 252, 245)');
      expect(tokenLine(system.tokensCss, 'bg')).not.toContain('base:minimal');
      expect(tokenLine(system.tokensCss, 'surface')).toContain('#fafafa');
      expect(tokenLine(system.tokensCss, 'surface')).toContain('/* base:minimal */');
      expect(tokenLine(system.tokensCss, 'accent')).toContain('#111111');
      expect(tokenLine(system.tokensCss, 'accent')).toContain('/* base:minimal */');
      expect(tokenLine(system.tokensCss, 'fg')).toContain('rgb(20, 20, 18)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('promotePaletteToSystem', () => {
  test('밝기로 bg/fg, 채도로 accent 를 정하고 나머지는 base 다', () => {
    const root = mkdtempSync(join(tmpdir(), 'promote-palette-'));
    try {
      const base = join(root, 'minimal');
      mkdirSync(base);
      writeFileSync(join(base, 'tokens.css'), ':root {\n  --surface: #fafafa;\n  --muted: #777777;\n  --border: #e2e2e2;\n  --font-body: Inter, sans-serif;\n}\n');
      const system = promotePaletteToSystem(['#111111', '#ffffff', '#cc3344'], {
        id: 'ink', name: 'Ink', base: 'minimal', systemsDir: root,
      });
      expect(tokenLine(system.tokensCss, 'bg')).toContain('#ffffff');
      expect(tokenLine(system.tokensCss, 'bg')).toContain('가장 밝음');
      expect(tokenLine(system.tokensCss, 'fg')).toContain('#111111');
      expect(tokenLine(system.tokensCss, 'accent')).toContain('#cc3344');
      expect(tokenLine(system.tokensCss, 'accent')).toContain('채도 최고');
      expect(tokenLine(system.tokensCss, 'muted')).toContain('#777777');
      expect(tokenLine(system.tokensCss, 'muted')).toContain('/* base:minimal */');
      expect(system.manifest.category).toBe('Custom');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
