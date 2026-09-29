import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { debug } from '../debug/log.js';
import { formatLintDesignRun, runLintDesign, tokensPathFromDesignDirection } from './lint-artifact-run.js';

type CapturedLog = { category: string; event: string; data?: unknown; options?: unknown };

function captureLogs(): { logs: CapturedLog[]; restore: () => void } {
  const logs: CapturedLog[] = [];
  const originalLog = debug.log;
  (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown, options?: unknown) => {
    logs.push({ category, event, data, options });
  }) as typeof debug.log;
  return { logs, restore: () => { (debug as { log: typeof debug.log }).log = originalLog; } };
}

describe('runLintDesign observability', () => {
  test('records the P0-producing result with resolved artifact paths and counts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lint-design-run-'));
    const htmlPath = join(directory, 'index.html');
    const cssPath = join(directory, 'styles.css');
    const designPath = join(directory, 'DESIGN.md');
    writeFileSync(htmlPath, '<h1>Title</h1>', 'utf8');
    writeFileSync(cssPath, '.button { background: #6366f1; }', 'utf8');
    writeFileSync(designPath, '# Design\n', 'utf8');
    const { logs, restore } = captureLogs();

    try {
      const result = runLintDesign({ htmlPath, cssPath, designPath });
      expect(result.p0Count).toBeGreaterThan(0);
      expect(logs).toContainEqual({
        category: 'design.lint',
        event: 'done',
        data: {
          htmlPath,
          cssPath,
          designPath,
          tokensSource: 'none',
          tokensFound: false,
          p0Count: result.p0Count,
          advisoryCount: result.advisoryCount,
          uncheckedRuleCount: result.skipped.length,
        },
        options: undefined,
      });
    } finally {
      restore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('records the original failure and rethrows the identical exception', () => {
    const { logs, restore } = captureLogs();
    const directory = mkdtempSync(join(tmpdir(), 'lint-design-failure-'));
    const htmlPath = join(directory, 'index.html');
    const sentinel = new Error('lint sentinel failure');
    writeFileSync(htmlPath, '<h1>Title</h1>', 'utf8');
    const input = {
      htmlPath,
      get cssPath(): string { throw sentinel; },
    };

    try {
      let thrown: unknown;
      try {
        runLintDesign(input);
      } catch (error) {
        thrown = error;
      }
      const failureLog = logs.find((log) => log.category === 'design.lint' && log.event === 'failed');
      const loggedError = (failureLog?.data as { error: unknown }).error;
      expect(thrown).toBe(sentinel);
      expect(typeof loggedError).toBe('string');
      expect(loggedError).toContain(sentinel.message);
      expect(failureLog).toEqual({
        category: 'design.lint',
        event: 'failed',
        data: { htmlPath, error: loggedError },
        options: { level: 'error' },
      });
    } finally {
      restore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('runLintDesign — the chosen design system tokens', () => {
  const SERIF_TOKENS = ':root {\n  /* palette */\n  --bg: #ffffff;\n  --fg: #111111;\n  --accent: #b5452b;\n  --font-display: "Fraunces", Georgia,\n    serif;\n  --text-base: 16px;\n}\n';
  const DIRECTION = '# Design\n\n## Design direction\n\n- editorial\n- tokens: design/system/tokens.css\n- source: open-design@1b47e60bd4\n';

  function project(design: string, tokens: string | null): { directory: string; htmlPath: string; designPath: string } {
    const directory = mkdtempSync(join(tmpdir(), 'lint-design-tokens-'));
    const htmlPath = join(directory, 'index.html');
    const designPath = join(directory, 'DESIGN.md');
    writeFileSync(htmlPath, '<h1>Title</h1>', 'utf8');
    writeFileSync(join(directory, 'styles.css'), 'h1 { font-family: Inter, sans-serif; color: var(--fg); }', 'utf8');
    writeFileSync(designPath, design, 'utf8');
    if (tokens !== null) {
      mkdirSync(join(directory, 'design', 'system'), { recursive: true });
      writeFileSync(join(directory, 'design', 'system', 'tokens.css'), tokens, 'utf8');
    }
    return { directory, htmlPath, designPath };
  }

  test('finds tokens.css from the Design direction section and checks the display font', () => {
    const p = project(DIRECTION, SERIF_TOKENS);
    try {
      const result = runLintDesign({ htmlPath: p.htmlPath });
      expect(result.tokensSource).toBe('design-direction');
      expect(result.tokensFound).toBe(true);
      expect(result.tokensPath).toBe(join(p.directory, 'design', 'system', 'tokens.css'));
      expect(result.typographyCount).toBeGreaterThanOrEqual(2);
      expect(result.paletteCount).toBeGreaterThanOrEqual(3);
      expect(result.skipped.some((s) => s.startsWith('display-font-mismatch'))).toBe(false);
      expect(result.findings.map((f) => f.rule)).toContain('display-font-mismatch');
      expect(formatLintDesignRun(result).join('\n')).toContain('출처 design-direction');
    } finally {
      rmSync(p.directory, { recursive: true, force: true });
    }
  });

  test('a flag wins over the Design direction line', () => {
    const p = project(DIRECTION, null);
    const flagged = join(p.directory, 'other.css');
    writeFileSync(flagged, SERIF_TOKENS, 'utf8');
    try {
      const result = runLintDesign({ htmlPath: p.htmlPath, tokensPath: flagged });
      expect(result.tokensSource).toBe('flag');
      expect(result.tokensPath).toBe(flagged);
      expect(result.tokensFound).toBe(true);
    } finally {
      rmSync(p.directory, { recursive: true, force: true });
    }
  });

  test('the seed wins when both declare the same name', () => {
    const seed = '# Design\n\n## Typography\n\n- --font-display: Inter, sans-serif\n\n## Design direction\n\n- tokens: design/system/tokens.css\n';
    const p = project(seed, SERIF_TOKENS);
    try {
      const result = runLintDesign({ htmlPath: p.htmlPath });
      expect(result.findings.map((f) => f.rule)).not.toContain('display-font-mismatch');
    } finally {
      rmSync(p.directory, { recursive: true, force: true });
    }
  });

  test('without a tokens file the result is unchanged', () => {
    const plain = project('# Design\n', null);
    const pointed = project(DIRECTION, null);
    try {
      const before = runLintDesign({ htmlPath: plain.htmlPath });
      const missing = runLintDesign({ htmlPath: pointed.htmlPath });
      expect(before.tokensSource).toBe('none');
      expect(before.tokensPath).toBeNull();
      expect(missing.tokensSource).toBe('design-direction');
      expect(missing.tokensFound).toBe(false);
      for (const r of [before, missing]) {
        expect(r.paletteCount).toBe(0);
        expect(r.typographyCount).toBe(0);
      }
      expect(missing.skipped).toEqual(before.skipped);
      expect(missing.findings).toEqual(before.findings);
    } finally {
      rmSync(plain.directory, { recursive: true, force: true });
      rmSync(pointed.directory, { recursive: true, force: true });
    }
  });

  test('reads the tokens line only inside the Design direction section', () => {
    expect(tokensPathFromDesignDirection('## Notes\n\n- tokens: a.css\n', '/p/DESIGN.md')).toBeNull();
    expect(tokensPathFromDesignDirection(DIRECTION, '/p/DESIGN.md')).toBe('/p/design/system/tokens.css');
  });
});
