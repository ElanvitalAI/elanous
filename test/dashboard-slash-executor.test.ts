import { describe, expect, test } from 'bun:test';

import { executeImmediateDashboardSlash } from '../src/dashboard/input/slash-executor.js';

describe('executeImmediateDashboardSlash', () => {
  test('runs /status immediately', () => {
    const result = executeImmediateDashboardSlash(
      { name: 'status', args: [] },
      { getStatusLines: () => ['Dashboard status', '  mode: default'] },
    );
    expect(result?.ok).toBe(true);
    expect(result?.logLines).toContain('Dashboard status');
  });

  test('runs /st alias immediately', () => {
    const result = executeImmediateDashboardSlash(
      { name: 'st', args: [] },
      { getStatusLines: () => ['ok'] },
    );
    expect(result?.ok).toBe(true);
  });

  test('leaves non-read-only slashes for queued confirmation path', () => {
    const result = executeImmediateDashboardSlash(
      { name: 'window', args: ['new'] },
      { getStatusLines: () => ['should not run'] },
    );
    expect(result).toBeNull();
  });

  test('leaves status with args for normal slash handling', () => {
    const result = executeImmediateDashboardSlash(
      { name: 'status', args: ['verbose'] },
      { getStatusLines: () => ['should not run'] },
    );
    expect(result).toBeNull();
  });

  test('opens pane surface immediately', () => {
    const opened: string[] = [];
    const result = executeImmediateDashboardSlash(
      { name: 'surface', args: ['obsidian'] },
      {
        getStatusLines: () => ['unused'],
        openPaneModal: (pane) => { opened.push(pane); },
      },
    );
    expect(result?.ok).toBe(true);
    expect(opened).toEqual(['obsidian']);
  });

  test('opens browser surface in vw immediately', () => {
    const events: string[] = [];
    const result = executeImmediateDashboardSlash(
      { name: 'surface', args: ['browser', 'vw'] },
      {
        getStatusLines: () => ['unused'],
        openSurfaceInVw: (surface) => {
          events.push(surface);
          return true;
        },
      },
    );
    expect(result?.ok).toBe(true);
    expect(events).toEqual(['browser']);
  });

  test('opens clipboard companion immediately', () => {
    const events: string[] = [];
    const result = executeImmediateDashboardSlash(
      { name: 'surface', args: ['clipboard'] },
      {
        getStatusLines: () => ['unused'],
        openCompanionSurface: (surface, target) => {
          events.push(`${surface}:${target}`);
          return true;
        },
      },
    );
    expect(result?.ok).toBe(true);
    expect(events).toEqual(['clipboard:popup']);
  });

  test('opens memo companion in vw immediately', () => {
    const events: string[] = [];
    const result = executeImmediateDashboardSlash(
      { name: 'surface', args: ['memo', 'vw'] },
      {
        getStatusLines: () => ['unused'],
        openCompanionSurface: (surface, target) => {
          events.push(`${surface}:${target}`);
          return true;
        },
      },
    );
    expect(result?.ok).toBe(true);
    expect(events).toEqual(['memo:vw']);
  });
});
