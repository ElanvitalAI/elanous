// RFC ux-controller-generator — 문서 실물 시험(문서 문구 대조 · goal-context 검증 메뉴 L1).
// 문서 전용 골: 생산 진입점 배선은 의도적 경계(«해당 없음») — 대신
// (a) RFC 실물 존재 (b) 원칙 4의 3층 분리·미디어 절 (c) 기존 자산 링크 경로 test -f
// (d) INDEX 허브 한 줄 (e) 기존 허브 행 보존 (f) 0.2.41 첫 조각 수용선 문면을 단언한다.
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..');
const rfcPath = join(repoRoot, 'docs', 'RFC-ux-controller-generator.md');
const hubPath = join(repoRoot, 'docs', 'INDEX-loop-agents-and-harness-rfcs.md');

const readIfPresent = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '');

describe('RFC ux-controller-generator 문서 실물', () => {
  const rfc = readIfPresent(rfcPath);

  test('(a) docs/RFC-ux-controller-generator.md 실물이 존재한다', () => {
    expect(existsSync(rfcPath)).toBe(true);
    expect(rfc.length).toBeGreaterThan(0);
  });

  test('(b) 원칙 4의 3층 분리 절이 제목으로 보인다', () => {
    for (const heading of [
      '## 노드는 의미 사건만 낸다 (진행 · 질문 · 결과 · 산출물/미디어 · 경보)',
      '## 중앙 UX 컨트롤러 — 행선을 정한다 (origin · fan-out · 핸드오프 · HITL 경로·만료)',
      '## 서피스별 UX 제너레이터 — 문구·형식을 그린다 (TUI · PWA · 텔레그램 · Discord)',
      '## 미디어는 그래프 중간에 꽂는 UX 부품 (Higgsfield MCP · diagram)',
    ]) {
      expect(rfc).toContain(heading);
    }
  });

  test('(b2) 미디어 사건이 UX 부품 생성 노드를 트리거한다', () => {
    expect(rfc).toContain('부품 생성 노드를 트리거한다');
    expect(rfc).toContain('Higgsfield MCP');
    expect(rfc).toContain('diagram');
  });

  test('(b3) 설계 칸 ①②③ 절이 보인다', () => {
    for (const heading of [
      '## 기존 자산 전수 — 재발명 0',
      '## 사건 스키마',
      '## 컨트롤러 정책',
      '## 제너레이터 계약',
      '## 핸드오프·HITL 규칙',
      '## 0.2.41 첫 조각',
      '## 남은 것',
    ]) {
      expect(rfc).toContain(heading);
    }
  });

  test('(c) 기존 자산 전수 절이 실제 경로를 링크하고 전부 test -f 를 통과한다', () => {
    const start = rfc.indexOf('## 기존 자산 전수');
    const end = rfc.indexOf('## 사건 스키마');
    const assetSection = start >= 0 && end > start ? rfc.slice(start, end) : '';
    expect(assetSection.length).toBeGreaterThan(0);
    const assetPaths = [
      'docs/manual/MANUAL-surface-character-role-2026-08-15.md',
      'src/session/index.ts',
      'src/agent/surface-ux/types.ts',
      'src/agent/surface-ux/build.ts',
      'src/skills/url-router.ts',
      'src/skills/url-route-exec.ts',
      'src/telegram.ts',
      'src/cli/notify-cli.ts',
      'apps/pwa/src/components/tool-approval/ToolApprovalSheet.tsx',
      'src/agent/task-notification.ts',
      'src/self-implement/graph-yaml.ts',
    ];
    for (const p of assetPaths) {
      expect(existsSync(join(repoRoot, p))).toBe(true);
      expect(assetSection).toContain(`\`${p}\``);
    }
    for (const symbol of [
      'SessionSurface',
      'SurfaceUx',
      'detectUrlRoute',
      'runUrlRoute',
      'PendingTaskNotification',
      'renderTaskNotificationsXml',
      'GraphNodeSpec',
      'GraphEdgeSpec',
      'edge.map',
      'fan_out',
      'trigger.events',
    ]) {
      expect(assetSection).toContain(symbol);
    }
  });

  test('(d) INDEX 허브에 RFC 한 줄이 추가됐다 (경로 문자열 ⊕ 보존 계약 문구)', () => {
    const hub = readIfPresent(hubPath);
    expect(hub).toContain('RFC-ux-controller-generator.md');
    expect(hub).toContain('보존 계약: 다른 명령·화면의 기본 동작·원장 형식 유');
  });

  test('(e) 기존 허브 행은 그대로 보존된다 (삭제·보호 경로 금지)', () => {
    const hub = readIfPresent(hubPath);
    for (const existing of [
      '## 개념 → 정본 (⭐ 먼저 여기)',
      'RFC-loop-agent-map-three-core-tiers-and-materialization-2026-10-06.md',
      'RFC-adaptive-graph-ops-2026-10-09.md',
      'RFC-adaptive-resolution-graph-traversal-2026-10-08.md',
      'RFC-tui-never-stop-survival-ladder-2026-10-27.md',
      '## 대체 · 이어짐',
    ]) {
      expect(hub).toContain(existing);
    }
  });

  test('(f) 0.2.41 첫 조각 문면이 수용선(컨트롤러 부착 지점·mock 무대)을 명시한다', () => {
    const firstPiece = rfc.slice(rfc.indexOf('## 0.2.41 첫 조각'));
    for (const token of [
      '사건 스키마',
      'TUI',
      '텔레그램',
      'fan-out',
      'onEnqueue',
      'onDrain',
      'src/ux-sim',
    ]) {
      expect(firstPiece).toContain(token);
    }
  });
});
