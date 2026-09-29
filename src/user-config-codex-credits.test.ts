import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// 대표 09-28 크레딧 허가 — 타입·파서에 넣고 저장 whitelist 를 빠뜨려 `config set` 이 «직렬화 드롭» 됐다(#21375 직후 운영).
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test('llm.codexCreditsAllowed 는 config set → get 왕복에서 살아남는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-credits-cfg-'));
  dirs.push(dir);
  const cli = (...args: string[]) => spawnSync(process.execPath, ['bin/elanous.mjs', '--config-dir', dir, 'config', ...args], { cwd: join(import.meta.dir, '..'), encoding: 'utf8' });
  expect(cli('set', 'llm.codexCreditsAllowed', 'true').status).toBe(0);
  const got = cli('get', 'llm.codexCreditsAllowed');
  expect(got.status).toBe(0);
  expect(got.stdout.trim().split('\n').at(-1)).toBe('true');
}, 60_000);

test('llm.codexQuotaPolicy 는 config set → get 왕복에서 살아남는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-policy-cfg-'));
  dirs.push(dir);
  const cli = (...args: string[]) => spawnSync(process.execPath, ['bin/elanous.mjs', '--config-dir', dir, 'config', ...args], { cwd: join(import.meta.dir, '..'), encoding: 'utf8' });
  expect(cli('set', 'llm.codexQuotaPolicy', 'within-quota').status).toBe(0);
  const got = cli('get', 'llm.codexQuotaPolicy');
  expect(got.status).toBe(0);
  expect(got.stdout.trim().split('\n').at(-1)).toContain('within-quota');
}, 60_000);
