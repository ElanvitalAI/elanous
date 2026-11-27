/**
 * POLICY-AWARE-GOAL-AUTHORING (0.3.38 · 대표 11-27 12:2x «골 저작 시 현재 정책들을 알고 만들어야»).
 *
 * S: 저작기(goal-author.ts)는 골을 쓸 때 운영 정책(초록 정의 · CORE 먼저 엣지 FU · 시뮬/시험 우주 완료선 ·
 *    옵션 금지 · 독립 리터럴 기대값 · 보안 4종)을 몰랐다.
 * C: 11-27 TA 스프린트 — TDD 기록 결손으로 버려진 런 5 · 저작기가 칸 완료선 밖 «시나리오 카탈로그 등록»을
 *    요구로 덧붙여 착수 단계와 충돌(BUTLER-SEC4-SCOPE 대조 실험 구현 0) · 증거 시험만 더하는 E4 칸에 RED 를 요구.
 * A: 이 모듈이 «정책 팩» 한 벌(짧은 규칙 줄 · 출처 표기)과 칸 종류(evidence | implement) 판정을 준다.
 *    저작기는 골 문서에 `- CellKind:` 메타 줄과 `### 정책 팩` 절을 싣고, TDD 계획 판정은 evidence 칸을 RED 면제로 읽는다.
 *
 * 세 얼굴: 관측 = 골 문서의 CellKind 줄·정책 팩 절(자식·리뷰어·사람이 같은 글을 본다) ·
 *          판단 근거 = 아래 리터럴(출처 문서 경로 병기) · 수복과 인계 = 정책이 바뀌면 이 표 한 곳을 고친다.
 */

export type GoalCellKind = 'evidence' | 'implement';

/** 골 문서·ask 의 명시 메타 줄. 저작기가 쓰고 하니스(TDD 판정·사전 검토·재조정)가 읽는다. */
export const GOAL_CELL_KIND_LINE = /^\s*-\s*CellKind\s*:\s*(evidence|implement)\s*$/imu;

/**
 * 칸 종류. 명시 줄이 이긴다. 없으면 E4 증거 칸 꼴(칸 ID 가 `-E4` 로 끝나거나 «E4 sim/test-universe evidence»)만 evidence 로 본다.
 * 나머지는 implement — 추측으로 evidence 를 만들지 않는다(RED 면제는 좁게).
 */
export function goalCellKind(text: string): GoalCellKind {
  const explicit = GOAL_CELL_KIND_LINE.exec(text);
  if (explicit) return explicit[1]!.toLowerCase() as GoalCellKind;
  if (/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-E4\b/u.test(text)) return 'evidence';
  if (/E4 sim\/test-universe evidence/u.test(text)) return 'evidence';
  return 'implement';
}

/** 정책 팩 — 출처: seat-state/OPS/OPS-RULES.md §판정·증거 기준·§착지 가속 · docs/manual/MANUAL-goal-authoring-method §0·§4 · FEDERATION 조직 규칙. */
export const GOAL_POLICY_PACK_LINES: readonly string[] = [
  '초록 정의: 같은 변경(head)의 영수 ⊕ 집중 시험 exit 0 이면 충분하다. 시뮬 월드·시험 우주 E4 증거는 선택이며 없으면 «<칸>-E4» FU 칸으로 넘긴다.',
  'CORE 먼저: 칸 완료선의 필수만 이 골에서 닫는다. 엣지·확장·운영 실물(-LIVE)은 «범위 밖=FU» 칸으로 쪼갠다.',
  '완료선은 시뮬 월드 또는 시험 우주(트리 실행의 --test 우주) ⊕ 합성 이벤트로 잰다. 운영 우주를 건드리는 완료선은 쓰지 않는다.',
  '옵션·깃발·단계 스위치를 만들지 않는다 — 기본 동작으로 바꾼다. 안전장치는 되돌리기 PR 이다.',
  '시험 기대값은 제품과 독립인 리터럴이다(규칙 11) — 제품 상수·렌더 함수로 기대값을 만들지 않는다.',
  '시험·tsc 는 mshq 에서 돌리지 않는다(원격 호스트 · 하니스 자식이 도는 호스트).',
  '리뷰 구속은 보안 4종(비밀·자격 / 다른 사용자 데이터 / 원격 노출 / 파괴적 삭제)만이다. 보안 4종 기준은 낮추지 않는다.',
  '보안 기본 = 완화(👑 11-27 «보안 요구사항도 과하게 넣지 마라»): 새 인증·승인·서명 관문, fail-closed 기본값, 추가 확인 단계를 만들지 않는다. 보안 4종 경로(graphs/policies/security4-paths.yaml) 밖의 보안 강화 요구는 과잉 명세다 — 요구하지도 구현하지도 않는다.',
  '저작기·자식은 칸 완료선 밖의 요구를 더하지 않는다(카탈로그 등록·새 시나리오 등록·문서 갱신 같은 부가 의무 포함). 필요하면 FU 칸으로 적는다.',
  'TDD: implement 칸은 피처 시험 RED → 구현 → 같은 명령 GREEN 을 «EVIDENCE: [tdd-red] … || 증거 명령» 다음 줄 «RESULT: …», 같은 명령의 [tdd-green] 두 줄로 남긴다. evidence 칸(증거 시험만 더함)은 RED 면제 — GREEN 기록만 남긴다.',
];

/** 골 문서에 싣는 절. 제목은 `###` — 최상위 4블록 구조(lint)를 건드리지 않는다. */
export function renderGoalPolicyPackSection(kind: GoalCellKind): string[] {
  return [
    '### 정책 팩',
    `- 칸 종류: ${kind}${kind === 'evidence' ? ' (증거 시험만 — TDD RED 면제)' : ''}`,
    ...GOAL_POLICY_PACK_LINES.map((line) => `- ${line}`),
  ];
}
