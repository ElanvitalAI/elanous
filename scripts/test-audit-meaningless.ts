// K10 D5 — 무의미 시험 전수조사(읽기 전용 · 정적). 산출 = TSV(파일 · 분류 · 근거) ⊕ 요약 JSON.
// 분류: A 대상 없음(상대 import 가 가리키는 파일이 없다 · 또는 저장소 코드를 하나도 안 부른다)
//       B 상수=상수(expect(<리터럴>)의 리터럴이 기대값과 같다 · expect(x).toBe(x) 같은 식)
//       C 중복(파일 본문 해시 동일 · 또는 같은 대상 모듈 ⊕ 같은 시험 제목 집합)
//       D 문면 고정(소스·문서를 readFileSync 로 읽어 toContain/toMatch 만 한다 — 동작을 안 부른다)
//       E 영구 skip(skip/todo/xit · skipIf(true) · 전부 skip)
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

const root = process.argv[2]; const out = process.argv[3];
const files = execFileSync('git', ['ls-files', '*.test.*'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);

const EXT = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.mts', '/index.ts', '/index.tsx', '/index.js'];
function resolveRel(fromFile: string, spec: string): boolean {
  const base = resolve(root, dirname(fromFile), spec);
  const cands = [base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), base.replace(/\.mjs$/, '.mts')];
  for (const c of cands) for (const e of EXT) if (existsSync(c + e)) return true;
  return false;
}
function resolveAlias(fromFile: string, spec: string): boolean {
  // PWA `@/x` → apps/pwa/src/x
  if (!spec.startsWith('@/')) return true;
  const base = join(root, 'apps/pwa/src', spec.slice(2));
  for (const e of EXT) if (existsSync(base + e)) return true;
  return false;
}

type Row = { file: string; cls: string[]; evidence: string[]; lines: number; tests: number };
const rows: Row[] = [];
const hashes = new Map<string, string[]>();
const titleSig = new Map<string, string[]>();

for (const f of files) {
  const text = readFileSync(join(root, f), 'utf8');
  const lines = text.split('\n').length;
  const cls: string[] = []; const ev: string[] = [];
  const tests = (text.match(/\b(?:test|it)(?:\.(?:only|each\([^)]*\)))?\s*\(/g) ?? []).length;
  // imports
  // 실제 import 문만(줄 맨 앞 import/export … from · 줄 맨 앞 await/const … import('…')) — 픽스처 문자열·주석 속 모양은 뺀다.
  const specs = [
    ...[...text.matchAll(/^\s*(?:import|export)\b[^'";`]*?\bfrom\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]),
    ...[...text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]),
    ...[...text.matchAll(/^[^'"`\n/]*\bawait\s+import\(\s*['"]([^'"]+)['"]\s*\)/gm)].map((m) => m[1]),
    ...[...text.matchAll(/^[^'"`\n/]*\bimport\(\s*`(\.{1,2}\/[^`$?]+)/gm)].map((m) => m[1]),
  ];
  const rel = specs.filter((s) => s.startsWith('.') || s.startsWith('@/'));
  const missing = rel.filter((s) => (s.startsWith('@/') ? !resolveAlias(f, s) : !resolveRel(f, s)));
  if (missing.length) { cls.push('A'); ev.push(`missing-import:${missing.slice(0, 3).join(',')}`); }
  const repoCode = rel.filter((s) => !/\.(json|md|txt|css)$/.test(s));
  // E: skip
  const skips = (text.match(/\b(?:test|it|describe)\.(?:skip|todo)\s*\(|\bx(?:it|describe|test)\s*\(|\.skipIf\(\s*true\s*\)/g) ?? []).length;
  if (skips > 0 && (tests === 0 || skips >= tests)) { cls.push('E'); ev.push(`all-skipped:${skips}/${tests}`); }
  else if (skips > 0) ev.push(`some-skipped:${skips}/${tests}`);
  // B: constant = constant
  const constEq = [...text.matchAll(/^[^'"`\n]*?expect\(\s*(['"`][^'"`\n]{0,80}['"`]|-?\d+(?:\.\d+)?|true|false|null)\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\(\s*(['"`][^'"`\n]{0,80}['"`]|-?\d+(?:\.\d+)?|true|false|null)\s*\)/gm)]
    .filter((m) => m[1] === m[2]);
  const selfEq = [...text.matchAll(/^[^'"`\n]*?expect\(\s*([A-Za-z_$][\w$.]*)\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\(\s*([A-Za-z_$][\w$.]*)\s*\)/gm)].filter((m) => m[1] === m[2]);
  const litExpect = (text.match(/expect\(\s*(?:['"`][^'"`\n]*['"`]|-?\d+(?:\.\d+)?|true|false|null)\s*\)/g) ?? []).length;
  if (constEq.length + selfEq.length > 0) { cls.push('B'); ev.push(`const-eq:${constEq.length + selfEq.length}`); }
  else if (litExpect >= 3) ev.push(`literal-subject-expects:${litExpect}`);
  // D: text pinning — readFileSync of source/docs ⊕ toContain/toMatch only, no calls into imported code
  const readsText = /readFileSync\(|Bun\.file\([^)]*\)\.text\(/.test(text);
  const matchers = (text.match(/\.\s*(?:toContain|toMatch|not\.toContain|not\.toMatch)\(/g) ?? []).length;
  const allExpects = (text.match(/\bexpect\(/g) ?? []).length;
  if (readsText && allExpects > 0 && matchers / allExpects >= 0.8 && repoCode.length === 0) { cls.push('D'); ev.push(`text-pin:${matchers}/${allExpects}`); }
  else if (readsText && allExpects > 0 && matchers / allExpects >= 0.8) ev.push(`text-pin-with-imports:${matchers}/${allExpects}`);
  // A(2): no repo code at all and no file reads — tests only itself
  if (repoCode.length === 0 && !readsText && !/spawn|execFile|Bun\.spawn|fetch\(/.test(text)) { if (!cls.includes('A')) { cls.push('A'); ev.push('no-repo-code'); } }
  // C: duplicates
  const h = createHash('sha256').update(text).digest('hex').slice(0, 16);
  hashes.set(h, [...(hashes.get(h) ?? []), f]);
  const titles = [...text.matchAll(/\b(?:test|it)\s*\(\s*['"`]([^'"`]{4,})['"`]/g)].map((m) => m[1]).sort();
  if (titles.length >= 2) { const sig = createHash('sha256').update(repoCode.sort().join('|') + '#' + titles.join('|')).digest('hex').slice(0, 16); titleSig.set(sig, [...(titleSig.get(sig) ?? []), f]); }
  rows.push({ file: f, cls, evidence: ev, lines, tests });
}
const byFile = new Map(rows.map((r) => [r.file, r]));
for (const [h, fs] of hashes) if (fs.length > 1) for (const f of fs) { const r = byFile.get(f)!; if (!r.cls.includes('C')) r.cls.push('C'); r.evidence.push(`same-bytes:${fs.filter((x) => x !== f).slice(0, 2).join(',')}`); }
for (const [s, fs] of titleSig) if (fs.length > 1) for (const f of fs) { const r = byFile.get(f)!; if (!r.cls.includes('C')) r.cls.push('C'); r.evidence.push(`same-target+titles:${fs.filter((x) => x !== f).slice(0, 2).join(',')}`); }

const tsv = ['file\tclasses\ttests\tlines\tevidence', ...rows.filter((r) => r.cls.length).map((r) => `${r.file}\t${r.cls.join(',')}\t${r.tests}\t${r.lines}\t${r.evidence.join(' ; ')}`)].join('\n');
writeFileSync(join(out, 'test-audit.tsv'), tsv + '\n');
const count = (c: string) => rows.filter((r) => r.cls.includes(c)).length;
const summary = { total: rows.length, flagged: rows.filter((r) => r.cls.length).length, A: count('A'), B: count('B'), C: count('C'), D: count('D'), E: count('E'),
  A_missing: rows.filter((r) => r.evidence.some((e) => e.startsWith('missing-import'))).length, A_noRepo: rows.filter((r) => r.evidence.includes('no-repo-code')).length };
writeFileSync(join(out, 'test-audit-summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
