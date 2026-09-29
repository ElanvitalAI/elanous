import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { debug } from '../debug/log.js';
import { runDesignGate, type DesignGateDeps } from './design-gate.js';

const SERIF_TOKENS = ':root {\n  --bg: #ffffff;\n  --fg: #111111;\n  --accent: #b5452b;\n  --font-display: "Fraunces", Georgia, serif;\n}\n';
const DIRECTION = '# Design\n\n## Design direction\n\n- editorial\n- tokens: design/system/tokens.css\n';
const SANS_CSS = 'h1 { font-family: Inter, sans-serif; color: var(--fg); }\n';
const SERIF_CSS = 'h1 { font-family: var(--font-display); color: var(--fg); }\n';

function project(options: { design?: string | null; tokens?: boolean; html?: Record<string, string> } = {}): string {
  const directory = mkdtempSync(join(tmpdir(), 'design-gate-'));
  if (options.design !== null) writeFileSync(join(directory, 'DESIGN.md'), options.design ?? DIRECTION, 'utf8');
  if (options.tokens !== false) {
    mkdirSync(join(directory, 'design', 'system'), { recursive: true });
    writeFileSync(join(directory, 'design', 'system', 'tokens.css'), SERIF_TOKENS, 'utf8');
  }
  for (const [rel, css] of Object.entries(options.html ?? { 'index.html': SANS_CSS })) {
    const htmlPath = join(directory, rel);
    mkdirSync(join(htmlPath, '..'), { recursive: true });
    writeFileSync(htmlPath, '<h1>Title</h1>\n', 'utf8');
    writeFileSync(join(htmlPath, '..', 'styles.css'), css, 'utf8');
  }
  return directory;
}

describe('runDesignGate', () => {
  test('a project with no declared direction is not applicable', () => {
    const directory = project({ design: '# Design\n\n## Craft rulebooks\n\n- color\n', html: {} });
    try {
      const result = runDesignGate({ projectDir: directory });
      expect(result.verdict).toBe('not-applicable');
      expect(result.reason).toBe('no-direction');
      expect(result.p0Total).toBe(0);
      expect(result.files).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('a missing DESIGN.md is not applicable', () => {
    const directory = project({ design: null, html: { 'index.html': SANS_CSS } });
    try {
      const result = runDesignGate({ projectDir: directory });
      expect(result.verdict).toBe('not-applicable');
      expect(result.reason).toBe('no-design-document');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('serif tokens against a sans-serif h1 fail with at least one P0', () => {
    const directory = project();
    try {
      const result = runDesignGate({ projectDir: directory });
      expect(result.verdict).toBe('fail');
      expect(result.direction).toBe('editorial');
      expect(result.p0Total).toBeGreaterThanOrEqual(1);
      expect(result.files[0]?.findings.map((finding) => finding.rule)).toContain('display-font-mismatch');
      expect(result.tokensSource).toBe('design-direction');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('the same page passes once the display font follows the token', () => {
    const directory = project({ html: { 'index.html': SERIF_CSS } });
    try {
      const result = runDesignGate({ projectDir: directory });
      expect(result.verdict).toBe('pass');
      expect(result.p0Total).toBe(0);
      expect(result.files).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('html under design/previews and design/system is not measured', () => {
    const directory = project({
      html: {
        'index.html': SERIF_CSS,
        'design/previews/editorial.html': SANS_CSS,
        'design/system/sample.html': SANS_CSS,
      },
    });
    try {
      const result = runDesignGate({ projectDir: directory });
      expect(result.files.map((file) => file.path)).toEqual(['index.html']);
      expect(result.verdict).toBe('pass');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('a base ref measures only the files the injected git reports', () => {
    const directory = project({
      html: {
        'kept.html': SERIF_CSS,
        'changed.html': SANS_CSS,
      },
    });
    const deps: DesignGateDeps = {
      gitDiffNames: () => ['changed.html'],
      gitUntracked: () => [],
    };
    try {
      const result = runDesignGate({ projectDir: directory, base: 'main' }, deps);
      expect(result.files.map((file) => file.path)).toEqual(['changed.html']);
      expect(result.verdict).toBe('fail');
      expect(result.p0Total).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('more html than maxFiles is truncated and the omitted count is reported', () => {
    const directory = project({
      html: {
        'a.html': SERIF_CSS,
        'b.html': SERIF_CSS,
        'c.html': SERIF_CSS,
      },
    });
    try {
      const result = runDesignGate({ projectDir: directory, maxFiles: 2 });
      expect(result.truncated).toBe(true);
      expect(result.omitted).toBe(1);
      expect(result.files).toHaveLength(2);
      expect(result.verdict).toBe('pass');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('zero html files is not applicable', () => {
    const directory = project({ html: {} });
    try {
      const result = runDesignGate({ projectDir: directory });
      expect(result.verdict).toBe('not-applicable');
      expect(result.reason).toBe('no-html');
      expect(result.direction).toBe('editorial');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('records the verdict without calling a model', () => {
    const directory = project();
    const logs: Array<{ category: string; event: string; data?: unknown }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
      logs.push({ category, event, data });
    }) as typeof debug.log;
    try {
      const result = runDesignGate({ projectDir: directory });
      expect(logs).toContainEqual({
        category: 'design.gate',
        event: 'verdict',
        data: {
          projectDir: directory,
          direction: 'editorial',
          verdict: result.verdict,
          p0Total: result.p0Total,
          fileCount: result.files.length,
        },
      });
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
