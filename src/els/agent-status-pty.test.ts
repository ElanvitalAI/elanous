import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startElsServer } from './server.js';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

// Same real-PTY readiness bound as src/cli/els-app-tabs-pty.test.ts.
const READY_MS = 30_000;
const HOLDER_POLL_MS = 50;

test('synthetic eln turn and idle shell appear correctly in an 80x24 real view', async () => {
  const root = mkdtempSync('/tmp/els-agent-ui-');
  let pids: number[] = [];
  const server = await startElsServer({ stateRoot: root, ps: async () => pids.map((pid, i) => `${pid} ${pid} ${i === 0 ? 'bun /fake/elanous.mjs' : '/bin/sh'}`).join('\n') });
  if ('exitCode' in server) throw new Error(server.message);
  const panes: string[] = [];
  const view = { executable: process.execPath, args: [join(import.meta.dir, '../../bin/elanous.mjs'), '--test-state-dir', '{root}', 'side'], root, rows: 24, cols: 80, env: { SHELL: '/bin/sh', NODE_ENV: 'development' }, quitKeys: '\u0002q' };
  try {
    for (const title of ['ELN-SEAT', 'SHELL-SEAT']) {
      const made = server.core.newPane({ ws: 'HQ', cwd: root, command: ['/bin/sh'], title });
      expect(made.exitCode).toBe(0); panes.push((JSON.parse(made.message) as { pane: string }).pane);
    }
    const deadline = Date.now() + READY_MS;
    while (pids.length < 2 && Date.now() < deadline) { pids = server.core.shellPids().map(row => row.pid); if (pids.length < 2) await Bun.sleep(HOLDER_POLL_MS); }
    expect(pids).toHaveLength(2);
    server.core.setForegrounds(new Map([[panes[0]!, { kind: 'eln', command: ['eln'], pid: pids[0]! }], [panes[1]!, { kind: 'shell', command: ['sh'], pid: pids[1]! }]]));
    const before = await mockSeatPtySequence({ ...view, ready: { label: 'before', until: (screen) => screen.includes('ELN-SEAT') && !screen.includes('? ELN-SEAT'), timeoutMs: READY_MS }, steps: [{ label: 'idle-shell', until: '⚪ SHELL-SEAT' }], artifactPath: '/tmp/cx7-agent-status-before.json' });
    expect(before.exitCode).toBe(0);
    expect(server.core.agentEvent(panes[0]!, { op: 'event', v: 1, ws: 'HQ', pane: panes[0]!, sid: 'sim', seq: 1, at: Date.now(), event: { kind: 'turn', phase: 'start', id: 'turn1' } }).exitCode).toBe(0);
    const after = await mockSeatPtySequence({ ...view, ready: { label: 'working-eln', until: '🟢 ELN-SEAT', timeoutMs: READY_MS }, steps: [{ label: 'idle-shell', until: '⚪ SHELL-SEAT' }], artifactPath: '/tmp/cx7-agent-status-after.json' });
    expect(after.exitCode).toBe(0);
  } finally {
    for (const pane of panes) server.core.close(pane);
    await server.close(); rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
