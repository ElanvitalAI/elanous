import { expect, test } from 'bun:test';
import { createStaleInstallWatch, detectStaleInstall, installedCurrentHead, installPrefixOf, staleInstallMarker } from './stale-install.js';
import { SOURCE_HEAD_DISPLAY_CHARS } from '../nexus/apps/app-build-head-mismatch.js';

// RAIL-STALE-TUI-HEAD 11-17: rail installed a new version and restarted nexus; the TUI kept the old one.
const OLD = '1728371e'.padEnd(40, '0');
const NEW = 'fdfb7a6a'.padEnd(40, '1');
const PREFIX = '/fake/share/elanous';
const RUNNING_ROOT = `${PREFIX}/versions/old/node_modules/elanous`;

/** Fake fs: only the paths named here exist. */
function fakeFs(files: Record<string, string>) {
  return (path: string): string => {
    if (!(path in files)) throw Object.assign(new Error('ENOENT ' + path), { code: 'ENOENT' });
    return files[path]!;
  };
}
const installed = (commit: string) => ({ [`${PREFIX}/current/install.json`]: JSON.stringify({ commit }) });

test('installer layouts resolve the prefix; a checkout has none', () => {
  expect(installPrefixOf(RUNNING_ROOT)).toBe(PREFIX);
  expect(installPrefixOf(`${PREFIX}/current/node_modules/elanous`)).toBe(PREFIX);
  expect(installPrefixOf('/work/checkout')).toBeUndefined();
});

test('a current symlink pointing at a newer install gives the restart marker and one tui.stale-install event', () => {
  const events: Array<Record<string, unknown>> = [];
  const watch = createStaleInstallWatch({
    detect: () => detectStaleInstall({ runningHead: OLD, packageRoot: RUNNING_ROOT, readText: fakeFs(installed(NEW)),
      readRuntimeHead: () => NEW }),
    log: data => events.push(data),
  });
  const marker = watch.check();
  expect(marker).toBe(`⟳ 재기동 필요 (새 판 ${NEW.slice(0, SOURCE_HEAD_DISPLAY_CHARS)})`);
  expect(watch.check()).toBe(marker); // turn start again: same marker
  expect(watch.marker()).toBe(marker);
  expect(events).toEqual([{ runningHead: OLD.slice(0, SOURCE_HEAD_DISPLAY_CHARS), installedHead: NEW.slice(0, SOURCE_HEAD_DISPLAY_CHARS),
    nexusHead: NEW.slice(0, SOURCE_HEAD_DISPLAY_CHARS), side: 'tui', marker }]);
});

test('the same head gives no marker and no event', () => {
  const events: unknown[] = [];
  const watch = createStaleInstallWatch({
    detect: () => detectStaleInstall({ runningHead: OLD, packageRoot: RUNNING_ROOT, readText: fakeFs(installed(OLD)),
      readRuntimeHead: () => OLD }),
    log: data => events.push(data),
  });
  expect(watch.check()).toBeNull();
  expect(watch.marker()).toBeNull();
  expect(events).toEqual([]);
});

test('a checkout process never shows the marker; an installed one also compares the nexus runtime head', () => {
  expect(detectStaleInstall({ runningHead: OLD, packageRoot: '/work/checkout', readText: fakeFs({}),
    readRuntimeHead: () => NEW })).toEqual({ stale: false, runningHead: OLD });
  // current/install.json unreadable, nexus on another head: a mismatch, but no side is proven.
  const unknown = detectStaleInstall({ runningHead: OLD, packageRoot: RUNNING_ROOT, readText: fakeFs({}), readRuntimeHead: () => NEW });
  expect(unknown).toEqual({ stale: true, runningHead: OLD, nexusHead: NEW, newHead: NEW, side: 'unknown' });
  expect(staleInstallMarker(unknown)).toBe(`⟳ 판 불일치 (nexus ${NEW.slice(0, SOURCE_HEAD_DISPLAY_CHARS)}) · 설치본과 다른 쪽 재기동`);
});

test('this TUI is the installed version and nexus lags: the marker tells nexus, not the TUI, to restart', () => {
  const verdict = detectStaleInstall({ runningHead: NEW, packageRoot: RUNNING_ROOT, readText: fakeFs(installed(NEW)),
    readRuntimeHead: () => OLD });
  expect(verdict).toEqual({ stale: true, runningHead: NEW, installedHead: NEW, nexusHead: OLD, newHead: OLD, side: 'nexus' });
  expect(staleInstallMarker(verdict)).toBe(`⟳ nexus 재기동 필요 (nexus 옛 판 ${OLD.slice(0, SOURCE_HEAD_DISPLAY_CHARS)})`);
  expect(installedCurrentHead(RUNNING_ROOT, fakeFs(installed(NEW)))).toBe(NEW);
  expect(installedCurrentHead('/work/checkout', fakeFs(installed(NEW)))).toBeUndefined();
});

test('unknown heads or unreadable metadata never claim staleness', () => {
  expect(detectStaleInstall({ runningHead: undefined, packageRoot: RUNNING_ROOT, readText: fakeFs(installed(NEW)) }))
    .toEqual({ stale: false });
  const broken = detectStaleInstall({ runningHead: OLD, packageRoot: RUNNING_ROOT,
    readText: fakeFs({ [`${PREFIX}/current/install.json`]: '{not json' }), readRuntimeHead: () => { throw new Error('io'); } });
  expect(broken.stale).toBe(false);
  expect(staleInstallMarker(broken)).toBeNull();
});
