import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../../src/elanous-config-dir.js';
import { runPrepare } from './prepare-node.js';

const oldContext = process.env.ELANOUS_GRAPH_CONTEXT;
const roots: string[] = [];
const old = 'a'.repeat(40), tip = 'b'.repeat(40);

afterEach(() => {
  if (oldContext === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
  else process.env.ELANOUS_GRAPH_CONTEXT = oldContext;
  resetElanousConfigDir();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(refreshedFrom: string | null = old) {
  const root = mkdtempSync(join(tmpdir(), 'release-prepared-stale-'));
  roots.push(root);
  setElanousConfigDir(root);
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.31', previousVersion: '0.2.30' }, outputs: {
    'version-release': { outcome: 'ok', commit: tip, ...(refreshedFrom ? { refreshedFrom } : {}) },
    gate: { outcome: 'ok' }, pwa: { outcome: 'ok' },
  } });
  const out = join(root, 'release/0.2.31/prepared');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'archive.txt'), 'old archive');
  return { root, out };
}

test('first prepare reaches the command when the release output directory does not exist', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-prepared-fresh-'));
  roots.push(root);
  setElanousConfigDir(root);
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.31', previousVersion: '0.2.30' }, outputs: {
    'version-release': { outcome: 'ok', commit: tip }, gate: { outcome: 'ok' }, pwa: { outcome: 'ok' },
  } });
  const out = join(root, 'release/0.2.31/prepared');
  const commands: string[] = [];
  const result = runPrepare((command) => {
    commands.push(command);
    if (command === 'git') return { status: 0, stdout: `${'c'.repeat(40)}\n`, stderr: '' };
    return { status: 0, stdout: JSON.stringify({ manifest: { version: '0.2.31', sourceCommit: tip, distDir: join(out, 'dist') } }), stderr: '' };
  });
  expect(result).toMatchObject({ outcome: 'ok', commit: tip });
  expect(commands).toEqual(['git', 'bun']);
});

test('0.2.36 resume reuses current-tip prepared output proven by this run ledger, even with old refreshedFrom', () => {
  const { root, out } = fixture();
  const runId = '226ca1fa-b383-4b9b-b667-bec6b625e7d4';
  const context = JSON.parse(process.env.ELANOUS_GRAPH_CONTEXT!) as Record<string, unknown>;
  context.runId = runId;
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify(context);
  mkdirSync(join(out, 'dist'), { recursive: true });
  writeFileSync(join(out, 'dist', 'elanous.tgz'), 'candidate');
  writeFileSync(join(out, 'release.json'), JSON.stringify({ version: '0.2.31', sourceCommit: tip, distDir: join(out, 'dist') }));
  const ledgerDir = join(root, 'graph-runs', 'release-loop');
  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(join(ledgerDir, `${runId}.json`), JSON.stringify({ graphId: 'release-loop', runId, nodes: [
    { nodeId: 'prepare', ok: true, output: JSON.stringify({ outcome: 'ok', out, commit: tip }) },
  ] }));
  const result = runPrepare(() => { throw new Error('same run must not rebuild'); });
  expect(result).toMatchObject({ outcome: 'ok', commit: tip, artifactOwner: { runId, reused: true } });
  expect(readFileSync(join(out, 'dist', 'elanous.tgz'), 'utf8')).toBe('candidate');
  expect(readdirSync(root).filter((name) => name.startsWith('.prepared-cleanup-'))).toHaveLength(0);
});

test('prepare refuses a damaged resume-attempt ledger before reusing or rebuilding artifacts', () => {
  const { root, out } = fixture();
  const runId = 'run-with-damaged-ledger';
  const context = JSON.parse(process.env.ELANOUS_GRAPH_CONTEXT!) as Record<string, unknown>;
  context.runId = runId;
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify(context);
  mkdirSync(join(out, 'dist'), { recursive: true });
  writeFileSync(join(out, 'dist', 'elanous.tgz'), 'candidate');
  writeFileSync(join(out, 'release.json'), JSON.stringify({ version: '0.2.31', sourceCommit: tip }));
  writeFileSync(join(out, '.release-node-owner.json'), JSON.stringify({ runId, commit: tip }));
  const attemptsDir = join(root, 'release/0.2.31/resume-attempts');
  mkdirSync(attemptsDir, { recursive: true });
  writeFileSync(join(attemptsDir, `${runId}.json`), JSON.stringify({ version: '0.2.31', runId, attempts: ['invalid-date'] }));
  expect(() => runPrepare(() => { throw new Error('must not launch a command'); })).toThrow('invalid release resume attempts');
  expect(readFileSync(join(out, 'dist', 'elanous.tgz'), 'utf8')).toBe('candidate');
});

test('another run current-tip prepared output is preserved beside a fresh build with owner receipt', () => {
  const { root, out } = fixture();
  const runId = 'new-release-run';
  const context = JSON.parse(process.env.ELANOUS_GRAPH_CONTEXT!) as Record<string, unknown>;
  context.runId = runId;
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify(context);
  writeFileSync(join(out, 'release.json'), JSON.stringify({ version: '0.2.31', sourceCommit: tip }));
  writeFileSync(join(out, '.release-node-owner.json'), JSON.stringify({ runId: 'other-run', commit: tip }));
  const result = runPrepare((command) => {
    if (command === 'git') return { status: 0, stdout: `${'c'.repeat(40)}\n`, stderr: '' };
    mkdirSync(join(out, 'dist'), { recursive: true });
    writeFileSync(join(out, 'release.json'), JSON.stringify({ version: '0.2.31', sourceCommit: tip, distDir: join(out, 'dist') }));
    return { status: 0, stdout: JSON.stringify({ manifest: { version: '0.2.31', sourceCommit: tip, distDir: join(out, 'dist') } }), stderr: '' };
  });
  expect(result).toMatchObject({ outcome: 'ok', artifactOwner: { runId, attempt: 0 } });
  expect(JSON.parse(readFileSync(join(out, '.release-node-owner.json'), 'utf8')).runId).toBe(runId);
  const quarantine = join(root, readdirSync(root).find((name) => name.startsWith('.prepared-cleanup-'))!);
  expect(readFileSync(join(quarantine, 'prepared/archive.txt'), 'utf8')).toBe('old archive');
  expect(JSON.parse(readFileSync(join(quarantine, 'receipt.json'), 'utf8'))).toMatchObject({ old: tip, commit: tip });
});

test('prepare quarantines a manifest-proven archive without deleting its bytes before building the new tip', () => {
  const { root, out } = fixture();
  writeFileSync(join(out, 'release.json'), JSON.stringify({ version: '0.2.31', sourceCommit: old }));
  const commands: string[] = [];
  const result = runPrepare((command, args) => {
    commands.push(command);
    if (command === 'git') return { status: 0, stdout: `${'c'.repeat(40)}\n`, stderr: '' };
    expect(existsSync(out)).toBe(false);
    return { status: 0, stdout: JSON.stringify({ manifest: { version: '0.2.31', sourceCommit: tip, distDir: join(out, 'dist') } }), stderr: '' };
  });
  expect(result).toMatchObject({ outcome: 'ok', commit: tip });
  expect(commands).toEqual(['git', 'bun']);
  const quarantines = readdirSync(root).filter((name) => name.startsWith('.prepared-cleanup-'));
  expect(quarantines).toHaveLength(1);
  const quarantine = join(root, quarantines[0]!);
  expect(readFileSync(join(quarantine, 'prepared/archive.txt'), 'utf8')).toBe('old archive');
  const receipt = JSON.parse(readFileSync(join(quarantine, 'receipt.json'), 'utf8'));
  expect(receipt).toMatchObject({ version: '0.2.31', old, commit: tip, from: out,
    to: join(realpathSync(root), quarantines[0]!, 'prepared') });
  expect(receipt.bytes).toBeGreaterThanOrEqual(Buffer.byteLength('old archive'));
});

test('quarantine size counts symlink bytes without following an outside target', () => {
  const { root, out } = fixture();
  writeFileSync(join(out, 'release.json'), JSON.stringify({ version: '0.2.31', sourceCommit: old }));
  const outside = join(root, 'outside-large');
  writeFileSync(outside, 'x'.repeat(100_000));
  symlinkSync(outside, join(out, 'outside-link'));
  runPrepare((command) => command === 'git'
    ? { status: 0, stdout: `${'c'.repeat(40)}\n`, stderr: '' }
    : { status: 0, stdout: JSON.stringify({ manifest: { version: '0.2.31', sourceCommit: tip, distDir: join(out, 'dist') } }), stderr: '' });
  const quarantine = join(root, readdirSync(root).find((name) => name.startsWith('.prepared-cleanup-'))!);
  const receipt = JSON.parse(readFileSync(join(quarantine, 'receipt.json'), 'utf8'));
  expect(receipt.bytes).toBeLessThan(100_000);
  expect(lstatSync(join(quarantine, 'prepared/outside-link')).isSymbolicLink()).toBe(true);
  expect(readFileSync(outside, 'utf8')).toHaveLength(100_000);
});

test('prepare preserves archives without a proven old-tip manifest', () => {
  for (const kind of ['missing', 'wrong-source', 'unmoved'] as const) {
    const { out } = fixture(kind === 'unmoved' ? null : old);
    if (kind === 'wrong-source') writeFileSync(join(out, 'release.json'), JSON.stringify({ version: '0.2.31', sourceCommit: 'd'.repeat(40) }));
    if (kind === 'unmoved') writeFileSync(join(out, 'release.json'), JSON.stringify({ version: '0.2.31', sourceCommit: old }));
    expect(() => runPrepare(() => { throw new Error('prepare command started'); })).toThrow('prepare output already exists');
    expect(readFileSync(join(out, 'archive.txt'), 'utf8')).toBe('old archive');
  }
});

test('prepare cannot remove an archive through a symlinked release parent', () => {
  const { root, out } = fixture();
  rmSync(join(root, 'release'), { recursive: true });
  const outside = join(root, 'outside');
  const escaped = join(outside, '0.2.31', 'prepared');
  mkdirSync(escaped, { recursive: true });
  writeFileSync(join(escaped, 'release.json'), JSON.stringify({ version: '0.2.31', sourceCommit: old }));
  writeFileSync(join(escaped, 'proof'), 'outside survives');
  symlinkSync(outside, join(root, 'release'));
  expect(() => runPrepare(() => { throw new Error('prepare command started'); })).toThrow('prepare output escapes release root');
  expect(readFileSync(join(escaped, 'proof'), 'utf8')).toBe('outside survives');
  expect(existsSync(out)).toBe(true);
});

test('prepare preserves a dangling symlink occupying its output path', () => {
  const { root, out } = fixture();
  rmSync(out, { recursive: true });
  symlinkSync(join(root, 'missing-archive'), out);
  expect(() => runPrepare(() => { throw new Error('prepare command started'); })).toThrow('prepare output already exists with unverified source');
  expect(lstatSync(out).isSymbolicLink()).toBe(true);
});

test('prepare rejects a traversing version and preserves output outside the release root', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-prepared-traversal-'));
  roots.push(root);
  setElanousConfigDir(root);
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '../outside', previousVersion: '0.2.30' }, outputs: {
    'version-release': { outcome: 'ok', commit: tip, refreshedFrom: old }, gate: { outcome: 'ok' }, pwa: { outcome: 'ok' },
  } });
  const out = join(root, 'outside', 'prepared');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'proof'), 'outside survives');
  writeFileSync(join(out, 'release.json'), JSON.stringify({ version: '../outside', sourceCommit: old }));
  expect(() => runPrepare(() => { throw new Error('prepare command started'); })).toThrow('version and previousVersion required');
  expect(readFileSync(join(out, 'proof'), 'utf8')).toBe('outside survives');
});

test('prepare keeps the old archive when the previous release ref is unavailable', () => {
  const { out } = fixture();
  writeFileSync(join(out, 'release.json'), JSON.stringify({ version: '0.2.31', sourceCommit: old }));
  expect(() => runPrepare((command) => {
    expect(command).toBe('git');
    return { status: 1, stdout: '', stderr: 'missing ref' };
  })).toThrow('previous release ref unavailable');
  expect(readFileSync(join(out, 'archive.txt'), 'utf8')).toBe('old archive');
});

test('prepare preserves an archive whose manifest changes while the previous ref is checked', () => {
  const { out } = fixture();
  writeFileSync(join(out, 'release.json'), JSON.stringify({ version: '0.2.31', sourceCommit: old }));
  expect(() => runPrepare((command) => {
    expect(command).toBe('git');
    writeFileSync(join(out, 'release.json'), JSON.stringify({ version: '0.2.31', sourceCommit: 'd'.repeat(40) }));
    return { status: 0, stdout: `${'c'.repeat(40)}\n`, stderr: '' };
  })).toThrow('prepared manifest changed before cleanup');
  expect(readFileSync(join(out, 'archive.txt'), 'utf8')).toBe('old archive');
});

test('prepare preserves an archive when an unrelated manifest field changes during ref lookup', () => {
  const { out } = fixture();
  writeFileSync(join(out, 'release.json'), JSON.stringify({ version: '0.2.31', sourceCommit: old, note: 'before' }));
  expect(() => runPrepare((command) => {
    expect(command).toBe('git');
    writeFileSync(join(out, 'release.json'), JSON.stringify({ version: '0.2.31', sourceCommit: old, note: 'after' }));
    return { status: 0, stdout: `${'c'.repeat(40)}\n`, stderr: '' };
  })).toThrow('prepared manifest changed before cleanup');
  expect(readFileSync(join(out, 'archive.txt'), 'utf8')).toBe('old archive');
});

test('prepare compares manifest bytes even when two invalid UTF-8 values decode alike', () => {
  const { out } = fixture();
  const manifest = (byte: number) => Buffer.concat([
    Buffer.from(`{"version":"0.2.31","sourceCommit":"${old}","note":"`),
    Buffer.from([byte]), Buffer.from('"}'),
  ]);
  writeFileSync(join(out, 'release.json'), manifest(0x80));
  expect(() => runPrepare((command) => {
    expect(command).toBe('git');
    writeFileSync(join(out, 'release.json'), manifest(0x81));
    return { status: 0, stdout: `${'c'.repeat(40)}\n`, stderr: '' };
  })).toThrow('prepared manifest changed before cleanup');
  expect(readFileSync(join(out, 'archive.txt'), 'utf8')).toBe('old archive');
});

test('prepare preserves quarantine and never follows a manifest symlink swapped after rename', () => {
  const { root, out } = fixture();
  writeFileSync(join(out, 'release.json'), JSON.stringify({ version: '0.2.31', sourceCommit: old }));
  const outside = join(root, 'outside-manifest.json');
  writeFileSync(outside, JSON.stringify({ version: '0.2.31', sourceCommit: old }));
  let moved = '';
  expect(() => runPrepare((command) => {
    expect(command).toBe('git');
    return { status: 0, stdout: `${'c'.repeat(40)}\n`, stderr: '' };
  }, (from, to) => {
    renameSync(from, to);
    moved = String(to);
    rmSync(join(moved, 'release.json'));
    symlinkSync(outside, join(moved, 'release.json'));
  })).toThrow('prepared output changed during cleanup');
  expect(readFileSync(join(moved, 'archive.txt'), 'utf8')).toBe('old archive');
  expect(lstatSync(join(moved, 'release.json')).isSymbolicLink()).toBe(true);
  expect(readFileSync(outside, 'utf8')).toBe(JSON.stringify({ version: '0.2.31', sourceCommit: old }));
});

test('prepare records quarantine but refuses a release parent replaced after the move', () => {
  const { root, out } = fixture();
  writeFileSync(join(out, 'release.json'), JSON.stringify({ version: '0.2.31', sourceCommit: old }));
  const versionDir = join(root, 'release/0.2.31');
  const outside = join(root, 'outside-version');
  mkdirSync(outside);
  let moved = '';
  expect(() => runPrepare((command) => {
    expect(command).toBe('git');
    return { status: 0, stdout: `${'c'.repeat(40)}\n`, stderr: '' };
  }, (from, to) => {
    renameSync(from, to);
    moved = String(to);
    renameSync(versionDir, `${versionDir}.held`);
    symlinkSync(outside, versionDir);
  })).toThrow('prepare parent changed after quarantine');
  expect(readFileSync(join(moved, 'archive.txt'), 'utf8')).toBe('old archive');
  expect(JSON.parse(readFileSync(join(root, readdirSync(root).find((name) => name.startsWith('.prepared-cleanup-'))!, 'receipt.json'), 'utf8')))
    .toMatchObject({ to: moved, sizeStatus: 'measured' });
  expect(readdirSync(outside)).toEqual([]);
});

test('prepare keeps an initial receipt if archive size cannot be read', () => {
  const { root, out } = fixture();
  writeFileSync(join(out, 'release.json'), JSON.stringify({ version: '0.2.31', sourceCommit: old }));
  mkdirSync(join(out, 'unreadable'));
  let moved = '';
  const result = runPrepare((command) => command === 'git'
    ? { status: 0, stdout: `${'c'.repeat(40)}\n`, stderr: '' }
    : { status: 0, stdout: JSON.stringify({ manifest: { version: '0.2.31', sourceCommit: tip, distDir: join(out, 'dist') } }), stderr: '' },
  (from, to) => {
    renameSync(from, to);
    moved = String(to);
    chmodSync(join(moved, 'unreadable'), 0o000);
  });
  chmodSync(join(moved, 'unreadable'), 0o700);
  expect(result.outcome).toBe('ok');
  const quarantine = join(root, readdirSync(root).find((name) => name.startsWith('.prepared-cleanup-'))!);
  const receipt = JSON.parse(readFileSync(join(quarantine, 'receipt.json'), 'utf8'));
  expect(receipt).toMatchObject({ to: moved, bytes: null, sizeStatus: 'unmeasured' });
});

test('prepare preserves a replacement output directory even with the old SHA manifest', () => {
  const { out } = fixture();
  writeFileSync(join(out, 'release.json'), JSON.stringify({ version: '0.2.31', sourceCommit: old }));
  expect(() => runPrepare((command) => {
    expect(command).toBe('git');
    renameSync(out, `${out}.original`);
    mkdirSync(out);
    writeFileSync(join(out, 'release.json'), JSON.stringify({ version: '0.2.31', sourceCommit: old }));
    writeFileSync(join(out, 'proof'), 'replacement survives');
    return { status: 0, stdout: `${'c'.repeat(40)}\n`, stderr: '' };
  })).toThrow('prepared output changed before cleanup');
  expect(readFileSync(join(out, 'proof'), 'utf8')).toBe('replacement survives');
});
