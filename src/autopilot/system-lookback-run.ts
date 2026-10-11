// ── R3 시스템 소스 룩백 실행기 (셀프힐 배선 · 2026-07-13 · 대표 지시) ──────────
//
// system-lookback.ts 는 순수(의심 소스 매핑 + 프롬프트 빌더)였고, "실제 LLM 조사·소스 read 는
// 배선측이 수행"이라 명시돼 있었다. 이 모듈이 그 배선이다: 모순 신호 → 의심 소스 파일 READ-ONLY
// 발췌 → buildLookbackPrompt → 역할 audit 이 고른 모델 조사 → 결함 리포트. 수정 권한 없음(READ-ONLY).
//
// escalate(mission-tool)가 시스템 결함 의심(systemSuspect) 페이즈에서 이 러너를 호출해 결함
// 리포트를 얻고, 그 리포트를 수리 미션 골에 실어 스폰한다(system-repair-spawn). 진단 해상도 사다리
// R3 = "주어진 정보만이 아니라 시스템 소스 자체를 의심·조사"(대표 2026-07-13).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContradictionSignal } from './contradiction-detector.js';
import { buildLookbackPrompt, suspectSourceFiles } from './system-lookback.js';
import { resolveRoleLlm } from '../user-config.js';
import { debug } from '../debug/log.js';

/** R3 조사 LLM 호출 seam — 역할 audit 모델(READ-ONLY 진단). 테스트/재사용 위해 주입 가능. */
async function opusLookback(prompt: string): Promise<string> {
  const { streamLLM, resolveDefaultProvider, getProvider, PROVIDERS } = await import('../llm.js');
  const override = process.env.ELANOUS_LOOKBACK_MODEL;
  const resolved = override ? undefined : resolveRoleLlm('audit');
  const model = override || resolved!.model;
  // 명시 env 모델의 provider 선택은 종전과 동일하다.
  const provider = override
    ? (model.startsWith('claude-') ? getProvider(model) : resolveDefaultProvider(model))
    : PROVIDERS[resolved!.provider];
  const providerName = override ? provider?.name : resolved!.provider;
  if (!provider) throw new Error(`Unknown audit provider: ${providerName}`);
  debug.log('llm.role-pin', 'resolved', { site: 'system-lookback', role: 'audit', model, provider: providerName, source: override ? 'env' : resolved!.source });
  return streamLLM([{ role: 'user', content: prompt }], () => {}, {
    model, provider, usageRole: 'audit', maxTokens: 2500,
  });
}

export interface SystemLookbackResult {
  /** Opus 결함 리포트(READ-ONLY 진단 — 결함 여부·위치·수정 후보). LLM 실패 시 결정론 폴백 문자열. */
  report: string;
  /** 조사한 의심 소스 파일(읽힌 것만). */
  suspectFiles: string[];
  /** 실제 빌드된 프롬프트(관측·재현용). */
  prompt: string;
  /** LLM 조사 성공 여부(false=폴백 리포트). */
  investigated: boolean;
}

/** R3 소스 룩백 실행 — 모순 신호가 가리키는 의심 소스를 READ-ONLY 로 읽어 Opus 에게 "시스템 결함인가"를
 *  조사시킨다. fail-soft: 소스 read 실패는 skip, LLM 실패는 결정론 폴백 리포트(모순 요약)로 대체.
 *  repoRoot 미지정=process.cwd(). review seam 주입 시 그 함수로 조사(테스트 격리). */
export async function runSystemLookback(input: {
  phaseTitle: string;
  signals: readonly ContradictionSignal[];
  repoRoot?: string;
  review?: (prompt: string) => Promise<string>;
}): Promise<SystemLookbackResult> {
  const repoRoot = input.repoRoot ?? process.cwd();
  const suspectFiles = suspectSourceFiles(input.signals);
  // READ-ONLY 소스 발췌 — 읽기 실패(경로 이동 등)는 조용히 skip(진단은 남은 소스로 진행).
  const sourceExcerpts: { file: string; content: string }[] = [];
  for (const f of suspectFiles) {
    try { sourceExcerpts.push({ file: f, content: readFileSync(join(repoRoot, f), 'utf-8') }); }
    catch { /* fail-soft — 파일 없으면 skip */ }
  }
  const prompt = buildLookbackPrompt({ phaseTitle: input.phaseTitle, signals: input.signals, sourceExcerpts });

  const review = input.review ?? opusLookback;
  try {
    const report = (await review(prompt)).trim();
    if (report) return { report, suspectFiles: sourceExcerpts.map((e) => e.file), prompt, investigated: true };
  } catch { /* fail-soft → 폴백 */ }

  // 폴백 리포트(LLM 조사 실패) — 모순 요약 + 의심 소스만이라도 수리 미션이 착수할 근거로 제공.
  const fallback = [
    '⚠️ R3 Opus 조사 실패(네트워크/키/타임아웃) — 결정론 폴백 리포트.',
    `실패 페이즈: ${input.phaseTitle}`,
    '감지된 시스템 모순:',
    ...input.signals.map((s) => `- [${s.kind}] ${s.detail}`),
    `의심 소스(READ-ONLY 조사 필요): ${sourceExcerpts.map((e) => e.file).join(', ') || '(발췌 없음)'}`,
  ].join('\n');
  return { report: fallback, suspectFiles: sourceExcerpts.map((e) => e.file), prompt, investigated: false };
}
