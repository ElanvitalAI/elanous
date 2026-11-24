// ELN-INTERNAL-DOCS-SYSTEM-1124 회귀 — 6층 지도 분류 · 현행성 규칙 · docs-index.jsonl 관측.
// 판정식(설계 정본 seat-state/OP/orders/ELN-INTERNAL-DOCS-SYSTEM-1124.md 끝)을 시험 우주로 옮긴다:
//   ① OP 첫 턴 L0~L3 항상 요약 합계 ≤4KB.
//   ② self find «초록을 시뮬로 닫는 법» → OPS-RULES 해당 절(current) 1위 · 옛 문서 0.
//   ③ 우산 연결 새 문서 → 다음 빌드 색인 반영 · 연결 없는 문서 → «미분류» 경보 1.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DOCS_ALWAYS_CARRY_MAX_BYTES,
  DOCS_FIND_TOP_N,
  DOCS_LAYERS,
  buildDocsIndex,
  docsCurrencyReport,
  docsFind,
  docsSystemAlwaysCarry,
  docsSystemManifest,
  renderDocsIndexJsonl,
} from './docs-system-map.js';

/** 관측 기준 시각 고정 — stale(90일) 판정이 달력 흔들림에 좌우되지 않게. */
const NOW = new Date('2026-11-24T00:00:00.000Z');
const CURRENT_PLAN = 'PLAN-0.3.35.md';

/** 판정식 우주의 축소 판: 6층 문서 · 대체된 옛 문서 · 우산 연결 없는 고아 · 옛/현행 판 계획 · 공개 문서. */
function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'docs-system-map-'));
  const w = (rel: string, lines: readonly string[]): void => {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${lines.join('\n')}\n`);
  };
  // L0 정체성·우산 — 우산의 정본.
  w('docs/conductor/CONDUCTOR.md', [
    '# 엘라누스 콘덕터',
    '',
    '엘라누스는 판을 발행하고 좌석을 움직이는 유기체다.',
    '',
    '## §0 정체성',
    '스스로 판단하고 스스로 수리한다.',
    '',
    '## §3 로드맵',
    '- 그래프 탭 · 문서 지도',
  ]);
  // L1 원칙.
  w('docs/principles/FIRST-PRINCIPLES.md', [
    '# 제1원칙',
    '',
    '측정·판정·관측이 먼저다.',
    'audience: internal',
  ]);
  // L2 운영 규칙 — «초록을 시뮬로 닫는 법» 의 현행 정본.
  w('seat-state/OPS/OPS-RULES.md', [
    '# OPS 운영 규칙',
    '',
    '착지·판정·발행 규칙.',
    'lastVerified: 2026-11-24',
    'audience: internal',
    '',
    '## 착지',
    'RED 먼저 · 원격 시험.',
    '',
    '## 초록을 시뮬로 닫는 법',
    '초록 시뮬 마감은 회고 절 앞에서 닫는다.',
  ]);
  // L3 기능 카드 — 우산 §3 연결.
  w('docs/features/ELN-SELF-CAPABILITY-MAP.md', [
    '# ELN-SELF-CAPABILITY-MAP 기능 카드',
    '',
    '하려는 일 → 명령 카드.',
    '🔗 우산 — CONDUCTOR §3',
  ]);
  // L4 매뉴얼 — 우산 연결 · lastVerified 90일 넘어 stale.
  w('docs/manual/MANUAL-llm-pipeline-validation.md', [
    '# LLM 파이프라인 검증 매뉴얼',
    '',
    '파이프라인 검증 절차.',
    '🔗 우산 — CONDUCTOR §2',
    'lastVerified: 2026-06-01',
  ]);
  // L5 기록 — 결정.
  w('docs/DECISION-tool-routing-default-1110.md', [
    '# 도구 경로 기본 결정',
    '',
    '경로 기본값 결정 기록.',
    '🔗 우산 — CONDUCTOR §3',
  ]);
  // 옛 문서 — 대체됨(초록 시뮬 마감 옛 기록) → 찾기에서 빠짐.
  w('docs/GREEN-SIM-CLOSURE-2026-08-01.md', [
    '# 초록 시뮬 마감 (옛 기록)',
    '',
    '옛 방식 기록.',
    '(대체됨 → seat-state/OPS/OPS-RULES.md)',
  ]);
  // 우산 연결 없는 새 문서 → «미분류» 경보.
  w('docs/DESIGN-orphan-2026-11-24.md', [
    '# 고아 설계 문서',
    '',
    '우산 절 연결이 없다.',
  ]);
  // L1.5 계획 — 옛 판 · 현행 판.
  w('seat-state/OP/plans/PLAN-0.3.34.md', ['# 판 계획 0.3.34', '', '지난 판.']);
  w('seat-state/OP/plans/PLAN-0.3.35.md', ['# 판 계획 0.3.35 — 문서 지도 테마', '', '이번 판 로스터 60.']);
  // 공개 문서 — audience: public.
  w('docs/public/QUICKSTART.md', ['# 엘라누스 빠른 시작', '', '엘라누스 설치와 첫 대화.', 'audience: public']);
  return root;
}

function build(root: string): ReturnType<typeof buildDocsIndex> {
  return buildDocsIndex({
    roots: [join(root, 'docs'), join(root, 'seat-state')],
    currentPlan: CURRENT_PLAN,
  });
}

describe('ELN-INTERNAL-DOCS-SYSTEM — 6층 지도 + 기계 색인', () => {
  test('층 분류 — L0 정체성·우산 · L1 원칙 · L1.5 계획 · L2 운영 규칙 · L3 기능 · L4 방법 · L5 기록', () => {
    const root = fixtureRoot();
    try {
      const entries = build(root);
      const layerOf = (path: string) => entries.find((e) => e.path === path)?.layer;
      expect(layerOf('docs/conductor/CONDUCTOR.md')).toBe('L0');
      expect(layerOf('docs/principles/FIRST-PRINCIPLES.md')).toBe('L1');
      expect(layerOf('seat-state/OP/plans/PLAN-0.3.34.md')).toBe('L1.5');
      expect(layerOf('seat-state/OP/plans/PLAN-0.3.35.md')).toBe('L1.5');
      expect(layerOf('seat-state/OPS/OPS-RULES.md')).toBe('L2');
      expect(layerOf('docs/features/ELN-SELF-CAPABILITY-MAP.md')).toBe('L3');
      expect(layerOf('docs/manual/MANUAL-llm-pipeline-validation.md')).toBe('L4');
      expect(layerOf('docs/DECISION-tool-routing-default-1110.md')).toBe('L5');
      expect(layerOf('docs/public/QUICKSTART.md')).toBe('L5');
      // 색인 칸 계약 — 모든 줄이 기본 칸을 가진다.
      for (const entry of entries) {
        expect(entry.path.length).toBeGreaterThan(0);
        expect(['current', 'superseded', 'draft']).toContain(entry.status);
        expect(['internal', 'public']).toContain(entry.audience);
        expect(entry.size).toBeGreaterThan(0);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('docs-index.jsonl — 한 줄 한 문서 · 모든 줄이 JSON · 경로 집합 일치', () => {
    const root = fixtureRoot();
    try {
      const entries = build(root);
      const lines = renderDocsIndexJsonl(entries).split('\n').filter((l) => l.trim() !== '');
      expect(lines.length).toBe(entries.length);
      const rows = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      for (const row of rows) {
        for (const key of ['path', 'layer', 'title', 'oneLine', 'status', 'audience', 'size', 'sections']) {
          expect(row).toHaveProperty(key);
        }
      }
      expect(new Set(rows.map((r) => r.path as string))).toEqual(new Set(entries.map((e) => e.path)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ELN-INTERNAL-DOCS-SYSTEM — 현행성 규칙', () => {
  test('주제당 current 하나 — 옛 문서는 (대체됨 → 경로) · 옛 판 PLAN 은 superseded', () => {
    const root = fixtureRoot();
    try {
      const entries = build(root);
      const old = entries.find((e) => e.path === 'docs/GREEN-SIM-CLOSURE-2026-08-01.md');
      expect(old?.status).toBe('superseded');
      expect(old?.supersededBy).toBe('seat-state/OPS/OPS-RULES.md');
      const oldPlan = entries.find((e) => e.path === 'seat-state/OP/plans/PLAN-0.3.34.md');
      expect(oldPlan?.status).toBe('superseded');
      const currentPlan = entries.find((e) => e.path === 'seat-state/OP/plans/PLAN-0.3.35.md');
      expect(currentPlan?.status).toBe('current');
      // 초록 시뮬 마감 주제의 current 는 OPS-RULES 하나뿐이다.
      const topicCurrent = entries.filter(
        (e) => e.status === 'current' && (e.title.includes('초록') || e.sections.some((s) => s.includes('초록'))),
          );
      expect(topicCurrent.map((e) => e.path)).toEqual(['seat-state/OPS/OPS-RULES.md']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('우산 연결 없는 current 문서 → «미분류» 경보 1 · 연결된 새 문서는 다음 빌드에 색인', () => {
    const root = fixtureRoot();
    try {
      const entries = build(root);
      const report = docsCurrencyReport(entries, { now: NOW });
      const unlinked = report.alarms.filter((a) => a.reason === 'umbrella-missing');
      expect(unlinked.length).toBe(1); // 출처: #39970 ELN-INTERNAL-DOCS-SYSTEM-1124 판정식 — 연결 없는 문서 → 미분류 경보 1
      expect(unlinked[0]!.path).toBe('docs/DESIGN-orphan-2026-11-24.md');
      expect(report.alarms.filter((a) => a.reason === 'superseded-target-missing').length).toBe(0);

      // 우산 연결된 새 문서 → 다음 빌드 색인 반영(경보 늘지 않음).
      writeFileSync(
        join(root, 'docs/DESIGN-linked-2026-11-24.md'),
        `${['# 우산 연결 설계 문서', '', '연결된 새 문서.', '🔗 우산 — CONDUCTOR §3'].join('\n')}\n`,
      );
      const rebuilt = build(root);
      const added = rebuilt.find((e) => e.path === 'docs/DESIGN-linked-2026-11-24.md');
      expect(added?.layer).toBe('L5');
      expect(added?.umbrellaSection).toBe('CONDUCTOR §3');
      const report2 = docsCurrencyReport(rebuilt, { now: NOW });
      expect(report2.alarms.filter((a) => a.reason === 'umbrella-missing').length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('stale — lastVerified 90일 넘은 current 만 걸린다', () => {
    const root = fixtureRoot();
    try {
      const entries = build(root);
      const report = docsCurrencyReport(entries, { now: NOW });
      expect(report.stale.map((s) => s.path)).toEqual(['docs/manual/MANUAL-llm-pipeline-validation.md']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ELN-INTERNAL-DOCS-SYSTEM — 3단 접근(예산 순)', () => {
  test('self find «초록을 시뮬로 닫는 법» → OPS-RULES 해당 절 current 1위 · 옛 문서 0', () => {
    const root = fixtureRoot();
    try {
      const entries = build(root);
      const hits = docsFind(entries, '초록을 시뮬로 닫는 법');
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits[0]!.entry.path).toBe('seat-state/OPS/OPS-RULES.md');
      expect(hits[0]!.entry.status).toBe('current');
      expect(hits[0]!.entry.layer).toBe('L2');
      expect(hits.length).toBeLessThanOrEqual(DOCS_FIND_TOP_N); // 출처: #39970 ELN-INTERNAL-DOCS-SYSTEM-1124 §3 — self find 상위 5
      for (const hit of hits) expect(hit.entry.status).toBe('current');
      // 옛 문서(대체됨)는 찾기 결과에 0번 나온다.
      const oldTopic = docsFind(entries, '초록 시뮬 마감 옛 기록');
      expect(oldTopic.filter((h) => h.entry.path === 'docs/GREEN-SIM-CLOSURE-2026-08-01.md').length).toBe(0);
      expect(oldTopic.every((h) => h.entry.status === 'current')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('audience — [내부]/[공개] 표시 · 공개 답변 근거는 public 만', () => {
    const root = fixtureRoot();
    try {
      const entries = build(root);
      const all = docsFind(entries, '엘라누스');
      expect(all.some((h) => h.entry.path === 'docs/conductor/CONDUCTOR.md' && h.badge === '[내부]')).toBe(true);
      expect(all.some((h) => h.entry.path === 'docs/public/QUICKSTART.md' && h.badge === '[공개]')).toBe(true);
      const pubOnly = docsFind(entries, '엘라누스', { audience: 'public' });
      expect(pubOnly.length).toBeGreaterThanOrEqual(1);
      for (const hit of pubOnly) expect(hit.entry.audience).toBe('public');
      expect(pubOnly.some((h) => h.entry.path === 'docs/conductor/CONDUCTOR.md')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('OP 첫 턴 L0~L3 항상 요약 합계 ≤4KB · 현행 판 계획 포인터', () => {
    const root = fixtureRoot();
    try {
      const entries = build(root);
      const carry = docsSystemAlwaysCarry(entries);
      expect(carry.bytes).toBeLessThanOrEqual(DOCS_ALWAYS_CARRY_MAX_BYTES); // 출처: #39970 ELN-INTERNAL-DOCS-SYSTEM-1124 판정식 — L0~L3 요약 합계 ≤4KB
      expect(carry.text).toContain('초록을 시뮬로 닫는 법'); // L2 절 제목 포인터
      expect(carry.text).toContain('0.3.35'); // 현행 판 계획 포인터
      expect(carry.text).not.toContain('0.3.34'); // 옛 판 계획은 항상 요약에 없다
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ELN-INTERNAL-DOCS-SYSTEM — 관측(manifest)', () => {
  test('층별 바이트 · 미분류 · superseded · stale 수', () => {
    const root = fixtureRoot();
    try {
      const entries = build(root);
      const report = docsCurrencyReport(entries, { now: NOW });
      const manifest = docsSystemManifest(entries, report);
      expect(manifest.total).toBe(11);
      expect(manifest.current).toBe(9); // 11 − superseded 2
      expect(manifest.superseded).toBe(2); // 출처: #39970 ELN-INTERNAL-DOCS-SYSTEM-1124 fixture — 옛 문서 1 + 옛 판 계획 1
      expect(manifest.draft).toBe(0);
      expect(manifest.unclassified).toBe(1); // 우산 미연결 고아 1
      expect(manifest.stale).toBe(1); // 90일 넘은 매뉴얼 1
      expect(manifest.layerBytes['L0']).toBeGreaterThan(0);
      expect(Object.keys(manifest.layerBytes).sort()).toEqual([...DOCS_LAYERS].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ELN-INTERNAL-DOCS-SYSTEM — 패키지 경계', () => {
  test('prepack은 색인을 만들지 않는다 — 홈 seat-state 제목·경로가 패키지로 못 새어나간다', () => {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8')) as {
      files: string[];
      scripts: Record<string, string>;
    };
    // docs-index.jsonl 은 로컬 빌드 산물(추적 금지) — prepack 도 files 도 거쳐야 타르볼에 못 들어간다.
    expect(pkg.scripts.prepack).not.toContain('build-docs-index');
    expect(pkg.files).not.toContain('docs-index.jsonl');
  });
});
