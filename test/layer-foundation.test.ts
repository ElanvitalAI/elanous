import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { formatClock, resolveTimeZone, setConfigTimeZoneSource } from '../src/time/format.js';
import { debug } from '../src/debug/log.js';

const root = resolve(import.meta.dir, '..');
const src = join(root, 'src') + sep;
const foundations = [
  'src/debug/log.ts',
  'src/time/format.ts',
  'src/autopilot/state-paths.ts',
  'src/instance/resolve.ts',
  'src/user-config.ts',
];
const maxSourceFiles = 80;
const compilerOptions: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022,
};

function isSourceFile(file: string): boolean {
  return file.startsWith(src) && file.endsWith('.ts');
}

function imports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const specs: string[] = [];
  function visit(node: ts.Node): void {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      specs.push(node.argument.literal.text);
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require' && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!)) {
      specs.push(node.arguments[0].text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
      specs.push(node.moduleReference.expression.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return specs;
}

function sourceEdges(file: string): string[] {
  return imports(file).map((spec) => ts.resolveModuleName(spec, file, compilerOptions, ts.sys).resolvedModule?.resolvedFileName)
    .filter((resolved): resolved is string => !!resolved && isSourceFile(resolved));
}

function firstPath(start: string, included: Set<string>): string {
  const highFanout = join(root, 'src/user-config.ts');
  const target = included.has(highFanout) ? highFanout : undefined;
  const queue: { file: string; path: string[] }[] = [{ file: start, path: [start] }];
  const seen = new Set<string>([start]);
  let first: string[] | undefined;
  for (let i = 0; i < queue.length; i++) {
    const { file, path } = queue[i]!;
    for (const next of sourceEdges(file)) {
      if (seen.has(next)) continue;
      const nextPath = [...path, next];
      if (included.has(next)) {
        first ??= nextPath;
        if (!target || next === target) return nextPath.map((p) => relative(root, p)).join(' → ');
      }
      seen.add(next);
      if (nextPath.length < 8) queue.push({ file: next, path: nextPath });
    }
  }
  return first?.map((p) => relative(root, p)).join(' → ')
    ?? `${relative(root, start)} → (first edge not resolved)`;
}

function repositorySourcesFor(file: string): Set<string> {
  const dir = mkdtempSync(join(tmpdir(), 'layer-foundation-'));
  try {
    const config = join(dir, 'tsconfig.json');
    writeFileSync(config, JSON.stringify({
      extends: join(root, 'tsconfig.json'), files: [join(root, file)], include: [],
      compilerOptions: { noEmit: true, typeRoots: [join(root, 'node_modules/@types'), join(root, 'node_modules')] },
    }));
    const output = execFileSync('node', [join(root, 'node_modules/typescript/bin/tsc'), '-p', config, '--listFilesOnly'], {
      cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000,
    });
    return new Set(output.trim().split(/\r?\n/).filter(isSourceFile));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function allTimeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? allTimeFiles(path) : entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('foundation import boundary', () => {
  test('static imports and single-root tsc stay inside the foundation boundary', () => {
    const config = join(root, 'src/user-config.ts');
    const configSource = readFileSync(config, 'utf8');
    expect(configSource).not.toMatch(/typeof\s+import\s*\(\s*['"]\.\/llm\.js['"]\s*\)/);
    const configEdges = sourceEdges(config);
    for (const heavy of [
      'src/self-implement/blocked-draft-policy.ts',
      'src/release-loop/rubric.ts',
      'src/skills/runner.ts',
    ]) {
      expect(configEdges.includes(join(root, heavy)), `src/user-config.ts → ${heavy}`).toBe(false);
    }
    for (const file of allTimeFiles(join(root, 'src/time'))) {
      expect(sourceEdges(file), `${relative(root, file)} → src/user-config.ts`).not.toContain(config);
    }
    const log = join(root, 'src/debug/log.ts');
    const sinkDir = join(root, 'src/mss/logging/sinks') + sep;
    expect(sourceEdges(log).filter((file) => file.startsWith(sinkDir)),
      'src/debug/log.ts → src/mss/logging/sinks/**').toEqual([]);

    for (const file of foundations) {
      const files = repositorySourcesFor(file);
      const count = files.size;
      console.log(`${file}: ${count} repository src files (limit ${maxSourceFiles})`);
      expect(count <= maxSourceFiles,
        `${file}: ${count} > ${maxSourceFiles}; first path: ${firstPath(join(root, file), new Set([...files].filter((f) => f !== join(root, file))))}`).toBe(true);
    }
  });
});

describe('debug sink preservation', () => {
  test('OTel remains off by default and registers when MSS_OTEL_ENDPOINT is set', () => {
    const scratch = join(root, '.elanous-test', 'scratch');
    mkdirSync(scratch, { recursive: true });
    const dir = mkdtempSync(join(scratch, 'foundation-sink-'));
    try {
      const script = join(dir, 'probe.ts');
      writeFileSync(script, `
        const { debug } = await import(${JSON.stringify(join(root, 'src/debug/log.ts'))});
        debug.log('llm.foundation', 'first-event');
        const sinks = (debug as unknown as { _extraSinks: { name: string; bufferedCount?: () => number }[] })._extraSinks;
        console.log('SINKS=' + JSON.stringify(sinks.map((sink) => sink.name)));
        console.log('FIRST_EVENT_BUFFERED=' + (sinks.find((sink) => sink.name === 'otel-genai')?.bufferedCount?.() ?? 0));
      `);
      const probe = (endpoint: string | undefined): { names: string[]; buffered: number } => {
        const { stdout, stderr, exitCode } = Bun.spawnSync({
          cmd: [process.execPath, script], cwd: root,
          env: { ...process.env, MSS_OTEL_ENDPOINT: endpoint, MSS_STDERR_SINK: undefined },
        });
        expect(exitCode, new TextDecoder().decode(stderr)).toBe(0);
        const line = new TextDecoder().decode(stdout).split('\n').find((item) => item.startsWith('SINKS='));
        expect(line).toBeDefined();
        const bufferedLine = new TextDecoder().decode(stdout).split('\n').find((item) => item.startsWith('FIRST_EVENT_BUFFERED='));
        expect(bufferedLine).toBeDefined();
        return {
          names: JSON.parse(line!.slice('SINKS='.length)) as string[],
          buffered: Number(bufferedLine!.slice('FIRST_EVENT_BUFFERED='.length)),
        };
      };
      expect(probe(undefined)).toEqual({ names: [], buffered: 0 });
      const active = probe('http://localhost:4318/v1/traces');
      expect(active.names).toContain('otel-genai');
      expect(active.buffered).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('enabled stderr sink receives the first log immediately after import', () => {
    const script = `const { debug } = await import(${JSON.stringify(join(root, 'src/debug/log.ts'))}); debug.log('layer.foundation', 'first-stderr');`;
    for (const enabled of [undefined, '1']) {
      const { stderr, exitCode } = Bun.spawnSync({
        cmd: [process.execPath, '-e', script], cwd: root,
        env: { ...process.env, MSS_OTEL_ENDPOINT: undefined, MSS_STDERR_SINK: enabled },
      });
      const lines = new TextDecoder().decode(stderr).split('\n').filter((line) => line.includes('"event":"first-stderr"'));
      expect(exitCode).toBe(0);
      expect(lines.length).toBe(enabled ? 1 : 0);
    }
  });

  test('debug.log records events and registration sends them to an extra sink', () => {
    const seen: string[] = [];
    const unregister = debug.registerSink({
      name: 'foundation-test',
      emit: (record) => { seen.push(`${record.category}/${record.event}`); },
    });
    try {
      debug.log('layer.foundation', 'sink-record', { ok: true });
      expect(seen).toContain('layer.foundation/sink-record');
      expect(debug.events().some((event) => event.category === 'layer.foundation' && event.event === 'sink-record')).toBe(true);
    } finally {
      unregister();
    }
    debug.log('layer.foundation', 'sink-unregistered');
    expect(seen).toEqual(['layer.foundation/sink-record']);
  });
});

describe('timezone registration', () => {
  test('a fresh process without registration resolves env before OS', () => {
    const script = `const { resolveTimeZone } = await import(${JSON.stringify(join(root, 'src/time/format.ts'))}); console.log(JSON.stringify(resolveTimeZone({ envTimeZone: 'Asia/Seoul', systemTimeZone: 'UTC' })));`;
    const { stdout, stderr, exitCode } = Bun.spawnSync({ cmd: [process.execPath, '-e', script], cwd: root });
    expect(exitCode, new TextDecoder().decode(stderr)).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(stdout).trim()))
      .toEqual({ timeZone: 'Asia/Seoul', source: 'env' });
  });

  test('logs CLI formatting uses saved timezone without pre-importing user-config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'layer-timezone-entry-'));
    try {
      mkdirSync(join(dir, 'elanous'));
      writeFileSync(join(dir, 'elanous/config.json'), JSON.stringify({ timezone: 'Europe/Paris' }));
      const script = `
        const { formatLogLine } = await import(${JSON.stringify(join(root, 'src/cli/logs-cli.ts'))});
        const row = { ts: '2026-01-01T12:00:00Z', level: 'info', surface: 'nexus', category: 'probe', event: 'clock', data: null };
        console.log('CLOCK=' + formatLogLine(row, false));
      `;
      const { stdout, stderr, exitCode } = Bun.spawnSync({
        cmd: [process.execPath, '-e', script], cwd: root,
        env: { ...process.env, XDG_CONFIG_HOME: dir, TZ: 'Asia/Seoul', ELANOUS_SUPPRESS_XDG_WARNING: '1' },
      });
      expect(exitCode, new TextDecoder().decode(stderr)).toBe(0);
      const line = new TextDecoder().decode(stdout).split('\n').find((entry) => entry.startsWith('CLOCK='));
      expect(line).toBe('CLOCK=13:00:00.000 I [nexus] probe clock');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('standalone logger formats with stored timezone without a pre-import', () => {
    const dir = mkdtempSync(join(tmpdir(), 'layer-logger-timezone-'));
    try {
      mkdirSync(join(dir, 'elanous'));
      writeFileSync(join(dir, 'elanous/config.json'), JSON.stringify({ timezone: 'Europe/Paris' }));
      const script = `
        const { formatLine } = await import(${JSON.stringify(join(root, 'src/debug/log.ts'))});
        console.log('CLOCK=' + formatLine({ ts: '2026-01-01T12:00:00Z', category: 'probe', event: 'clock' }));
      `;
      const { stdout, stderr, exitCode } = Bun.spawnSync({
        cmd: [process.execPath, '-e', script], cwd: root,
        env: { ...process.env, XDG_CONFIG_HOME: dir, TZ: 'Asia/Seoul', ELANOUS_SUPPRESS_XDG_WARNING: '1' },
      });
      expect(exitCode, new TextDecoder().decode(stderr)).toBe(0);
      expect(new TextDecoder().decode(stdout).split('\n').find((entry) => entry.startsWith('CLOCK=')))
        .toBe('CLOCK=[13:00:00.000] [probe] clock');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('standalone workflow scheduler loads saved timezone before choosing its cron clock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'layer-scheduler-timezone-'));
    try {
      mkdirSync(join(dir, 'elanous'));
      writeFileSync(join(dir, 'elanous/config.json'), JSON.stringify({ timezone: 'Europe/Paris' }));
      const script = `
        const { startScheduler } = await import(${JSON.stringify(join(root, 'src/workflow-runtime/triggers/scheduler.ts'))});
        const { resolveTimeZone } = await import(${JSON.stringify(join(root, 'src/time/format.ts'))});
        const handle = startScheduler({ registry: [], runWorkflow: () => {} });
        console.log('SCHEDULER_TZ=' + JSON.stringify(resolveTimeZone({ envTimeZone: 'Asia/Seoul', systemTimeZone: 'UTC' })));
        handle.stop();
      `;
      const { stdout, stderr, exitCode } = Bun.spawnSync({
        cmd: [process.execPath, '-e', script], cwd: root,
        env: { ...process.env, XDG_CONFIG_HOME: dir, TZ: 'Asia/Seoul', ELANOUS_SUPPRESS_XDG_WARNING: '1' },
      });
      expect(exitCode, new TextDecoder().decode(stderr)).toBe(0);
      const line = new TextDecoder().decode(stdout).split('\n').find((entry) => entry.startsWith('SCHEDULER_TZ='));
      expect(line).toBeDefined();
      expect(JSON.parse(line!.slice('SCHEDULER_TZ='.length)))
        .toEqual({ timeZone: 'Europe/Paris', source: 'config' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('standalone schedule runner uses the saved timezone for node-cron and catch-up', () => {
    const dir = mkdtempSync(join(tmpdir(), 'layer-schedule-runner-timezone-'));
    try {
      mkdirSync(join(dir, 'elanous'));
      writeFileSync(join(dir, 'elanous/config.json'), JSON.stringify({ timezone: 'Europe/Paris' }));
      const script = `
        const { openSchedulesDb } = await import(${JSON.stringify(join(root, 'src/domains/schedule-registry.ts'))});
        const { startScheduleRunner } = await import(${JSON.stringify(join(root, 'src/domains/schedule-runner.ts'))});
        const { resolveTimeZone } = await import(${JSON.stringify(join(root, 'src/time/format.ts'))});
        const db = openSchedulesDb(':memory:');
        db.run("INSERT INTO schedule_registry(id, name, source, cron, command, category, enabled, run_via) VALUES ('foundation', 'foundation', 'test', '0 8 * * *', 'noop', 'maintenance', 1, 'elanous')");
        const scheduled = [];
        const handle = startScheduleRunner({ db, crontabText: () => '', schedule: (expr, _cb) => {
          scheduled.push([expr, resolveTimeZone().timeZone]);
          return { stop() {} };
        }, nowDate: () => new Date('2026-01-01T01:00:00Z'), catchupGraceMs: 0 });
        console.log('RUNNER=' + JSON.stringify({ scheduled, resolution: resolveTimeZone({ envTimeZone: 'Asia/Seoul', systemTimeZone: 'UTC' }) }));
        handle.stop();
        db.close();
      `;
      const { stdout, stderr, exitCode } = Bun.spawnSync({
        cmd: [process.execPath, '-e', script], cwd: root,
        env: { ...process.env, XDG_CONFIG_HOME: dir, TZ: 'Asia/Seoul', ELANOUS_SUPPRESS_XDG_WARNING: '1' },
      });
      expect(exitCode, new TextDecoder().decode(stderr)).toBe(0);
      const line = new TextDecoder().decode(stdout).split('\n').find((entry) => entry.startsWith('RUNNER='));
      expect(line).toBeDefined();
      expect(JSON.parse(line!.slice('RUNNER='.length))).toEqual({
        scheduled: [['0 8 * * *', 'Europe/Paris']],
        resolution: { timeZone: 'Europe/Paris', source: 'config' },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('standalone cron match uses saved timezone without pre-importing user-config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'layer-cron-timezone-'));
    try {
      mkdirSync(join(dir, 'elanous'));
      writeFileSync(join(dir, 'elanous/config.json'), JSON.stringify({ timezone: 'Europe/Paris' }));
      const script = `
        const { cronMatches } = await import(${JSON.stringify(join(root, 'src/domains/cron-match.ts'))});
        const instant = new Date('2026-01-01T12:00:00Z');
        console.log('MATCH=' + cronMatches('0 13 * * *', instant));
      `;
      const { stdout, stderr, exitCode } = Bun.spawnSync({
        cmd: [process.execPath, '-e', script], cwd: root,
        env: { ...process.env, XDG_CONFIG_HOME: dir, TZ: 'Asia/Seoul', ELANOUS_SUPPRESS_XDG_WARNING: '1' },
      });
      expect(exitCode, new TextDecoder().decode(stderr)).toBe(0);
      expect(new TextDecoder().decode(stdout).split('\n').find((entry) => entry.startsWith('MATCH=')))
        .toBe('MATCH=true');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('without a config value env wins over OS; explicit config injection remains authoritative', () => {
    const restore = setConfigTimeZoneSource(() => undefined);
    try {
      expect(resolveTimeZone({ envTimeZone: 'Asia/Seoul', systemTimeZone: 'UTC' }))
        .toEqual({ timeZone: 'Asia/Seoul', source: 'env' });
      expect(resolveTimeZone({ configTimeZone: 'UTC', envTimeZone: 'Asia/Seoul' }))
        .toEqual({ timeZone: 'UTC', source: 'config' });
      expect(resolveTimeZone({ configTimeZone: undefined, envTimeZone: undefined, systemTimeZone: 'UTC' }))
        .toEqual({ timeZone: 'UTC', source: 'system' });
      expect(resolveTimeZone({ configTimeZone: undefined, envTimeZone: undefined, systemTimeZone: 'Invalid/Zone' }))
        .toEqual({ timeZone: 'UTC', source: 'fallback' });
    } finally {
      restore();
    }
  });

  test('registered source selects config and does not alter explicit injection or clock formatting', () => {
    const restore = setConfigTimeZoneSource(() => 'Europe/Paris');
    try {
      expect(resolveTimeZone()).toEqual({ timeZone: 'Europe/Paris', source: 'config' });
      expect(resolveTimeZone({ configTimeZone: undefined, envTimeZone: 'Asia/Seoul' }))
        .toEqual({ timeZone: 'Asia/Seoul', source: 'env' });
      expect(formatClock('2026-01-01T12:00:00Z')).toBe('13:00:00');
    } finally {
      restore();
    }
  });

  test('user-config registration reads saved timezone without changing getUserConfig output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'layer-timezone-'));
    const saved = process.env.XDG_CONFIG_HOME;
    let resetConfig: (() => void) | undefined;
    try {
      process.env.XDG_CONFIG_HOME = dir;
      mkdirSync(join(dir, 'elanous'));
      const path = join(dir, 'elanous/config.json');
      writeFileSync(path, JSON.stringify({ timezone: 'Europe/Paris' }));
      const { getUserConfig, resetUserConfig } = await import('../src/user-config.js');
      resetConfig = resetUserConfig;
      resetUserConfig();
      const config = getUserConfig();
      expect(config.timezone).toBeUndefined();
      expect(config.raw?.timezone).toBe('Europe/Paris');
      expect(resolveTimeZone({ envTimeZone: 'Asia/Seoul', systemTimeZone: 'UTC' }))
        .toEqual({ timeZone: 'Europe/Paris', source: 'config' });
      writeFileSync(path, JSON.stringify({ timezone: 'Asia/Seoul' }));
      resetUserConfig();
      expect(getUserConfig().raw?.timezone).toBe('Asia/Seoul');
      expect(resolveTimeZone({ envTimeZone: undefined, systemTimeZone: 'UTC' }))
        .toEqual({ timeZone: 'Asia/Seoul', source: 'config' });
      const { setUserConfigOverlay } = await import('../src/user-config.js');
      setUserConfigOverlay((cfg) => ({ ...cfg, timezone: 'Europe/Paris' }));
      try {
        expect(getUserConfig().timezone).toBe('Europe/Paris');
        expect(resolveTimeZone()).toEqual({ timeZone: 'Europe/Paris', source: 'config' });
      } finally {
        setUserConfigOverlay(null);
      }
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
      resetConfig?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });

});
