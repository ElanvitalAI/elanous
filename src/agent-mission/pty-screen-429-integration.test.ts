import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentMission, setAgentMissionTimingForTest } from './driver.js';
import { emitPtyDecision } from './pty-decision.js';
import { startPty } from '../pty-shell/registry.js';

test('real PTY 429 and exited child cannot turn existing artifact into a commit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mission-screen-429-'));
  const restore = setAgentMissionTimingForTest({ readyQuietMs: 100, pollMs: 20, keystrokeGapMs: 20 });
  let commits = 0;
  try {
    const result = await runAgentMission({ mission: 'perform task', branch: 'fixture', repo: dir,
      evidence: { kind: 'doc', dirRel: 'docs', glob: /result/ }, memory: false, commit: true, screensDir: join(dir, 'screens') }, {
      createWorktree: (() => ({ path: dir, branch: 'fixture', base: 'HEAD' })) as never,
      recordWorktreeProvenance: () => {}, emitContextEvent: () => {}, emitExternalEvent: () => {}, emitPtyDecision: (input) => emitPtyDecision(input, () => {}),
      checkEvidence: () => ({ ok: true, path: join(dir, 'docs/result.md') }),
      commitWorktree: () => { commits++; return { ok: true, out: '' }; },
      controlStream: async () => '{"action":"wait"}',
      resolvePtyWebAddress: (() => ({ webUrl: null, webUrlSource: null })) as never,
      startPty: (opts) => startPty({ ...opts, cmd: '/bin/sh', args: ['-c', 'printf "ready\\n"; read line; printf "429 rate limit exceeded\\n"; exit 0'] }),
    });
    const screens = readdirSync(join(dir, 'screens')).map(name => readFileSync(join(dir, 'screens', name), 'utf8')).join('\n');
    expect(screens).toContain('429 rate limit exceeded');
    expect(result).toMatchObject({ ok: false, evidenceSatisfied: true, committed: false, driveVerdict: 'done-but-failed' });
    expect(commits).toBe(0);
  } finally { restore(); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
