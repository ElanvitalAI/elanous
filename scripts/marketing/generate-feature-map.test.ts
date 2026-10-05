import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FEATURE_MATURITY } from '../../src/maturity/feature-maturity.js';
import type { ChecklistItem } from '../../src/release-loop/checklist.js';
import { generateFeatureMap } from './generate-feature-map.js';

const map = `# MAP
## 2. 기능 배치표 (판 · 성숙도)
| 소구점 | 기능 | 칸 | 판 | 성숙도 | 공개 | 근거 | 표면 |
|---|---|---|---|---|---|---|---|
| P1 | 채팅 | CHAT | 0.2 | /chat stable | ✅ | #11 | 사 |
| P2 | 설정 | SETTINGS | 0.2 | /settings beta | ✅ | #12 | 사 |
| P2 | 다중 단계 | CHAT·PENDING | 0.2 | /chat stable | ✅ | #18 | 사 |
| P3 | 도구 | TOOL | 0.2 | /approvals tool | — | #13 | — |
| P4 | 근거 없는 줄 | EMPTY | 0.2 | /today stable | ✅ | #14 | 사 |
| P5 | 숨겨야 할 기능 이름 | SECRET | 0.2 | /chat stable | 특허 보류 | #15 | 사 |
| P5 | 근거열 비공개 기능 | CITATION | 0.2 | /chat stable | ✅ | 특허 보류 · #19 | 사 |
| P5 | 체크리스트 비공개 기능 | CHECKHELD | 0.2 | /chat stable | ✅ | #20 | 사 |
| P5 | 미착지 증거 비공개 기능 | NOTGREEN | 0.2 | /chat stable | ✅ | #22 | 사 |
## 3. 내부 배치
| P6 | 여긴 아님 | OTHER | 0.2 | /chat stable | ✅ | #16 | 사 |
`;
const item = (id: string, status: ChecklistItem['status'], evidence = ''): ChecklistItem => ({
  id, title: id, status, evidence, updatedAt: '2026-10-05T00:00:00Z', updatedBy: 'test',
});
const items = [item('CHAT', 'green', 'merged PR #11'), item('SETTINGS', 'green', '#12'),
  item('TOOL', 'green', '#13'), item('EMPTY', 'green'), item('SECRET', 'green', '#15'),
  item('CITATION', 'green', '#19'), item('CHECKHELD', 'green', '특허 보류 · #20'),
  item('PENDING', 'yellow', '#17'), item('NOTGREEN', 'yellow', '특허 보류 · #22')];

test('temporary sources grade green registry features and withhold unsupported and patent-held claims', () => {
  const result = generateFeatureMap({ map, items, registry: FEATURE_MATURITY, version: '0.2.18' });
  expect(result).toContain('| 채팅 | 된다 | CHAT | #11 |');
  expect(result).toContain('| 설정 | 베타 | SETTINGS | #12 |');
  expect(result).toContain('| 다중 단계 | 로드맵 | CHAT·PENDING | 부분: #11 · 나머지 칸 미완 |');
  expect(result).not.toContain('| 다중 단계 | 로드맵 | CHAT·PENDING | #11 |');
  expect(result).toContain('| 도구 | 로드맵 | TOOL | #13 |');
  expect(result).toContain('| 근거 없는 줄 | 된다 | EMPTY | 근거 없음 |');
  expect(result.match(/^\| 개념 \| 로드맵 \| — \| 근거 없음 \|$/gm)).toHaveLength(4);
  expect(result).not.toContain('숨겨야 할 기능 이름');
  expect(result).not.toContain('근거열 비공개 기능');
  expect(result).not.toContain('체크리스트 비공개 기능');
  expect(result).not.toContain('미착지 증거 비공개 기능');
  expect(result).not.toContain('NOTGREEN');
  expect(result).not.toContain('SECRET');
  expect(result).not.toContain('CITATION');
  expect(result).not.toContain('CHECKHELD');
  expect(result).not.toContain('#15');
  expect(result).not.toContain('#19');
  expect(result).not.toContain('#20');
  expect(result).not.toContain('여긴 아님');
  expect(result).not.toContain('| PENDING |');
  expect(result).not.toContain('#14');
});

test('non-green and unregistered features never become a current capability', () => {
  const withUnknown = map.replace('/chat stable | ✅ | #11', '/unregistered stable | ✅ | #11');
  const result = generateFeatureMap({ map: withUnknown, items: [item('CHAT', 'green', '#11'), item('SETTINGS', 'green', '#12')], registry: FEATURE_MATURITY, version: '0.2.18' });
  expect(result).toContain('| 채팅 | 로드맵 | CHAT | #11 |');
  expect(result).toContain('| 설정 | 베타 | SETTINGS | #12 |');
  expect(FEATURE_MATURITY.pwaRoute['/chat'].pwa).toBe('stable');
});

test('the real section 2 rows use map maturity and evidence only when no checklist cell exists', () => {
  const source = `## 2. 기능 배치표 (판 · 성숙도 · 공개 · 근거 · 표면)
| 소구점 | 기능 | 칸 | 판 | 성숙도 | 공개 | 근거(PR · 실측 · 재는 명령) | 표면 |
|---|---|---|---|---|---|---|---|
| P1·P2 | 한 줄 → 병합까지(하니스) | — | 0.2.x | stable(cli) | ✅ 기능만 · 숫자는 공개 보류(D-20261003-06) | 병합 PR 큰 수 표기 후보 «2만+ PR» · \`docs/marketing/SOURCES-site-numbers-2026-10-03.md\`의 \`gh pr list --state merged --limit 100000 --json number\` (전체 병합 PR·제작 주체 미분류) | 사 공 행 세 |
| P1 | 명함 한 장 → 영업 전략 | card-followup | 플러그인 0.2.9 | — (플러그인) | ✅ «약 2분» | 진행표 실측 약 2분 · 0.2.10: 텔레그램에 명함 사진 한 장(키워드 없이도) → 자동 시작(CARD1 #22860 ⊕ «명함처럼 보일 때만» CARD1b #22865 · Mac 호스트에서만 판별) — ⏳ 설치본 실물 명함 1회 뒤 «사진 한 장»으로 | 행 세 |
| P2 | 체크리스트 기능 | CHAT | 0.2.x | /chat stable | ✅ | 지도에는 #999 | 사 |
| P2 | 미공개 지도 기능 | — | 0.2.x | beta(cli) | ⏳ 보류 | #444 | 문 |
| P2 | 공개 베타 기능 | nonexistent | 0.2.x | /trace beta | ✅ «실험» | #555 | 문 |
| P2 | 지도 특허 기능 | — | 0.2.x | stable(cli) | ✅ 특허 보류 | #666 | 사 |
`;
  const result = generateFeatureMap({ map: source, items: [item('CHAT', 'green', '#11')], registry: FEATURE_MATURITY, version: '0.2.18' });
  expect(result).toContain('| 한 줄 → 병합까지(하니스) | 된다 | 지도 판정 | 근거 없음 |');
  expect(result).toContain('| 명함 한 장 → 영업 전략 | 로드맵 | 지도 판정 | #22860, #22865 |');
  expect(result).toContain('| 체크리스트 기능 | 된다 | CHAT | #11 |');
  expect(result).not.toContain('#999');
  expect(result).toContain('| 미공개 지도 기능 | 로드맵 | 지도 판정 | #444 |');
  expect(result).toContain('| 공개 베타 기능 | 베타 | 지도 판정 | #555 |');
  expect(result).toContain('| 개념 | 로드맵 | — | 근거 없음 |');
  expect(result).not.toContain('#666');
});

test('the CLI generates the real marketing map with at least one current capability, excluding internal sections', () => {
  const root = mkdtempSync(join(tmpdir(), 'feature-map-real-'));
  try {
    writeFileSync(join(root, 'checklist.json'), JSON.stringify({ items: [] }));
    const run = Bun.spawnSync(['bun', join(import.meta.dir, 'generate-feature-map.ts'), '--version', '0.2.18', '--map', join(import.meta.dir, '../../docs/marketing/MAP-value-props-to-features.md'), '--checklist', join(root, 'checklist.json'), '--out', join(root, 'feature-map.md')], { cwd: root });
    expect(run.exitCode).toBe(0);
    const result = readFileSync(join(root, 'feature-map.md'), 'utf8');
    expect(result).toContain('| 한 줄 → 병합까지(하니스) | 된다 | 지도 판정 | 근거 없음 |');
    expect(result).toContain('| 명함 한 장 → 영업 전략 | 로드맵 | 지도 판정 | #22860, #22865 |');
    expect(result.match(/^\\| .* \\| (?:된다|베타) \\|/gm)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(result).not.toContain('산출물 원장 — 맡긴 일의 결과를 추적');
    expect(result).not.toContain('AI 임원이 하위 조직을 거느린다');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('green checklist cells outside section 2 never enter the feature map', () => {
  const unmapped = { ...item('UNMAPPED', 'green', '#23999'), title: '내부 체크리스트 제목' };
  const offmap = { ...item('OFFMAP', 'green', '특허 보류 · #21'), title: '비공개 특허 제목' };
  const result = generateFeatureMap({ map, items: [item('CHAT', 'yellow'), unmapped, offmap], registry: FEATURE_MATURITY, version: '0.2.18' });
  expect(result).not.toContain('UNMAPPED');
  expect(result).not.toContain('내부 체크리스트 제목');
  expect(result).not.toContain('#23999');
  expect(result).not.toContain('OFFMAP');
  expect(result).not.toContain('비공개 특허 제목');
  expect(result).not.toContain('#21');
  expect(result.match(/^\| 개념 \| 로드맵 \| — \| 근거 없음 \|$/gm)).toHaveLength(2);
  expect(result).toContain('| 채팅 | 로드맵 | CHAT | 근거 없음 |');
});

test('the CLI hides held claims when only maturity or surface marks a map row', () => {
  const root = mkdtempSync(join(tmpdir(), 'feature-map-held-'));
  try {
    for (const [column, maturity, surface] of [
      ['성숙도', '/chat stable · 특허 보류', '사'],
      ['표면', '/chat stable', '사 · 특허 보류'],
    ]) {
      const id = `HELD-${column}`;
      const name = `${column} 열에만 숨긴 기능`;
      const pr = column === '성숙도' ? '#98761' : '#98762';
      const source = `## 2. 기능 배치표 (판 · 성숙도)\n| 소구점 | 기능 | 칸 | 판 | 성숙도 | 공개 | 근거 | 표면 |\n|---|---|---|---|---|---|---|---|\n| P1 | ${name} | ${id} | 0.2 | ${maturity} | ✅ | ${pr} | ${surface} |\n`;
      writeFileSync(join(root, 'map.md'), source);
      writeFileSync(join(root, 'checklist.json'), JSON.stringify({ items: [item(id, 'green', pr)] }));
      const run = Bun.spawnSync(['bun', join(import.meta.dir, 'generate-feature-map.ts'), '--version', '0.2.18', '--map', join(root, 'map.md'), '--checklist', join(root, 'checklist.json'), '--out', join(root, 'feature-map.md')], { cwd: root });
      expect(run.exitCode).toBe(0);
      const output = readFileSync(join(root, 'feature-map.md'), 'utf8');
      expect(output.match(/^\| 개념 \| 로드맵 \| — \| 근거 없음 \|$/gm)).toHaveLength(1);
      expect(output.match(/^\| /gm)).toHaveLength(2);
      expect(output).not.toContain(name);
      expect(output).not.toContain(id);
      expect(output).not.toContain(pr);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the CLI reads temporary source files without writing to a release ledger', () => {
  const root = mkdtempSync(join(tmpdir(), 'feature-map-'));
  try {
    writeFileSync(join(root, 'map.md'), map);
    writeFileSync(join(root, 'checklist.json'), JSON.stringify({ items: [...items, { ...item('UNMAPPED', 'green', '#23999'), title: '내부 체크리스트 제목' }] }));
    const run = Bun.spawnSync(['bun', join(import.meta.dir, 'generate-feature-map.ts'), '--version', '0.2.18', '--map', join(root, 'map.md'), '--checklist', join(root, 'checklist.json'), '--out', join(root, 'feature-map.md')], { cwd: root });
    expect(run.exitCode).toBe(0);
    const output = readFileSync(join(root, 'feature-map.md'), 'utf8');
    expect(output).toContain('| 채팅 | 된다 | CHAT | #11 |');
    expect(output).toContain('| 설정 | 베타 | SETTINGS | #12 |');
    expect(output).toContain('| 도구 | 로드맵 | TOOL | #13 |');
    expect(output).toContain('| 근거 없는 줄 | 된다 | EMPTY | 근거 없음 |');
    expect(output.match(/^\| 개념 \| 로드맵 \| — \| 근거 없음 \|$/gm)).toHaveLength(4);
    expect(output).not.toContain('숨겨야 할 기능 이름');
    expect(output).not.toContain('근거열 비공개 기능');
    expect(output).not.toContain('체크리스트 비공개 기능');
    expect(output).not.toContain('미착지 증거 비공개 기능');
    expect(output).not.toContain('NOTGREEN');
    expect(output).not.toContain('SECRET');
    expect(output).not.toContain('CITATION');
    expect(output).not.toContain('CHECKHELD');
    expect(output).not.toContain('UNMAPPED');
    expect(output).not.toContain('내부 체크리스트 제목');
    expect(output).not.toContain('#23999');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
