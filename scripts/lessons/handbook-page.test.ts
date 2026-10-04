import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LessonLedger } from '../../src/lessons/lesson-ledger.js';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';

const root = () => mkdtempSync(join(tmpdir(), 'handbook-lessons-'));
const script = join(import.meta.dir, 'handbook-page.ts');
const run = (...args: string[]) => spawnSync('bun', [script, ...args], { encoding: 'utf8', timeout: 30_000 });
const add = (ledger: LessonLedger, id: string, extra: { enforcedBy?: string; disproof?: string } = {}) =>
  ledger.add({ id, incident: `사고 ${id}`, cause: '공유 상태', remedy: '상태를 격리한다', owner: 'MK', source: `PR#${id}`, ...extra });

test('renders ordered sections, status counts, unenforced count, disproof and last occurrence', () => {
  const stateDir = root();
  const out = join(stateDir, 'custom.md');
  const ledger = new LessonLedger({ stateDir, now: () => new Date('2026-10-05T00:00:00Z') });
  try {
    add(ledger, 'candidate', { disproof: 'bun test src/lessons/lesson-ledger.test.ts' });
    ledger.recur('candidate', { source: 'PR#again', by: 'MK' });
    add(ledger, 'open');
    add(ledger, 'enforced', { enforcedBy: '.rules/check.md' });
    add(ledger, 'promoted', { disproof: 'bun test scripts/lessons/handbook-page.test.ts' });
    ledger.promote('promoted', { rulePath: '.rules/promoted.md', by: 'MK' });
    const result = run('--state-dir', stateDir, '--out', out, '--json');
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ total: 4, byStatus: { candidate: 1, open: 1, enforced: 1, promoted: 1 }, unenforced: 1, out });
    const page = readFileSync(out, 'utf8');
    expect(page).toContain('# 교훈');
    expect(page).toContain('생성 시각:');
    expect(page).toContain('(KST)');
    expect(page).toContain('총 4 · candidate 1 · open 1 · enforced 1 · promoted 1 · 강제 자리 없음 1');
    const headings = ['## 승격 후보', '## 강제 자리 없음', '## 강제됨', '## 규칙으로 승격됨'];
    const positions = headings.map(heading => page.indexOf(heading));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    for (const [index, id] of ['candidate', 'open', 'enforced', 'promoted'].entries()) {
      const end = positions[index + 1] ?? page.length;
      expect(page.slice(positions[index], end)).toContain(`### ${id} — 사고 ${id}`);
    }
    expect(page).toContain('반증: bun test src/lessons/lesson-ledger.test.ts');
    expect(page).toContain('재발: 2회');
    expect(page).toContain('마지막 발생: 2026-10-05T00:00:00.000Z · 출처: PR#again');
    expect(page).toContain('강제 자리: .rules/check.md');
    expect(page).toContain('강제 자리: .rules/promoted.md');
    expect(page).toContain('원인: 공유 상태');
    expect(page).toContain('처방: 상태를 격리한다');
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('ledger text cannot inject sections, links, or HTML into the handbook', () => {
  const stateDir = root();
  const ledger = new LessonLedger({ stateDir });
  try {
    ledger.add({
      id: 'unsafe',
      incident: '사고\n## 강제됨\n<script>alert(1)</script>',
      cause: '원인\n## 규칙으로 승격됨\n[클릭](https://example.com) 일반 URL https://example.com 및 www.example.com',
      remedy: '처방\n## 승격 후보\n**가짜 강조**',
      owner: 'MK',
      source: 'PR#1\n## 강제 자리 없음',
      disproof: 'bun test\n## 강제됨',
    });
    ledger.recur('unsafe', { source: 'PR#2\n## 규칙으로 승격됨', by: 'MK' });
    ledger.add({
      id: 'enforced-unsafe', incident: '강제됨', cause: '원인', remedy: '처방',
      owner: 'MK', source: 'PR#3', enforcedBy: '.rules/check.md\n## 승격 후보',
    });
    const result = run('--state-dir', stateDir, '--json');
    expect(result.status, result.stderr).toBe(0);
    const page = readFileSync(join(stateDir, 'lessons', 'handbook-lessons.md'), 'utf8');
    expect(page.match(/^## .+$/gm)).toEqual(['## 승격 후보', '## 강제 자리 없음', '## 강제됨', '## 규칙으로 승격됨']);
    expect(page).not.toContain('<script>');
    expect(page).not.toContain('[클릭](https://example.com)');
    expect(page).not.toContain('**가짜 강조**');
    expect(page).toContain('사고 ## 강제됨');
    expect(page).toContain('출처: PR#2 ## 규칙으로 승격됨');
    expect(page).toContain('강제 자리: .rules/check.md ## 승격 후보');
    const html = String(unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(rehypeStringify).processSync(page));
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('<script>');
    expect(html).toContain('example.com');
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('candidate without disproof is marked unable to promote', () => {
  const stateDir = root();
  try {
    const ledger = new LessonLedger({ stateDir });
    add(ledger, 'candidate');
    ledger.recur('candidate', { source: 'PR#again', by: 'MK' });
    const result = run('--state-dir', stateDir);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(stateDir, 'lessons', 'handbook-lessons.md'), 'utf8')).toContain('반증 없음 — 승격 불가');
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('empty ledger skips without writing a page', () => {
  const stateDir = root();
  try {
    const result = run('--state-dir', stateDir, '--json');
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ skipped: 'empty-ledger' });
    expect(existsSync(join(stateDir, 'lessons', 'handbook-lessons.md'))).toBe(false);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('file instead of state directory reports an error and exits 1', () => {
  const stateDir = root();
  try {
    const file = join(stateDir, 'not-a-directory');
    writeFileSync(file, 'occupied');
    const result = run('--state-dir', file, '--json');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('handbook-page:');
    expect(result.stdout).not.toContain('empty-ledger');
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
