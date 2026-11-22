// Synthetic PTY output at the real ELS core subscription boundary; no real shell is driven.
import { mkdirSync, rmdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElsCore, type ElsPty } from '../../../els/core.js';
import { emptyJournal } from '../../../els/space.js';
import type { SimWorldScenario } from '../types.js';

const scenario: SimWorldScenario = {
  id: 'E-LIVE-CWD-OSC7',
  title: 'synthetic PTY cwd reports update the real ELS journal and reject stale directories',
  async run(ctx) {
    const start = join(ctx.universeRoot, 'start');
    const next = join(ctx.universeRoot, '한글 space');
    mkdirSync(start, { recursive: true });
    mkdirSync(next, { recursive: true });
    let journal = emptyJournal();
    let saves = 0;
    const listeners = new Set<(data: string) => void>();
    const pty: ElsPty = {
      id: 'synthetic-pty', isAlive: () => true, write: () => {}, renderScreen: async () => '',
      onExit: () => {}, kill: () => {},
      onOutput: cb => { listeners.add(cb); return { dispose: () => { listeners.delete(cb); } }; },
    };
    const core = createElsCore({ load: () => journal, save: value => { journal = value; saves++; }, spawn: () => pty });
    const observed = () => journal.panes[0]?.cwd ?? null;
    const inject = (label: string, chunks: string[]) => {
      ctx.recorder.event('els-cwd-inject', { synthetic: true, label, chunks });
      for (const chunk of chunks) for (const listener of listeners) listener(chunk);
    };
    const settle = () => new Promise(resolve => setTimeout(resolve, 100));
    try {
      const error = core.start();
      if (error) throw new Error(error.message);
      const created = core.newPane({ ws: 'SIM-CWD', cwd: start, command: ['sh'] });
      if (created.exitCode !== 0 || listeners.size !== 1) throw new Error(`pane setup failed: ${created.message}; listeners=${listeners.size}`);
      const url = pathToFileURL(next); url.hostname = hostname();
      const report = `\x1b]7;${url.href}\x1b\\`;
      inject('split-local-directory', [report.slice(0, 5), report.slice(5)]);
      await settle();
      const afterLocal = observed();
      ctx.recorder.event('els-cwd-observed', { synthetic: true, label: 'split-local-directory', expected: next, cwd: afterLocal, saves });
      const before = saves;
      const deleted = join(ctx.universeRoot, 'deleted');
      mkdirSync(deleted);
      rmdirSync(deleted);
      inject('deleted-directory', [`\x1b]7;${pathToFileURL(deleted).href}\x07`]);
      await settle();
      const afterDeleted = observed();
      const afterDeletedSaves = saves;
      ctx.recorder.event('els-cwd-observed', { synthetic: true, label: 'deleted-directory', expected: next, cwd: afterDeleted, saves });
      inject('remote-host', ['\x1b]7;file://remote.invalid/tmp\x07']);
      await settle();
      const afterRemote = observed();
      ctx.recorder.event('els-cwd-observed', { synthetic: true, label: 'remote-host', expected: next, cwd: afterRemote, saves });
      const ok = afterLocal === next && afterDeleted === next && afterRemote === next && before === afterDeletedSaves && before === saves;
      ctx.recorder.event('els-cwd-verdict', { synthetic: true, ok });
      return ok ? { ok: true } : { ok: false, reason: 'live cwd journal differs from expected', diff: JSON.stringify({ afterLocal, afterDeleted, afterRemote, before, afterDeletedSaves, saves }) };
    } finally {
      core.stopAll();
      ctx.recorder.event('els-cwd-cleanup', { synthetic: true, remainingListeners: listeners.size });
    }
  },
};
export const simWorldScenarios: readonly SimWorldScenario[] = [scenario];
