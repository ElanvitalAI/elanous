import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preserveTuiRegressFailure } from './tui-regress-evidence.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('preserveTuiRegressFailure', () => {
  test('keeps failed screens and effective config while redacting credentials', () => {
    const root = mkdtempSync(join(tmpdir(), 'tui-regress-evidence-test-'));
    roots.push(root);
    const configDir = join(root, 'config');
    const artifactRoot = join(root, 'artifacts');
    mkdirSync(configDir);
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ tui: { role: 'owner' }, llm: { apiKey: 'secret-value' }, nested: [{ refreshToken: 'token-value' }] }));

    const artifactDir = preserveTuiRegressFailure({
      runId: 'run-12345678-1234-1234-1234-123456789abc',
      event: 'tui-regress.completed',
      verificationCommand: 'bun scripts/tui-regress.ts --only R4 --json',
      artifactRoot,
      configDir,
      check: { id: 'R4', title: 'palette', role: 'owner' },
      screens: { directive: 'screen capture', failure: 'last screen' },
      pty: { cols: 160, rows: 50, bootMs: 9000 },
      environment: { driveTui: '1', nodeEnv: null, credentialVariablesPresent: ['OPENAI_API_KEY'] },
      verdict: { ok: false, reason: 'palette missing' },
    });

    expect(readFileSync(join(artifactDir, 'screens', 'directive.txt'), 'utf8')).toBe('screen capture');
    expect(readFileSync(join(artifactDir, 'screens', 'failure.txt'), 'utf8')).toBe('last screen');
    const effectiveConfig = JSON.parse(readFileSync(join(artifactDir, 'effective-config.json'), 'utf8'));
    expect(effectiveConfig.tui.role).toBe('owner');
    expect(effectiveConfig.llm.apiKey).toBe('[REDACTED]');
    expect(effectiveConfig.nested[0].refreshToken).toBe('[REDACTED]');
    expect(JSON.stringify(effectiveConfig)).not.toContain('secret-value');
    expect(JSON.parse(readFileSync(join(artifactDir, 'run.json'), 'utf8'))).toMatchObject({
      runId: 'run-12345678-1234-1234-1234-123456789abc',
      event: 'tui-regress.completed',
      verificationCommand: 'bun scripts/tui-regress.ts --only R4 --json',
      verdict: { reason: 'palette missing' },
    });
  });
});
