// SEAT-MODEL-PERSIST-OP — `/model deep` typed into a seat (the same calls entry.ts makes for an `els send … "/model deep"`
// paste: busy → busyModelCommand + applyNextTuiModelTier · idle → parseNextTuiModelCommand + applyNextTuiModelTier) is
// written to <root>/seat-model/<SEAT>.tier.json and comes back after a restart — for the OP tab too, which the els server
// mints with ELANOUS_ELS_WS=OP and no ELANOUS_TRACK (live 11-27: no *.tier.json for any seat · terra after every rail).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyNextTuiModelTier, busyModelCommand, parseNextTuiModelCommand, restoreSeatTier, tuiSeat } from './model.js';
import { getSessionTierOverride } from '../../model-tier/session-override.js';

const KEYS = ['ELANOUS_TRACK', 'ELANOUS_SEAT', 'ELANOUS_ELS_WS'] as const;
const saved: Record<string, string | undefined> = {};
let root = '';
beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } root = mkdtempSync(join(tmpdir(), 'seat-model-persist-')); });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } rmSync(root, { recursive: true, force: true }); });

const opPane = () => { process.env.ELANOUS_ELS_WS = 'OP'; }; // the live OP pane env: ELANOUS_ELS_WS=OP · ELANOUS_ELS_PANE=p… · no ELANOUS_TRACK
const tierFile = (seat: string) => JSON.parse(readFileSync(join(root, 'seat-model', `${seat}.tier.json`), 'utf8')) as { seat: string; tier: string; choice: string };

describe('the seat a TUI runs as', () => {
  test('ELANOUS_TRACK → ELANOUS_SEAT → seats/<SEAT> cwd → the els workspace of the pane', () => {
    expect(tuiSeat({ ELANOUS_TRACK: 'tc-h-cx-1', ELANOUS_ELS_WS: 'TC' }, '/tmp')).toBe('TC-H-CX-1');
    expect(tuiSeat({ ELANOUS_ELS_WS: 'OP' }, '/Users/x/elanous-hq/seats/OP')).toBe('OP');
    expect(tuiSeat({ ELANOUS_ELS_WS: 'OP' }, '/var/folders/run')).toBe('OP');
    expect(tuiSeat({}, '/var/folders/run')).toBeUndefined();
  });
});

describe('/model deep sent into a seat is persisted and restored after a restart', () => {
  test('busy seat (a turn is running): the paste applies now and is written for the OP pane', () => {
    opPane();
    const cmd = busyModelCommand('/model deep');
    expect(cmd).not.toBeNull();
    applyNextTuiModelTier('op-busy-session', cmd!.tier, cmd!.choice, { root });
    expect(tierFile('OP')).toMatchObject({ seat: 'OP', tier: 'best', choice: 'deep' });
    expect(getSessionTierOverride('op-busy-session')?.llm).toBe('best');
  });
  test('idle seat: the same choice is written · a restarted session (new id) gets it back', () => {
    opPane();
    const parsed = parseNextTuiModelCommand('/model deep');
    if (parsed.kind !== 'tier') throw new Error('not a tier command');
    applyNextTuiModelTier('op-idle-session', parsed.tier, parsed.choice, { root });
    expect(existsSync(join(root, 'seat-model', 'OP.tier.json'))).toBe(true);
    const back = restoreSeatTier('op-after-rail-restart', { root });
    expect(back).toMatchObject({ seat: 'OP', tier: 'best', choice: 'deep' });
    expect(getSessionTierOverride('op-after-rail-restart')?.llm).toBe('best');
  });
  test('a hand pane keeps its own seat file (ELANOUS_TRACK wins over the workspace)', () => {
    process.env.ELANOUS_TRACK = 'TC-H-CX-1';
    process.env.ELANOUS_ELS_WS = 'TC';
    applyNextTuiModelTier('hand-session', 'budget', 'fast', { root });
    expect(tierFile('TC-H-CX-1')).toMatchObject({ seat: 'TC-H-CX-1', tier: 'budget', choice: 'fast' });
    expect(existsSync(join(root, 'seat-model', 'TC.tier.json'))).toBe(false);
  });
});
