import { afterEach, expect, test, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { Command } from 'commander';
import { registerLoopCommands } from '../loop-cli.js';
import { debug } from '../../debug/log.js';
import { contractMajor, mergeOverlay, readLoopPackage, verifyLoopPackage } from './verify.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const example = readFileSync(resolve(import.meta.dir, '../contract/examples/cmo-seat.loop.yaml'), 'utf8');

type Doc = Record<string, any>;
function fixture(change: (manifest: Doc) => void = () => {}, overlay?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'loop-package-'));
  roots.push(dir);
  const manifest = parseYaml(example) as Doc;
  manifest.schema = 'https://elanous.ai/schemas/loop-agent/1.0.0';
  change(manifest);
  writeFileSync(join(dir, 'loop.yaml'), stringifyYaml(manifest));
  if (overlay !== undefined) writeFileSync(join(dir, 'overlay.yaml'), stringifyYaml(overlay));
  for (const path of ['graphs/operate-loop.yaml', 'docs/roles/MK.md']) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), 'fixture\n');
  }
  return dir;
}

function cli(dir: string): { status: number | null; result: ReturnType<typeof verifyLoopPackage> } {
  const run = Bun.spawnSync(['bun', 'bin/elanous.mjs', '--test', 'loop', 'package', 'verify', dir, '--json'], {
    cwd: resolve(import.meta.dir, '../../..'), stdout: 'pipe', stderr: 'pipe',
  });
  const stdout = new TextDecoder().decode(run.stdout);
  expect(stdout.trim()).toStartWith('{');
  return { status: run.exitCode, result: JSON.parse(stdout) };
}

const fasterCadence = { timezone: 'Asia/Seoul', byDefcon: [5, 4, 3, 2, 1].map(defcon => ({ defcon, everyMinutes: 30 })) };

test('① safe cadence overlay merges and both verifier and CLI accept without changing package files', () => {
  const dir = fixture(() => {}, { cadence: fasterCadence });
  const before = readFileSync(join(dir, 'loop.yaml'), 'utf8');
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const read = readLoopPackage(dir);
    expect(read.errors).toEqual([]);
    expect(contractMajor(read.manifest!)).toEqual({ ok: true });
    const result = verifyLoopPackage(dir);
    expect(result).toMatchObject({ ok: true, errors: [], refusedOverlayFields: [], merged: { cadence: fasterCadence } });
    expect(log).toHaveBeenCalledWith('loop.package', 'verified', { id: 'cmo-seat', version: '1.0.0', errors: 0, refusedOverlayFields: [] });
    expect(readFileSync(join(dir, 'loop.yaml'), 'utf8')).toBe(before);
    expect(cli(dir)).toMatchObject({ status: 0, result: { ok: true, merged: { cadence: fasterCadence } } });
  } finally { log.mockRestore(); }
});

test('human CLI prints OK and a final status line; refusals print each error and exit 1', async () => {
  const outputs: string[] = [];
  const print = spyOn(console, 'log').mockImplementation((text: string) => { outputs.push(text); });
  try {
    for (const [dir, accepted] of [
      [fixture(() => {}, { cadence: fasterCadence }), true],
      [fixture(() => {}, { role: 'docs/evil.md' }), false],
    ] as const) {
      process.exitCode = 0;
      const program = new Command();
      registerLoopCommands(program);
      await program.parseAsync(['loop', 'package', 'verify', dir], { from: 'user' });
      expect(process.exitCode).toBe(accepted ? 0 : 1);
      expect(outputs.at(-1)).toBe(`loop-package cmo-seat 1.0.0 ${accepted ? 'ok' : 'refused'} errors=${accepted ? 0 : 1}`);
      expect(outputs[0]).toBe(accepted ? 'OK' : 'overlay refused: role');
      outputs.length = 0;
    }
  } finally { print.mockRestore(); process.exitCode = 0; }
});

test('② role and spawn overlay fields are refused rather than merged', () => {
  const dir = fixture(() => {}, { role: 'docs/evil.md', spawn: { max: 999 }, cadence: fasterCadence });
  const original = readLoopPackage(dir).manifest!;
  expect(mergeOverlay(original, { role: 'docs/evil.md', spawn: { max: 999 } })).toMatchObject({ refused: ['role', 'spawn'], merged: { role: original.role, spawn: original.spawn } });
  const result = verifyLoopPackage(dir);
  expect(result).toMatchObject({ ok: false, refusedOverlayFields: ['role', 'spawn'], merged: { role: original.role, spawn: original.spawn, cadence: fasterCadence } });
  expect(result.errors).toContain('overlay refused: role, spawn');
  expect(cli(dir)).toMatchObject({ status: 1, result: { ok: false, refusedOverlayFields: ['role', 'spawn'] } });
});

test('③ escaping graph reference is rejected', () => {
  const dir = fixture(manifest => { manifest.graph = '../../etc/x.yaml'; });
  const result = verifyLoopPackage(dir);
  expect(result.ok).toBe(false);
  expect(result.errors).toContain('graph path escape: ../../etc/x.yaml');
  expect(cli(dir)).toMatchObject({ status: 1, result: { ok: false, errors: expect.arrayContaining(['graph path escape: ../../etc/x.yaml']) } });
});

test('④ schema major 2 is incompatible independently of package version', () => {
  const dir = fixture(manifest => { manifest.schema = 'https://elanous.ai/schemas/loop-agent/2.0.0'; });
  const result = verifyLoopPackage(dir);
  expect(result.ok).toBe(false);
  expect(result.errors.some(error => error.includes('contract major mismatch'))).toBe(true);
  expect(cli(dir)).toMatchObject({ status: 1, result: { ok: false, errors: expect.arrayContaining([expect.stringContaining('contract major mismatch')]) } });
});

test('⑤ merged overlay must pass cross-field contract validation', () => {
  const dir = fixture(manifest => { manifest.observability.category = 'loop.other'; }, { cadence: fasterCadence });
  const result = verifyLoopPackage(dir);
  expect(result).toMatchObject({ ok: false, refusedOverlayFields: [], merged: { cadence: fasterCadence } });
  expect(result.errors).toContain('observability.category must equal loop.<id>');
  expect(cli(dir)).toMatchObject({ status: 1, result: { ok: false, errors: expect.arrayContaining(['observability.category must equal loop.<id>']) } });
});

test('example without a schema field uses the repository contract; absolute paths are refused', () => {
  const dir = fixture(manifest => { delete manifest.schema; manifest.role = '/etc/passwd'; });
  const result = verifyLoopPackage(dir);
  expect(result.ok).toBe(false);
  expect(result.errors).not.toContain('contract major mismatch');
  expect(result.errors).toContain('role path escape: /etc/passwd');
  expect(verifyLoopPackage(fixture(manifest => { manifest.role = 'C:\\secrets\\role.md'; })).errors)
    .toContain('role path escape: C:\\secrets\\role.md');
});

test('overlay grounding drops required tools and its merged result is rejected', () => {
  const dir = fixture(() => {}, { grounding: [] });
  const result = verifyLoopPackage(dir);
  expect(result.refusedOverlayFields).toEqual([]);
  expect(result.merged?.grounding).toEqual([]);
  expect(result.errors).toContain('/resolution/steps/1/grounding/0 undeclared grounding tool: omni-digest');
  expect(cli(dir)).toMatchObject({ status: 1, result: { ok: false } });
});

test('symlinked graph outside the package is refused even with an in-package name', () => {
  const dir = fixture();
  rmSync(join(dir, 'graphs/operate-loop.yaml'));
  symlinkSync('/etc/passwd', join(dir, 'graphs/operate-loop.yaml'));
  expect(verifyLoopPackage(dir).errors).toContain('graph path escape: graphs/operate-loop.yaml');
});

test('conflicting schema and $schema declarations cannot bypass the major check', () => {
  const dir = fixture(manifest => { manifest.$schema = 'https://elanous.ai/schemas/loop-agent/2.0.0'; });
  expect(verifyLoopPackage(dir).errors.some(error => error.includes('contract major mismatch'))).toBe(true);
});

test('missing role and unknown grounding tool or missing neighbor absence policy fail closed', () => {
  const dir = fixture(manifest => { manifest.grounding = ['unlisted-tool']; manifest.neighbors[0].onAbsent = undefined; });
  rmSync(join(dir, 'docs/roles/MK.md'));
  const result = verifyLoopPackage(dir);
  expect(result.ok).toBe(false);
  expect(result.errors).toContain('role file missing: docs/roles/MK.md');
  expect(result.errors.some(error => error.includes('grounding'))).toBe(true);
  expect(result.errors.some(error => error.includes('onAbsent'))).toBe(true);
});
