import type { EnvProfile } from './env-profile.js';

export interface RungChoice {
  rung: 1 | 2 | 3 | 4 | 5;
  tool: string | null;
  install: string[];
  reason: string;
}

/** Selects a display-only starting rung; installation and execution belong to separate commands. */
export function chooseRung(mission: string, profile: EnvProfile): RungChoice {
  if (!mission.trim()) throw new Error('mission must not be empty');
  const has = (tool: string) => profile.tools.includes(tool);
  const choose = (rung: RungChoice['rung'], tool: string | null, reason: string): RungChoice => ({
    rung, tool, install: tool !== null && !has(tool) ? [tool] : [], reason,
  });

  if (/리팩터|refactor|다른 눈|second (?:opinion|review)|large|대규모/i.test(mission)) {
    return choose(5, 'codex', '큰 구현 또는 독립 리뷰에는 외부 코딩 에이전트');
  }
  if (/코드|수정|추가|구현|테스트|시험|bug|fix|implement|code|test/i.test(mission)) {
    return choose(4, null, '코드 변경과 검증에는 Elanous 하니스');
  }
  if (/\b(?:csv|json|text|convert|transform)\b|변환|합계/i.test(mission)) {
    return choose(1, /\bjson\b|JSON|csv|CSV/i.test(mission) ? 'jq' : 'awk', '텍스트 변환은 셸 도구로 시작');
  }
  if (/\b(?:video|gif|audio|ffmpeg)\b|영상|동영상|음성/i.test(mission)) {
    return choose(1, 'ffmpeg', '미디어 변환은 셸 도구로 시작');
  }
  if (/\b(?:pull request|PR|draft|github)\b|깃허브|풀리퀘스트/i.test(mission)) {
    return choose(2, 'gh', 'GitHub 조회는 도메인 CLI로 시작');
  }
  if (/로그|logs?|memory|기억/i.test(mission)) {
    return choose(3, null, 'Elanous 관측·기억 능력으로 시작');
  }
  return choose(3, null, '명확한 하위 도구가 없어 Elanous 능력에서 시작 (실행 전 확인 필요)');
}
