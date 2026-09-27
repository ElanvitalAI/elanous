import { expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { detectUrlRoute, type UrlRoutingConfig } from '../skills/url-router.js';
import { classifyFrontInput, INTAKE_FRONT_QUESTION_WORDS, type FrontClassifierInput } from './front-classifier.js';
import { decideIntakeFrontRoute } from './front-route-rules.js';

const urlRouting: UrlRoutingConfig = {
  enabled: true,
  twoStage: true,
  defaultTargets: ['obsidian'],
  guardKeywords: ['참고', '구현', '비교', '구현해', 'implement', 'fix'],
  absorbKeywords: ['흡수', 'absorb'],
  map: { youtube: 'youtube-master', x: 'omni-digest', github: 'omni-digest', web: 'omni-digest' },
  absorbSkill: 'yt-vault',
};

const surfaces: FrontClassifierInput['surface'][] = ['pwa', 'pwa-chat', 'telegram', 'tui', 'external'];
const cases: Array<{ text: string; kind: ReturnType<typeof classifyFrontInput>['kind'] }> = [
  { text: 'https://youtu.be/x', kind: 'link' },
  { text: 'https://youtu.be/x 요약', kind: 'link' },
  { text: 'https://github.com/a/b 구현해', kind: 'instruction' },
  { text: '버튼 색 고쳐', kind: 'instruction' },
  { text: '- 하나\n- 둘\n- 셋', kind: 'list' },
  { text: '이거 왜 느려?', kind: 'question' },
  { text: '오늘 회의 메모', kind: 'memo' },
];

test('같은 문장 표는 다섯 서피스에서 같은 판정·앞문 규칙·URL 라우터 결과를 낸다', () => {
  const logSpy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    for (const { text, kind } of cases) {
      const decisions = surfaces.map((surface) => classifyFrontInput({ text, surface, consent: 'route' }, { urlRouting }));
      for (const decision of decisions) {
        expect(decision).toEqual(decisions[0]);
        expect(decision.kind).toBe(kind);
        expect(decision).toMatchObject(decideIntakeFrontRoute({ text, consent: 'route' }));
        expect(decision.urlRoute).toEqual(detectUrlRoute(text, urlRouting));
      }
    }
  } finally {
    logSpy.mockRestore();
  }
});

test('hint·consent 도 기존 앞문 판정을 보존하고 서피스 판정에 영향이 없다', () => {
  const logSpy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    for (const input of [
      { text: '오늘 회의 메모', hint: 'tasks' },
      { text: '오늘 회의 메모' },
      { text: 'https://github.com/a/b 구현해', hint: 'absorb' },
    ]) {
      const expected = decideIntakeFrontRoute(input);
      const decisions = surfaces.map((surface) => classifyFrontInput({ ...input, surface }, { urlRouting }));
      for (const decision of decisions) {
        expect(decision).toMatchObject(expected);
        expect(decision).toEqual(decisions[0]);
      }
    }
  } finally {
    logSpy.mockRestore();
  }
});

test('의문 말로 끝나는 문장과 물음표는 question 이다', () => {
  const logSpy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    for (const word of INTAKE_FRONT_QUESTION_WORDS) {
      expect(classifyFrontInput({ text: `이건 ${word}`, surface: 'tui' }, { urlRouting }).kind).toBe('question');
    }
    expect(classifyFrontInput({ text: '이거 왜 느려?', surface: 'pwa-chat' }, { urlRouting }).kind).toBe('question');
  } finally {
    logSpy.mockRestore();
  }
});

test('영어 의문사는 독립된 단어일 때만 question 이다', () => {
  const logSpy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    for (const surface of surfaces) {
      expect(classifyFrontInput({ text: 'We met somewhere', surface }, { urlRouting }).kind).toBe('memo');
      expect(classifyFrontInput({ text: 'Tell me where', surface }, { urlRouting }).kind).toBe('question');
    }
  } finally {
    logSpy.mockRestore();
  }
});

test('hint 가 경로 판정을 덮어도 URL ⊕ 구현 말은 instruction 이다', () => {
  const logSpy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const text = 'https://github.com/a/b 구현해';
    const decision = classifyFrontInput({ text, surface: 'pwa', hint: 'absorb' }, { urlRouting });
    expect(decision.track).toBe('absorb');
    expect(decision.reason).toBe('hint');
    expect(decision.kind).toBe('instruction');
    expect(decision.urlRoute).toEqual(detectUrlRoute(text, urlRouting));
  } finally {
    logSpy.mockRestore();
  }
});

test('URL 자동라우팅이 꺼져도 URL 은 link 이며 로그에 원문을 쓰지 않는다', () => {
  const rows: unknown[] = [];
  const logSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    rows.push({ category, event, data });
  }) as typeof debug.log);
  try {
    const text = 'https://example.com/secret';
    const decision = classifyFrontInput({ text, surface: 'external' }, { urlRouting: { ...urlRouting, enabled: false } });
    expect(decision.kind).toBe('link');
    expect(decision.urlRoute).toBeNull();
    expect(rows).toEqual([{
      category: 'intake.front-classifier', event: 'classified',
      data: { surface: 'external', kind: 'link', track: 'absorb', urlKind: null, textLength: text.length },
    }]);
    expect(JSON.stringify(rows)).not.toContain(text);
  } finally {
    logSpy.mockRestore();
  }
});
