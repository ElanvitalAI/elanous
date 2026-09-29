import { describe, expect, test, spyOn } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { parseTypecheckErrors } from '../typecheck-ratchet.js';
import { changedFileTypecheck } from './seams.js';

const MODEL = 'src/model.ts';
const A = 'apps/pwa/src/a.tsx';
const B = 'apps/pwa/src/b.tsx';
const A_ERROR = `${A}(2,31): error TS2322: Type 'number' is not assignable to type 'string'.`;
const B_ERROR = `${B}(2,14): error TS2741: Property 'required' is missing in type '{ stable: string; }' but required in type 'Model'.`;

function fixture(pwaDependencies: boolean): string {
  const cwd = mkdtempSync(join(tmpdir(), 'changed-file-consumers-'));
  mkdirSync(join(cwd, 'src'), { recursive: true });
  mkdirSync(join(cwd, 'apps/pwa/src'), { recursive: true });
  if (pwaDependencies) mkdirSync(join(cwd, 'apps/pwa/node_modules'), { recursive: true });
  writeFileSync(join(cwd, 'tsconfig.gate.json'), '{}\n');
  writeFileSync(join(cwd, 'apps/pwa/tsconfig.json'), '{}\n');
  writeFileSync(join(cwd, MODEL), 'export interface Model { stable: string; }\n');
  writeFileSync(join(cwd, A), "import type { Model } from '../../../src/model';\nexport const value: Model = { stable: 1 };\n");
  writeFileSync(join(cwd, B), "import type { Model } from '../../../src/model';\nexport const value: Model = { stable: 'ok' };\n");
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  };
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-m', 'base');
  writeFileSync(join(cwd, MODEL), 'export interface Model { stable: string; required: boolean; }\n');
  return cwd;
}

const completed = (out: string) => ({ out, status: out ? 1 : 0, signal: null, durationMs: 1 });

describe('changedFileTypecheck — base diagnostic comparison for consumers', () => {
  test('only b.tsx fails after base comparison; pre-existing a.tsx is not promoted', () => {
    const cwd = fixture(true);
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const calls: string[] = [];
      const baseCalls: string[] = [];
      const result = changedFileTypecheck(cwd, [MODEL], (_cmd, args) => {
        const config = args.at(-1)!;
        calls.push(config);
        return completed(config.includes('apps/pwa/') ? `${A_ERROR}\n${B_ERROR}` : '');
      }, undefined, (_cwd: string, config: string) => {
        baseCalls.push(config);
        return parseTypecheckErrors(config === 'apps/pwa/tsconfig.json' ? A_ERROR : '');
      });
      expect(calls.slice(0, 2)).toEqual(['tsconfig.gate.json', 'apps/pwa/tsconfig.json']);
      expect(calls[2]).toContain('.elanous-typecheck-scope-');
      expect(calls[3]).toContain('.elanous-typecheck-scope-');
      expect(baseCalls).toEqual(['apps/pwa/tsconfig.json']);
      expect(result).toMatchObject({ passed: false, executed: true, checked: 2, errors: 1 });
      expect(result.log).toContain(B_ERROR);
      expect(result.log).not.toContain(A_ERROR);
      expect(log).toHaveBeenCalledWith('typecheck.gate', 'ratchet', expect.objectContaining({
        executions: [
          expect.objectContaining({ config: 'tsconfig.gate.json', checkedFiles: [MODEL] }),
          expect.objectContaining({ config: 'apps/pwa/tsconfig.json', checkedFiles: [B] }),
        ],
      }), { level: 'warn' });
    } finally {
      log.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('null base warns without failing or promoting an unverified consumer', () => {
    const cwd = fixture(true);
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const calls: string[] = [];
      const baseCalls: string[] = [];
      const result = changedFileTypecheck(cwd, [MODEL], (_cmd, args) => {
        const config = args.at(-1)!;
        calls.push(config);
        return completed(config.includes('apps/pwa/') ? A_ERROR : '');
      }, undefined, (_cwd: string, config: string) => {
        baseCalls.push(config);
        return null;
      });
      expect(calls.slice(0, 2)).toEqual(['tsconfig.gate.json', 'apps/pwa/tsconfig.json']);
      expect(calls[2]).toContain('.elanous-typecheck-scope-');
      expect(calls[3]).toBe('apps/pwa/tsconfig.json');
      expect(baseCalls).toEqual(['apps/pwa/tsconfig.json']);
      expect(result).toMatchObject({ passed: true, executed: true, checked: 1, errors: 0 });
      expect(result.log).toContain('base 진단 비교 불가');
      expect(result.log).not.toContain(A_ERROR);
      expect(log).toHaveBeenCalledWith('typecheck.gate', 'ratchet', expect.objectContaining({
        executions: [
          expect.objectContaining({ config: 'tsconfig.gate.json', checkedFiles: [MODEL] }),
          expect.objectContaining({ config: 'apps/pwa/tsconfig.json', checkedFiles: [] }),
        ],
        promotionWarnings: expect.arrayContaining([expect.stringContaining('base 진단 비교 불가')]),
      }), { level: 'warn' });
    } finally {
      log.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('missing PWA dependencies skip PWA tsc when only a root export changed', () => {
    const cwd = fixture(false);
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const calls: string[] = [];
      const baseCalls: string[] = [];
      const result = changedFileTypecheck(cwd, [MODEL], (_cmd, args) => {
        calls.push(args.at(-1)!);
        return completed('');
      }, undefined, (_cwd: string, config: string) => {
        baseCalls.push(config);
        return [];
      });
      expect(calls[0]).toBe('tsconfig.gate.json');
      expect(calls[1]).toContain('.elanous-typecheck-scope-');
      expect(baseCalls).toEqual([]);
      expect(result).toMatchObject({ passed: true, executed: true, checked: 1, errors: 0 });
      expect(result.log).toContain('PWA 의존성 없음');
      expect(log).toHaveBeenCalledWith('typecheck.gate', 'ratchet', expect.objectContaining({
        executions: [expect.objectContaining({ config: 'tsconfig.gate.json', checkedFiles: [MODEL] })],
        promotionWarnings: expect.arrayContaining([expect.stringContaining('PWA 의존성 없음')]),
      }), { level: 'warn' });
    } finally {
      log.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
