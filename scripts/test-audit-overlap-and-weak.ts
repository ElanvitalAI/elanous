// K10 D5b — ① 커버리지 겹침(고유 기여) ② 은퇴 기능 시험 ③ 약한 단언. 읽기 전용.
// 사용: bun test-audit-b.ts <repo> <cov-root|-> <out-dir>
//   cov-root = 파일별 lcov 폴더(<n>/lcov.info) ⊕ index.tsv(file n rc secs). '-' 면 ①을 건너뛴다.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [repo, covRoot, out] = process.argv.slice(2);
const files = execFileSync('git', ['ls-files', '*.test.ts', '*.test.tsx'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);

// ③ 약한 단언 — 파일마다 매처 종류를 센다(줄이 아니라 출현 수).
const WEAK = new Set(['toBeDefined', 'toBeTruthy', 'toBeFalsy', 'not.toThrow', 'toBeInstanceOf', 'not.toBeNull', 'not.toBeUndefined']);
const weakRows: string[] = ['file\texpects\tweak\tkinds'];
let weakOnly = 0;
// ② 은퇴 기능 — 제목에 은퇴·제거·옛 낱말 ⊕ 부정 단언(없음을 지킴)이 아닌 것
const RETIRED = /\b(retired|legacy|deprecated|obsolete)\b|은퇴|폐기|옛 (?:문|경로|명령|이름|동작)/i;
const retiredRows: string[] = ['file\ttitles\tnegative\tpositive\tverdict'];
for (const f of files) {
  const text = readFileSync(join(repo, f), 'utf8');
  const kinds = new Map<string, number>();
  for (const m of text.matchAll(/\)\s*\.\s*((?:not\s*\.\s*)?[a-zA-Z]+)\s*\(/g)) {
    const k = m[1].replace(/\s+/g, '');
    if (!/^(not\.)?to[A-Z]/.test(k)) continue;
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }
  const total = [...kinds.values()].reduce((a, b) => a + b, 0);
  const weak = [...kinds].filter(([k]) => WEAK.has(k)).reduce((a, [, v]) => a + v, 0);
  if (total > 0 && weak === total) { weakOnly++; weakRows.push(`${f}\t${total}\t${weak}\t${[...kinds].map(([k, v]) => `${k}:${v}`).join(',')}`); }
  const titles = [...text.matchAll(/\b(?:test|it|describe)\s*\(\s*['"`]([^'"`]{4,})['"`]/g)].map((m) => m[1]).filter((t) => RETIRED.test(t));
  if (titles.length) {
    const neg = [...kinds].filter(([k]) => k.startsWith('not.') || ['toThrow','toBeUndefined','toBeNull','toBeFalsy'].includes(k)).reduce((a, [, v]) => a + v, 0)
      + (text.match(/toHaveLength\(0\)|toEqual\(\[\]\)|toBe\(false\)|toBe\(0\)/g) ?? []).length;
    const pos = total - neg;
    const verdict = neg >= pos ? '가드(없음을 지킨다) — 유지' : '옛 동작 검사 후보 — 열어 보기';
    retiredRows.push(`${f}\t${titles.slice(0, 3).join(' | ')}\t${neg}\t${pos}\t${verdict}`);
  }
}
writeFileSync(join(out, 'weak-assertions.tsv'), weakRows.join('\n') + '\n');
writeFileSync(join(out, 'retired-feature-tests.tsv'), retiredRows.join('\n') + '\n');

// ① 커버리지 겹침
let covSummary: Record<string, unknown> = { skipped: true };
if (covRoot !== '-') {
  const index = readFileSync(join(covRoot, 'index.tsv'), 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'));
  const lineOwners = new Map<string, number>(); // "src:line" → 몇 파일이 닿나
  const perTest = new Map<string, Set<string>>();
  for (const [file, n, rc] of index) {
    if (rc !== '0') continue;
    const p = join(covRoot, 'cov', n, 'lcov.info');
    if (!existsSync(p)) continue;
    const set = new Set<string>(); let sf = '';
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (line.startsWith('SF:')) sf = line.slice(3);
      else if (line.startsWith('DA:') && sf.startsWith('src/') && !/\.test\.tsx?$/.test(sf)) {
        const [ln, hits] = line.slice(3).split(',');
        if (Number(hits) > 0) set.add(`${sf}:${ln}`);
      }
    }
    perTest.set(file, set);
    for (const k of set) lineOwners.set(k, (lineOwners.get(k) ?? 0) + 1);
  }
  const rows = [...perTest].map(([file, set]) => {
    let unique = 0; for (const k of set) if (lineOwners.get(k) === 1) unique++;
    return { file, lines: set.size, unique };
  }).sort((a, b) => a.unique - b.unique || b.lines - a.lines);
  writeFileSync(join(out, 'coverage-unique.tsv'), ['file\tcovered_src_lines\tunique_src_lines', ...rows.map((r) => `${r.file}\t${r.lines}\t${r.unique}`)].join('\n') + '\n');
  const zero = rows.filter((r) => r.unique === 0 && r.lines > 0).length;
  const noSrc = rows.filter((r) => r.lines === 0).length;
  covSummary = { measured: rows.length, failedOrSkipped: index.filter((r) => r[2] !== '0').length, zeroUnique: zero, touchesNoSrc: noSrc, uniqueLe5: rows.filter((r) => r.lines > 0 && r.unique > 0 && r.unique <= 5).length, distinctSrcLines: lineOwners.size };
}
const summary = { files: files.length, weakOnly, retiredTitled: retiredRows.length - 1, retiredOldBehaviour: retiredRows.filter((r) => r.includes('옛 동작')).length, coverage: covSummary };
writeFileSync(join(out, 'test-audit-b-summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
