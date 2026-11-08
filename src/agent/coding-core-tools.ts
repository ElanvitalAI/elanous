import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── 코딩코어 조립기 — turn 조립기 통일 Phase 2 (2026-07-22) ──
//
// CLI(buildCliAgentTools)와 continuation-turn-runner(buildContinuationAgentTools·telegram 코딩코어)
// 가 각자 손으로 유지하던 **native 코딩코어 spec 조립**(Read/Grep/Glob/ListDir/Edit/Write)을 단일
// 출처로. continuation 주석이 "Replicates the CLI's buildCliAgentTools (kept in sync deliberately)"
// 라고 명시한 그 수동 동기화 스멜을 제거한다. 두 조립기는 동일한 resolveDynamicSessionNativeToolSpecs
// 호출(preferredSurfaceId='coding/turn'·userText='')을 문자 그대로 복제하고 있었다.
//
// ⚠️ 여기는 **spec 조립만** — Read/Write 의 실구현(file_path 스키마 native ↔ daemon-tools path 스키마)
//    병합은 Phase 4(대표 go-ahead). Bash 는 cwd 가 서피스별로 달라(CLI=process.cwd · continuation=
//    getSessionCwd) 각 조립기가 소유. PtyShell·WebSearch·L2 core 도 서피스별 조립 유지.
//
// 골든룰: buildCodingCoreNativeSpecs() 이름배열 = ['Read','Grep','Glob','ListDir','Edit','Write']
//   (양 조립기 native 블록과 diff=0). coding-core-tools.test 스냅샷 가드.



/** native 코딩코어 spec(Read/Grep/Glob/ListDir/Edit/Write) — 대시보드 'coding/turn' 서피스 프로파일과
 *  동일 경로로 해석해 CLI·continuation 이 같은 tool set·같은 가드(broad-search-block·scoped-analysis)
 *  를 공유. userText='' 로 1회 조립(호출처가 재사용). resolveDynamicSessionNativeToolSpecs 는 순수
 *  (부작용 없음)라 서피스 무관. */
export function buildCodingCoreNativeSpecs(): LLMToolSpec[] {
  const sr = require('../session-runtime/index.js') as typeof import('../session-runtime/index.js');
  const surface = sr.resolveSessionSurfaceProfile({ preferredSurfaceId: 'coding/turn' });
  return sr.resolveDynamicSessionNativeToolSpecs({
    userText: '',
    defaultFamilyIds: surface.defaultNativeFamilyIds,
    surfaceId: surface.id,
  });
}
