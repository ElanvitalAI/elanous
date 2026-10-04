import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { exportSeatPack, SeatPackLeakError, type SeatPackManifest } from './seat-pack.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'seat-pack-'));
  dirs.push(root);
  const write = (name: string, body: string) => {
    const path = join(root, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
  };
  write('package.json', JSON.stringify({ version: '0.2.12' }));
  write('docs/roles/FAKE.md', '# Fake seat\n\n`graphs/fake/seat.yaml`\n');
  write('docs/roles/FAKE/child.md', '| A1 | Contract |\n|---|---|\n| 판정선 | A verified outcome. |\n');
  write('graphs/fake/seat.yaml', 'id: fake-seat\n');
  write('graphs/other.yaml', 'id: other\n');
  return { root, out: join(root, 'out'), write };
}

test('fake seat pack includes its charters, referenced graph, verdicts and default budget with matching sha256', () => {
  const { root, out } = fixture();
  const result = exportSeatPack('FAKE', out, root);
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as SeatPackManifest;
  expect(manifest).toEqual(result);
  expect(manifest.name).toBe('FAKE');
  expect(manifest.version).toBe('0.2.12');
  expect(manifest.files.map((file) => file.path)).toEqual([
    'budget.json', 'docs/roles/FAKE.md', 'docs/roles/FAKE/child.md', 'graphs/fake/seat.yaml', 'verdicts.json',
  ]);
  for (const file of manifest.files) {
    expect(file.sha256).toBe(createHash('sha256').update(readFileSync(join(out, file.path))).digest('hex'));
  }
  expect(JSON.parse(readFileSync(join(out, 'budget.json'), 'utf8'))).toEqual({ dailyGoals: 6, concurrentPods: 2 });
  expect(JSON.parse(readFileSync(join(out, 'verdicts.json'), 'utf8'))).toEqual([
    { source: 'docs/roles/FAKE/child.md', text: 'A verified outcome.' },
  ]);
  expect(existsSync(join(out, 'graphs/other.yaml'))).toBe(false);
  expect(() => exportSeatPack('FAKE', out, root)).toThrow('output must be an empty directory');
  expect(() => exportSeatPack('../FAKE', join(root, 'unsafe'), root)).toThrow('invalid seat');
  expect(readdirSync(out)).toContain('manifest.json');
});

test('removing the charter reference does not drop the seat\'s own graph folder', () => {
  const { root, out, write } = fixture();
  write('docs/roles/FAKE.md', '# Fake seat\n');
  exportSeatPack('FAKE', out, root);
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as SeatPackManifest;
  expect(manifest.files.map((file) => file.path)).toEqual([
    'budget.json', 'docs/roles/FAKE.md', 'docs/roles/FAKE/child.md', 'graphs/fake/seat.yaml', 'verdicts.json',
  ]);
  expect(existsSync(join(out, 'graphs/fake/seat.yaml'))).toBe(true);
  expect(existsSync(join(out, 'graphs/other.yaml'))).toBe(false);
});

test('seat gate section is included in verdicts when no 판정선 table exists', () => {
  const { root, out, write } = fixture();
  write('docs/roles/FAKE/child.md', '## 2. 관문 (before export)\n- Do not publish before approval.\n\n## 3. 절차\n- Not a gate.\n');
  exportSeatPack('FAKE', out, root);
  expect(JSON.parse(readFileSync(join(out, 'verdicts.json'), 'utf8'))).toEqual([
    { source: 'docs/roles/FAKE/child.md', text: 'Do not publish before approval.' },
  ]);
});

test.each([
  ['crown', `${String.fromCodePoint(0x1f451)} private decision`],
  ['track', '**[TC]** private track'],
  ['plain track', '[TC] private track'],
  ['path', '/Users/secret/Documents'],
  ['account', `owner: ${userInfo().username}`],
])('leak gate rejects %s with file and line before writing', (_kind, text) => {
  const { root, out, write } = fixture();
  write('docs/roles/FAKE/child.md', `safe\n${text}\n| 판정선 | A verified outcome. |\n`);
  expect(() => exportSeatPack('FAKE', out, root)).toThrow(SeatPackLeakError);
  try { exportSeatPack('FAKE', out, root); } catch (error) {
    expect(String(error)).toContain('docs/roles/FAKE/child.md:2:');
  }
  expect(existsSync(out)).toBe(false);
});

test('leak gate scans referenced graphs before creating output', () => {
  const { root, out, write } = fixture();
  write('graphs/fake/seat.yaml', 'id: fake-seat\nsecret: /Users/private/Documents\n');
  expect(() => exportSeatPack('FAKE', out, root)).toThrow(SeatPackLeakError);
  try { exportSeatPack('FAKE', out, root); } catch (error) {
    expect(String(error)).toContain('graphs/fake/seat.yaml:2: public leak (absolute user path)');
  }
  expect(existsSync(out)).toBe(false);
});

test('extra account marker is also checked without replacing the actual account name', () => {
  const { root, out, write } = fixture();
  const marker = `${userInfo().username}-different`;
  const previous = process.env.ELANOUS_LEAK_HOME_USER;
  write('docs/roles/FAKE/child.md', `safe\nowner: ${marker}\n| 판정선 | A verified outcome. |\n`);
  process.env.ELANOUS_LEAK_HOME_USER = marker;
  try {
    expect(() => exportSeatPack('FAKE', out, root)).toThrow(SeatPackLeakError);
    expect(existsSync(out)).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_LEAK_HOME_USER;
    else process.env.ELANOUS_LEAK_HOME_USER = previous;
  }
});

test('actual account name is rejected even when the extra leak marker differs', () => {
  const { root, out, write } = fixture();
  const actualUsername = userInfo().username;
  const previous = process.env.ELANOUS_LEAK_HOME_USER;
  write('docs/roles/FAKE/child.md', `safe\nowner: ${actualUsername}\n| 판정선 | A verified outcome. |\n`);
  process.env.ELANOUS_LEAK_HOME_USER = `${actualUsername}-different`;
  try {
    expect(actualUsername).not.toBe(process.env.ELANOUS_LEAK_HOME_USER);
    expect(() => exportSeatPack('FAKE', out, root)).toThrow(SeatPackLeakError);
    try { exportSeatPack('FAKE', out, root); } catch (error) {
      expect(String(error)).toContain('docs/roles/FAKE/child.md:2: public leak (account name)');
    }
    expect(existsSync(out)).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_LEAK_HOME_USER;
    else process.env.ELANOUS_LEAK_HOME_USER = previous;
  }
});
