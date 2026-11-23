import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startElsServer } from './server.js';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

// Same real-PTY bounds as src/cli/els-app-tabs-pty.test.ts.
const READY_MS = 30_000;
const STEP_MS = 15_000;

test('80x24 test universe shows the HQ and per-space coordinator marks', async () => {
  const root = mkdtempSync('/tmp/els-coord-ui-');
  const server = await startElsServer({ stateRoot: root });
  if ('exitCode' in server) throw new Error(server.message);
  const panes: string[] = [];
  const view = { executable: process.execPath, args: [join(import.meta.dir, '../../bin/elanous.mjs'), '--test-state-dir', '{root}', 'side'], root, rows: 24, cols: 80, env: { SHELL: '/bin/sh', NODE_ENV: 'development' }, quitKeys: '\u0002q' };
  try {
    for (const [ws, seat] of [['HQ', 'OP'], ['HQ', 'WORK'], ['SUB', 'LEAD'], ['SUB', 'MEMBER']] as const) {
      const cwd = join(root, 'seats', seat); mkdirSync(cwd, { recursive: true });
      const made = server.core.newPane({ ws, cwd, command: ['/bin/sh'], title: seat });
      expect(made.exitCode).toBe(0);
      panes.push((JSON.parse(made.message) as { pane: string }).pane);
    }
    expect(server.core.setCoordinator('HQ').exitCode).toBe(0);
    const before = await mockSeatPtySequence({ ...view, ready: { label: 'before-assignment', until: 'SUB', timeoutMs: READY_MS }, steps: [{ label: 'before', until: 'SUB' }], artifactPath: '/tmp/cx7-coordinator-before.json' });
    expect(before.exitCode).toBe(0);
    expect(server.core.setSpaceCoordinator('HQ', 'OP').exitCode).toBe(0);
    expect(server.core.setSpaceCoordinator('SUB', 'LEAD').exitCode).toBe(0);
    let output = '';
    const after = await mockSeatPtySequence({ ...view, ready: { label: 'hq-after', until: '⭐', timeoutMs: READY_MS }, steps: [
      { label: 'sub-after', keys: '\u001b[<0;3;4M\u001b[<0;3;4m', until: (screen) => /⭐.*LEAD/.test(screen.split('\n')[0] ?? ''), timeoutMs: STEP_MS },
    ], onOutput: chunk => { output += chunk; }, artifactPath: '/tmp/cx7-coordinator-after.json' });
    expect(after.exitCode).toBe(0);
    expect(after.frames[0]!.screen).toContain('⭐ HQ');
    expect(after.frames[0]!.screen).not.toContain('⭐ SUB');
    expect(after.frames[1]!.screen.split('\n')[0]).toContain('⭐');
    expect(output).toMatch(/\u001b\[1m[^\r\n]*OP/);
    expect(output).toMatch(/\u001b\[1m[^\r\n]*LEAD/);
  } finally {
    for (const pane of panes) server.core.close(pane);
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
