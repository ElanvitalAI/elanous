// 🧪 골 저작이 «의뢰»하는 검증 시나리오 생성기.
//
// ⛔⭐ **이 셀이 있는 이유** (RFC-goal-authoring-requests-a-test-scenario §5 `T3`):
//   골은 「무엇을 만드나」는 말하고 ***「그것이 켜지면 되는지 어떻게 보나」는 말하지 않는다.***
//   📏 2026-08-20 전수: 저작된 골 중 검증 시나리오 절을 가진 것 **0건** · 그 절을 만드는 코드도 **0건**.
//   그런데 그 절을 «읽는» 파서는 goal-author.ts 에 이미 완비돼 있고, 없으면 무엇이 없는지
//   네 가지를 이름으로 댄다. ⇒ 결손은 「읽는 자」가 아니라 ***「쓰는 자」***였다.
//
// ⭐ 계약 셋 (대표 2026-08-19: *"별도 테스트 시나리오 생성 모듈에 «의뢰»를 해서 받아와야"*):
//   ⓐ 이 모듈은 «문서 조각»만 낸다 — 파일을 안 읽고 명령을 «안 돌린다». 순수 함수다.
//   ⓑ 방법론 어휘를 «여기서 발명하지 않는다» — 호출자가 레지스트리를 «인자로» 준다.
//      ⛔ 자기 목록을 가지면 같은 축에 두 어휘가 생기고 두 곳이 반씩 갱신된다.
//   ⓒ ***「없다」와 「모른다」를 안 섞는다*** — 선언이 없으면 `unknown` ⊕ `unmeasured`,
//      그리고 그 사유가 «이름»을 갖는다(`no-launch-declaration`).

/** 저작 시점에 아는 기동 선언. ⛔ 이 모듈은 이것을 «파싱하지 않는다» — 이미 파싱된 값을 받는다. */
export interface TestScenarioLaunchInput {
  readonly port?: number;
  readonly entrypoint?: string;
}

export interface TestScenarioRequestInput {
  /** 기동 선언. `null` 은 「골이 말하지 않았다」이지 「켤 것이 없다」가 아니다. */
  readonly launch: TestScenarioLaunchInput | null;
  /** 수용 기준 — 각 기준이 «어느 층에서» 확인되는지를 시나리오가 싣는다. */
  readonly acceptanceCriteria: readonly string[];
  /** ⛔ 방법론 레지스트리는 호출자가 준다(계약 ⓑ). 비어 있으면 어떤 라이브도 measured 가 될 수 없다. */
  readonly registeredMethodologies: readonly string[];
  /** 라이브 명령의 «출처» — 보통 저작 중인 골 문서의 경로. 없으면 measured 로 못 간다. */
  readonly commandSource?: string;
  /** Multiple authoritative source candidates are retained for review, never chosen by priority. */
  readonly commandSourceCandidates?: readonly string[];
}

export type TestScenarioLiveStatus = 'measured' | 'unmeasured';

export interface TestScenarioRequestResult {
  /** 골 문서에 그대로 이어 붙일 «세 절». ⛔ 최상위 `##` 여야 파서가 문다(markdownSection 계약).
   *  ⛔ 각 절은 «자기 앞뒤에 빈 줄을 갖지 않는다» — 간격은 호출자가 `join('\n\n')` 으로 준다.
   *     빈 줄을 절 안에 넣으면 앞 절이 이미 갖고 있을 때 «두 개»가 되어 절 본문이 달라진다(실측). */
  readonly sections: readonly string[];
  readonly deliverableType: string;
  readonly liveStatus: TestScenarioLiveStatus;
  /** unmeasured 일 때만 있다. 파서의 `TEST_SCENARIO_UNMEASURED_REASONS` 어휘를 쓴다. */
  readonly reason?: string;
}

/** 기동 선언으로 산출물을 켜서 보는 방법론. ⛔ 이름을 여기서 «짓지 않는다» — 레지스트리에 있어야 쓴다. */
const LAUNCH_METHODOLOGY = 'deliverable-verify';
/** 파서의 예약 어휘 — 「모른다」의 이름. */
const UNKNOWN_DELIVERABLE = 'unknown';

/**
 * 골이 아는 것만으로 검증 시나리오를 만든다.
 *
 * ⛔ 추측하지 않는다 — 기동 선언이 없으면 라이브 칸을 「아마 웹일 것이다」로 채우지 않고
 * ***사유와 함께 미측정***으로 남긴다. 그것이 없는 길을 자식에게 주지 않는 유일한 길이다.
 */
export function requestTestScenario(input: TestScenarioRequestInput): TestScenarioRequestResult {
  // ⛔ 「켤 수 있나」는 Port «또는» Entrypoint 다 — 파서가 둘 중 하나만 있어도 선언을 인정한다.
  //   ⚠️ 초판이 `port` 만 봐서 Entrypoint 만 선언한 골을 no-launch-declaration 으로 «거짓 분류»했다
  //   (리뷰 must-fix). 그 문면은 이 파일의 안내문과도 어긋났다 — 「선언했으면 됐다」라고 적어 두고 거부했다.
  const canLaunch = input.launch !== null
    && (input.launch.port !== undefined || (input.launch.entrypoint ?? '').trim() !== '');
  const methodologyAvailable = input.registeredMethodologies.includes(LAUNCH_METHODOLOGY);
  const commandSourceCandidates = [...new Set((input.commandSourceCandidates ?? [])
    .map((candidate) => candidate.trim())
    .filter((candidate) => /^[^:\s]+:[^:\s]+$/u.test(candidate)))];
  const explicitCommandSource = input.commandSource?.trim() || undefined;
  const candidateConflict = commandSourceCandidates.length > 1
    || (commandSourceCandidates.length === 1 && explicitCommandSource !== undefined && commandSourceCandidates[0] !== explicitCommandSource);
  const commandSource = candidateConflict
    ? undefined
    : explicitCommandSource || commandSourceCandidates[0];
  // Ambiguous declarations must use file:key tokens. Preserve a legacy explicit
  // document path as a labeled source token rather than emitting a malformed item.
  const explicitAmbiguityCandidate = explicitCommandSource
    ? (/^[^:\s]+:[^:\s]+$/u.test(explicitCommandSource) ? explicitCommandSource : `${explicitCommandSource}:explicit-command-source`)
    : undefined;
  const ambiguityCandidates = [...new Set([
    ...commandSourceCandidates,
    ...(candidateConflict && explicitAmbiguityCandidate ? [explicitAmbiguityCandidate] : []),
  ])];
  const commandSourceAmbiguous = candidateConflict || (!commandSource && commandSourceCandidates.length > 1);

  if (canLaunch && methodologyAvailable && commandSource) {
    return {
      sections: [
        scenarioSection(LAUNCH_METHODOLOGY, input.acceptanceCriteria),
        measuredLiveSection(LAUNCH_METHODOLOGY, commandSource, input.launch as TestScenarioLaunchInput),
        resultReportSection(),
      ],
      deliverableType: LAUNCH_METHODOLOGY,
      liveStatus: 'measured',
    };
  }

  // ⛔ 사유를 «가장 바깥 원인»으로 고른다 — 선언이 없으면 방법론·명령출처를 따질 자리가 아니다.
  const reason = commandSourceAmbiguous
    ? 'ambiguous-command-source'
    : !canLaunch
      ? 'no-launch-declaration'
    : !methodologyAvailable
      ? 'no-methodology'
      : 'no-command-source';
  return {
    sections: [
      scenarioSection(UNKNOWN_DELIVERABLE, input.acceptanceCriteria),
      unmeasuredLiveSection(reason, reason === 'ambiguous-command-source' ? ambiguityCandidates : [], reason === 'ambiguous-command-source' && candidateConflict ? explicitCommandSource : undefined),
      resultReportSection(),
    ],
    deliverableType: UNKNOWN_DELIVERABLE,
    liveStatus: 'unmeasured',
    reason,
  };
}

/** U·I 층 — ⭐ 수용 기준 하나하나가 «어느 층에서» 확인되는지 문서에서 읽히게 한다(리뷰 반복 지적). */
function scenarioSection(deliverableType: string, acceptanceCriteria: readonly string[]): string {
  const criteria = acceptanceCriteria.map((criterion) => criterion.trim()).filter((criterion) => criterion !== '');
  const unit = criteria.length === 0
    ? ['- (수용 기준이 없다 — 이 골은 U 층에서 확인할 것을 선언하지 않았다)']
    : criteria.map((criterion) => `- ${criterion} — 변경 파일 범위 게이트가 판정한다(\`elanous self gate --changed\`)`);
  return [
    '## 검증 시나리오',
    '',
    `**산출물 종류**: \`${deliverableType}\``,
    '',
    '### U. 유닛 — 코드가 무는가',
    ...unit,
    '',
    '### I. 통합 — 그 코드가 «실행 경로»에 있나',
    '- 새로 만든 것의 «호출자»를 이름으로 댄다 — 리뷰의 `[wiring]` 증거가 판정한다',
    '- ⛔ 「테스트가 통과한다」는 I 층의 답이 «아니다» — 그것은 U 층이다',
  ].join('\n');
}

/** L 층(측정 가능) — ⛔ 파서가 다섯 칸을 «전부» 요구하고 사유·후보·선결은 «금지»한다.
 *  ⛔⭐ 제목은 «정확히** `## L. 라이브` 여야 한다 — `markdownSection` 이 exact-trimmed-line 으로 찾는다.
 *  📍 그래서 「— 켜면 되나」 같은 꼬리를 붙이면 «절이 없는 것»이 된다(실측으로 잡았다). */
function measuredLiveSection(methodology: string, commandSource: string, launch: TestScenarioLaunchInput): string {
  // ⛔ Port 가 없으면 주소를 «지어내지 않는다» — 선언한 엔트리포인트가 뜨는 것까지가 이 골이 아는 전부다.
  const target = launch.port === undefined
    ? `기동 선언의 엔트리포인트(\`${(launch.entrypoint ?? '').trim()}\`)가 뜬다`
    : `http://127.0.0.1:${launch.port}/ 이 응답한다`;
  return [
    '## L. 라이브',
    '',
    '### 상태 `measured`',
    `- 방법론: \`${methodology}\``,
    `- 명령 출처: \`${commandSource}\``,
    // ⛔ 명령 인자는 «골 문서 경로»다 — 저작 시점엔 파일명이 아직 없다(제목 파생).
    //   ⇒ 자리를 이름으로 남기고, 무엇을 넣어야 하는지 «문서가 스스로» 말하게 한다.
    '- 기동: `elanous harness deliverable-verify <이 골 문서의 경로> --launch`',
    '- 눈: 그 명령이 산출물을 켜서 보고 «반드시» 끈다 — 판정은 하니스가 한다',
    `- 기대: ${target} · 관측이 결함을 내지 않는다`,
    '',
    '> ⛔ 이 칸을 «자식이 자기 화면을 찍어» 채우면 그것은 관측이 아니라 자백이다.',
  ].join('\n');
}

/** L 층(측정 불가) — ⛔ 방법론·명령출처·기동·눈·기대를 «싣지 않는다»(파서가 금지한다). */
function unmeasuredLiveSection(reason: string, candidates: readonly string[] = [], explicitSource?: string): string {
  const prerequisite = reason === 'no-launch-declaration'
    ? '골이 `## 산출물을 어떻게 켜나` 절에 `Port:` 또는 `Entrypoint:` 를 선언했으면 됐다'
    : reason === 'ambiguous-command-source'
      ? '골이 후보 중 하나를 권위 있는 명령 출처로 확정했으면 됐다'
      : reason === 'no-methodology'
        ? '호출자가 등록 방법론 레지스트리에 `deliverable-verify` 를 등록했으면 됐다'
        : '골이 권위 있는 명령 출처를 선언했으면 됐다';
  return [
    '## L. 라이브',
    '',
    '### 상태 `unmeasured`',
    `- 사유: \`${reason}\``,
    ...(reason.startsWith('ambiguous-') ? [`- 후보 목록: ${candidates.join(', ')}`] : []),
    ...(explicitSource ? [`- 원래 명시 출처(후보와 별도): \`${explicitSource}\``] : []),
    `- 무엇이 있었으면 됐나: ${prerequisite}`,
    '',
    '> ⚠️ ⛔ 「측정 불가」는 「결함 없음」이 «아니다». 이 골은 라이브 층을 «안 본 채» 끝난다.',
  ].join('\n');
}

/** ⛔ 집계는 «정확히 한 번». `-` 는 「아직 안 돌렸다」이고 측정된 0 과 «다른 값»이다. */
function resultReportSection(): string {
  return [
    '## 결과 보고 양식',
    '',
    '**집계**: 초록 `-` / 빨강 `-` / **못 잼 `-`**',
    '',
    '> ⛔ `-` 는 «미실행»이다 — 측정된 `0` 과 섞지 마라.',
  ].join('\n');
}
