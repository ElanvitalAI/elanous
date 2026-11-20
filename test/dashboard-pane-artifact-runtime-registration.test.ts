import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { registerDashboardPaneArtifactRuntimes } from '../src/tool-runtime/pane-artifact-runtime-registration.js';

describe('registerDashboardPaneArtifactRuntimes', () => {
  test('registers artifact, recording, pane, and pane-watch runtimes from shared dashboard state', () => {
    const artifactCalls: unknown[] = [];
    const recordingCalls: unknown[] = [];
    const paneCalls: unknown[] = [];
    const watchCalls: unknown[] = [];

    const artifactStore = { kind: 'artifact-store' };
    const widgetHost = { kind: 'widget-host' };
    const paneVisualStateStore = { kind: 'pane-visual-state-store' };

    registerDashboardPaneArtifactRuntimes({
      artifactStore: artifactStore as never,
      widgetHost: widgetHost as never,
      paneVisualStateStore: paneVisualStateStore as never,
      registerArtifact: ((opts) => { artifactCalls.push(opts); }) as never,
      registerRecording: ((opts) => { recordingCalls.push(opts); }) as never,
      registerPane: ((opts) => { paneCalls.push(opts); }) as never,
      registerPaneWatchCompare: ((opts) => { watchCalls.push(opts); }) as never,
    });

    expect(artifactCalls).toEqual([{ store: artifactStore }]);
    expect(recordingCalls).toEqual([{ widgetHost, artifactStore }]);
    expect(paneCalls).toEqual([{ store: paneVisualStateStore }]);
    expect(watchCalls).toEqual([{}]);
  });
});

describe('ELS-PTY-RECORD-CLASSIC-REF: old src/dashboard registration path is gone', () => {
  const root = resolve(import.meta.dir, '..');
  // Built from parts so this file does not itself contain the literal path.
  const oldPath = ['src', 'dashboard', 'pane-artifact-runtime-registration'].join('/');
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p);
      return /\.(?:tsx?|json|md)$/.test(e.name) ? [p] : [];
    });

  test('no file under src/ or scripts/ mentions the old path or imports it relatively', () => {
    const offenders = [...walk(join(root, 'src')), ...walk(join(root, 'scripts'))].filter((f) => {
      const text = readFileSync(f, 'utf8');
      return text.includes(oldPath) || /from '\.\/pane-artifact-runtime-registration\.js'/.test(text) && f.includes('/src/dashboard/');
    });
    expect(offenders).toEqual([]);
    expect(existsSync(join(root, `${oldPath}.ts`))).toBe(false);
  });

  test('classic dashboard still registers via the neutral tool-runtime module', () => {
    const index = readFileSync(join(root, 'src/dashboard/index.ts'), 'utf8');
    expect(index).toContain("from '../tool-runtime/pane-artifact-runtime-registration.js'");
    expect(index).toContain('registerDashboardPaneArtifactRuntimes({');
  });
});
