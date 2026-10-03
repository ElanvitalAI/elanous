import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildRouteConsumerTestIndex } from './route-consumer-test-index.js';
import { buildImporterTestIndex } from './importer-test-index.js';
import { resolveGateScope } from './gate-scope.js';
import { runSelfGateCli } from './gate-cli.js';

function repo(files: Record<string, string>) {
  const cwd = mkdtempSync(join(tmpdir(), 'gate-callers-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(cwd, path, '..'), { recursive: true });
    writeFileSync(join(cwd, path), text);
  }
  return { cwd, exists: (path: string) => existsSync(join(cwd, path)), dispose: () => rmSync(cwd, { recursive: true, force: true }) };
}

test('server-only change selects a PWA Chrome route consumer and a reverse import test', () => {
  const source = 'src/nexus/api/inside-events.ts';
  const chrome = 'apps/pwa/chrome/inside-events.test.ts';
  const component = 'apps/pwa/src/components/InsideEvents.test.tsx';
  const importer = 'test/inside-caller.test.ts';
  const fixture = repo({
    [source]: "export const INSIDE_EVENTS_PATH = '/v1/inside/events';\n",
    [chrome]: "await fetch('/v1/inside/events');\n",
    [component]: "const url = '/v1/inside/events?limit=1';\n",
    [importer]: "import '../src/nexus/api/inside-events.js';\n",
    'apps/pwa/chrome/unrelated.test.ts': "fetch('/v1/inside/events-extra');\n",
  });
  try {
    const paths = [chrome, component, importer, 'apps/pwa/chrome/unrelated.test.ts'];
    const route = buildRouteConsumerTestIndex(fixture.cwd, paths, [source]);
    const imports = buildImporterTestIndex(fixture.cwd, paths, [source]);
    const scope = resolveGateScope([source], fixture.exists, imports ?? undefined, { routeConsumerTestIndex: route ?? undefined });
    expect(scope.testArgs).toEqual([chrome, component, importer]);
    expect(scope.callerTests).toEqual([
      { file: chrome, reasons: ['route'] }, { file: component, reasons: ['route'] }, { file: importer, reasons: ['import'] },
    ]);
    expect(scope.unverified).toEqual([]);
    expect(scope.importerTestsNotRun?.total).toBe(0);
  } finally { fixture.dispose(); }
});

test('parameter and wildcard server routes select concrete PWA consumers, not neighboring paths', () => {
  const source = 'src/nexus/api/items.ts';
  const parameterConsumer = 'apps/pwa/chrome/item.test.ts';
  const wildcardConsumer = 'apps/pwa/src/components/Files.test.tsx';
  const unrelated = 'apps/pwa/chrome/item-neighbor.test.ts';
  const fixture = repo({
    [source]: "server.get('/v1/items/:id', handler);\nserver.get('/v1/files/*', handler);\n",
    [parameterConsumer]: "await fetch('/v1/items/42?detail=1');\n",
    [wildcardConsumer]: "await fetch('/v1/files/a/b');\n",
    [unrelated]: "fetch('/v1/items/42/extra'); fetch('/v1/files-other/a/b');\n",
  });
  try {
    const route = buildRouteConsumerTestIndex(fixture.cwd, [parameterConsumer, wildcardConsumer, unrelated], [source]);
    expect(route.testsBySource.get(source)).toEqual([parameterConsumer, wildcardConsumer]);
    const scope = resolveGateScope([source], fixture.exists, undefined, { routeConsumerTestIndex: route });
    expect(scope.testArgs).toEqual([parameterConsumer, wildcardConsumer]);
    expect(scope.callerTests).toEqual([
      { file: parameterConsumer, reasons: ['route'] },
      { file: wildcardConsumer, reasons: ['route'] },
    ]);
  } finally { fixture.dispose(); }
});

test('deleted or renamed parameterized route still selects the old concrete PWA consumer from the comparison base', () => {
  const source = 'src/nexus/api/items.ts';
  const consumer = 'apps/pwa/chrome/item.test.ts';
  const newConsumer = 'apps/pwa/chrome/other.test.ts';
  const fixture = repo({
    [source]: "server.get('/v1/items/:id', handler);\n",
    [consumer]: "await fetch('/v1/items/42');\n",
    [newConsumer]: "await fetch('/v1/other/42');\n",
  });
  try {
    const git = (args: string[]) => expect(spawnSync('git', args, { cwd: fixture.cwd }).status).toBe(0);
    git(['init', '-q']);
    git(['add', '.']);
    git(['-c', 'user.name=gate', '-c', 'user.email=gate@example.com', 'commit', '-qm', 'base']);
    for (const updated of ["server.get('/v1/other/:id', handler);\n", '', null]) {
      if (updated === null) unlinkSync(join(fixture.cwd, source));
      else writeFileSync(join(fixture.cwd, source), updated);
      const index = buildRouteConsumerTestIndex(fixture.cwd, [consumer, newConsumer], [source]);
      const scope = resolveGateScope([source], fixture.exists, undefined, { routeConsumerTestIndex: index });
      expect(scope.testArgs).toContain(consumer);
      expect(scope.callerTests).toContainEqual({ file: consumer, reasons: ['route'] });
      if (updated?.includes('/v1/other/')) expect(scope.testArgs).toContain(newConsumer);
    }
  } finally { fixture.dispose(); }
});

test('failed base lookup for a deleted server source is unmeasured, not an empty caller set', () => {
  const source = 'src/nexus/api/items.ts';
  const consumer = 'apps/pwa/chrome/item.test.ts';
  const fixture = repo({ [source]: "server.get('/v1/items/:id', handler);\n", [consumer]: "await fetch('/v1/items/42');\n" });
  try {
    const git = (args: string[]) => expect(spawnSync('git', args, { cwd: fixture.cwd }).status).toBe(0);
    git(['init', '-q']);
    git(['add', '.']);
    git(['-c', 'user.name=gate', '-c', 'user.email=gate@example.com', 'commit', '-qm', 'base']);
    unlinkSync(join(fixture.cwd, source));
    const index = buildRouteConsumerTestIndex(fixture.cwd, [consumer], [source], 'missing-base');
    expect(index.testsBySource.get(source)).toBeUndefined();
    expect(index.lookupFailures).toHaveLength(1);
    expect(index.lookupFailures[0]?.source).toBe(source);
    const result = runSelfGateCli(fixture.cwd, {}, {
      changedFiles: () => ({ files: [source], baseRef: 'missing-base' }),
      runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
    });
    expect(result.lines.join('\n')).toContain(`caller route base lookup failed — unmeasured: ${source}`);
    expect(result.lines).not.toContain('caller tests: (none)');
  } finally { fixture.dispose(); }
});

test('CLI runs the old PWA consumer when a committed server route is removed or changed', () => {
  const source = 'src/nexus/api/items.ts';
  const consumer = 'apps/pwa/chrome/item.test.ts';
  const fixture = repo({ [source]: "server.get('/v1/items/:id', handler);\n", [consumer]: "await fetch('/v1/items/42');\n" });
  try {
    const git = (args: string[]) => expect(spawnSync('git', args, { cwd: fixture.cwd }).status).toBe(0);
    git(['init', '-q']);
    git(['add', '.']);
    git(['-c', 'user.name=gate', '-c', 'user.email=gate@example.com', 'commit', '-qm', 'base']);
    for (const updated of ["server.get('/v1/other/:id', handler);\n", '']) {
      writeFileSync(join(fixture.cwd, source), updated);
      const ran: string[][] = [];
      const result = runSelfGateCli(fixture.cwd, {}, {
        changedFiles: () => ({ files: [source], baseRef: 'HEAD' }),
        runTests: (_cwd, files) => { ran.push([...files]); return { status: 0, stdout: '', stderr: '' }; },
        runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
      });
      expect(ran).toEqual([[consumer]]);
      expect(result.lines).toContain(`caller tests: ${consumer} (route)`);
    }
  } finally { fixture.dispose(); }
});

test('CLI executes a concrete PWA fetch for a changed parameterized server route', () => {
  const source = 'src/nexus/api/items.ts';
  const consumer = 'apps/pwa/chrome/item.test.ts';
  const fixture = repo({
    [source]: "server.get('/v1/items/:id', handler);\n",
    [consumer]: "await fetch('/v1/items/42');\n",
  });
  try {
    spawnSync('git', ['init', '-q'], { cwd: fixture.cwd });
    spawnSync('git', ['add', '.'], { cwd: fixture.cwd });
    const ran: string[][] = [];
    const result = runSelfGateCli(fixture.cwd, {}, {
      changedFiles: () => ({ files: [source], baseRef: 'HEAD' }),
      runTests: (_cwd, files) => { ran.push([...files]); return { status: 0, stdout: '', stderr: '' }; },
      runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
    });
    expect(result.testFiles).toEqual([consumer]);
    expect(ran).toEqual([[consumer]]);
    expect(result.lines).toContain(`caller tests: ${consumer} (route)`);
    expect(result.exitCode).toBe(0);
  } finally { fixture.dispose(); }
});

test('deleted tracked tests do not erase route matches from remaining files', () => {
  const source = 'src/nexus/api/inside-events.ts';
  const consumer = 'apps/pwa/chrome/inside-events.test.ts';
  const fixture = repo({ [source]: "export const INSIDE_EVENTS_PATH = '/v1/inside/events';\n", [consumer]: "fetch('/v1/inside/events');\n" });
  try {
    const index = buildRouteConsumerTestIndex(fixture.cwd, ['test/deleted.test.ts', consumer], [source]);
    expect(index.testsBySource.get(source)).toEqual([consumer]);
  } finally { fixture.dispose(); }
});

test('a test consuming both the route and module is selected once with both reasons', () => {
  const source = 'src/nexus/api/inside-events.ts';
  const consumer = 'apps/pwa/src/components/InsideEvents.test.tsx';
  const fixture = repo({
    [source]: "export const INSIDE_EVENTS_PATH = '/v1/inside/events';\n",
    [consumer]: "import '../../../../src/nexus/api/inside-events.js';\nfetch('/v1/inside/events');\n",
  });
  try {
    const imports = buildImporterTestIndex(fixture.cwd, [consumer], [source]);
    const route = buildRouteConsumerTestIndex(fixture.cwd, [consumer], [source]);
    const scope = resolveGateScope([source], fixture.exists, imports ?? undefined, { routeConsumerTestIndex: route ?? undefined });
    expect(scope.testArgs).toEqual([consumer]);
    expect(scope.callerTests).toEqual([{ file: consumer, reasons: ['import', 'route'] }]);
  } finally { fixture.dispose(); }
});

test('CLI executes the PWA route and import consumers when only the server source changed', () => {
  const source = 'src/nexus/api/inside-events.ts';
  const pwa = 'apps/pwa/chrome/inside-events.test.ts';
  const importer = 'test/inside-caller.test.ts';
  const fixture = repo({
    [source]: "export const INSIDE_EVENTS_PATH = '/v1/inside/events';\n",
    [pwa]: "fetch('/v1/inside/events');\n",
    [importer]: "import '../src/nexus/api/inside-events.js';\n",
  });
  try {
    spawnSync('git', ['init', '-q'], { cwd: fixture.cwd });
    spawnSync('git', ['add', '.'], { cwd: fixture.cwd });
    const ran: string[][] = [];
    const result = runSelfGateCli(fixture.cwd, {}, {
      changedFiles: () => ({ files: [source], baseRef: 'HEAD' }),
      runTests: (_cwd, files) => { ran.push([...files]); return { status: 0, stdout: '', stderr: '' }; },
      runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
    });
    expect(result.testFiles).toEqual([pwa, importer]);
    expect(ran).toEqual([[pwa, importer]]);
    expect(result.lines).toContain(`caller tests: ${pwa} (route), ${importer} (import)`);
    expect(result.exitCode).toBe(0);
  } finally { fixture.dispose(); }
});

test('CLI warns with the exact overflow list after selecting 30 callers', () => {
  const source = 'src/nexus/api/inside-events.ts';
  const files: Record<string, string> = { [source]: "export const INSIDE_EVENTS_PATH = '/v1/inside/events';\n" };
  for (let n = 0; n < 32; n += 1) files[`apps/pwa/chrome/caller-${String(n).padStart(2, '0')}.test.ts`] = "fetch('/v1/inside/events');\n";
  const fixture = repo(files);
  try {
    spawnSync('git', ['init', '-q'], { cwd: fixture.cwd });
    spawnSync('git', ['add', '.'], { cwd: fixture.cwd });
    const result = runSelfGateCli(fixture.cwd, {}, {
      changedFiles: () => ({ files: [source], baseRef: 'HEAD' }),
      runTests: () => ({ status: 0, stdout: '', stderr: '' }),
      runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
    });
    expect(result.testFiles).toHaveLength(30);
    expect(result.lines.join('\n')).toContain('⚠️ caller test cap exceeded — not run: apps/pwa/chrome/caller-30.test.ts (route), apps/pwa/chrome/caller-31.test.ts (route)');
  } finally { fixture.dispose(); }
});

test('the default 30-file caller cap preserves overflow names and reasons without a full-suite fallback', () => {
  const source = 'src/nexus/api/inside-events.ts';
  const files: Record<string, string> = { [source]: "export const INSIDE_EVENTS_PATH = '/v1/inside/events';\n" };
  for (let n = 0; n < 32; n += 1) files[`apps/pwa/chrome/caller-${String(n).padStart(2, '0')}.test.ts`] = "fetch('/v1/inside/events');\n";
  const fixture = repo(files);
  try {
    const route = buildRouteConsumerTestIndex(fixture.cwd, Object.keys(files), [source]);
    const scope = resolveGateScope([source], fixture.exists, undefined, { routeConsumerTestIndex: route ?? undefined });
    expect(scope.testArgs).toHaveLength(30);
    expect(scope.callerTestsOverflow).toEqual([
      { file: 'apps/pwa/chrome/caller-30.test.ts', reasons: ['route'] },
      { file: 'apps/pwa/chrome/caller-31.test.ts', reasons: ['route'] },
    ]);
    expect(scope.skipTestStep).toBe(false);
  } finally { fixture.dispose(); }
});

test('a hub server file selects only consumers of routes on diff-touched lines (all routes when the diff is unavailable)', () => {
  const source = 'src/nexus/api/hub.ts';
  const touchedConsumer = 'apps/pwa/src/touched.test.ts';
  const untouchedConsumer = 'apps/pwa/src/untouched.test.ts';
  const fixture = repo({
    [source]: "if (pathname === '/v1/alpha') ok();\nif (pathname === '/v1/beta') ok();\n",
    [touchedConsumer]: "fetch('/v1/alpha');\n",
    [untouchedConsumer]: "fetch('/v1/beta');\n",
  });
  const git = (...args: string[]) => spawnSync('git', args, { cwd: fixture.cwd, encoding: 'utf8' });
  try {
    git('init', '-q'); git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
    writeFileSync(join(fixture.cwd, source), "if (pathname === '/v1/alpha') okChanged();\nif (pathname === '/v1/beta') ok();\n");
    const index = buildRouteConsumerTestIndex(fixture.cwd, [touchedConsumer, untouchedConsumer], [source]);
    expect(index.testsBySource.get(source)).toEqual([touchedConsumer]);
    const noDiff = buildRouteConsumerTestIndex(fixture.cwd, [touchedConsumer, untouchedConsumer], [source], 'HEAD', undefined, () => null);
    expect(noDiff.testsBySource.get(source)).toEqual([touchedConsumer, untouchedConsumer]);
  } finally { fixture.dispose(); }
});
