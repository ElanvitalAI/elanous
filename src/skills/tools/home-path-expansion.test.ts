// `~` 경로 펼치기 — 모델이 `~/…` 를 그대로 넘기면 rg·fs 가 `<cwd>/~/…` 로 읽어 실패했다
// (terra 가 `~/elanous-hq/latest` 를 넘겨 Grep/Glob 이 «No such file»). 네 도구가 같은 뜻으로 펼친다.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expandHomePath } from '../../agent/path-policy.js';
import { dispatchGrep } from './grep.js';
import { dispatchGlob } from './glob.js';
import { dispatchListDir } from './list-dir.js';
import { dispatchRead } from './read.js';
import { getSessionCwd, setSessionCwd } from '../../session/working-dir.js';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'home-exp-')));
const fakeHome = join(base, 'me');
const otherHome = join(base, 'colleague');
mkdirSync(join(base, 'tmp'), { recursive: true });
const cwd = join(base, 'cwd');
mkdirSync(join(fakeHome, 'notes'), { recursive: true });
mkdirSync(otherHome, { recursive: true });
mkdirSync(cwd, { recursive: true });
writeFileSync(join(fakeHome, 'notes', 'judge-load.md'), '# Judge load\nTILDE_MARKER line\n');

const prevHome = process.env.HOME;
const prevCwd = getSessionCwd();
process.env.HOME = fakeHome;
setSessionCwd(cwd, 'tool');
afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  try { setSessionCwd(prevCwd, 'tool'); } catch { /* noop */ }
  rmSync(base, { recursive: true, force: true });
});

const rg = (() => { try { return spawnSync('rg', ['--version']).status === 0; } catch { return false; } })();
const maybe = rg ? test : test.skip;

describe('expandHomePath', () => {
  test('펼친다: ~ · ~/x (지금 사용자 홈만)', () => {
    expect(expandHomePath('~')).toBe(fakeHome);
    expect(expandHomePath('~/notes/a.md')).toBe(join(fakeHome, 'notes', 'a.md'));
  });
  test('그대로 둔다: ~user/… (홈 옆에 그 이름 디렉토리가 있어도) · 모르는 사용자 · 중간의 ~ · 상대·절대 경로', () => {
    // 홈 옆 `colleague`·`tmp` 가 실재해도 추측해서 펼치지 않는다(Terra must-fix #40047).
    expect(expandHomePath('~colleague/x')).toBe('~colleague/x');
    expect(expandHomePath(`~${userInfo().username}/notes`)).toBe(`~${userInfo().username}/notes`);
    expect(expandHomePath('~tmp/x')).toBe('~tmp/x');
    expect(expandHomePath('~nobody-here-xyz/x')).toBe('~nobody-here-xyz/x');
    expect(expandHomePath('docs/~/x')).toBe('docs/~/x');
    expect(expandHomePath('./~')).toBe('./~');
    expect(expandHomePath('/abs/path')).toBe('/abs/path');
  });
});

describe('네 도구가 ~ 경로를 받는다', () => {
  maybe('Grep path:"~/notes"', async () => {
    const r = await dispatchGrep({ pattern: 'TILDE_MARKER', path: '~/notes', output_mode: 'content' });
    expect(r.output).toContain('judge-load.md');
    expect(r.output).toContain('TILDE_MARKER line');
  });
  maybe('Glob path:"~/notes"', async () => {
    const r = await dispatchGlob({ pattern: '*.md', path: '~/notes' });
    expect(r.output).toContain(join(fakeHome, 'notes', 'judge-load.md'));
  });
  test('ListDir path:"~/notes"', async () => {
    const r = await dispatchListDir({ path: '~/notes' });
    expect(r.path).toBe(join(fakeHome, 'notes'));
    expect(r.output).toContain('judge-load.md');
  });
  test('Read file_path:"~/notes/judge-load.md"', async () => {
    const r = await dispatchRead({ file_path: '~/notes/judge-load.md' });
    expect(JSON.stringify(r)).toContain('TILDE_MARKER line');
  });
});
