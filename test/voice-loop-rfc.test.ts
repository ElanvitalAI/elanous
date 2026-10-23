import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { readDocContract } from '../src/ux-sim/goal-device.js';

const root = resolve(import.meta.dir, '..');
const RFC = resolve(root, 'docs/RFC-loop-agent-map-three-core-tiers-and-materialization-2026-10-06.md');

// §A11 «바깥 목소리» 가 이 조각 뒤에도 지켜야 하는 계약들. 행 수와 문면을 함께
// 고정해, 두 항목을 더하면서 기존 절을 지우거나 줄이면 이 시험이 짚는다.
const PRESERVED = [
  { label: '역할·수명 계약', rows: 5, phrases: ['| 등급 |', '**표준**', '코어 셋', '상주 판정', '공개 권한'] },
  { label: '맡는 일 넷', rows: 4, phrases: ['**피처 문서화 파이프라인**', '**외부 메시지 전략·발신**', '**특허 관리**', '**브랜드 자산**', '`ELA-53`', '2026-10-20'] },
  { label: '표면·원천·drift 계약', rows: 8, phrases: ['`elanous.ai`', '테크 블로그', 'CHANGELOG·판 노트', '소셜 채널'] },
  { label: '관계·경계', rows: 4, phrases: ['| 조율자 |', '| 바깥 목소리 |', '| 수호자 |', '| 알림 관리 담당(조율자 쪽) |'] },
  { label: '상시 공개 규칙과 판정선', rows: 4, phrases: ['측정된 결과만', '경쟁사 비교·언급은 **0**', '«곧»은 **0**', '승인 전 게시 **0**'] },
  { label: 'M0~M3 — 설계 단계와 구현 상태를 분리', rows: 4, phrases: ['**M0 계약·목록**', '**M1 근거 기반 생성**', '**M2 특허·승인 관문**', '**M3 채널 게시·drift 증명**', '현 상태'] },
  { label: '현재 구현과 계획의 경계 (읽기 근거)', rows: 4, phrases: ['`src/task-orchestrator/dispatcher.ts`', '`src/video-pipeline/broll-agent.ts`', '이 RFC 에서 주장하지 않는 것'] },
  { label: '요청 판정선 ↔ 이 RFC 의 증거 위치', rows: 6, phrases: ['§A11 «역할·수명 계약»', '§A11 «맡는 일 넷»', '의도적 문서 전용 경계'] },
] as const;

function readVoiceLoopSection() {
  return readDocContract(RFC, { section: '바깥 목소리', items: ['담당 일', '승인 경계'], preserved: PRESERVED });
}

describe('VOICE-LOOP-RFC: 바깥 목소리 루프의 담당 일·승인 경계', () => {
  it('두 항목이 §A11 에 남고 각 항목이 맡는 일과 승인 경계의 실물을 담는다', () => {
    const reading = readVoiceLoopSection();
    expect(reading.sectionFound).toBe(true);
    expect(reading.sectionHeading).toContain('A11. 바깥 목소리');
    expect(reading.missingItems).toEqual([]);
    expect(reading.ok).toBe(true);

    const [duties, boundary] = reading.items;
    expect(duties!.label).toBe('담당 일');
    expect(duties!.present).toBe(true);
    expect(duties!.rows).toBe(4);
    for (const duty of ['피처 문서화 파이프라인', '외부 메시지 전략', '특허 관리', '브랜드 자산']) {
      expect(duties!.body).toContain(duty);
    }
    for (const trail of ['DOC-GEN', 'CHANNEL-STD', '`ELA-53`', '2026-10-20', '첫 공개와 출원 여부는']) {
      expect(duties!.body).toContain(trail);
    }

    expect(boundary!.label).toBe('승인 경계');
    expect(boundary!.present).toBe(true);
    expect(boundary!.rows).toBe(4);
    for (const rule of ['승인 대기열', '② 비공개', '③ 출원', '첫 공개와 출원 결정은', '승인 전 게시 **0**']) {
      expect(boundary!.body).toContain(rule);
    }
  });

  it('후속 M0~M3 절은 네 단계와 현 상태 열을 그대로 남긴다', () => {
    const reading = readVoiceLoopSection();
    const milestones = reading.preserved.find(block => block.label.startsWith('M0~M3'));
    expect(milestones).toBeDefined();
    expect(milestones!.present).toBe(true);
    expect(milestones!.rows).toBe(4);
    expect(reading.brokenPreserved).toEqual([]);

    const stages = ['M0 계약·목록', 'M1 근거 기반 생성', 'M2 특허·승인 관문', 'M3 채널 게시·drift 증명'];
    const positions = stages.map(stage => milestones!.body.indexOf(`**${stage}**`));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);

    const rows = milestones!.lines.filter(line => line.startsWith('| **M'));
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      const status = row.split('|')[3] ?? '';
      expect(status.trim()).not.toBe('');
      expect(status).toMatch(/아직|계획|구현되지 않는다|주장하지 않는다/);
    }
  });

  it('§A11 의 나머지 계약 절은 행 수와 문면을 그대로 지킨다', () => {
    const reading = readVoiceLoopSection();
    expect(reading.preserved.map(block => block.label)).toEqual(PRESERVED.map(entry => entry.label));
    expect(reading.preserved.map(block => [block.present, block.rows]))
      .toEqual(PRESERVED.map(entry => [true, entry.rows]));
    expect(reading.brokenPreserved).toEqual([]);
  });

  it('두 항목은 다른 절을 대체하지 않고 후속 절 앞에 선다', () => {
    const reading = readVoiceLoopSection();
    const [duties, boundary] = reading.items;
    const dutiesAt = duties!.lines.join('\n');
    const boundaryAt = boundary!.lines.join('\n');
    expect(dutiesAt).not.toBe(boundaryAt);
    const sectionOrder = reading.items.map(block => block.label);
    expect(sectionOrder).toEqual(['담당 일', '승인 경계']);
    // 두 항목의 본문은 서로의 문면을 삼키지 않는다 — 경계 문면은 담당 일 쪽에 없다.
    expect(duties!.body).not.toContain('승인 대기열에서 승인된 항목만');
    expect(boundary!.body).not.toContain('DOC-GEN 사실 페이지');
  });
});