import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElsCore } from './core.js';
import { connectHolderElsPty, reattachHolder, startHolder } from './holder.js';
import { emptyJournal } from './space.js';

test('actual holder preserves newest valid OSC emitted while server is detached', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hc-'));
  const old = join(root, 'old'); const next = join(root, 'next');
  mkdirSync(old); mkdirSync(next);
  const go = join(root, 'go'); const sent = join(root, 'sent');
  const script = `while [ ! -f "$1" ]; do sleep 0.02; done; printf '\\033]7;%s\\007\\033]7;%s\\007\\033]7;%s\\007' "$3" "$4" "$5"; : > "$2"; sleep 30`;
  const holder = await startHolder({ stateRoot: root, paneId: 'p', cwd: old, title: 'test',
    command: ['/bin/sh', '-c', script, 'sh', go, sent, pathToFileURL(old).href, pathToFileURL(next).href, pathToFileURL(join(root, 'absent')).href] });
  let stored = emptyJournal();
  const proc = () => ({ read: async () => old, dispose: () => {} });
  let core = createElsCore({ load: () => stored, save: value => { stored = value; }, randomId: prefix => prefix,
    spawn: () => connectHolderElsPty(root, 'p', holder.meta), procCwdReader: proc() });
  try {
    expect(core.start()).toBeUndefined();
    expect(core.newPane({ ws: 'W', cwd: old, command: ['sh'] }).exitCode).toBe(0);
    await Bun.sleep(250);
    core.stopAll();
    writeFileSync(go, 'go');
    for (let n = 0; n < 100 && !existsSync(sent); n++) await Bun.sleep(20);
    expect(existsSync(sent)).toBe(true);
    await Bun.sleep(250);
    core = createElsCore({ load: () => stored, save: value => { stored = value; },
      spawn: () => { throw new Error('unexpected spawn'); }, reattach: pane => reattachHolder(root, pane.id), procCwdReader: proc() });
    expect(core.start()).toBeUndefined();
    for (let n = 0; n < 100 && stored.panes[0]?.cwd !== next; n++) await Bun.sleep(20);
    expect(stored.panes[0]?.cwd).toBe(next);
    expect(stored.panes[0]?.cwdOsc7).toBe(true);
    await Bun.sleep(200);
    expect(stored.panes[0]?.cwd).toBe(next);
  } finally {
    core.stopAll();
    await holder.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
