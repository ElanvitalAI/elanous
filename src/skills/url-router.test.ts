// P1 — URL→skill router. Deterministic pure-function tests.
// PLAN-url-triage-routing-2026-07-22.
import { describe, test, expect } from 'bun:test';
import { detectUrlRoute, classifyUrl, extractUrls, workContextGuardReason, type UrlRoutingConfig } from './url-router.js';
import { urlRoutingDefaults } from '../user-config.js';

const CFG: UrlRoutingConfig = {
  enabled: true,
  twoStage: true,
  defaultTargets: ['obsidian'],
  guardKeywords: ['참고', '구현', '반박', '비교', 'implement', 'fix'],
  absorbKeywords: ['absorb', '흡수', '지식화'],
  map: { youtube: 'youtube-master', x: 'omni-digest', github: 'omni-digest', web: 'omni-digest' },
  absorbSkill: 'yt-vault',
};

describe('classifyUrl', () => {
  test('youtube variants', () => {
    expect(classifyUrl('https://youtu.be/abc123')).toBe('youtube');
    expect(classifyUrl('https://www.youtube.com/watch?v=x')).toBe('youtube');
    expect(classifyUrl('https://m.youtube.com/shorts/x')).toBe('youtube');
  });
  test('x / twitter', () => {
    expect(classifyUrl('https://x.com/user/status/1')).toBe('x');
    expect(classifyUrl('https://twitter.com/user/status/1')).toBe('x');
  });
  test('github', () => {
    expect(classifyUrl('https://github.com/karpathy/nanochat')).toBe('github');
  });
  test('generic web fallback', () => {
    expect(classifyUrl('https://example.com/article')).toBe('web');
    expect(classifyUrl('not a url')).toBe('web');
  });
});

describe('extractUrls', () => {
  test('dedupes and strips trailing punctuation', () => {
    expect(extractUrls('봐 (https://x.com/a). 그리고 https://x.com/a 또'))
      .toEqual(['https://x.com/a']);
  });
  test('multiple distinct urls in order', () => {
    expect(extractUrls('https://a.com 와 https://b.com'))
      .toEqual(['https://a.com', 'https://b.com']);
  });
});

describe('detectUrlRoute', () => {
  test('bare youtube URL → youtube-master, two-stage, obsidian', () => {
    const d = detectUrlRoute('https://youtu.be/abc', CFG);
    expect(d).not.toBeNull();
    expect(d!.kind).toBe('youtube');
    expect(d!.skill).toBe('youtube-master');
    expect(d!.absorb).toBe(false);
    expect(d!.twoStage).toBe(true);
    expect(d!.targets).toEqual(['obsidian']);
  });

  test('youtube + absorb keyword → yt-vault, single-pass', () => {
    const d = detectUrlRoute('이 영상 흡수해줘 https://youtu.be/abc', CFG);
    expect(d!.skill).toBe('yt-vault');
    expect(d!.absorb).toBe(true);
    expect(d!.twoStage).toBe(false);   // absorb is the detailed endpoint
  });

  test('X URL → omni-digest', () => {
    const d = detectUrlRoute('https://x.com/u/status/1', CFG);
    expect(d!.kind).toBe('x');
    expect(d!.skill).toBe('omni-digest');
  });

  test('github URL → omni-digest', () => {
    const d = detectUrlRoute('https://github.com/a/b', CFG);
    expect(d!.skill).toBe('omni-digest');
  });

  test('guard keyword suppresses auto-fire (R5/R8) — code reference', () => {
    expect(detectUrlRoute('이 코드 참고해서 구현해줘 https://github.com/a/b', CFG)).toBeNull();
  });

  test('guard keyword suppresses — argumentative intent', () => {
    expect(detectUrlRoute('이거 요약 말고 반박해봐 https://example.com/x', CFG)).toBeNull();
  });

  test('no URL → null', () => {
    expect(detectUrlRoute('그냥 대화입니다', CFG)).toBeNull();
  });

  test('disabled → null', () => {
    expect(detectUrlRoute('https://youtu.be/abc', { ...CFG, enabled: false })).toBeNull();
  });

  test('absorb keyword only applies to youtube (x+흡수 still omni-digest)', () => {
    const d = detectUrlRoute('이 글 흡수 https://x.com/u/status/1', CFG);
    expect(d!.skill).toBe('omni-digest');
    expect(d!.absorb).toBe(false);
  });

  test('twoStage=false config → summary path single-pass', () => {
    const d = detectUrlRoute('https://youtu.be/abc', { ...CFG, twoStage: false });
    expect(d!.twoStage).toBe(false);
  });
});

// URL-ROUTE-WORK-CONTEXT-GUARD (10-22) — a URL inside a work instruction is a value, not a digest target.
describe('detectUrlRoute — work-context guard', () => {
  // The instruction as observed on 10-22 22:37 (n8n lecture session): the RSS URL is a node value.
  const OBSERVED = 'n8n 특강 단계별 영상 이어 하기(REQUEST-step-video-1022.md). 과제3 [녹화] 워크플로우 — RSS Read 노드 추가 · RSS URL https://hnrss.org/frontpage · Limit 5 · 실행 결과 촬영 → 자막 → hyperframes 로 mp4 · 과제2 재촬영 mp4 · 보너스 mp4 · 강의자료 연결. 끝까지 하고 mp4 경로 보고.';

  test('the observed n8n instruction does not route (test config and shipped defaults)', () => {
    expect(detectUrlRoute(OBSERVED, CFG)).toBeNull();
    expect(detectUrlRoute(OBSERVED, urlRoutingDefaults())).toBeNull();
    expect(workContextGuardReason(OBSERVED)).not.toBeNull();
  });

  test('field-input phrasing does not route even when short', () => {
    for (const text of [
      'RSS Read 노드의 URL 칸에 https://hnrss.org/frontpage 입력',
      'https://hnrss.org/frontpage 를 노드에 넣어줘',
      'Webhook URL 은 https://example.com/hook 로 설정해',
      'paste into the URL field: https://example.com/a',
    ]) {
      expect(detectUrlRoute(text, CFG)).toBeNull();
      expect(workContextGuardReason(text)).toMatch(/^field-input/);
    }
  });

  test('a short multi-step list carrying a URL does not route', () => {
    expect(detectUrlRoute('RSS Read · URL https://hnrss.org/frontpage · Limit 5', CFG)).toBeNull();
  });

  test('a long work instruction does not route even without field words', () => {
    const long = `${'다음 단계를 차례로 진행하고 결과를 확인한 뒤 보고해 주세요 '.repeat(5)}https://example.com/doc`;
    expect(workContextGuardReason(long)).toMatch(/^long-instruction/);
    expect(detectUrlRoute(long, CFG)).toBeNull();
  });

  test('a user config that replaces guardKeywords cannot drop the guard', () => {
    expect(detectUrlRoute(OBSERVED, { ...CFG, guardKeywords: [] })).toBeNull();
  });

  test('existing contract kept: bare URL and short summarize requests still route', () => {
    for (const text of [
      'https://hnrss.org/frontpage',
      'https://hnrss.org/frontpage 상세하게 분석해서 정리해줘. 옵시디언에 저장해줘.',
      '이거 요약해줘 https://youtu.be/abc',
      'https://x.com/u/status/1 짧게 핵심만',
    ]) {
      expect(workContextGuardReason(text)).toBeNull();
      expect(detectUrlRoute(text, CFG)).not.toBeNull();
      expect(detectUrlRoute(text, urlRoutingDefaults())).not.toBeNull();
    }
  });
});

// 재현 — URL-ROUTE-WORK-CONTEXT-GUARD 사고(10-22 22:37 KST · n8n 특강 세션 elanous-session-bif5y7).
// 관측: 작업 지시 속 «…RSS URL https://hnrss.org/frontpage · Limit 5 …»(n8n 노드에 넣을 값)를
// 결정론 라우터가 omni-digest(짧게 → 상세 · 옵시디언 저장)로 바꿔 돌렸다.
// 로그: skill.router url-route {kind:web, skill:omni-digest, url:https://hnrss.org/frontpage} → executeSkill 2단.
describe('URL-ROUTE-WORK-CONTEXT-GUARD incident 10-22 — n8n instruction with RSS URL', () => {
  // 사고 보고에 인용된 원문 조각 그대로.
  const QUOTED = '…RSS URL https://hnrss.org/frontpage · Limit 5 …';
  // 같은 세션의 후속 지시 문면으로 재구성한 원 지시(원 지시 자체는 세션 파일에 남지 않았다).
  const RECONSTRUCTED = 'n8n 특강 단계별 영상 이어 하기(REQUEST-step-video-1022.md). 과제3 [녹화] 워크플로우 — RSS Read 노드 추가 · RSS URL https://hnrss.org/frontpage · Limit 5 · 실행 결과 촬영 → 자막 → hyperframes 로 mp4 · 과제2 재촬영 mp4 · 보너스 mp4 · 강의자료 연결. 끝까지 하고 mp4 경로 보고.';

  for (const [name, text] of [['quoted fragment', QUOTED], ['reconstructed instruction', RECONSTRUCTED]] as const) {
    test(`${name}: does not route to omni-digest under the shipped defaults`, () => {
      expect(detectUrlRoute(text, urlRoutingDefaults())).toBeNull();
      expect(detectUrlRoute(text, CFG)).toBeNull();
    });
  }

  test('a URL written as a labelled value is a field value, not a digest target', () => {
    for (const text of ['RSS URL https://hnrss.org/frontpage', 'Webhook URL: https://example.com/hook', 'endpoint=https://api.example.com/v1']) {
      expect(workContextGuardReason(text)).toBe('labelled-url-value');
    }
    // A word merely ending in «url» is not a label.
    expect(workContextGuardReason('curl https://example.com')).toBeNull();
    // A label-like key INSIDE a lone URL is part of the URL, not a label (r1 must-fix).
    for (const text of ['https://example.com/?url=https://foo.com', 'https://example.com/redirect?uri=https://foo.com/x']) {
      expect(workContextGuardReason(text)).toBeNull();
      expect(detectUrlRoute(text, urlRoutingDefaults())?.skill).toBe('omni-digest');
    }
  });

  test('an explicit summarize request with a labelled URL still routes (the labelled guard must not swallow digests)', () => {
    for (const text of [
      'URL https://example.com/a 요약해줘',
      'RSS URL https://hnrss.org/frontpage 요약해줘',
      'URL: https://x.com/u/status/1 정리',
      'summarize this URL https://example.com/a',
      '이 링크 정리해줘 https://example.com/a',
    ]) {
      expect(workContextGuardReason(text)).toBeNull();
      expect(detectUrlRoute(text, urlRoutingDefaults())).not.toBeNull();
    }
    // The incident fragment has no digest word — still held back.
    expect(workContextGuardReason(QUOTED)).toBe('labelled-url-value');
  });

  test('the same URL sent alone still routes (the digest the incident ran is still reachable on purpose)', () => {
    const d = detectUrlRoute('https://hnrss.org/frontpage', urlRoutingDefaults());
    expect(d?.skill).toBe('omni-digest');
    expect(d?.url).toBe('https://hnrss.org/frontpage');
  });
});
