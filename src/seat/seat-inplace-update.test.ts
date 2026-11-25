import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideInPlaceUpdate, takeCarry, writeCarry, type InPlaceInput } from './inplace-update.js';
import { launchArgv, runSeatLauncher } from './seat-launcher.js';
import { exitTuiRun } from '../index.js';

const base: InPlaceInput = { seat: 'OP', runningCommit: 'aaa', installedCommit: 'bbb', busy: false, capsulesActive: false, draftChars: 0,
  queuedPersonLines: 0, lastHumanKeyAgoMs: 999_999, releaseWindow: null, failedCommits: new Set(), probe: () => true };

describe('SEAT-INPLACE-UPDATE decision', () => {
  test('literal decisions', () => {
    expect(decideInPlaceUpdate(base)).toEqual({ action: 'go', toCommit: 'bbb' });
    expect(decideInPlaceUpdate({ ...base, installedCommit: 'aaa' })).toEqual({ action: 'none', reason: 'same-build' });
    expect(decideInPlaceUpdate({ ...base, seat: 'CC-2' })).toEqual({ action: 'none', reason: 'not-a-coordinator' });
    expect(decideInPlaceUpdate({ ...base, draftChars: 3, lastHumanKeyAgoMs: 5_000 })).toEqual({ action: 'wait', reason: 'person-typing' });
    expect(decideInPlaceUpdate({ ...base, draftChars: 3, lastHumanKeyAgoMs: 21_000 })).toEqual({ action: 'go', toCommit: 'bbb' });
    expect(decideInPlaceUpdate({ ...base, installedCommit: null })).toEqual({ action: 'none', reason: 'install-unreadable' });
  });
  test('carry: read once · other session dropped · stale dropped', () => {
    const root = mkdtempSync(join(tmpdir(), 'carry-'));
    try {
      const carry = { v: 1 as const, seat: 'OP', sessionId: 's1', fromCommit: 'a', toCommit: 'b', writtenAt: 1_000, draft: 'hi',
        queuedPersonLines: [], notices: [], durable: {}, durableFiles: {} };
      writeCarry(root, carry);
      expect(takeCarry(root, 'OP', 's1', 2_000).carry?.draft).toBe('hi');
      expect(takeCarry(root, 'OP', 's1', 2_000)).toEqual({ carry: null });
      writeCarry(root, carry);
      expect(takeCarry(root, 'OP', 's2', 2_000)).toEqual({ carry: null, dropped: 'other-session' });
      writeCarry(root, carry);
      expect(takeCarry(root, 'OP', 's1', 1_000 + 31 * 60_000)).toEqual({ carry: null, dropped: 'stale' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('launch argv puts the session last and drops older resumes', () => {
    expect(launchArgv(['--provider', 'openai-codex', '--resume', 'old', '--continue'], 'new')).toEqual(['--provider', 'openai-codex', '--resume', 'new']);
  });
  test('exitTuiRun: in-place request under the launcher exits 75', async () => {
    const prev = process.env.ELANOUS_SEAT_LAUNCHER; process.env.ELANOUS_SEAT_LAUNCHER = '1';
    let code = -1;
    try {
      await exitTuiRun({ exit: ((c: number) => { code = c; throw new Error('exited'); }) as (c: number) => never,
        takeRestartRequest: () => ({ reason: 'seat-inplace-update:sess-9' }) }).catch(() => {});
    } finally { if (prev === undefined) delete process.env.ELANOUS_SEAT_LAUNCHER; else process.env.ELANOUS_SEAT_LAUNCHER = prev; }
    expect(code).toBe(75);
  });
  test('test universe: real spawn · install `current` re-pointed between launches · same session, same pane env', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inplace-e2e-'));
    try {
      const tail = ['node_modules', 'elanous', 'bin'];
      const log = join(root, 'launch.log');
      for (const [name, body] of [
        ['v-old', `require('fs').appendFileSync(${JSON.stringify(log)}, 'old ' + process.argv.slice(2).join(' ') + ' ' + process.env.ELANOUS_ELS_PANE + '\\n');
          const fs = require('fs'); fs.unlinkSync(${JSON.stringify(join(root, 'current'))}); fs.symlinkSync(${JSON.stringify(join(root, 'v-new'))}, ${JSON.stringify(join(root, 'current'))});
          process.exit(75);`],
        ['v-new', `require('fs').appendFileSync(${JSON.stringify(log)}, 'new ' + process.argv.slice(2).join(' ') + ' ' + process.env.ELANOUS_ELS_PANE + '\\n'); process.exit(0);`],
      ] as const) {
        mkdirSync(join(root, name, ...tail), { recursive: true });
        writeFileSync(join(root, name, ...tail, 'elanous.mjs'), body);
      }
      symlinkSync(join(root, 'v-old'), join(root, 'current'));
      const prev = process.env.ELANOUS_ELS_PANE; process.env.ELANOUS_ELS_PANE = 'p1234abcd';
      let rc = -1;
      try { rc = await runSeatLauncher({ installRoot: root, args: ['--model', 'gpt-6.1-terra'], sessionId: () => 'sess-e2e' }); }
      finally { if (prev === undefined) delete process.env.ELANOUS_ELS_PANE; else process.env.ELANOUS_ELS_PANE = prev; }
      expect(rc).toBe(0);
      expect(existsSync(log)).toBe(true);
      expect(readFileSync(log, 'utf8')).toBe('old --model gpt-6.1-terra --resume sess-e2e p1234abcd\nnew --model gpt-6.1-terra --resume sess-e2e p1234abcd\n');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
