// SpawnCodingAgentHeadless (I2) — spawns claude-code / codex under a bare
// PtyShell (no VW) so a headless surface can drive the agent's terminal.
// The real-spawn path is manually verified (needs the binary on PATH); the
// CI-safe unit tests here cover brand validation, the missing-binary error,
// and family exposure — no external binary required (whichBinary seam).

import { describe, test, expect, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  dispatchSpawnCodingAgentHeadless,
  buildSpawnCodingAgentHeadlessTool,
  dispatchDriveCodingAgentHeadless,
  buildDriveCodingAgentHeadlessTool,
} from '../src/skills/tools/spawn-coding-agent-headless';
import { CodingAgentBinaryMissing } from '../src/terminal/coding-agent';
import { buildPtyShellSpecs, PTY_SHELL_TOOL_NAMES } from '../src/boot/daemon-tools/pty-shell';
import { resetForTesting, listPty } from '../src/pty-shell/registry';
import type { CodingAgentBrand } from '../src/skills/tools/spawn-coding-agent-headless';

const supportedBrands: CodingAgentBrand[] = ['claude-code', 'codex'];

afterEach(() => resetForTesting());

describe('SpawnCodingAgentHeadless', () => {
  test('owns CodingAgentBrand without importing the VW tool', () => {
    const source = readFileSync(new URL('../src/skills/tools/spawn-coding-agent-headless.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/export type CodingAgentBrand = 'claude-code' \| 'codex';/);
    expect(source).not.toMatch(/from\s+['"]\.\/spawn-coding-agent-vw(?:\.js)?['"]/);
    const properties = buildSpawnCodingAgentHeadlessTool().parameters.properties as { brand: { enum: string[] } };
    expect(properties.brand.enum).toEqual(supportedBrands);
  });

  test('rejects an unknown brand', () => {
    expect(() => dispatchSpawnCodingAgentHeadless({ brand: 'aider' })).toThrow(/must be 'claude-code' or 'codex'/);
  });

  test('throws CodingAgentBinaryMissing when the binary is not on PATH', () => {
    // whichBinary seam returns null → binary "missing" without touching PATH.
    expect(() =>
      dispatchSpawnCodingAgentHeadless({ brand: 'codex' }, { whichBinary: () => null }),
    ).toThrow(CodingAgentBinaryMissing);
    // Nothing was spawned.
    expect(listPty().length).toBe(0);
  });

  test('is exposed in the PtyShell tool family (telegram/webterm surface)', () => {
    expect((PTY_SHELL_TOOL_NAMES as readonly string[]).includes('SpawnCodingAgentHeadless')).toBe(true);
    const names = buildPtyShellSpecs().map(s => s.name);
    expect(names).toContain('SpawnCodingAgentHeadless');
  });

  test('tool schema requires brand and offers cwd/extra_args/cols/rows', () => {
    const spec = buildSpawnCodingAgentHeadlessTool();
    expect(spec.name).toBe('SpawnCodingAgentHeadless');
    const params = spec.parameters as { required?: string[]; properties?: Record<string, unknown> };
    expect(params.required).toContain('brand');
    expect(Object.keys(params.properties ?? {})).toEqual(
      expect.arrayContaining(['brand', 'cwd', 'extra_args', 'cols', 'rows']),
    );
  });
});

describe('DriveCodingAgentHeadless — one-call harness', () => {
  // Real drive (spawn → send → wait → capture) is manually verified against a
  // live codex binary; CI-safe tests cover validation + wiring only.
  test('requires a non-empty prompt', async () => {
    await expect(dispatchDriveCodingAgentHeadless({ brand: 'codex' })).rejects.toThrow(/prompt.*required/);
    await expect(dispatchDriveCodingAgentHeadless({ brand: 'codex', prompt: '  ' })).rejects.toThrow(/prompt.*required/);
  });

  test('throws CodingAgentBinaryMissing when the binary is not on PATH (nothing left running)', async () => {
    await expect(
      dispatchDriveCodingAgentHeadless({ brand: 'codex', prompt: 'do a thing' }, { whichBinary: () => null }),
    ).rejects.toThrow(CodingAgentBinaryMissing);
    expect(listPty().length).toBe(0);
  });

  test('is exposed in the tool family with a required prompt', () => {
    expect((PTY_SHELL_TOOL_NAMES as readonly string[]).includes('DriveCodingAgentHeadless')).toBe(true);
    const spec = buildDriveCodingAgentHeadlessTool();
    const params = spec.parameters as { required?: string[] };
    expect(params.required).toEqual(expect.arrayContaining(['brand', 'prompt']));
    expect(buildPtyShellSpecs().map(s => s.name)).toContain('DriveCodingAgentHeadless');
  });
});
