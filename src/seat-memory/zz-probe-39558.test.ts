import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOpMemorySeed, planOpMemorySeed } from './op-memory-seed.js';
import { planSeatMemoryImport } from './seat-memory-import.js';
import { readSeatMemoryIndex, searchSeatMemories } from './seat-memory.js';

const mem = (name: string, desc: string, body: string) => `---\nname: ${name}\ndescription: ${desc}\ntype: project\n---\n\n${body}\n`;
const allIndexText = (to: string) => readdirSync(to).filter(f => f.startsWith('MEMORY')).map(f => readFileSync(join(to, f), 'utf8')).join('\n');

function setup(withClaude: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'probe39558-'));
  const to = join(root, 'seats', 'OP');
  mkdirSync(to, { recursive: true });
  // existing target memories: one listed in the target main index, one un-indexed
  writeFileSync(join(to, 'zebra-indexed.md'), mem('zebra-indexed', 'zebrafish quokka indexed probe', 'body zebrafish'));
  writeFileSync(join(to, 'walrus-unindexed.md'), mem('walrus-unindexed', 'walrusprobe narwhal unindexed', 'body walrusprobe'));
  writeFileSync(join(to, 'MEMORY.md'), '- [zebra-indexed](zebra-indexed.md) — zebrafish quokka indexed probe\n');
  const claude = join(root, 'claude-memory');
  mkdirSync(claude, { recursive: true });
  if (withClaude) {
    writeFileSync(join(claude, 'src-indexed.md'), mem('src-indexed', 'source indexed one', 'x'));
    writeFileSync(join(claude, 'src-unindexed.md'), mem('src-unindexed', 'pangolinsrc unindexed', 'y'));
    writeFileSync(join(claude, 'MEMORY.md'), '- [src-indexed](src-indexed.md) — source indexed one\n');
  }
  const ops = join(root, 'OPS-RULES.md');
  writeFileSync(ops, '# 규칙\n- 하나\n');
  const dec = join(root, 'DECISIONS-OP.tsv');
  writeFileSync(dec, '2026-11-20T10:00\tOP\tdecision one\n');
  return { root, to, claude, ops, dec };
}

for (const withClaude of [true, false]) {
  describe(`H1 withClaude=${withClaude}`, () => {
    test('existing target memories remain reachable via some index after seed', () => {
      const f = setup(withClaude);
      const opts = { claudeDir: withClaude ? f.claude : join(f.root, 'nope'), opsRulesPath: f.ops, decisionsPath: f.dec, allowedSourceRoots: [f.root], to: f.to, seat: 'OP' };
      const plan = planOpMemorySeed(opts);
      const importPlan = withClaude ? planSeatMemoryImport({ from: f.claude, to: f.to, seat: 'OP' }) : null;
      console.log('H1', withClaude, 'seedPlan.supplementalIndex=', JSON.stringify(plan.supplementalIndex), 'importPlan.supplementalIndex.file=', importPlan?.supplementalIndex?.file);
      applyOpMemorySeed(plan);
      const idx = allIndexText(f.to);
      console.log('H1', withClaude, 'files=', readdirSync(f.to).filter(x => x.startsWith('MEMORY')).join(','));
      console.log('H1', withClaude, 'main has zebra=', readSeatMemoryIndex(f.to).includes('(zebra-indexed.md)'), 'any idx walrus=', idx.includes('(walrus-unindexed.md)'), 'any idx zebra=', idx.includes('(zebra-indexed.md)'), 'any idx src-unindexed=', idx.includes('(src-unindexed.md)'));
      // JUD-C judb-39558-d415b76374f7(① · #129870) — 검색 API 반환을 «출력만»이 아니라 실제 단언한다:
      // 기존 대상 기억(색인·미색인) ⊕ 원본(claude) 기억(색인·미색인)이 시딩 후에도 검색된다(Claude 유무 양쪽).
      const found = (q: string) => searchSeatMemories(q, f.to).map(h => h.entry.name);
      console.log('H1', withClaude, 'search zebra=', found('zebrafish quokka').join(','), 'search walrus=', found('walrusprobe narwhal').join(','), 'search src-unindexed=', withClaude ? found('pangolinsrc unindexed').join(',') : '-');
      expect(found('zebrafish quokka')).toContain('zebra-indexed');
      expect(found('walrusprobe narwhal')).toContain('walrus-unindexed');
      if (withClaude) {
        expect(found('pangolinsrc unindexed')).toContain('src-unindexed');
        expect(found('source indexed one')).toContain('src-indexed');
      }
      expect(idx.includes('(zebra-indexed.md)')).toBe(true);
      expect(idx.includes('(walrus-unindexed.md)')).toBe(true);
      if (withClaude) expect(idx.includes('(src-unindexed.md)')).toBe(true);
    });
  });
}

describe('H2', () => {
  test('decision fragment source line == original TSV line', () => {
    const root = mkdtempSync(join(tmpdir(), 'probe39558h2-'));
    const to = join(root, 'seats', 'OP');
    mkdirSync(to, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) { lines.push(`2026-11-01T0${i % 10}:00\tOP\told row ${i}`); lines.push(''); }
    const longText = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    lines.push(`2026-11-21T12:34\tOP\tLONGROW ${longText}`);
    const longLineNo = lines.length; // 1-based
    lines.push('');
    lines.push(`2026-11-21T13:00\tOP\tafter row`);
    lines.push('');
    const latestLong = `2026-11-22T09:00\tOP\tLATESTLONG ${longText}`;
    lines.push(latestLong);
    const latestLineNo = lines.length;
    const dec = join(root, 'DECISIONS-OP.tsv');
    writeFileSync(dec, lines.join('\n') + '\n');
    const plan = planOpMemorySeed({ claudeDir: join(root, 'nope'), decisionsPath: dec, allowedSourceRoots: [root], to, seat: 'OP', decisionsRecent: 5 } as any);
    const marks: Array<{ name: string; line: number; frag: string; expected: number }> = [];
    for (const f of plan.files) {
      const m = /출처 줄 (\d+) · 조각 (\d+\/\d+)/.exec(f.text);
      if (!m) continue;
      const expected = f.text.includes('LATESTLONG') || f.name === 'op-decision-latest' || f.name.startsWith('op-decision-20261122') ? latestLineNo : longLineNo;
      marks.push({ name: f.name, line: Number(m[1]), frag: m[2]!, expected });
    }
    console.log('H2 longLineNo=', longLineNo, 'latestLineNo=', latestLineNo);
    for (const m of marks) console.log('H2', m.name, 'frag', m.frag, 'recorded', m.line, 'expected', m.expected);
    expect(marks.length).toBeGreaterThan(0);
    for (const m of marks) expect(m.line).toBe(m.expected);
  });
});

// JUD-C judb-39558-d415b76374f7(② · #129883) — 생성 이름 원본의 처분 계약: claude 원본 중 생성 이름(ops-rule-*·op-decision-*·
// landing-knowhow) 기억은 이식에서 제외되는데, 대상에 동일 파일이 없고 동일 이름 생성물도 없으면 색인(주 ⭐줄·보조 색인)이
// 없는 파일을 가리키는 끊어진 링크를 만들어 온다. 원본 색인(⭐)·미색인 양쪽 경로에 대해 ① 처분 원장 기록 ② 끊어진 링크 0
// ③ 적용 후 링크 대상 존재·검색 접근을 단언한다.
describe('H3', () => {
  test('excluded generated-name originals: disposition ledger + no broken index links + access', () => {
    const root = mkdtempSync(join(tmpdir(), 'probe39558h3-'));
    const to = join(root, 'seats', 'OP');
    mkdirSync(to, { recursive: true });
    writeFileSync(join(to, 'zebra-indexed.md'), mem('zebra-indexed', 'zebrafish quokka indexed probe', 'body zebrafish'));
    writeFileSync(join(to, 'MEMORY.md'), '- [zebra-indexed](zebra-indexed.md) — zebrafish quokka indexed probe\n');
    const claude = join(root, 'claude-memory');
    mkdirSync(claude, { recursive: true });
    // 생성 이름 원본 2개 — 원본 색인(⭐) 1 · 원본 미색인 1. OPS 섹션 슬러그·결정 슬러그와 달라 동일 이름 생성물이 없다.
    writeFileSync(join(claude, 'ops-rule-ghost.md'), mem('ops-rule-ghost', 'ghostsection opsrule original', 'body ghost'));
    writeFileSync(join(claude, 'op-decision-ghost.md'), mem('op-decision-ghost', 'ghostdecision original', 'body ghostdec'));
    writeFileSync(join(claude, 'src-ok.md'), mem('src-ok', 'srcok normal original', 'body srcok'));
    writeFileSync(join(claude, 'MEMORY.md'), '- [ops-rule-ghost](ops-rule-ghost.md) — ghostsection opsrule original\n- [src-ok](src-ok.md) — srcok normal original\n');
    const ops = join(root, 'OPS-RULES.md');
    writeFileSync(ops, '# 실제규칙\n- 줄 하나\n');
    const dec = join(root, 'DECISIONS-OP.tsv');
    writeFileSync(dec, '2026-11-20T10:00\tOP\tdecision one\n');
    const plan = planOpMemorySeed({ claudeDir: claude, opsRulesPath: ops, decisionsPath: dec, allowedSourceRoots: [root], to, seat: 'OP' });
    applyOpMemorySeed(plan);
    // ① 처분 계약 — 생성 이름 원본은 이식되지 않고 skipped 원장에 기록된다(원본은 읽기 전용 claudeDir 에 유지).
    expect(existsSync(join(to, 'ops-rule-ghost.md'))).toBe(false);
    expect(existsSync(join(to, 'op-decision-ghost.md'))).toBe(false);
    expect(existsSync(join(claude, 'ops-rule-ghost.md'))).toBe(true);
    expect(plan.skipped.some(s => s.file === 'ops-rule-ghost.md' && s.reason === 'superseded-by-generated-name')).toBe(true);
    expect(plan.skipped.some(s => s.file === 'op-decision-ghost.md' && s.reason === 'superseded-by-generated-name')).toBe(true);
    // ② 끊어진 링크 0 — 주 색인·보조 색인의 모든 줄에서 링크 대상 파일이 대상 디렉터리에 실재한다.
    const broken: string[] = [];
    for (const line of allIndexText(to).split('\n')) {
      const m = /\]\(([^)\s]+\.md)\)/.exec(line);
      if (m && !existsSync(join(to, m[1]!))) broken.push(line);
    }
    console.log('H3 broken links=', JSON.stringify(broken), 'index files=', readdirSync(to).filter(x => x.startsWith('MEMORY')).join(','));
    expect(broken).toEqual([]);
    // ③ 접근 — 검색 API 가 대상 기존·이식된 원본을 반환하고, 미이식 원본(ghost)은 반환되지 않는다.
    expect(searchSeatMemories('zebrafish quokka', to).map(h => h.entry.name)).toContain('zebra-indexed');
    expect(searchSeatMemories('srcok normal original', to).map(h => h.entry.name)).toContain('src-ok');
    expect(searchSeatMemories('ghostsection opsrule', to).map(h => h.entry.name)).not.toContain('ops-rule-ghost');
  });
});
