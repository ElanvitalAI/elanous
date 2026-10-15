// ⛔ 인자 계약의 «단위» 시험 — CLI 를 spawn 하는 시험과 «다른 층»이다.
//   scripts/lib/argv.test.ts 와 같은 결: 계약 자체를 in-process 로 누른다(빠르고,
//   종료코드가 아니라 «값»을 본다). 스크립트 탑레벨 배선은 형제 샤드(task:d0183079b142)의
//   몫 — 여기는 정의만 누른다.
import { describe, expect, it } from 'bun:test';
import { parseNarrativeModelArg } from './morning-report-options.js';

describe('parseNarrativeModelArg — 명시 서사 모델', () => {
  it('띄어 쓴 철자(--narrative-model X)에서 값을 그대로 돌려준다', () => {
    expect(parseNarrativeModelArg(['--narrative-model', 'model-x'])).toBe('model-x');
  });

  it('붙여 쓴 철자(--narrative-model=X)를 «같게» 읽는다', () => {
    expect(parseNarrativeModelArg(['--narrative-model=model-x'])).toBe('model-x');
  });

  it('플래그가 없으면 undefined — 기본 provider 경로가 보존된다', () => {
    expect(parseNarrativeModelArg([])).toBeUndefined();
  });

  it('스크립트의 다른 플래그가 섞여 있어도 모델 값을 오염 없이 읽는다', () => {
    expect(parseNarrativeModelArg(['--dry', '--narrative-model', 'model-x'])).toBe('model-x');
    expect(parseNarrativeModelArg(['--no-narrate', '--no-upload'])).toBeUndefined();
  });

  it('명시한 모델의 값이 없으면 오류 — 기본 모델로 조용히 대체하지 않는다', () => {
    expect(() => parseNarrativeModelArg(['--narrative-model']))
      .toThrow("'morning-report' 에서 --narrative-model 에 값이 없다");
    expect(() => parseNarrativeModelArg(['--narrative-model=']))
      .toThrow("'morning-report' 에서 --narrative-model 에 값이 없다");
  });
});
