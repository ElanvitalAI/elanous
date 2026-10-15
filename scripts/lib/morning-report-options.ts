// ── morning-report 스크립트 CLI 인자 — 명시 서사 모델(--narrative-model) ────────
//
// scripts/morning-report.ts 는 지금 인자를 process.argv.includes(...) 인라인으로 읽는다
// (--dry · --no-narrate · --no-upload). 이 파일은 그 스크립트의 인자 계약을 일반 파서
// scripts/lib/argv.ts#parseArgv 위에 정의한다. 계약이 스크립트의 네 플래그를 «전부» 아는
// 것은, 이 헬퍼가 «스크립트 CLI 인자» 전체를 받아 모델 값만 뽑는 목적이어서다 —
// 다른 플래그가 섞인 실제 argv 가 들어와도 모델 값에 오염이 없다.
//
// 반환 계약 — src/domains/morning-report.ts#MorningReportOpts.model 에 그대로 꽂힌다:
//   · '--narrative-model X' / '--narrative-model=X' 두 철자를 «같게» 읽어 값 문자열 반환.
//   · 플래그가 없으면 undefined — src/domains/morning-essential.ts 의 기본 provider
//     경로(model 미지정 ⇒ providerFor(cfg))를 그대로 보존한다. 값이 없거나 빈 값이면
//     parseArgv 오류를 던져 기본 모델로 조용히 실행되지 않도록 한다.
//
// ⛔ 의도된 경계(비연결 선언): 이 유닛은 «정의 + 단위시험» 에서 멈춘다.
//   scripts/morning-report.ts 탑레벨(CLI 진입) → composeMorningReport(..., { model }) 배선은
//   의존 형제 샤드(task:d0183079b142)의 몫이다. 지금 이 유닛을 실행 경로에서 부르는 곳은
//   scripts/lib/morning-report-options.test.ts(bun test, in-process) 다.

import { parseArgv, type ArgvContract } from './argv.js';

/** morning-report 스크립트의 전체 CLI 플래그 — 파서 계약(여기 없는 플래그는 거부된다). */
const MORNING_REPORT_ARGV: ArgvContract = {
  known: {
    '--dry': 'bool',
    '--no-narrate': 'bool',
    '--no-upload': 'bool',
    '--narrative-model': 'value',
  },
  label: 'morning-report',
};

/**
 * 아침 브리핑 시장서사의 명시 LLM 모델(--narrative-model)을 argv 에서 뽑는다.
 * 플래그가 없으면 undefined — undefined 자체가 «기본 provider 경로» 값이다.
 */
export function parseNarrativeModelArg(argv: string[]): string | undefined {
  const parsed = parseArgv(argv, MORNING_REPORT_ARGV);
  if (parsed.errors.length > 0) throw new Error(parsed.errors.join('\n'));
  return parsed.values['narrative-model'];
}
