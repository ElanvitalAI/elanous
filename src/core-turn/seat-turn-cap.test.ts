// SEAT-TURN-CAP-DEFAULT-15M (#38786) — JUD must ⓐ 수리(20261119-0319-JUD-CONFIRM-38786):
// 삭제된 seat-turn-cap-role.test.ts 가 살아 있는 함수의 불변식 시험까지 지웠다.
// seatCapCheckpoint 2 + readSeatRuntime 3 시험을 원문 그대로 이동해 온다.
// (resolveSeatTurnCapForRole·seatRegistryRuntime 시험은 함수 자체가 삭제돼 함께 갔다.)
// 원본: d826cc0586 src/core-turn/seat-turn-cap-role.test.ts — 출처: #38786
//
// 규칙 11(07:4x 회고): 시험 기대값은 제품과 독립 — 상수·렌더 함수 재사용 없이 독립 리터럴만.
// 판정자가 같은 명령으로 같은 수를 얻어야 서명한다.
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSeatRuntime } from './seat-registry-runtime.js';
import { seatCapCheckpoint } from './seat-turn-cap.js';

describe('seatCapCheckpoint — 체크포인트 유무 판정표', () => {
  // 행 = 요약(빈 · 있음 · 1500자 초과). 기대값은 독립 리터럴(표식·자를 길이 포함).
  it('빈 요약은 표식 없이, 요약이 있으면 [CHECKPOINT] 표식과 함께 실린다', () => {
    expect(seatCapCheckpoint('')).toBe('');
    expect(seatCapCheckpoint('  \n  ')).toBe('');
    expect(seatCapCheckpoint('남은 일: 배선 하나')).toBe('\n[CHECKPOINT]\n남은 일: 배선 하나');
  });

  it('긴 요약은 1500자에서 잘라 말줄임표를 붙인다', () => {
    expect(seatCapCheckpoint('x'.repeat(2000))).toBe(`\n[CHECKPOINT]\n${'x'.repeat(1500)}…`);
  });
});

describe('readSeatRuntime — 실제 레지스트리 파일(v1·v2)', () => {
  it('v2 파일에서 자리의 runtime 을 읽고, 없는 자리는 undefined 다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seat-runtime-v2-'));
    try {
      const file = join(dir, 'seat-registry.json');
      writeFileSync(file, JSON.stringify({
        version: 2,
        seats: [
          { address: 'HAND-ELN-ELS-API', host: 'local', runtime: 'eln', delivery: 'queue', replyBody: 'agent', optIn: false },
          { address: 'HAND-CLAUDE-MSG', host: 'local', runtime: 'external-cli', delivery: 'adapter', session: 'w4:pB', replyBody: 'agent', optIn: false },
        ],
      }));
      expect(readSeatRuntime('HAND-ELN-ELS-API', { registryPath: file })).toBe('eln');
      // 자리 이름은 대소문자·공백을 정규화해 찾는다.
      expect(readSeatRuntime(' hand-eln-els-api ', { registryPath: file })).toBe('eln');
      expect(readSeatRuntime('HAND-CLAUDE-MSG', { registryPath: file })).toBe('external-cli');
      expect(readSeatRuntime('ABSENT-9', { registryPath: file })).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('v1 파일도 v2 로 정규화해 읽는다 — runtime=eln 자리만 구현 손, 빈칸은 external-cli', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seat-runtime-v1-'));
    try {
      const file = join(dir, 'seat-registry.json');
      writeFileSync(file, JSON.stringify({
        version: 1,
        seats: [
          { address: 'HAND-ELN-ELS-API', host: 'local', target: 'wX:p1', wake: 'herdr', replyBody: 'agent', optIn: true, runtime: 'eln' },
          { address: 'HAND-TUI-D', host: 'mshq', target: 'w4:pB', wake: 'herdr', replyBody: 'agent', optIn: true, runtime: 'claude-code' },
        ],
      }));
      expect(readSeatRuntime('HAND-ELN-ELS-API', { registryPath: file })).toBe('eln');
      expect(readSeatRuntime('HAND-TUI-D', { registryPath: file })).toBe('external-cli');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('파일 없음·깨진 JSON 은 undefined(= 운영 상한)다 — 상한이 자리 턴을 막아선 안 된다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seat-runtime-absent-'));
    try {
      expect(readSeatRuntime('HAND-ELN-ELS-API', { registryPath: join(dir, 'nope.json') })).toBeUndefined();
      const broken = join(dir, 'seat-registry.json');
      writeFileSync(broken, '{ not json');
      expect(readSeatRuntime('HAND-ELN-ELS-API', { registryPath: broken })).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
