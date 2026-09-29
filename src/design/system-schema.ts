// 번들 디자인 시스템 tokens.css 가 공유하는 토큰 이름.
// 순서는 docs/design/systems/*/tokens.css 의 :root 선언 순서와 같다.
// 2026-09-28 요구는 «57»이라 적었으나 그 목록과 번들 52 의 교집합은 56 이다.
// 값은 여기 없다 — 못 잰 칸을 지어내지 않기 위해서다.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultDesignSystemsDir } from './design-systems.js';

export const BUNDLED_TOKEN_SCHEMA = [
  'bg',
  'surface',
  'surface-warm',
  'fg',
  'fg-2',
  'muted',
  'meta',
  'border',
  'border-soft',
  'accent',
  'accent-on',
  'accent-hover',
  'accent-active',
  'success',
  'warn',
  'danger',
  'font-display',
  'font-body',
  'font-mono',
  'text-xs',
  'text-sm',
  'text-base',
  'text-lg',
  'text-xl',
  'text-2xl',
  'text-3xl',
  'text-4xl',
  'leading-body',
  'leading-tight',
  'tracking-display',
  'space-1',
  'space-2',
  'space-3',
  'space-4',
  'space-5',
  'space-6',
  'space-8',
  'space-12',
  'section-y-desktop',
  'section-y-tablet',
  'section-y-phone',
  'radius-sm',
  'radius-md',
  'radius-lg',
  'radius-pill',
  'elev-flat',
  'elev-ring',
  'elev-raised',
  'focus-ring',
  'motion-fast',
  'motion-base',
  'ease-standard',
  'container-max',
  'container-gutter-desktop',
  'container-gutter-tablet',
  'container-gutter-phone',
] as const;

/** base 를 안 주면 이 번들 시스템에서 못 잰 칸을 채운다. */
export const DEFAULT_BASE_SYSTEM = 'minimal';

const TOKEN_DECL = /(?:^|\n)\s*(--[a-z0-9-]+)\s*:/gi;

/** 한 tokens.css 의 :root 선언 이름(접두 `--` 를 뗀 것)을 등장 순서로. */
export function tokenNamesInCss(css: string): string[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const root = /:root\s*\{([\s\S]*?)\}/.exec(stripped)?.[1] ?? '';
  const names: string[] = [];
  for (const match of root.matchAll(TOKEN_DECL)) {
    const name = match[1]!.slice(2);
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * 번들 폴더마다 tokens.css 를 읽어 이름 교집합을 낸다.
 * 순서는 첫 시스템의 선언 순서를 따른다(전부 같으면 스키마 순서와 같다).
 */
export function readBundledSchema(systemsDir?: string): readonly string[] {
  const dir = systemsDir ?? defaultDesignSystemsDir();
  let folders: string[];
  try {
    folders = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  let intersection: string[] | null = null;
  let order: readonly string[] = [];
  for (const folder of folders) {
    let css = '';
    try {
      css = readFileSync(join(dir, folder, 'tokens.css'), 'utf8');
    } catch {
      continue;
    }
    const names = tokenNamesInCss(css);
    if (names.length === 0) continue;
    if (intersection === null) {
      intersection = [...names];
      order = names;
      continue;
    }
    const present = new Set(names);
    intersection = intersection.filter((name) => present.has(name));
  }
  if (!intersection || intersection.length === 0) return [];
  const keep = new Set(intersection);
  return order.filter((name) => keep.has(name));
}
