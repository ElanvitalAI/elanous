import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulateUserConfigDefaultSparse, type UserConfigDefaultSparseSimulation } from './user-config-default-sparse-sim.js';

let root: string;
let result: UserConfigDefaultSparseSimulation;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ux-sim-user-config-default-sparse-'));
  result = simulateUserConfigDefaultSparse(root);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('default-equal generated keys are omitted from saved user config', () => {
  expect(result.savedDefaultChatFastPath).toBeUndefined();
  expect(result.savedDefaultDashboardFoldMode).toBeUndefined();
  expect(result.savedUnknownEmptyExtension).toEqual({});
  expect(result.reloadedUnknownEmptyExtension).toEqual({});
});

test('explicit PWA and channel voice selections survive save and reload', () => {
  expect({
    savedStt: result.savedVoiceSttProvider,
    savedTelegram: result.savedTelegramReplyMode,
    reloadedStt: result.reloadedVoiceSttProvider,
    reloadedTelegram: result.reloadedTelegramReplyMode,
  }).toEqual({
    savedStt: 'gemini-live-stt',
    savedTelegram: 'text',
    reloadedStt: 'gemini-live-stt',
    reloadedTelegram: 'text',
  });
});

test('an explicit old choice survives when a later default equals that choice', () => {
  expect({
    saved: result.savedExplicitDefaultChoice,
    reloaded: result.reloadedExplicitDefaultChoice,
    afterDefaultChange: result.futureDefaultRetainsExplicitChoice,
  }).toEqual({ saved: false, reloaded: false, afterDefaultChange: false });
});
