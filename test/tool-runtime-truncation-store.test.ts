import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  persistToolOutputPreview,
  sweepToolResults,
  toolOutputStoreRoot,
} from '../src/tool-runtime/truncation-store.js';
import {
  effectiveInstanceRoot,
  resolveInstance,
  resetEffectiveInstanceRoot,
} from '../src/instance/resolve.js';

const originalStateDir = process.env.ELANOUS_STATE_DIR;

function restoreInstanceResolution(): void {
  if (originalStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = originalStateDir;
  resetEffectiveInstanceRoot();
}

describe('tool-runtime truncation store', () => {
  test('uses the effective instance root for default persistence and sweep', async () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), 'tool-results-instance-'));
    try {
      delete process.env.ELANOUS_STATE_DIR;
      resetEffectiveInstanceRoot();
      const resolvedRoot = resolveInstance().root;
      expect(effectiveInstanceRoot()).toBe(resolvedRoot);
      expect(toolOutputStoreRoot()).toBe(join(resolvedRoot, 'tool-results'));

      process.env.ELANOUS_STATE_DIR = isolatedRoot;
      expect(effectiveInstanceRoot()).toBe(isolatedRoot);
      expect(toolOutputStoreRoot()).toBe(join(isolatedRoot, 'tool-results'));

      const persisted = await persistToolOutputPreview('x\ny\nz', {
        sessionId: 'isolated-session',
        toolName: 'Read',
        config: { persistOnOverflow: true, retentionDays: 7, previewLines: 1 },
        nowMs: 1,
      });
      expect(persisted.path).toStartWith(toolOutputStoreRoot());
      utimesSync(persisted.path!, new Date(0), new Date(0));

      const removed = await sweepToolResults({ retentionDays: 7, nowMs: 8 * 24 * 60 * 60 * 1000 });
      expect(removed.removedFiles).toBe(1);
      expect(existsSync(persisted.path!)).toBe(false);
    } finally {
      restoreInstanceResolution();
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  test('returns original output when line count is within preview budget', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tool-results-'));
    try {
      const result = await persistToolOutputPreview('a\nb', {
        baseDir: root,
        sessionId: 's1',
        toolName: 'Read',
        config: { persistOnOverflow: true, retentionDays: 7, previewLines: 5 },
      });
      expect(result.persisted).toBe(false);
      expect(result.output).toBe('a\nb');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('persists overflow and returns preview plus path reference', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tool-results-'));
    try {
      const text = Array.from({ length: 6 }, (_, i) => `line ${i}`).join('\n');
      const result = await persistToolOutputPreview(text, {
        baseDir: root,
        sessionId: 's1',
        toolName: 'Bash',
        config: { persistOnOverflow: true, retentionDays: 7, previewLines: 3 },
      });
      expect(result.persisted).toBe(true);
      expect(result.path).toBeDefined();
      expect(existsSync(result.path!)).toBe(true);
      expect(result.output).toContain('line 0');
      expect(result.output).toContain('line 2');
      expect(result.output).not.toContain('line 5');
      expect(result.output).toContain('Full output saved to');
      expect(result.output).toContain('Read with offset/limit or Grep');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('agent reference variant changes the guidance line', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tool-results-'));
    try {
      const text = Array.from({ length: 4 }, (_, i) => `line ${i}`).join('\n');
      const result = await persistToolOutputPreview(text, {
        baseDir: root,
        sessionId: 's1',
        toolName: 'Read',
        allowAgentReference: true,
        config: { persistOnOverflow: true, retentionDays: 7, previewLines: 2 },
      });
      expect(result.output).toContain('Delegate further reading to the Agent tool');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('sweep removes files older than retention window', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tool-results-'));
    try {
      const persisted = await persistToolOutputPreview('x\ny\nz', {
        baseDir: root,
        sessionId: 's1',
        toolName: 'Read',
        config: { persistOnOverflow: true, retentionDays: 7, previewLines: 1 },
      });
      utimesSync(persisted.path!, new Date(0), new Date(0));
      const removed = await sweepToolResults({ baseDir: root, retentionDays: 7, nowMs: 8 * 24 * 60 * 60 * 1000 });
      expect(removed.removedFiles).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
