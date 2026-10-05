import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaimsLedger } from '../../src/claims/claims-ledger.js';
import { debug } from '../../src/debug/log.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../../src/elanous-config-dir.js';
import { addItem, setItem } from '../../src/release-loop/checklist.js';
import { listSeatRequests } from '../../src/seat-dispatch/seat-request-ledger.js';
import { draftReleaseStory, runReleaseStory } from './draft.js';

const version = '9.8.7';
const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'release-story-'));
  dirs.push(dir);
  setElanousConfigDir(dir);
  const nextPath = join(dir, 'next.md');
  const outDir = join(dir, 'story');
  const manualRoot = join(dir, 'docs/manual');
  mkdirSync(manualRoot, { recursive: true });
  return { dir, nextPath, outDir, manualRoot, version, checklistRoot: dir, stateDir: dir };
}
afterEach(() => {
  resetElanousConfigDir();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function green(id: string, title: string, status: 'green' | 'done' = 'green') {
  addItem(version, { id, title });
  setItem(version, id, { status }, 'MK');
}

test('two user lines, two green cells, one manual candidate and one linked verified claim produce three drafts', () => {
  const options = fixture();
  writeFileSync(options.nextPath, '# Next\n## Internal\n- internal note\n## Feat\n- 새로운 검색\n- 쉬운 공유\n');
  green('STORY_A', '검색 개선 — 세부', 'green');
  green('STORY_B', '공유 개선 · 세부', 'done');
  addItem(version, { id: 'STORY_YELLOW', title: '아직' });
  writeFileSync(join(options.manualRoot, 'guide.md'), 'STORY_A 안내\n');
  const ledger = new ClaimsLedger({ stateDir: options.dir });
  ledger.add({ id: 'C1', claim: '검색이 더 쉽습니다.', audience: 'personal', owner: 'MK' });
  ledger.verify('C1', { value: 'yes', command: 'measure', measuredAt: new Date().toISOString(), validUntil: new Date(Date.now() + 86400000).toISOString(), by: 'MK' });
  ledger.link('C1', { cell: 'STORY_A', version });
  ledger.add({ id: 'C2', claim: '다른 판의 주장입니다.', audience: 'personal', owner: 'MK' });
  ledger.verify('C2', { value: 'yes', command: 'measure', measuredAt: new Date().toISOString(), validUntil: new Date(Date.now() + 86400000).toISOString(), by: 'MK' });
  ledger.link('C2', { cell: 'STORY_A', version: '9.8.6' });
  ledger.add({ id: 'C3', claim: '아직 공개되지 않은 칸의 주장입니다.', audience: 'personal', owner: 'MK' });
  ledger.verify('C3', { value: 'yes', command: 'measure', measuredAt: new Date().toISOString(), validUntil: new Date(Date.now() + 86400000).toISOString(), by: 'MK' });
  ledger.link('C3', { cell: 'STORY_YELLOW', version });
  const events: unknown[] = [];
  const spy = spyOn(debug, 'log').mockImplementation((category, event, data) => { if (category === 'release.story') events.push({ event, data }); });
  try {
    const result = draftReleaseStory(options);
    expect(result).toMatchObject({ status: 'drafted', userLines: 2, greenCells: 2, claims: 1, manualCandidates: 1, files: [
      join(options.outDir, 'announcement.md'), join(options.outDir, 'site-news.md'), join(options.outDir, 'manual-candidates.md'),
    ] });
    expect(events).toContainEqual({ event: 'drafted', data: { version, userLines: 2, internalDropped: 1, greenCells: 2, claims: 1, manualCandidates: 1, brandFindings: result.brandFindings } });
    const announcement = readFileSync(result.files[0]!, 'utf8');
    expect(announcement).toContain('새로운 검색');
    expect(announcement).toContain('쉬운 공유');
    expect(announcement).toContain('검색 개선');
    expect(announcement).toContain('공유 개선');
    expect(announcement).toContain('검색이 더 쉽습니다.');
    expect(announcement).not.toContain('internal note');
    expect(announcement).not.toContain('다른 판의 주장입니다.');
    expect(announcement).not.toContain('아직 공개되지 않은 칸의 주장입니다.');
    const news = readFileSync(result.files[1]!, 'utf8');
    expect(news).toContain(`Release: ${version}`);
    expect(news).toContain(`# What's new in ${version}`);
    expect(news).not.toContain('검색 개선');
    expect(news.split('\n').filter((line) => line.startsWith('- ')).length).toBeLessThanOrEqual(3);
    expect(readFileSync(result.files[2]!, 'utf8')).toContain('STORY_B · 공유 개선 · 매뉴얼 언급 없음');
    expect(readFileSync(result.files[2]!, 'utf8')).not.toContain('STORY_A ·');
  } finally { spy.mockRestore(); }
});

test('successful release story delivers three files and one MK request per version, including retries', () => {
  const options = fixture();
  writeFileSync(options.nextPath, '# Next\n## Feat\n- Search is faster\n');
  green('STORY_RELEASE', '검색 개선');
  const context = { input: { version, previousVersion: '9.8.6' }, outputs: { publish: { outcome: 'ok' }, verify: { outcome: 'ok' } } };
  const draft = () => draftReleaseStory(options);
  expect(runReleaseStory(context, draft)).toMatchObject({ outcome: 'ok', status: 'drafted', files: [
    join(options.outDir, 'announcement.md'), join(options.outDir, 'site-news.md'), join(options.outDir, 'manual-candidates.md'),
  ] });
  expect(readFileSync(join(options.outDir, 'announcement.md'), 'utf8')).toContain('검색 개선');
  expect(readFileSync(join(options.outDir, 'site-news.md'), 'utf8')).toContain('Search is faster');
  expect(readFileSync(join(options.outDir, 'manual-candidates.md'), 'utf8')).toContain('STORY_RELEASE');
  expect(runReleaseStory(context, draft).outcome).toBe('ok');
  const requests = readFileSync(join(options.dir, 'seat-requests', 'requests.jsonl'), 'utf8').trim().split('\n');
  expect(requests).toHaveLength(1);
  expect(listSeatRequests(options.dir, { seat: 'MK' })).toMatchObject([{ key: `release-story:${version}`, seat: 'MK',
    source: 'release-story', version, status: 'pending', text: `${version} 공지 초안 준비됨: ${options.outDir}` }]);
});

test('draft failure is observed without queuing an MK request', () => {
  const options = fixture();
  writeFileSync(options.nextPath, '# Next\n## Feat\n- Search is faster\n');
  const context = { input: { version, previousVersion: '9.8.6' }, outputs: { publish: { outcome: 'ok' }, verify: { outcome: 'ok' } } };
  const logged = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    expect(runReleaseStory(context, () => { throw new Error('injected generator failure'); })).toMatchObject({ outcome: 'fail', reason: 'injected generator failure' });
    expect(logged).toHaveBeenCalledWith('release.story', 'draft-failed', { version, reason: 'injected generator failure' });
    expect(readdirSync(options.dir)).not.toContain('seat-requests');
    expect(runReleaseStory({ ...context, outputs: { ...context.outputs, publish: { outcome: 'fail' } }, }, () => { throw new Error('should not draft'); }).outcome).toBe('fail');
  } finally { logged.mockRestore(); }
});

test('brand finding stays at the top of the offending draft without blocking generation', () => {
  const options = fixture();
  writeFileSync(options.nextPath, '# Next\n## Feat\n- available now for readers\n');
  green('BRAND_CELL', 'available now — 설명');
  const result = draftReleaseStory(options);
  expect(result.files).toHaveLength(3);
  expect(result.brandFindings).toBeGreaterThan(0);
  expect(readFileSync(join(options.outDir, 'announcement.md'), 'utf8')).toStartWith('> ⚠ 브랜드 규칙: B2 «available now»\n');
  expect(readFileSync(join(options.outDir, 'site-news.md'), 'utf8')).toMatch(/^> ⚠ 브랜드 규칙: [^\n]+\n(?:> ⚠ 브랜드 규칙: [^\n]+\n)*\n# /);
  expect(readFileSync(join(options.outDir, 'site-news.md'), 'utf8')).toContain('> ⚠ 브랜드 규칙: B2 «available now»');
});

test('missing brand rules mark every release story draft and the returned result unmeasured with zero brand passes', () => {
  const options = fixture();
  writeFileSync(options.nextPath, '# Next\n## Feat\n- A better search\n');
  const missing = join(options.dir, 'absent-rules.yaml');
  const result = draftReleaseStory({ ...options, rulesPath: missing });
  expect(result.brandUnmeasured).toBe('규칙 없음 — 측정 불가');
  expect(result.brandFindings).toBe(0);
  expect(result.files).toHaveLength(3);
  for (const file of result.files) expect(readFileSync(file, 'utf8')).toStartWith('> ⚠ 규칙 없음 — 측정 불가\n\n');
  const measured = draftReleaseStory(options);
  expect(measured.brandUnmeasured).toBeUndefined();
  expect(measured.brandFindings).toBe(0);
  for (const file of measured.files) expect(readFileSync(file, 'utf8')).not.toContain('규칙 없음 — 측정 불가');
});

test('empty public input and zero green cells skip all files', () => {
  const options = fixture();
  writeFileSync(options.nextPath, '# Next\n## Internal\n- internal only\n');
  addItem(version, { id: 'PENDING', title: '대기' });
  const events: unknown[] = [];
  const spy = spyOn(debug, 'log').mockImplementation((category, event, data) => { if (category === 'release.story') events.push({ event, data }); });
  try {
    expect(draftReleaseStory(options)).toMatchObject({ status: 'skipped: no-user-facing-change', files: [] });
    expect(events).toContainEqual({ event: 'skipped', data: { version, userLines: 0, internalDropped: 1, greenCells: 0, claims: 0, manualCandidates: 0, brandFindings: 0 } });
    expect(readdirSync(options.dir)).not.toContain('story');
    expect(readdirSync(options.dir)).not.toContain('claims');
  } finally { spy.mockRestore(); }
});

test('a public paragraph without bullets or green cells produces drafts instead of skipping', () => {
  const options = fixture();
  writeFileSync(options.nextPath, '# Next\n## Internal\nInternal paragraph must stay hidden.\n## Feat\n검색 결과를 더 쉽게 찾을 수 있습니다.\n');
  const result = draftReleaseStory(options);
  expect(result).toMatchObject({ status: 'drafted', userLines: 1, greenCells: 0 });
  expect(result.files).toHaveLength(3);
  expect(readFileSync(join(options.outDir, 'announcement.md'), 'utf8')).toContain('- 검색 결과를 더 쉽게 찾을 수 있습니다.');
  expect(readFileSync(join(options.outDir, 'announcement.md'), 'utf8')).not.toContain('Internal paragraph must stay hidden.');
  expect(readFileSync(join(options.outDir, 'site-news.md'), 'utf8')).toContain('- 검색 결과를 더 쉽게 찾을 수 있습니다.');
});

test('one user-facing line without green cells still produces drafts', () => {
  const options = fixture();
  writeFileSync(options.nextPath, '# Next\n## Feat\n- 읽기 개선\n');
  const result = draftReleaseStory(options);
  expect(result.status).toBe('drafted');
  expect(result.userLines).toBe(1);
  expect(result.greenCells).toBe(0);
  expect(result.files).toHaveLength(3);
});

test('unopenable claim state directory is distinguished from zero linked claims', () => {
  const options = fixture();
  writeFileSync(options.nextPath, '# Next\n## Feat\n- 안내 개선\n');
  green('DOCS1', '안내 개선');
  const nonDirectory = join(options.dir, 'not-a-directory');
  writeFileSync(nonDirectory, 'file');
  const result = draftReleaseStory({ ...options, stateDir: nonDirectory });
  expect(result.claims).toBe(0);
  expect(readFileSync(join(options.outDir, 'announcement.md'), 'utf8')).toContain('근거: 소구점 원장 못 읽음(');
});

test('real release/next.md produces clean drafts in an isolated checklist, ledger and output', () => {
  const options = fixture();
  const realNext = join(import.meta.dir, '../../release/next.md');
  green('OUTBOUND', '/v1/outbound 가 «delivered» 를 기록: 사용자에게 전달 — 내부 설명');
  const ledger = new ClaimsLedger({ stateDir: options.dir });
  ledger.add({ id: 'REAL_STORY', claim: 'Verified release detail.', audience: 'personal', owner: 'MK' });
  ledger.verify('REAL_STORY', { value: 'yes', command: 'measure', measuredAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 86400000).toISOString(), by: 'MK' });
  ledger.link('REAL_STORY', { cell: 'OUTBOUND', version });
  const events: unknown[] = [];
  const spy = spyOn(debug, 'log').mockImplementation((category, event, data) => { if (category === 'release.story') events.push({ event, data }); });
  try {
    const result = draftReleaseStory({ ...options, nextPath: realNext });
    const announcement = readFileSync(join(options.outDir, 'announcement.md'), 'utf8');
    const news = readFileSync(join(options.outDir, 'site-news.md'), 'utf8');
    for (const text of [announcement, news]) {
      expect(text).not.toMatch(/^\s*-\s*internal\b/im);
      expect(text).not.toContain('Target: next');
    }
    expect(announcement).toContain('- /v1/outbound 가 «delivered» 를 기록');
    expect(announcement).toContain('Verified release detail.');
    expect(announcement).not.toContain('«delivered\n');
    expect(announcement).not.toContain('- feat —');
    expect(announcement).not.toContain('- fix —');
    expect(news).toContain(`# What's new in ${version}`);
    expect(news).toContain(`Release: ${version}`);
    expect(news).not.toContain('⚠ 브랜드 규칙: B11');
    expect(news).not.toContain('가 «delivered»');
    const realMarkdown = readFileSync(realNext, 'utf8');
    const internalSection = /(?:^|\n)## Internal[ \t]*\n([\s\S]*?)(?=\n## |$)/.exec(realMarkdown)?.[1]?.trim();
    if (internalSection) {
      for (const line of internalSection.split('\n').filter((line) => line.trim())) {
        expect(announcement).not.toContain(line);
        expect(news).not.toContain(line);
      }
      expect(result.internalDropped).toBeGreaterThan(0);
    } else {
      expect(result.internalDropped).toBe(0);
    }
    expect(events).toContainEqual({ event: 'drafted', data: { version, userLines: result.userLines, internalDropped: result.internalDropped,
      greenCells: result.greenCells, claims: result.claims, manualCandidates: result.manualCandidates, brandFindings: result.brandFindings } });
  } finally { spy.mockRestore(); }
});

test('internal prefixes and trailing metadata are removed before drafting', () => {
  const options = fixture();
  writeFileSync(options.nextPath, '# Next\n## Fix\n- Internal: hidden\n- internal - also hidden\n- internal — not public\n- fix — visible. "Documentation: none. Target: next."\n- feat — another change. "Target: next."\n');
  const result = draftReleaseStory(options);
  expect(result).toMatchObject({ internalDropped: 3, userLines: 2 });
  const announcement = readFileSync(join(options.outDir, 'announcement.md'), 'utf8');
  const news = readFileSync(join(options.outDir, 'site-news.md'), 'utf8');
  for (const text of [announcement, news]) {
    expect(text).toContain('- visible.');
    expect(text).toContain('- another change.');
    expect(text).not.toMatch(/^\s*-\s*internal\b/im);
    expect(text).not.toContain('Documentation:');
    expect(text).not.toContain('Target: next');
    expect(text).not.toContain('"\n');
  }
});

test('first phrase keeps delimiters inside paired quotes', () => {
  const options = fixture();
  writeFileSync(options.nextPath, '# Next\n## Feat\n- visible\n');
  green('QUOTES', '/v1/outbound 가 «delivered: now — safe» 와 "ready: yes — ok" 및 `done: yes — ok` 를 보여 준다: details');
  const result = draftReleaseStory(options);
  expect(readFileSync(result.files[0]!, 'utf8')).toContain('- /v1/outbound 가 «delivered: now — safe» 와 "ready: yes — ok" 및 `done: yes — ok` 를 보여 준다');
});

test('English checklist titles remain in site news while Korean checklist titles stay in announcement', () => {
  const options = fixture();
  writeFileSync(options.nextPath, '# Next\n## Feat\n- public item\n');
  green('ENGLISH', 'English improvement — details');
  green('KOREAN', '한국어 칸 제목 — 세부');
  const result = draftReleaseStory(options);
  const announcement = readFileSync(result.files[0]!, 'utf8');
  const news = readFileSync(result.files[1]!, 'utf8');
  expect(announcement).toContain('- 한국어 칸 제목');
  expect(news).toContain('- English improvement');
  expect(news).not.toContain('한국어 칸 제목');
  expect(news).not.toContain('⚠ 브랜드 규칙: B11');
});

test('first phrase never leaves an unmatched opening guillemet', () => {
  const options = fixture();
  writeFileSync(options.nextPath, '# Next\n## Feat\n- visible\n');
  green('UNMATCHED', '/v1/outbound 가 «delivered: details');
  const result = draftReleaseStory(options);
  const announcement = readFileSync(result.files[0]!, 'utf8');
  expect(announcement).toContain('- /v1/outbound 가 delivered: details');
  expect(announcement).not.toContain('«delivered');
});

test('CLI --version --next --out --json uses isolated inputs and outputs', () => {
  const options = fixture();
  writeFileSync(options.nextPath, '# Next\n## Feat\n- 읽기 개선\n');
  green('CLI_GREEN', '읽기 개선 — 공개');
  const child = Bun.spawnSync(['bun', join(import.meta.dir, 'draft.ts'), '--version', version, '--next', options.nextPath, '--out', options.outDir, '--json'], {
    cwd: join(import.meta.dir, '../..'), env: { ...process.env, ELANOUS_STATE_DIR: options.dir }, stdout: 'pipe', stderr: 'pipe',
  });
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toMatchObject({ status: 'drafted', userLines: 1, greenCells: 1, manualCandidates: 1, files: [
    join(options.outDir, 'announcement.md'), join(options.outDir, 'site-news.md'), join(options.outDir, 'manual-candidates.md'),
  ] });
  expect(readdirSync(options.outDir)).toHaveLength(3);
  expect(readdirSync(options.dir)).not.toContain('seat-requests');
});
