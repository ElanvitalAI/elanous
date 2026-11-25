// 낡은 cwd 트리 → Grep/Glob 가 latest 도 찾고 한 줄 힌트(11-25 실험).
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessStaleCwd, mapToLatest, setStaleCwdProbeForTesting, type StaleCwdDeps } from './stale-cwd.js';
import { dispatchGrep } from '../skills/tools/grep.js';
import { dispatchGlob } from '../skills/tools/glob.js';
import { getSessionCwd, setSessionCwd } from '../session/working-dir.js';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'stale-cwd-')));
const cwdRoot = join(base, 'seat');
const latestRoot = join(base, 'latest');
mkdirSync(join(cwdRoot, 'docs'), { recursive: true });
mkdirSync(join(latestRoot, 'docs', 'conductor'), { recursive: true });
writeFileSync(join(cwdRoot, 'docs', 'OLD.md'), 'nothing here\n');
writeFileSync(join(latestRoot, 'docs', 'conductor', 'JUDGE-LOAD-REDUCTION.md'), 'STALE_CWD_SENTINEL design\n');

const prevCwd = getSessionCwd();
setSessionCwd(cwdRoot, 'tool');
afterAll(() => {
  setStaleCwdProbeForTesting(null);
  try { setSessionCwd(prevCwd, 'tool'); } catch { /* noop */ }
  rmSync(base, { recursive: true, force: true });
});

const DAY = 86_400;
const deps = (headTs: number, mainTs: number, latest = [latestRoot]): StaleCwdDeps & { calls: number } => {
  const d = {
    calls: 0,
    latestRoots: () => latest,
    gitRoot: () => cwdRoot,
    commitTimes: () => { d.calls += 1; return [headTs, mainTs] as [number, number]; },
  };
  return d;
};

const rg = (() => { try { return spawnSync('rg', ['--version']).status === 0; } catch { return false; } })();
const maybe = rg ? test : test.skip;

describe('assessStaleCwd', () => {
  test('origin/main 보다 N일 넘게 뒤처지면 latest 와 일수를 낸다', () => {
    expect(assessStaleCwd(cwdRoot, deps(0, 5 * DAY))).toEqual({ days: 5, cwdRoot, latestRoot });
  });
  test('뒤처짐이 기준 이하 · latest 설정 없음 · cwd 가 곧 latest 면 null(git 도 안 부른다)', () => {
    expect(assessStaleCwd(cwdRoot, deps(0, 1 * DAY))).toBeNull();
    const none = deps(0, 9 * DAY, []);
    expect(assessStaleCwd(cwdRoot, none)).toBeNull();
    expect(none.calls).toBe(0);
    const self = deps(0, 9 * DAY, [cwdRoot]);
    expect(assessStaleCwd(cwdRoot, self)).toBeNull();
    expect(self.calls).toBe(0);
  });
  test('mapToLatest — cwd 트리 안 경로만 latest 같은 상대 경로로', () => {
    const stale = { days: 5, cwdRoot, latestRoot };
    expect(mapToLatest(join(cwdRoot, 'docs'), stale)).toBe(join(latestRoot, 'docs'));
    expect(mapToLatest(base, stale)).toBeNull();
  });
});

describe('Grep/Glob — 낡은 cwd 면 latest 결과 ⊕ 힌트', () => {
  maybe('Grep content: cwd 에 없는 문서를 latest 에서 찾고 힌트 한 줄', async () => {
    setStaleCwdProbeForTesting(() => ({ days: 6, cwdRoot, latestRoot }));
    const r = await dispatchGrep({ pattern: 'STALE_CWD_SENTINEL', path: 'docs', output_mode: 'content' });
    expect(r.output.split('\n')[0]).toBe(`[cwd tree is 6 days old — searched latest too (${latestRoot})]`);
    expect(r.output).toContain(join(latestRoot, 'docs', 'conductor', 'JUDGE-LOAD-REDUCTION.md'));
  });
  maybe('Glob: latest 의 파일 이름도 붙는다', async () => {
    setStaleCwdProbeForTesting(() => ({ days: 6, cwdRoot, latestRoot }));
    const r = await dispatchGlob({ pattern: '**/JUDGE-*.md' });
    expect(r.output.split('\n')[0]).toBe(`[cwd tree is 6 days old — searched latest too (${latestRoot})]`);
    expect(r.output).toContain(join(latestRoot, 'docs', 'conductor', 'JUDGE-LOAD-REDUCTION.md'));
  });
  maybe('낡지 않으면 출력은 그대로(힌트·latest 없음)', async () => {
    setStaleCwdProbeForTesting(() => null);
    const g = await dispatchGrep({ pattern: 'STALE_CWD_SENTINEL', path: 'docs', output_mode: 'content' });
    expect(g.output).toBe('No matches');
    const f = await dispatchGlob({ pattern: '**/JUDGE-*.md' });
    expect(f.output).not.toContain('latest');
  });
});
