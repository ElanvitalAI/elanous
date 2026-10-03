import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { stringify } from 'yaml';

const root = resolve(import.meta.dir, '../..');
const temp = mkdtempSync(join(tmpdir(), 'storyboard-cli-'));
const fixtureDir = join(temp, 'site-hero');
mkdirSync(fixtureDir);
const rendered = join(root, 'docs/marketing/STORYBOARD-sb2-cli-fixture-v1.md');
afterAll(() => { rmSync(temp, { recursive: true, force: true }); rmSync(rendered, { force: true }); });

const base = {
  id: 'sb2-cli-fixture', kind: 'site-hero', title: 'SB2', version: 1, status: 'draft', owner: 'UX',
  format: { aspects: ['16:9'], duration_s: 1 }, principles: ['연출 장면'],
  shots: [{ id: 's1', t: [0, 1], stage: 'hook', purpose: '출처 검사', real_or_staged: 'staged', state: 'planned',
    on_screen_text: [{ text: '실제 문면', source: 'real-ui', ref: '화면' }] }],
};
function fixture(name: string, source: string, ref?: string): string {
  const file = join(fixtureDir, `${name}.yaml`);
  const sb = structuredClone(base);
  sb.shots[0]!.on_screen_text[0]!.source = source;
  if (ref) sb.shots[0]!.on_screen_text[0]!.ref = ref;
  else delete (sb.shots[0]!.on_screen_text[0] as { ref?: string }).ref;
  writeFileSync(file, stringify(sb));
  return file;
}
function cli(...args: string[]) {
  return spawnSync('bun', ['bin/elanous.mjs', '--test', 'storyboard', ...args], { cwd: root, encoding: 'utf8' });
}

test('real CLI rejects made-up source with JSON error and nonzero exit', () => {
  const file = fixture('error', 'made-up');
  const result = cli('lint', file, '--json');
  expect(result.status).toBe(1);
  const body = JSON.parse(result.stdout);
  expect(body.errorCount).toBe(1);
  expect(body.warningCount).toBe(0);
  expect(body.files).toHaveLength(1);
  expect(body.files[0].file).toContain('site-hero/error.yaml');
  expect(body.files[0].errors[0]).toContain('source');
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
});

test('real CLI accepts warning-only real-ui text without ref', () => {
  const file = fixture('warning', 'real-ui');
  const result = cli('lint', file, '--json');
  expect(result.status).toBe(0);
  const body = JSON.parse(result.stdout);
  expect(body.errorCount).toBe(0);
  expect(body.warningCount).toBeGreaterThanOrEqual(1);
  expect(body.files[0].warnings[0]).toContain('ref');
  const text = cli('lint', file);
  expect(text.status).toBe(0);
  expect(text.stdout).toContain(`⚠ ${body.files[0].file}:`);
  expect(text.stdout).toContain(`✓ ${body.files[0].file} · v1 · draft · 샷 1`);
});

test('real CLI accepts the repository approved v3 storyboard', () => {
  const result = cli('lint', 'storyboards/site-hero/suseuro-stage-v3.yaml', '--json');
  expect(result.status).toBe(0);
  const body = JSON.parse(result.stdout);
  expect(body.errorCount).toBe(0);
  expect(body.files).toHaveLength(1);
});

test('real CLI discovers YAML defaults except underscore files', () => {
  const result = cli('lint', '--json');
  expect(result.status).toBe(0);
  const body = JSON.parse(result.stdout);
  expect(body.files.some((f: { file: string }) => f.file.endsWith('site-hero/suseuro-stage-v3.yaml'))).toBe(true);
  expect(body.files.every((f: { file: string }) => !f.file.split('/').at(-1)?.startsWith('_'))).toBe(true);
});

test('render command writes generated MD and legacy script still lints', () => {
  const file = fixture('render', 'real-ui', '화면');
  try {
    const result = cli('render', file);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('✓ ');
    expect(readFileSync(rendered, 'utf8')).toContain('## 샷 구조표');
    const legacy = spawnSync('bun', ['scripts/storyboard/storyboard.ts', 'lint', file], { cwd: root, encoding: 'utf8' });
    expect(legacy.status).toBe(0);
    expect(legacy.stdout).toContain('✓ ');
    const legacyRender = spawnSync('bun', ['scripts/storyboard/storyboard.ts', 'render', file], { cwd: root, encoding: 'utf8' });
    expect(legacyRender.status).toBe(0);
    expect(legacyRender.stdout).toContain('→ docs/marketing/STORYBOARD-sb2-cli-fixture-v1.md');
    expect(readFileSync(rendered, 'utf8')).toContain('## 샷 구조표');
  } finally { rmSync(rendered, { force: true }); }
});

test('unrelated CLI command works when loading storyboard CLI fails, while storyboard fails', () => {
  const preload = join(temp, 'block-storyboard.ts');
  writeFileSync(preload, `Bun.plugin({
    name: 'block-storyboard-import',
    setup(build) {
      build.onLoad({ filter: /storyboard-cli\\.(ts|js)$/ }, () => {
        throw new Error('storyboard loader blocked');
      });
    },
  });\n`);
  const unrelated = spawnSync('bun', ['--preload', preload, 'bin/elanous.mjs', '--test', '--help'], { cwd: root, encoding: 'utf8' });
  expect(unrelated.status).toBe(0);
  expect(unrelated.stdout).toContain('Usage:');
  expect(unrelated.stderr).not.toContain('storyboard loader blocked');
  const storyboard = spawnSync('bun', ['--preload', preload, 'bin/elanous.mjs', '--test', 'storyboard', 'lint', 'storyboards/site-hero/suseuro-stage-v3.yaml', '--json'], { cwd: root, encoding: 'utf8' });
  expect(storyboard.status).not.toBe(0);
  expect(storyboard.stderr).toContain('storyboard loader blocked');
});

test('JSON lint reports YAML parse and read failures alongside valid files', () => {
  const malformed = join(fixtureDir, 'malformed.yaml');
  writeFileSync(malformed, 'id: [invalid\n');
  const missing = join(fixtureDir, 'missing.yaml');
  const valid = fixture('valid', 'real-ui', '화면');
  const result = cli('lint', malformed, missing, valid, '--json');
  expect(result.status).toBe(1);
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
  const body = JSON.parse(result.stdout);
  expect(body.errorCount).toBe(2);
  expect(body.warningCount).toBe(0);
  expect(body.files).toHaveLength(3);
  expect(body.files[0].errors[0]).toContain('Flow sequence');
  expect(body.files[1].errors[0]).toContain('ENOENT');
  expect(body.files[2].errors).toEqual([]);
});
