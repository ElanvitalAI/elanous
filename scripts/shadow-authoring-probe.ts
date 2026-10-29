/**
 * SHADOW-MODEL-ARMS(0.2.44 칸) · 저작 단계 그림자 «1팔» probe — 명시 실행 전용 스크립트.
 *
 * 저작(goal-author) 단계 그림자 1팔을 `planShadowArms` 일일 상한 안에서 «실제 호출»해
 * 난이도·모델·예상/실제 비용·결과를 한 줄 원장 형식으로 stdout 에 출력한다.
 * ⛔ 관측만 한다 — 라이브 LLM(Claude 구독) 호출 0 · 골/PR/착지 파일 쓰기 0.
 * ⛔ 자동 런 훅과 다른 단계(implement·review·judge) 팔은 후속 조각이다.
 *
 * 사용(저장소 루트에서): bun scripts/shadow-authoring-probe.ts
 */
import { probeAuthoringShadowArm } from '../src/self-implement/goal-author.js';

/** 명시 실행 probe — 생산 저작 probe 경로(probeAuthoringShadowArm ⊕ probeShadowArm ⊕ planShadowArms)를 그대로 지나 한 줄을 낸다. */
export function runShadowAuthoringProbe(authorRunId = `shadow-authoring-probe-${new Date().toISOString().slice(0, 10)}`): string {
  return probeAuthoringShadowArm(authorRunId).line;
}

if (import.meta.main) {
  console.log(runShadowAuthoringProbe());
}
