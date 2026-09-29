import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultDesignSystemsDir, listDesignSystems } from './design-systems.js';
import {
  createCustomSystemFromPalette,
  createCustomSystemFromUrl,
  type CustomSystemCreateDeps,
} from './custom-system-create.js';
import type { ExtractDesignResult } from '../webclone/extract-design-run.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): { library: string; extracts: string } {
  const root = mkdtempSync(join(tmpdir(), 'custom-system-'));
  roots.push(root);
  return { library: join(root, 'library'), extracts: join(root, 'extracts') };
}

const tokens = JSON.stringify({
  customProperties: { '--bg': '#ffffff', '--fg': '#111111', '--accent': '#c8553d' },
});

function fakeExtract(outRoot: string, slug = 'stumptowncoffee'): ExtractDesignResult {
  const outDir = join(outRoot, slug);
  return {
    slug,
    outDir,
    viewport: { w: 1280, h: 800 },
    tokenCount: 3,
    paletteCount: 3,
    roleCount: 0,
    missingRoles: [],
    assets: [],
    assetNote: null,
    honoursReducedMotion: null,
    browserForcedReducedMotion: false,
  };
}

function deps(library: string, extracts: string, extra: Partial<CustomSystemCreateDeps> = {}): CustomSystemCreateDeps {
  return {
    libraryDirectory: () => library,
    systemsDirectory: defaultDesignSystemsDir,
    extractRoot: () => extracts,
    readFile: () => tokens,
    runExtractDesign: async (options) => fakeExtract(options.outRoot),
    ...extra,
  };
}

describe('createCustomSystemFromUrl', () => {
  test('derives the id from the host and does not invent unread token values', async () => {
    const { library, extracts } = scratch();
    const calls: string[] = [];
    const created = await createCustomSystemFromUrl(
      { url: 'https://www.stumptowncoffee.com/roasters' },
      deps(library, extracts, {
        runExtractDesign: async (options) => {
          calls.push(options.url);
          return fakeExtract(options.outRoot);
        },
      }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.id).toBe('stumptowncoffee');
    expect(calls).toEqual(['https://www.stumptowncoffee.com/roasters']);
    expect(created.tokens.map((row) => row.token)).toEqual(expect.arrayContaining(['bg', 'fg', 'accent']));
    expect(created.tokens.every((row) => row.value.length > 0 && !row.value.includes('지어'))).toBe(true);
    const css = created.system.tokensCss;
    for (const line of css.split('\n')) {
      if (!line.includes('원본에서 못 읽었다')) continue;
      expect(line.trim().startsWith('/*')).toBe(true);
      expect(line).not.toMatch(/:\s*#[0-9a-f]/i);
    }
    expect(listDesignSystems(library).map((system) => system.id)).toEqual(['stumptowncoffee']);
  });

  test('appends -2 when the host slug is already taken', async () => {
    const { library, extracts } = scratch();
    const first = await createCustomSystemFromUrl({ url: 'https://stumptowncoffee.com' }, deps(library, extracts));
    expect(first.ok && first.id).toBe('stumptowncoffee');
    const second = await createCustomSystemFromUrl({ url: 'https://stumptowncoffee.com/cafe' }, deps(library, extracts));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.id).toBe('stumptowncoffee-2');
  });

  test('refuses a non-http url before calling the extractor', async () => {
    const { library, extracts } = scratch();
    let called = 0;
    const refused = await createCustomSystemFromUrl(
      { url: 'ftp://stumptowncoffee.com' },
      deps(library, extracts, {
        runExtractDesign: async () => {
          called += 1;
          return fakeExtract(extracts);
        },
      }),
    );
    expect(refused).toEqual({ ok: false, reason: 'bad-url', detail: 'ftp://stumptowncoffee.com' });
    expect(called).toBe(0);
  });

  test('an explicit id that is already taken is id-taken, not a suffix', async () => {
    const { library, extracts } = scratch();
    await createCustomSystemFromUrl({ url: 'https://stumptowncoffee.com', id: 'mine' }, deps(library, extracts));
    const again = await createCustomSystemFromUrl({ url: 'https://other.example', id: 'mine' }, deps(library, extracts));
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toBe('id-taken');
  });
});

describe('createCustomSystemFromPalette', () => {
  test('saves the given colors and refuses an empty palette', async () => {
    const { library, extracts } = scratch();
    const created = await createCustomSystemFromPalette(
      { colors: ['#f4efe6', '#1f3a2e', '#c8553d'], id: 'forest-note', name: 'Forest' },
      deps(library, extracts),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.id).toBe('forest-note');
    expect(created.tokens.some((row) => row.token === 'bg' && row.value === '#f4efe6')).toBe(true);
    expect(created.tokens.some((row) => row.token === 'accent' && row.value === '#c8553d')).toBe(true);
    writeFileSync(join(library, 'forest-note', 'tokens.css'), created.system.tokensCss);
    const empty = await createCustomSystemFromPalette({ colors: ['  ', ''], id: 'empty-note' }, deps(library, extracts));
    expect(empty).toMatchObject({ ok: false, reason: 'no-colors' });
  });
});
