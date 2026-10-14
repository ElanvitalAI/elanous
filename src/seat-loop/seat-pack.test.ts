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

test.each([`ghp_${'C'.repeat(24)}`, `github_pat_${'D'.repeat(24)}_${'E'.repeat(24)}`])('KNOWHOW token outside cards cannot be exported even though the generic pack scan does not recognize it', (token) => {
  const { root, out, write } = fixture();
  write('docs/roles/FAKE/KNOWHOW.md', `# Fake knowhow\n${token}\n`);
  try {
    exportSeatPack('FAKE', out, root);
    throw new Error('token was exported');
  } catch (error) {
    expect(error).toHaveProperty('name', 'KnowhowLintError');
    expect(String(error)).toContain('비밀 표식 (github token)');
    expect(String(error)).not.toContain(token);
  }
  expect(existsSync(out)).toBe(false);
});

test.each([
  ['빈 필수 칸', '기대', ''],
  ['빈 결합 상태', '출처', 'OBS-T900 · 상태:'],
  ['결합 상태만 있는 빈 출처', '출처', '· 상태: active'],
  ['쓰기 측정 명령', '재는 명령', 'rm -rf out'],
  ['중복 빈 필수 칸', '기대', ''],
])('KNOWHOW %s is rejected before export writes output', (_case, field, value) => {
  const { root, out, write } = fixture();
  const fields: Record<string, string> = {
    '상황': '상황 설명', '신호(관측)': '관측 설명', '원인': '원인 설명',
    '처방': '처방 설명', '재는 명령': 'git status', '기대': '기대 결과',
    '유효 조건': '유효 조건 설명', '검증': '검증 결과', '출처': 'OBS-T900 · 상태: active',
  };
  fields[field] = value;
  const lines = Object.entries(fields).map(([key, entry]) => `- ${key}: ${entry}`);
  if (_case === '중복 빈 필수 칸') lines.push('- 기대: 뒤에서 채운 값');
  write('docs/roles/FAKE/KNOWHOW.md', `# Fake knowhow\n\n## K-FAKE-1: 관측\n${lines.join('\n')}\n`);
  expect(() => exportSeatPack('FAKE', out, root)).toThrow(expect.objectContaining({ name: 'KnowhowLintError' }));
  expect(existsSync(out)).toBe(false);
});

test('KNOWHOW project key is rejected before export writes output', () => {
  const { root, out, write } = fixture();
  write('docs/roles/FAKE/KNOWHOW.md', `# Fake knowhow\n\nsk-proj-${'a'.repeat(24)}\n`);
  expect(() => exportSeatPack('FAKE', out, root)).toThrow('비밀 표식 (api key)');
  expect(existsSync(out)).toBe(false);
});

test('valid KNOWHOW card is included in a successful seat export', () => {
  const { root, out, write } = fixture();
  const card = [
    '# Fake knowhow', '', '## K-FAKE-1: 관측',
    '- 상황: 게이트가 노랗다', '- 신호(관측): checklist status 에 노랑 표시',
    '- 원인: 증거가 없다', '- 처방: 증거를 모은다', '- 재는 명령: git status',
    '- 기대: 노랑 원인 표시', '- 유효 조건: 이번 판', '- 검증: 실측',
    '- 출처: OBS-T900 · 상태: active', '',
  ].join('\n');
  write('docs/roles/FAKE/KNOWHOW.md', card);
  const manifest = exportSeatPack('FAKE', out, root);
  expect(manifest.files.some((file) => file.path === 'docs/roles/FAKE/KNOWHOW.md')).toBe(true);
  expect(readFileSync(join(out, 'docs/roles/FAKE/KNOWHOW.md'), 'utf8')).toBe(card);
});

test('indented second KNOWHOW card with missing fields blocks seat export', () => {
  const { root, out, write } = fixture();
  const first = [
    '# Fake knowhow', '', '## K-FAKE-1: 관측',
    '- 상황: 게이트', '- 신호(관측): 노랑', '- 원인: 증거 부족', '- 처방: 증거 수집',
    '- 재는 명령: git status', '- 기대: 노랑 원인', '- 유효 조건: 이번 판',
    '- 검증: 실측', '- 출처: OBS-T900 · 상태: active', '',
  ].join('\n');
  write('docs/roles/FAKE/KNOWHOW.md', `${first}\n  ## K-FAKE-2: 빈 카드\n- 상황: 새 카드\n`);
  expect(() => exportSeatPack('FAKE', out, root)).toThrow('K-FAKE-2 — 필수 칸 누락: 신호');
  expect(existsSync(out)).toBe(false);
});

test('fenced example cannot fill a missing KNOWHOW field during export', () => {
  const { root, out, write } = fixture();
  const lines = [
    '# Fake knowhow', '', '## K-FAKE-1: 관측',
    '- 상황: 게이트', '- 신호(관측): 노랑', '- 원인: 증거 부족', '- 처방: 증거 수집',
    '- 재는 명령: git status', '- 기대: 노랑 원인', '- 유효 조건: 이번 판',
    '```md', '```md', '- 검증: 통과', '```', '- 출처: OBS-T900 · 상태: active', '',
  ];
  write('docs/roles/FAKE/KNOWHOW.md', lines.join('\n'));
  expect(() => exportSeatPack('FAKE', out, root)).toThrow('필수 칸 누락: 검증');
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
