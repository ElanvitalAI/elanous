// JUD #39447 HOLD(#122147) — classifyBashCommand 단위 계약: 읽기 전용 머리 허용
// 목록·파일 리다이렉션·치환·빈 명령. 보수성 계약: 알 수 없는 것은 전부 mutating.
import { describe, expect, test } from 'bun:test';
import { classifyBashCommand } from './bash-parallel-safety.js';

describe('JUD #39447 HOLD(#122147) — Bash 명령별 격리 분류', () => {
  test('읽기 전용 머리(합성 명령 포함)는 read-only', () => {
    for (const command of [
      'cat /tmp/x',
      'sleep 25',
      'echo C3_TRIO_DONE_1',
      'sleep 25; echo C3_TRIO_DONE_1',
      'ls -la | wc -l',
    ]) {
      expect(classifyBashCommand(command).kind).toBe('read-only');
    }
  });

  test('파일 리다이렉션은 mutating — `>&N` 중복도 토큰 파싱 불가로 직렬', () => {
    expect(classifyBashCommand('printf first > /tmp/pd-order-same-file').kind).toBe('mutating');
    expect(classifyBashCommand('echo x >> /tmp/log').kind).toBe('mutating');
    expect(classifyBashCommand('grep e 2> /tmp/err').kind).toBe('mutating');
    expect(classifyBashCommand('cat /tmp/x 2>&1').kind).toBe('mutating');
  });

  test('변이 유틸·치환·알 수 없는 머리·빈 명령은 mutating', () => {
    for (const command of ['rm -rf /tmp/x', 'mv /tmp/a /tmp/b', 'echo $(rm -rf /tmp/x)', 'tee /tmp/out', '']) {
      expect(classifyBashCommand(command).kind).toBe('mutating');
    }
  });
});

// JUD #39447 HOLD(#122997) · OP #123004 — 읽기 전용 머리도 쓰기/실행 인자 형식을 가질 수 있다.
// 허용 목록 방식: 각 머리의 게이트가 read-only 유지 형태만 명명하고, 그 외 형태(모르는 깃발 포함)는 판단 불가 ⇒ mutating ⇒ 직렬.
describe('JUD #39447 HOLD(#122997) — 읽기 전용 머리의 쓰기/실행 인자 형식 (OP #123004)', () => {
  test('sort -o FILE / 조합 클러스터(-ro) / --output 는 mutating', () => {
    for (const command of [
      'sort -o /tmp/out /tmp/in',
      'sort -ro /tmp/out /tmp/in',
      'sort --output=/tmp/out /tmp/in',
    ]) {
      expect(classifyBashCommand(command).kind).toBe('mutating');
    }
  });

  test('find -exec/-ok/-delete(-dir 접두 포함) 는 mutating', () => {
    for (const command of [
      'find /tmp -name "*.log" -delete',
      'find /tmp -exec rm {} +',
      'find /tmp -ok rm {} +',
      'find /tmp -maxdepth 1 -execdir cat {} ;',
    ]) {
      expect(classifyBashCommand(command).kind).toBe('mutating');
    }
  });

  test('env·printenv는 목록 밖 — 전부 직렬(기본 직렬 계약)', () => {
    expect(classifyBashCommand('env rm -rf /tmp/x').kind).toBe('mutating');
    expect(classifyBashCommand('env -i').kind).toBe('mutating');
    expect(classifyBashCommand('env FOO=1 rm /tmp/x').kind).toBe('mutating');
    expect(classifyBashCommand('env').kind).toBe('mutating');
    expect(classifyBashCommand('env FOO=1 FOO2=').kind).toBe('mutating');
    expect(classifyBashCommand('printenv PATH').kind).toBe('mutating');
  });
});

// JUD #39447 3rd HOLD(hold-39447-833c524ba42c.json) · OP #123504 — 양의 허용 목록: 기본 직렬,
// 검증된 (명령+인자 형식) 쌍만 병렬. 원시 공백 분할은 파싱된 셸 단어가 아니므로 따옴표·변수·
// 치환·glob·리다이렉트 등 파싱 불가 문법은 전부 직렬로 떨어진다.
describe('JUD #39447 3rd HOLD — 양의 허용 목록: 목록 안 병렬 / 목록 밖·모호 직렬 (OP #123504)', () => {
  test('목록 안 병렬 3종 — cat / ls|wc / sleep;echo', () => {
    expect(classifyBashCommand('cat /tmp/x').kind).toBe('read-only');
    expect(classifyBashCommand('ls -la /tmp | wc -l').kind).toBe('read-only');
    expect(classifyBashCommand('sleep 25; echo C3_TRIO_DONE_1').kind).toBe('read-only');
  });

  test('목록 밖 직렬 3종 — sort / find / env', () => {
    expect(classifyBashCommand('sort /tmp/in').kind).toBe('mutating');
    expect(classifyBashCommand('find /tmp -maxdepth 1 -type f').kind).toBe('mutating');
    expect(classifyBashCommand('env').kind).toBe('mutating');
  });

  test('해석 모호 직렬 3종 — 따옴표 / 변수 / 리다이렉트', () => {
    expect(classifyBashCommand('grep pat "/tmp/a b"').kind).toBe('mutating');
    expect(classifyBashCommand('cat $HOME/x').kind).toBe('mutating');
    expect(classifyBashCommand('cat /tmp/x 2>&1').kind).toBe('mutating');
  });

  test('목록 안도 검증된 형식만 — 클러스터/수치는 병렬, 모르는 깃발은 직렬', () => {
    expect(classifyBashCommand('head -n 5 /tmp/f').kind).toBe('read-only');
    expect(classifyBashCommand('wc -lc /tmp/f').kind).toBe('read-only');
    expect(classifyBashCommand('ls --sort=ext /tmp').kind).toBe('read-only');
    expect(classifyBashCommand('cat --unknown-flag /tmp/f').kind).toBe('mutating');
    expect(classifyBashCommand('sleep 2.5 30').kind).toBe('read-only');
    expect(classifyBashCommand('sleep 25s').kind).toBe('mutating');
    expect(classifyBashCommand('echo -n C3_TRIO_DONE_1').kind).toBe('read-only');
    expect(classifyBashCommand('echo -x unknown').kind).toBe('mutating');
  });
});

// JUD #39447 4th HOLD(OP #123678) — rg: 외부 설정(RIPGREP_CONFIG_PATH)·실행 파일 출처가
// 명령줄에서 보장되지 않으므로 허용 목록에서 제외해 직렬로 떨어진다(선택지 1 — 최소 수리).
describe('JUD #39447 4th HOLD — rg는 목록 밖: 외부 설정·실행 파일 출처 미보장 (OP #123678)', () => {
  test('rg 전부 직렬 — 플래그 형식 무관', () => {
    expect(classifyBashCommand('rg pat /tmp/f').kind).toBe('mutating');
    expect(classifyBashCommand('rg -i pat /tmp/f').kind).toBe('mutating');
    expect(classifyBashCommand('rg --type ts pat /tmp').kind).toBe('mutating');
  });
});