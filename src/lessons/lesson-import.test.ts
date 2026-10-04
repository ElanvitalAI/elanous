import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LessonLedger } from './lesson-ledger.js';
import { importLessons, scanLessonDocs } from './lesson-import.js';

const temp = () => realpathSync(mkdtempSync(join(tmpdir(), 'lesson-import-')));
const document = (root: string, name: string, content: string, system = false) => {
  const dir = join(root, 'docs', ...(system ? ['system'] : []));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
};

test('scan three document shapes; preview stays read-only, apply is idempotent and retains empty remedy', () => {
  const root = temp();
  const ledger = new LessonLedger({ stateDir: root });
  try {
    document(root, 'INCIDENT-shared-state-2026-10-04.md', '# INCIDENT — 공유 상태 충돌 (2026-10-04)\n\n## 1. 근본 원인\n공유 상태를 사용했다.\n\n## 2. 교훈·재발 방지\n격리한다.\n');
    document(root, 'FINDING-cause-only-2026-10-05.md', '# FINDING — 원인만 있음\n\n## 원인\n우연에 의존했다.\n', true);
    document(root, 'FINDING-empty-2026-10-06.md', '# FINDING — 절 없음\n\n본문만 있다.\n');
    const scan = scanLessonDocs(root);
    expect(scan.files).toBe(3);
    expect(scan.items).toHaveLength(2);
    expect(scan.skipped).toEqual([{ source: 'docs/FINDING-empty-2026-10-06.md', reason: 'missing cause and remedy' }]);
    const incident = scan.items.find(item => item.source === 'docs/INCIDENT-shared-state-2026-10-04.md')!;
    const finding = scan.items.find(item => item.source === 'docs/system/FINDING-cause-only-2026-10-05.md')!;
    expect(incident).toMatchObject({ incident: '공유 상태 충돌 (2026-10-04)', cause: '공유 상태를 사용했다.', remedy: '격리한다.' });
    expect(incident.id).toStartWith('shared-state-2026-10-04-');
    expect(finding).toMatchObject({ cause: '우연에 의존했다.', remedy: '' });
    expect(importLessons(ledger, scan.items, { apply: false, by: 'TC' }).written).toBe(0);
    expect(() => ledger.get(incident.id)).toThrow('lesson not found');
    expect(importLessons(ledger, scan.items, { apply: true, by: 'TC' }).written).toBe(2);
    expect(ledger.get(finding.id)).toMatchObject({ cause: '우연에 의존했다.', remedy: '', occurrence_count: 1, status: 'open' });
    const again = importLessons(ledger, scan.items, { apply: true, by: 'TC' });
    expect(again.written).toBe(0);
    expect(again.skipped).toHaveLength(2);
    expect(ledger.get(finding.id).occurrence_count).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('IDs stay stable when an earlier colliding document arrives, and source dedupes legacy IDs', () => {
  const root = temp();
  const ledger = new LessonLedger({ stateDir: root });
  try {
    const slug = 'a'.repeat(65);
    const later = `FINDING-${slug}-2026-10-05.md`;
    document(root, later, '# FINDING — 긴 제목\n\n## 원인\n원인 문단.\n');
    const initial = scanLessonDocs(root).items[0]!;
    expect(importLessons(ledger, [initial], { apply: true, by: 'TC' }).written).toBe(1);
    document(root, `FINDING-${slug}-2026-10-04.md`, '# FINDING — 다른 제목\n\n## 원인\n다른 원인.\n');
    const scanned = scanLessonDocs(root).items;
    expect(scanned.find(item => item.source === `docs/${later}`)?.id).toBe(initial.id);
    expect(new Set(scanned.map(item => item.id)).size).toBe(2);
    expect(importLessons(ledger, scanned, { apply: true, by: 'TC' }).written).toBe(1);
    expect(ledger.get(initial.id).occurrence_count).toBe(1);
    const legacy = { ...initial, id: 'legacy-source-id' };
    expect(importLessons(ledger, [legacy], { apply: true, by: 'TC' }).written).toBe(0);
    expect(() => ledger.get(legacy.id)).toThrow('lesson not found');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('manual add still requires both cause and remedy; document import accepts only one', () => {
  const root = temp();
  const ledger = new LessonLedger({ stateDir: root });
  const input = { id: 'manual', incident: '사고', cause: '원인', remedy: '', owner: 'TC', source: 'docs/FINDING-manual.md' };
  try {
    expect(() => ledger.add(input)).toThrow('remedy is required');
    expect(() => ledger.add({ ...input, cause: '', remedy: '대응' })).toThrow('cause is required');
    expect(importLessons(ledger, [input], { apply: true, by: 'TC' }).written).toBe(1);
    expect(ledger.get('manual').remedy).toBe('');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real nested SCQA and Root cause/Fix docs import, prefixed headings parse, excluded dirs and symlinks stay out', () => {
  const root = temp();
  const repo = join(import.meta.dir, '..', '..');
  const finding = 'docs/evidence/webclone-fidelity-2026-09-10/FINDING-the-mirror-does-not-cross-hosts-so-a-failed-clone-looks-perfect.md';
  const incident = 'docs/bug/INCIDENT-2026-04-23-chat-history-context-reset.md';
  try {
    for (const source of [finding, incident]) {
      const content = execFileSync('git', ['show', `HEAD:${source}`], { cwd: repo, encoding: 'utf8' });
      mkdirSync(join(root, source, '..'), { recursive: true });
      writeFileSync(join(root, source), content);
    }
    document(root, 'INCIDENT-numbered.md', '# INCIDENT — 번호\n\n## 2. 🔎 근본 원인\n번호 원인.\n\n## §2. 🛠️ Fix\n번호 처방.\n');
    document(root, 'FINDING-letters.md', '# FINDING — 문자\n\n## a. Why\n문자 원인.\n\n## ① Answer\n문자 처방.\n');
    document(root, 'FINDING-single.md', '# FINDING — 단독\n\n## C\n단독 원인.\n\n## A\n단독 처방.\n');
    document(root, 'FINDING-false-positive.md', '# FINDING — 거짓 양성\n\n## Architecture\n이 내용은 교훈이 아니다.\n\n## C-sharp\n이 내용도 원인이 아니다.\n');
    for (const dir of ['goals', 'archive']) {
      const path = join(root, 'docs', dir);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'INCIDENT-numbered.md'), '# INCIDENT — 제외\n\n## 원인\n제외 원인.\n');
    }
    symlinkSync(join(root, incident), join(root, 'docs', 'INCIDENT-linked.md'));
    symlinkSync(join(root, 'docs', 'bug'), join(root, 'docs', 'linked-directory'));
    const scan = scanLessonDocs(root);
    expect(scan.files).toBe(6);
    expect(scan.items).toHaveLength(5);
    const realFinding = scan.items.find(item => item.source === finding)!;
    const realIncident = scan.items.find(item => item.source === incident)!;
    expect(realFinding.cause).toStartWith('***rustlang 의');
    expect(realFinding.remedy).toStartWith('미러를 직접 떠 보니');
    expect(realIncident.cause).toStartWith('`ChatMessage.content` was typed');
    expect(realIncident.remedy).toStartWith('`src/chat/index.ts:1882`');
    expect(scan.items.find(item => item.source === 'docs/INCIDENT-numbered.md')).toMatchObject({ cause: '번호 원인.', remedy: '번호 처방.' });
    expect(scan.items.find(item => item.source === 'docs/FINDING-letters.md')).toMatchObject({ cause: '문자 원인.', remedy: '문자 처방.' });
    expect(scan.items.find(item => item.source === 'docs/FINDING-single.md')).toMatchObject({ cause: '단독 원인.', remedy: '단독 처방.' });
    expect(scan.skipped).toEqual([{ source: 'docs/FINDING-false-positive.md', reason: 'missing cause and remedy' }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cause and remedy heading aliases are case-insensitive and anchored after prefixes', () => {
  const root = temp();
  try {
    for (const [index, [cause, remedy]] of ([
      ['원인', '교훈'], ['근본', '재발 방지'], ['기전', '처방'], ['ROOT CAUSE', '대응'],
      ['WHY', '수리'], ['Complication', 'FIX'],
    ] as Array<[string, string]>).entries()) {
      document(root, `FINDING-alias-${index}.md`, `# FINDING — 별칭 ${index}\n\n## 1. 🔎 ${cause} 분석\n원인 ${index}.\n\n## ① ${remedy} 내용\n처방 ${index}.\n`);
    }
    const scan = scanLessonDocs(root);
    expect(scan.items).toHaveLength(6);
    for (const [index, item] of scan.items.entries()) {
      expect(item).toMatchObject({ cause: `원인 ${index}.`, remedy: `처방 ${index}.` });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('symlinked docs root is not traversed', () => {
  const root = temp();
  const target = temp();
  try {
    document(target, 'FINDING-outside.md', '# FINDING — 바깥\n\n## 원인\n바깥 원인.\n');
    symlinkSync(join(target, 'docs'), join(root, 'docs'));
    expect(scanLessonDocs(root)).toMatchObject({ files: 0, items: [], skipped: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('same filename in separate folders yields distinct stable IDs', () => {
  const root = temp();
  try {
    for (const directory of ['docs/bug', 'docs/evidence/deep']) {
      mkdirSync(join(root, directory), { recursive: true });
      writeFileSync(join(root, directory, 'FINDING-same-2026-10-04.md'), '# FINDING — 동일\n\n## 원인\n동일 원인.\n');
    }
    const scan = scanLessonDocs(root);
    expect(scan.items).toHaveLength(2);
    expect(new Set(scan.items.map(item => item.id)).size).toBe(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('tracked real INCIDENT title and cause survive scanning a copied git show document', () => {
  const root = temp();
  const repo = join(import.meta.dir, '..', '..');
  try {
    const source = execFileSync('git', ['ls-files', 'docs/INCIDENT-*.md'], { cwd: repo, encoding: 'utf8' }).trim().split('\n')[0]!;
    const content = execFileSync('git', ['show', `HEAD:${source}`], { cwd: repo, encoding: 'utf8' });
    document(root, source.split('/').at(-1)!, content);
    const title = content.split(/\r?\n/).find(line => /^# INCIDENT\s*[—–-]/.test(line))!;
    const scan = scanLessonDocs(root);
    expect(scan.items).toHaveLength(1);
    expect(scan.items[0]?.incident).toBe(title.replace(/^#\s*INCIDENT\s*[—–-]\s*/, '').trim());
    expect(scan.items[0]?.cause.length).toBeGreaterThan(0);
    expect(readFileSync(join(root, source), 'utf8')).toBe(content);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
