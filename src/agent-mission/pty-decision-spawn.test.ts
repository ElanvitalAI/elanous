import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogStore } from '../mss/logging/log-store.js';
import { parseDecision } from '../../apps/pwa/src/components/inside/pty-decisions.js';

const childMission = `
import { runAgentMission } from './src/agent-mission/driver.ts';
import { registerStandaloneLogSink } from './src/domains/standalone-log-sink.ts';
import { debug } from './src/debug/log.ts';
const dir = process.env.PTY_DECISION_FIXTURE_DIR;
let brainCalls = 0;
if (!await registerStandaloneLogSink('agent-mission')) throw new Error('logs.db sink unavailable');
const result = await runAgentMission({
  mission: 'Build the evidence', workdir: dir, memory: false, resources: 'off', commit: false,
  agent: { name: 'aside', cmd: '/bin/sh', args: ['-c', "printf 'Ready\\n'; IFS= read -r mission; mkdir -p docs; printf 'evidence\\n' > docs/output.md; printf 'MISSION-COMPLETE\\n'; sleep 20"] },
  evidence: { kind: 'doc', dirRel: 'docs', glob: /output\\.md/ },
  screensDir: dir + '/screens', maxRounds: 2,
}, { controlStream: async () => ++brainCalls === 1
  ? '{"action":"send","text":"continue","reason":"Confirm evidence"}'
  : '{"action":"verify","reason":"Evidence ready"}' });
debug.flush();
if (!result.ok) throw new Error('mission failed: ' + result.detail);
console.log('mission-ok');
`;

test('spawned agent mission persists read → judge → input → done in its isolated logs.db', () => {
  const root = mkdtempSync(join(tmpdir(), 'pty-decision-spawn-'));
  try {
    mkdirSync(join(root, 'work'));
    const child = Bun.spawnSync({
      cmd: [process.execPath, '-e', childMission], cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: root, ELANOUS_STATE_DIR: join(root, 'state'), ELANOUS_CONFIG_DIR: join(root, 'config'),
        PTY_DECISION_FIXTURE_DIR: join(root, 'work'), NODE_ENV: 'production',
        ELANOUS_RUN_ID: '', ELANOUS_HARNESS_SPACE_ID: '',
      },
      stdout: 'pipe', stderr: 'pipe', timeout: 60_000,
    });
    const stdout = Buffer.from(child.stdout).toString();
    const stderr = Buffer.from(child.stderr).toString();
    expect({ exitCode: child.exitCode, stdout, stderr }).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('mission-ok') });
    const store = LogStore.openReadOnly(join(root, 'state', 'logs', 'logs.db'));
    try {
      const brain = store.query({ exactCategories: ['agent-mission'], events: ['brain'] });
      expect(brain).not.toHaveLength(0);
      const rows = store.query({ exactCategories: ['pty.decision'], limit: 100 })
        .reverse().map((row) => parseDecision(row.data ? JSON.parse(row.data) : null));
      expect(rows.every(Boolean)).toBe(true);
      const decisions = rows.filter((row): row is NonNullable<typeof row> => row !== null);
      const read = decisions.findIndex((row) => row.step === 'read');
      const judge = decisions.findIndex((row, index) => index > read && row.step === 'judge');
      const input = decisions.findIndex((row, index) => index > judge && row.step === 'input');
      const done = decisions.findIndex((row, index) => index > input && row.step === 'done');
      expect([read, judge, input, done].every((index) => index >= 0)).toBe(true);
      expect(decisions.map((row) => row.seq)).toEqual(decisions.map((_, index) => decisions[0]!.seq + index));
      expect(decisions[done]?.detail).toMatchObject({ result: { kind: 'file', ref: join(root, 'work', 'docs', 'output.md') } });
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 75_000);
