import { expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// A published install runs `nexus build` relative to the installed bin and
// expects the sibling apps/pwa package to be present. Ask the package manager
// for its real file list so this contract follows package.json `files` rules.
setDefaultTimeout(60_000);

const root = resolve(import.meta.dir, '..');

test('the npm package includes the PWA package and build entry points', () => {
  const result = spawnSync(process.execPath, ['pm', 'pack', '--dry-run', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);

  const packed = new Set(
    result.stdout
      .split('\n')
      .map((line) => /^packed\s+\S+\s+(apps\/pwa\/[^\s]+)$/.exec(line)?.[1])
      .filter((path): path is string => path !== undefined),
  );
  expect(packed.has('apps/pwa/package.json')).toBe(true);
  expect(packed.has('apps/pwa/scripts/static-generation.ts')).toBe(true);
  expect(packed.has('apps/pwa/next.config.ts')).toBe(true);
  expect(packed.has('apps/pwa/src/app/page.tsx')).toBe(true);
  expect(packed.has('apps/pwa/src/components/inside/InsidePage.browser-test-support.ts')).toBe(false);
  expect(packed.has('apps/pwa/src/lib/testing/restore-module-mocks.ts')).toBe(false);
  expect(packed.has('apps/pwa/src/test-devices/graph-design-replay.ts')).toBe(true);
  expect(packed.has('apps/pwa/src/test-devices/fake-fetch.ts')).toBe(false);
  expect(packed.has('apps/pwa/src/test-devices/mock-nexus-pwa-journey.tsx')).toBe(false);
  expect([...packed].some((path) => path.startsWith('apps/pwa/') && /\.test\.[^/]+$/.test(path))).toBe(false);
});
