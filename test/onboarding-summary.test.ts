import { describe, expect, test } from 'bun:test';
import { showSummaryRecap } from '../src/onboarding/summary.js';
import { scriptedIO } from '../src/onboarding.js';
import type { UserConfig } from '../src/user-config/types.js';

const baseCfg: UserConfig = {
  llm: { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-x' },
  skills: { activeSet: 'opencode', dirs: ['/skills/a'] },
  obsidian: { vault: '/Users/me/notes' },
  telegram: { enabled: true, botToken: '12:abc', allowedUsers: [123, 456], homeChannel: undefined },
  discord: { enabled: false, allowedUsers: [] },
  onboarding: { completed: false },
} as unknown as UserConfig;

// PR-Δ13 (Sprint 13 · 2026-04-28) re-designed the recap:
//   - Save Y/N is now a chooseFrom with key 'y'/'n' (renders as
//     horizontal radio in fullScreenIO, numbered picker in scripted).
//   - When user picks "No", a second chooseFrom presents the edit
//     picker (5 sections + 'c' cancel).
//
// Scripted IO drives chooseFrom via its prompt: empty input picks
// the default (index 0); '1'-'6' picks numerically; 'y'/'n'/'c'
// pick by key letter.

describe('onboarding/summary · save Y/N', () => {
  test('empty (default) accepts', async () => {
    const io = scriptedIO(['']);
    const r = await showSummaryRecap(io, baseCfg);
    expect(r.action).toBe('accept');
  });

  test("'y' accepts", async () => {
    const io = scriptedIO(['y']);
    const r = await showSummaryRecap(io, baseCfg);
    expect(r.action).toBe('accept');
  });

  test("'1' accepts (numeric Yes)", async () => {
    const io = scriptedIO(['1']);
    const r = await showSummaryRecap(io, baseCfg);
    expect(r.action).toBe('accept');
  });
});

describe('onboarding/summary · edit picker', () => {
  test("'n' followed by '1' edits llm", async () => {
    const io = scriptedIO(['n', '1']);
    const r = await showSummaryRecap(io, baseCfg);
    expect(r.action).toBe('edit');
    expect(r.editSection).toBe('llm');
  });

  test("'n' followed by '4' edits telegram", async () => {
    const io = scriptedIO(['n', '4']);
    const r = await showSummaryRecap(io, baseCfg);
    expect(r.action).toBe('edit');
    expect(r.editSection).toBe('telegram');
  });

  test("'n' followed by 'c' cancels", async () => {
    const io = scriptedIO(['n', 'c']);
    const r = await showSummaryRecap(io, baseCfg);
    expect(r.action).toBe('cancel');
  });

  test("'n' followed by '6' (Cancel option) cancels", async () => {
    const io = scriptedIO(['n', '6']);
    const r = await showSummaryRecap(io, baseCfg);
    expect(r.action).toBe('cancel');
  });
});

describe('onboarding/summary · printed recap content', () => {
  test('print() output includes all 5 sections + key ✓ marker', async () => {
    const io = scriptedIO(['y']);
    await showSummaryRecap(io, baseCfg);
    const log = io.outputs.join('\n');
    expect(log).toContain('[llm]');
    expect(log).toContain('[skills]');
    expect(log).toContain('[obsidian]');
    expect(log).toContain('[telegram]');
    expect(log).toContain('[discord]');
    expect(log).toContain('✓ key');
    expect(log).toContain('✓ token');
  });

  test('save prompt is rendered as a Yes/No picker', async () => {
    const io = scriptedIO(['y']);
    await showSummaryRecap(io, baseCfg);
    const log = io.outputs.join('\n');
    // chooseFrom fallback prints 'Save and finish?' + numbered list.
    expect(log).toContain('Save and finish?');
    expect(log).toMatch(/1\) Yes/);
    expect(log).toMatch(/2\) No/);
  });

  test('edit picker shows all 5 sections + cancel', async () => {
    const io = scriptedIO(['n', '1']);
    await showSummaryRecap(io, baseCfg);
    const log = io.outputs.join('\n');
    expect(log).toContain('Edit which section?');
    expect(log).toMatch(/1\) LLM provider/);
    expect(log).toMatch(/2\) Skills/);
    expect(log).toMatch(/3\) Obsidian vault/);
    expect(log).toMatch(/4\) Telegram bot/);
    expect(log).toMatch(/5\) Discord bot/);
    expect(log).toMatch(/6\) Cancel/);
  });
});
