import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUserConfig, saveUserConfig } from '../src/user-config.js';

describe('ACP resident user configuration', () => {
  test('an explicit false survives saving and reloading', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-acp-resident-'));
    try {
      const path = join(dir, 'config.json');
      const cfg = buildUserConfig(path);
      cfg.vw.entries.acp.resident = false;
      saveUserConfig(cfg, path);
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { vw: { acp: { resident: boolean } } };
      expect(raw.vw.acp.resident).toBe(false);
      expect(buildUserConfig(path).vw.entries.acp.resident).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an omitted or malformed ACP resident value defaults to true', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-acp-resident-'));
    try {
      const path = join(dir, 'config.json');
      expect(buildUserConfig(path).vw.entries.acp.resident).toBe(true);
      writeFileSync(path, JSON.stringify({ vw: { acp: { resident: 'nope' } } }));
      expect(buildUserConfig(path).vw.entries.acp.resident).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
