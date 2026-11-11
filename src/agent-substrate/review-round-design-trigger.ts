/** Advisory signal for repeated review failure modes; it never changes the review verdict. */
export type ReviewDesignCategory = 'boundary-omission' | 'boundary-bypass';

export interface ReviewDesignTransition {
  signal: 'design-transition';
  category: ReviewDesignCategory;
  round: number;
  recommendation: string;
}

/** Keep the vocabulary narrow: an unknown finding is not evidence of a repeated design issue. */
export function reviewDesignCategory(finding: string): ReviewDesignCategory | null {
  // The failed control and its target must be in the same sentence as the defect.
  // A separate missing log or test is not evidence of a missed safety boundary.
  for (const text of finding.toLowerCase().split(/[.!?。](?:\s+|$)/)) {
    const control = /경계|차단|거부|허용|펜스|fence|block|reject|allow|guard/.test(text);
    const target = /외부|파일|쓰기|명령|권한|접근|연결|websocket|worker|external|write|command|permission|access|connection/.test(text);
    if (!control || !target) continue;
    if (/허용하지 않|allow(?:s|ed)? not|does not allow/.test(text)
      && !/놓치|누락|차단하지 못|거부하지 못|걸리지 않|우회|회피|bypass|escape/.test(text)) continue;
    if (/놓치|누락|판별하지 못|분석하지 않|분석할 수 없|차단하지 못|차단하지 않|적용되지 않|누적되지 않|불투명|걸리지 않|확장 차단|shadow|scope|miss(?:ed|ing)|undecidable/.test(text)) return 'boundary-omission';
    if (/우회|회피|bypass|escape|후속.*허용|경계 밖.*허용|outside.*allow/.test(text)) return 'boundary-bypass';
  }
  return null;
}

/** Only explicit new failure surfaces establish novelty; prose changes are insufficient. */
function boundarySurfaceMarkers(finding: string): Set<string> {
  // A marker is evidence only when it belongs to the sentence describing the failed boundary.
  const defect = finding.toLowerCase().split(/[.!?。](?:\s+|$)/).filter((text) =>
    /경계|차단|거부|허용|펜스|파서|탐지식|검사|fence|block|reject|allow|guard|parser/.test(text)
    && /외부|파일|쓰기|명령|권한|접근|연결|websocket|worker|external|write|command|permission|access|connection/.test(text)
    && /놓치|누락|판별하지 못|분석하지 않|분석할 수 없|차단하지 못|차단하지 않|적용되지 않|누적되지 않|불투명|걸리지 않|확장 차단|shadow|scope|miss(?:ed|ing)|undecidable|우회|회피|bypass|escape|경계 밖.*허용|outside.*allow/.test(text));
  const text = defect.join(' ');
  const markers = new Set<string>();
  const surfaces: ReadonlyArray<[string, RegExp]> = [
    ['websocket', /websocket|웹소켓/],
    ['regex-address', /정규식|regex|regexp/],
    ['web-worker', /web worker|웹 워커/],
    ['service-worker', /서비스 워커|service worker/],
    ['shared-worker', /sharedworker|shared worker/],
    ['ip-literal', /ip 리터럴|ip literal/],
    ['localhost', /localhost/],
    ['heredoc', /heredoc/],
    ['awk', /\bawk\b/],
    ['sed', /\bsed\b/],
    ['command-substitution', /명령 치환|command substitution/],
  ];
  for (const [marker, pattern] of surfaces) if (pattern.test(text)) markers.add(marker);
  return markers;
}

export function assessReviewRoundDesignTrigger(input: {
  round: number;
  previousReviewFindings: readonly string[];
  currentFindings: readonly string[];
}): ReviewDesignTransition | null {
  // Source: .rules/30-harness/review.md; OP REVIEW-ROUND-DESIGN-TRIGGER assignment sets round three as the advisory threshold.
  if (input.round < 3) return null;
  const previous = new Map<ReviewDesignCategory, Set<string>>();
  for (const finding of input.previousReviewFindings) {
    const category = reviewDesignCategory(finding);
    if (!category) continue;
    const entries = previous.get(category) ?? new Set<string>();
    for (const marker of boundarySurfaceMarkers(finding)) entries.add(marker);
    previous.set(category, entries);
  }
  for (const finding of input.currentFindings) {
    const category = reviewDesignCategory(finding);
    if (!category) continue;
    const priorMarkers = previous.get(category);
    const currentMarkers = boundarySurfaceMarkers(finding);
    // A new named execution surface is evidence only if the finding also describes
    // an exclusive old control scope. Merely adding a name can reword one defect.
    const newIndependentSurface = [...currentMarkers].some((marker) =>
      !priorMarkers?.has(marker) && (marker === 'awk' && priorMarkers?.has('sed')
        || marker === 'sed' && priorMarkers?.has('awk')
        || marker === 'service-worker' && priorMarkers?.has('web-worker')
        || marker === 'web-worker' && priorMarkers?.has('service-worker')));
    const explicitOldScope = /(?:window\.websocket|window\s+only|window만|window\.websocket만).*(?:worker|워커)/i.test(finding);
    const newWorkerOutsideOldScope = priorMarkers?.has('websocket') && currentMarkers.has('web-worker') && explicitOldScope;
    if (!priorMarkers || (!newIndependentSurface && !newWorkerOutsideOldScope)) continue;
    return {
      signal: 'design-transition', category, round: input.round,
      recommendation: '같은 범주의 새 must-fix가 반복됐습니다. 차단 목록을 계속 늘리기 전에 허용 목록으로 설계를 전환하고, 판별 불가 입력은 fail-closed로 보존하세요.',
    };
  }
  return null;
}
