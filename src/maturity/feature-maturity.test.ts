import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { FEATURE_MATURITY, maturityOn, visibleOn } from './feature-maturity';
import { ROUTE_MATURITY } from '../../apps/pwa/src/lib/route-maturity';

const app = resolve(import.meta.dir, '../../apps/pwa/src/app');

function builtPages(directory: string): string[] {
  const pages: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /^page\.(?:tsx?|jsx?)$/.test(entry.name)) {
        const segments = relative(directory, dir).split(sep).filter((part) => part && !/^\(.+\)$/.test(part));
        pages.push(segments.length ? `/${segments.join('/')}` : '/');
      }
    }
  };
  walk(directory);
  return [...pages, '/404'];
}

describe('feature maturity across surfaces', () => {
  test('each existing PWA page has exactly one PWA grade', () => {
    const pages = builtPages(app);
    expect(new Set(pages).size).toBe(pages.length);
    expect(Object.keys(FEATURE_MATURITY.pwaRoute).sort()).toEqual(pages.sort());
    expect(Object.fromEntries(Object.entries(FEATURE_MATURITY.pwaRoute).map(([route, grade]) => [route, grade.pwa]))).toEqual(ROUTE_MATURITY);
    for (const [route, grade] of Object.entries(FEATURE_MATURITY.pwaRoute)) {
      expect(maturityOn(route, 'pwa')).toBe(grade.pwa);
    }
    expect(maturityOn('/chat', 'pwa')).toBe('stable');
    expect(maturityOn('/today', 'pwa')).toBe('stable');
    expect(maturityOn('/settings', 'pwa')).toBe('beta');
    expect(maturityOn('/approvals', 'pwa')).toBe('tool');
    expect(maturityOn('/scheduler', 'pwa')).toBe('ops');
    expect(maturityOn('/morning', 'pwa')).toBe('broken');
    expect(maturityOn('/share', 'pwa')).toBe('system');
  });

  test('desktop falls back to the PWA grade and role exposure', () => {
    for (const [route, grade] of Object.entries(FEATURE_MATURITY.pwaRoute)) {
      expect(maturityOn(route, 'desktop')).toBe(grade.pwa);
      for (const role of ['owner', 'contributor', 'general'] as const) {
        expect(visibleOn(route, 'desktop', role)).toBe(visibleOn(route, 'pwa', role));
      }
    }
    expect(maturityOn('/today', 'desktop')).toBe('stable');
    expect(visibleOn('/today', 'pwa', 'general')).toBe(true);
    expect(visibleOn('/today', 'desktop', 'general')).toBe(true);
    expect(visibleOn('/settings', 'desktop', 'general')).toBe(true);
    expect(visibleOn('/share', 'desktop', 'general')).toBe(false);
    expect(visibleOn('/share', 'desktop', 'owner')).toBe(true);
  });

  test('absent surfaces and routes are neither graded nor visible even to owners', () => {
    for (const surface of ['ios', 'android', 'tui', 'cli', 'telegram', 'discord', 'acp'] as const) {
      expect(maturityOn('/chat', surface)).toBeUndefined();
      expect(visibleOn('/chat', surface, 'owner')).toBe(false);
      expect(visibleOn('/settings', surface, 'general')).toBe(false);
    }
    for (const surface of ['pwa', 'desktop', 'ios', 'android', 'tui', 'cli', 'telegram', 'discord', 'acp'] as const) {
      expect(maturityOn('/nonexistent', surface)).toBeUndefined();
      expect(visibleOn('/nonexistent', surface, 'owner')).toBe(false);
    }
  });
});
