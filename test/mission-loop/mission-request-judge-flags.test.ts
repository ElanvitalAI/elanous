import { setDefaultTimeout, afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runMissionRequestJudge } from '../../scripts/mission-request-judge.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'mission-request-judge-flags-'));
  roots.push(value);
  mkdirSync(join(value, 'docs/mission-requests'), { recursive: true });
  return value;
}

const entry = resolve(import.meta.dir, '..', '..', 'scripts/mission-request-judge.ts');
const cronRun = resolve(import.meta.dir, '..', '..', 'scripts/cron-run.ts');

describe('mission request judge flags', () => {
  it('rejects an unknown flag before catalog judgment or the composite cycle', async () => {
    let compositeRuns = 0;

    await expect(runMissionRequestJudge(['--root', root(), '--tickk'], {
      runCompositeCycle: async () => { compositeRuns += 1; return { actions: [] }; },
    })).rejects.toMatchObject({
      message: '⛔ 모르는 플래그: --tickk',
      lines: ['⛔ 모르는 플래그: --tickk'],
    });

    expect(compositeRuns).toBe(0);
  });

  it('consumes the --root value and permits positional tokens', async () => {
    const lines = await runMissionRequestJudge(['--root', root(), 'positional']);

    expect(lines.at(-1)).toBe('📏 훑은 0 · invalid 0');
  });

  it('rejects unknown flags through direct and cron-wrapper CLI entrypoints', () => {
    const authorityRoot = root();
    const direct = spawnSync('bun', [entry, '--root', authorityRoot, '--tickk'], { encoding: 'utf8' });
    const wrapped = spawnSync('bun', [cronRun, entry, '--root', authorityRoot, '--tickk'], { encoding: 'utf8' });

    expect(direct.status).toBe(1);
    expect(direct.stderr).toContain('--tickk');
    expect(wrapped.status).toBe(1);
    expect(wrapped.stderr).toContain('--tickk');
  });
});
