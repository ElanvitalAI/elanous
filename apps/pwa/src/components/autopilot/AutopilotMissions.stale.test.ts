import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MISSION_ROLLUP_UNMEASURED_HINT,
  STALE_MISSION_DAYS,
  missionRollupLabel,
  missionStaleChip,
  missionStaleHint,
  missionStaleness,
} from '../../lib/mission-staleness';

// ── MISSIONS-STALE-MARK — «멈춘 미션이 «도는 중»으로 보인다» 판정선 ─────────────
// ⚠️ 이 worktree 에는 apps/pwa/node_modules/react 가 «없다» — 실측: 기존
//    AutopilotPanel.test.tsx 도 `react/jsx-dev-runtime Cannot find module` 로 못 뜬다.
//    그래서 카드를 «렌더»할 수 없다. 대신 두 층으로 증명한다:
//      ① lib 의 «실제 함수»를 불러 ask 실측 값(07-12~07-26 → 89~75일)으로 문구를 낸다
//      ② 카드 소스의 «실제 호출 자리»를 문자열로 못 박는다(거짓 wiring 방지)
const source = readFileSync(join(import.meta.dir, 'AutopilotMissions.tsx'), 'utf8');
const libSource = readFileSync(join(import.meta.dir, '../../lib/mission-staleness.ts'), 'utf8');
const apiSource = readFileSync(join(import.meta.dir, '../../lib/autopilot-api.ts'), 'utf8');

const now = Date.parse('2026-10-09T03:00:00Z'); // ask 제출일 (12:00 KST)
const DAY = 86_400_000;
const at = (iso: string) => Date.parse(iso);
const running = { status: 'running', timeZone: 'Asia/Seoul' };

describe('AutopilotMissions — «N일 멈춤» 표지', () => {
  it('칩 문구는 ask 실측과 같다: 07-12 → «89일 멈춤 · 마지막 갱신 2026-07-12»', () => {
    expect(missionStaleChip(missionStaleness(at('2026-07-12T03:00:00Z'), now, running)!))
      .toBe('89일 멈춤 · 마지막 갱신 2026-07-12');
    expect(missionStaleChip(missionStaleness(at('2026-07-26T03:00:00Z'), now, running)!))
      .toBe('75일 멈춤 · 마지막 갱신 2026-07-26');
  });

  it('카드는 그 문구를 lib 에서 «가져온다» — 카드 안에서 조립하지 않는다', () => {
    expect(source).toContain('{missionStaleChip(stale)}');
    expect(source).toContain('title={missionStaleHint()}');
    expect(source).not.toContain('일 멈춤 · 마지막 갱신');
    expect(missionStaleHint()).toContain(`${STALE_MISSION_DAYS}일`);
  });

  it('판정 입력은 «마지막 갱신»이다 — 서버가 실은 updatedAt 을 그대로 쓴다', () => {
    expect(source).toContain(
      'const staleness = missionStaleness(m.updatedAt, Date.now(), { status: m.status });',
    );
    // 근거 없는 «멈춤» 주장 금지 — updatedAt 을 못 읽은(null) 미션은 칩을 달지 않는다
    expect(source).toContain('const stale = staleness?.stale ? staleness : null;');
    expect(apiSource).toContain('updatedAt: w.updatedAt,');
    expect(apiSource).toContain('derived: w.derived,');
  });

  it('기준(14일)은 «상수 한 곳» — lib 이 정의하고 카드는 자기 기준을 만들지 않는다', () => {
    expect(STALE_MISSION_DAYS).toBe(14);
    expect(libSource.match(/export const STALE_MISSION_DAYS/g)?.length).toBe(1);
    expect(source).toContain("} from '@/lib/mission-staleness';");
    expect(source).not.toMatch(/const\s+STALE_\w+\s*=/);
    expect(source).not.toMatch(/thresholdDays\s*:/);
    // 경계: 13일 = 안 멈춤 · 14일 = 멈춤
    expect(missionStaleness(now - 13 * DAY, now, running)!.stale).toBe(false);
    expect(missionStaleness(now - 14 * DAY, now, running)!.stale).toBe(true);
  });
});

describe('AutopilotMissions — «닫기 제안»', () => {
  it('«멈춤»이면서 자율 미션일 때만 뜬다 (사람 TOX 미션은 작업 보드로 보낸다)', () => {
    expect(source).toContain('{stale && !isHuman && (');
    expect(source).toContain('{stale && isHuman && (');
    expect(source).toContain('닫기 제안 — 작업 보드');
    expect(source).toContain('href="/tasks"');
  });

  it('기존 cancel 경로를 «재사용»한다 — 새 종료 기전을 만들지 않는다', () => {
    expect(source).toContain("await api.missionAction(m.id, 'cancel');");
    expect(source).toContain('onMutate();');
    expect(source).toContain('onClick={() => void cancel()}');
    expect(source).toContain("{cancelling ? '종료 중…' : '닫기 제안'}");
  });

  it('제안은 «확인»을 거쳐야 집행된다 (부작용 fail-closed)', () => {
    expect(source).toContain('aria-label="미션 종료 확인"');
    expect(source).toContain("{cancelling ? '종료 중…' : '종료 확인'}");
    // «닫기 제안» 버튼 자체는 cancel 을 «부르지 않는다» — 확인창을 열 뿐이다
    expect(source).toContain('onClick={() => setConfirmClose((v) => !v)}');
    expect(source).toContain('aria-expanded={confirmClose}');
    expect(source).toContain('{confirmClose && (');
  });
});

describe('AutopilotMissions — 종료 상태 ⊕ 파생 롤업', () => {
  it('«활성» 판정도 «같은» 종료 집합을 쓴다 (apm ⊕ TOX 둘 다)', () => {
    // 승인 대기(proposed)에는 확인 없는 «미션 종료»를 띄우지 않는다(승인/거절 블록이 있다).
    expect(source).toContain('{trace && !isMissionTerminalStatus(m.status) && !awaitingApproval && (');
    expect(missionStaleness(at('2026-07-12T03:00:00Z'), now, { ...running, status: 'done' })!.stale)
      .toBe(false);
    expect(missionStaleness(at('2026-07-12T03:00:00Z'), now, { ...running, status: 'completed' })!.stale)
      .toBe(false);
  });

  it('«파생 미측정»과 «파생 0»은 «다른» 값이다 — 0 은 실측, 미측정은 결손', () => {
    expect(source).toContain('<RollupChips r={m.derived} />');
    expect(source).toContain('{missionRollupLabel(r)}');
    expect(source).toContain('{...(r ? {} : { title: MISSION_ROLLUP_UNMEASURED_HINT })}');
    expect(missionRollupLabel(undefined)).toBe('파생 미측정');
    expect(missionRollupLabel(null)).toBe('파생 미측정');
    expect(missionRollupLabel({ total: 0 })).toBe('파생 0');
    expect(missionRollupLabel(undefined)).not.toBe(missionRollupLabel({ total: 0 }));
    expect(MISSION_ROLLUP_UNMEASURED_HINT).toContain('«파생 0»이 아니라');
  });
});

describe('AutopilotMissions — 보존 계약 ⊕ wiring', () => {
  it('공개 export 이름·시그니처는 그대로다', () => {
    expect(source).toContain('export function AutopilotMissions({ api }: { api: AutopilotApi }) {');
    expect(source).toContain(
      'function MissionCard({ api, m, onMutate }: { api: AutopilotApi; m: MissionSummary; onMutate: () => void }) {',
    );
  });

  it('카드는 «기존 실행 경로»에서 불린다 — 목록이 onMutate=reload 를 물려준다', () => {
    expect(source).toContain(
      '{missions.map((m) => <MissionCard key={m.id} api={api} m={m} onMutate={reload} />)}',
    );
  });
});
