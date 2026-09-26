import { describe, expect, test, spyOn } from 'bun:test';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { applyDoctorFixes, planDoctorFixes } from './doctor-fix.js';
import { fixPrivateFiles, scanPrivateFiles } from './doctor-private-files.js';

const mode = (path: string) => lstatSync(path).mode & 0o7777;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'doctor-private-'));
  const configDir = join(root, '.elanous');
  mkdirSync(configDir, { mode: 0o755 });
  for (const [name, bits] of [['config.json', 0o600], ['config.json.bak-x', 0o644], ['llm-fallback.json', 0o444], ['notes.txt', 0o644]] as const) {
    const path = join(configDir, name);
    writeFileSync(path, 'PRIVATE-CONTENT');
    chmodSync(path, bits);
  }
  return { root, configDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('doctor private files', () => {
  test('scan uses only names and lstat; fix retains owner bits and never touches unrelated entries', () => {
    const f = fixture();
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      mkdirSync(join(f.configDir, 'nested'));
      writeFileSync(join(f.configDir, 'nested', 'auth.json'), 'NESTED');
      chmodSync(join(f.configDir, 'nested', 'auth.json'), 0o644);
      writeFileSync(join(f.root, 'outside'), 'OUTSIDE');
      symlinkSync(join(f.root, 'outside'), join(f.configDir, 'auth.json'));
      const scan = scanPrivateFiles(f.configDir);
      expect(scan.dirMode).toBe(0o755);
      expect(scan.loose).toEqual([
        { path: join(f.configDir, 'config.json.bak-x'), mode: 0o644 },
        { path: join(f.configDir, 'llm-fallback.json'), mode: 0o444 },
      ]);
      const fixed = fixPrivateFiles(scan);
      expect(fixed).toEqual({ dir: { path: f.configDir, before: 0o755, after: 0o700 }, files: [
        { path: join(f.configDir, 'config.json.bak-x'), before: 0o644, after: 0o600 },
        { path: join(f.configDir, 'llm-fallback.json'), before: 0o444, after: 0o400 },
      ] });
      expect(log).toHaveBeenCalledWith('doctor.private-files', 'fixed', fixed);
      expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE-CONTENT');
      expect(mode(f.configDir)).toBe(0o700);
      expect(mode(join(f.configDir, 'notes.txt'))).toBe(0o644);
      expect(mode(join(f.configDir, 'config.json'))).toBe(0o600);
      expect(mode(join(f.configDir, 'nested', 'auth.json'))).toBe(0o644);
      expect(mode(join(f.root, 'outside'))).toBe(0o644);
      expect(scanPrivateFiles(f.configDir).loose).toEqual([]);
    } finally { log.mockRestore(); f.cleanup(); }
  });

  test('doctor plans counts only; no confirmation changes nothing, confirmation fixes and next plan is empty', () => {
    const f = fixture();
    try {
      const deps = { configDir: f.configDir, cacheDir: join(f.root, 'missing-cache'), keyNames: ['key'] };
      const item = planDoctorFixes(deps).items.find((entry) => entry.id === 'private-files');
      expect(item).toMatchObject({ path: f.configDir, status: 'fixable', reason: 'directory 755 · files 2' });
      expect(JSON.stringify(item)).not.toContain('config.json.bak-x');
      expect(JSON.stringify(item)).not.toContain('PRIVATE-CONTENT');
      expect(applyDoctorFixes(deps, false).items.find((entry) => entry.id === 'private-files')?.result).toBe('skipped');
      expect(mode(f.configDir)).toBe(0o755);
      expect(mode(join(f.configDir, 'llm-fallback.json'))).toBe(0o444);
      expect(applyDoctorFixes(deps, true).items.find((entry) => entry.id === 'private-files')?.result).toBe('fixed');
      expect(mode(join(f.configDir, 'llm-fallback.json'))).toBe(0o400);
      expect(planDoctorFixes(deps).items.find((entry) => entry.id === 'private-files')).toBeUndefined();
    } finally { f.cleanup(); }
  });

  test('directory-only exposure is fixable without changing private file owner bits', () => {
    const f = fixture();
    try {
      chmodSync(join(f.configDir, 'config.json.bak-x'), 0o600);
      chmodSync(join(f.configDir, 'llm-fallback.json'), 0o400);
      const scan = scanPrivateFiles(f.configDir);
      expect(scan).toMatchObject({ dirMode: 0o755, loose: [] });
      const deps = { configDir: f.configDir, cacheDir: join(f.root, 'missing-cache'), keyNames: ['key'] };
      expect(planDoctorFixes(deps).items.find((item) => item.id === 'private-files')).toMatchObject({ status: 'fixable', reason: 'directory 755 · files 0' });
      fixPrivateFiles(scan);
      expect(mode(f.configDir)).toBe(0o700);
      expect(mode(join(f.configDir, 'llm-fallback.json'))).toBe(0o400);
      expect(planDoctorFixes(deps).items.find((item) => item.id === 'private-files')).toBeUndefined();
    } finally { f.cleanup(); }
  });

  test('stale scan does not restore old owner bits or follow replaced files', () => {
    const f = fixture();
    try {
      const scan = scanPrivateFiles(f.configDir);
      chmodSync(join(f.configDir, 'llm-fallback.json'), 0o254);
      rmSync(join(f.configDir, 'config.json.bak-x'));
      writeFileSync(join(f.root, 'outside'), 'OUTSIDE');
      chmodSync(join(f.root, 'outside'), 0o644);
      symlinkSync(join(f.root, 'outside'), join(f.configDir, 'config.json.bak-x'));
      fixPrivateFiles(scan);
      expect(mode(join(f.configDir, 'llm-fallback.json'))).toBe(0o200);
      expect(mode(join(f.root, 'outside'))).toBe(0o644);
      expect(scanPrivateFiles(f.configDir).loose).toEqual([]);
    } finally { f.cleanup(); }
  });
});
