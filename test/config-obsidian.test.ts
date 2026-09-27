// ── Default Obsidian vault ──
// The inputs (env, home) are injected, so the result is the same on every machine.
// (The old test recomputed `process.env`/`homedir()` inside the test — it mirrored the
// code, passed whatever the default was, and could differ between machines.)

import { describe, test, expect } from 'bun:test';
import { defaultObsidianVault, fallbackObsidianVault } from '../src/obsidian/default-vault.js';

describe('defaultObsidianVault', () => {
  test('without OBSIDIAN_VAULT it is <home>/Documents/Obsidian', () => {
    expect(defaultObsidianVault({ env: {}, home: '/h' })).toBe('/h/Documents/Obsidian');
    expect(fallbackObsidianVault('/h')).toBe('/h/Documents/Obsidian');
  });

  test('OBSIDIAN_VAULT wins, trimmed', () => {
    expect(defaultObsidianVault({ env: { OBSIDIAN_VAULT: '  /v/Notes ' }, home: '/h' })).toBe('/v/Notes');
  });

  test('a blank OBSIDIAN_VAULT is treated as unset', () => {
    expect(defaultObsidianVault({ env: { OBSIDIAN_VAULT: '   ' }, home: '/h' })).toBe('/h/Documents/Obsidian');
  });
});
