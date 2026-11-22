/**
 * HARNESS-GOAL-INTAKE-LINT — 골의 «다섯 칸 계약»(대표 11-22).
 *
 * 골 문서는 `## 골 계약` 절 하나에 `### <칸>` 다섯 개를 갖는다. 손·TA·판정이 나중에 범위나
 * 증거 요구를 넓히지 못하게, 발사 «입구»에서 칸이 다 있는지 본다.
 *   ⛔ 낱말을 정규식으로 «추정»하지 않는다 — 표제 줄(trim 한 줄 전체)과 목록 칸(`- 키: 값`)만 읽는다.
 */
// ⛔ goal-author 를 import 하지 않는다 — goal-author 가 이 모듈을 부르므로 순환이 된다.

/** `## 골 계약` 표제 줄부터 다음 H1/H2 앞까지(울타리 코드 안의 표제는 표제가 아니다). */
function contractSectionBody(document: string): string | null {
  const lines = document.split(/\r?\n/);
  let inFence = false;
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim();
    if (trimmed.startsWith('```')) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (start < 0) {
      if (trimmed === `## ${GOAL_CONTRACT_SECTION}`) start = index + 1;
      continue;
    }
    // 다음 H1/H2 또는 머리말 꼬리 구분선(`---` · writeAuthoredGoal 의 identity tail)에서 끝난다.
    if (trimmed === '#' || trimmed === '##' || trimmed === '---' || trimmed.startsWith('# ') || trimmed.startsWith('## ')) return lines.slice(start, index).join('\n');
  }
  return start < 0 ? null : lines.slice(start).join('\n');
}

export const GOAL_CONTRACT_SECTION = '골 계약';

export const GOAL_CONTRACT_FIELDS = ['완료선', '범위 밖=FU', '검증 예산', '판정', '라운드 상한'] as const;
export type GoalContractField = typeof GOAL_CONTRACT_FIELDS[number];

/** 각 칸의 기본 문면 — say 가 채우는 값이자 ask 거절 메시지가 보여 주는 값. */
export function goalContractDefaults(ask: string): Record<GoalContractField, string> {
  const oneLine = ask.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(' ') || '(요청 한 줄)';
  return {
    '완료선': `- M1: ${oneLine} · 증거: 시험`,
    '범위 밖=FU': '- 없음',
    '검증 예산': '- 원격 1 · pregate 1',
    '판정': '- 등급: T1 · 판정자: 1 · 보안: 불필요',
    '라운드 상한': '- r3/r5',
  };
}

export interface GoalDoneLine { readonly id: string; readonly text: string; readonly evidence: string }

/** `- <id>: <본문> · 증거: <종류>` 목록 칸. id·증거 둘 다 있어야 완료선 한 줄이다. */
function parseDoneLine(line: string): GoalDoneLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('- ')) return null;
  const item = trimmed.slice(2);
  const colon = item.indexOf(':');
  if (colon <= 0) return null;
  const id = item.slice(0, colon).trim();
  if (id.includes(' ')) return null;
  const parts = item.slice(colon + 1).split(' · ').map((part) => part.trim());
  const evidencePart = parts.find((part) => part.startsWith('증거:'));
  const evidence = evidencePart?.slice('증거:'.length).trim() ?? '';
  if (!evidence) return null;
  return { id, text: parts.filter((part) => part !== evidencePart).join(' · '), evidence };
}

export interface GoalContract {
  readonly fields: ReadonlyMap<GoalContractField, string>;
  readonly doneLines: readonly GoalDoneLine[];
}

export function parseGoalContract(document: string): GoalContract | null {
  const body = contractSectionBody(document);
  if (body === null) return null;
  const fields = new Map<GoalContractField, string>();
  let current: GoalContractField | null = null;
  let buffer: string[] = [];
  const flush = (): void => {
    if (current !== null && buffer.join('\n').trim() !== '') fields.set(current, buffer.join('\n').trim());
  };
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('### ')) {
      flush();
      const name = trimmed.slice(4).trim();
      current = (GOAL_CONTRACT_FIELDS as readonly string[]).includes(name) ? name as GoalContractField : null;
      buffer = [];
      continue;
    }
    if (current !== null) buffer.push(line);
  }
  flush();
  const doneLines = (fields.get('완료선') ?? '').split(/\r?\n/)
    .map(parseDoneLine).filter((line): line is GoalDoneLine => line !== null);
  if (doneLines.length === 0) fields.delete('완료선');
  return { fields, doneLines };
}

export function missingGoalContractFields(document: string): GoalContractField[] {
  const contract = parseGoalContract(document);
  return GOAL_CONTRACT_FIELDS.filter((field) => !contract?.fields.has(field));
}

export function renderGoalContractSection(ask: string): string {
  const defaults = goalContractDefaults(ask);
  return [`## ${GOAL_CONTRACT_SECTION}`, ...GOAL_CONTRACT_FIELDS.flatMap((field) => ['', `### ${field}`, defaults[field]])].join('\n');
}

/** say 저작물에 계약 절이 없으면 기본값으로 붙인다. 이미 있으면 손대지 않는다. */
export function withDefaultGoalContract(document: string, ask: string): string {
  if (contractSectionBody(document) !== null) return document;
  return `${document.replace(/\s*$/, '')}\n\n${renderGoalContractSection(ask)}\n`;
}

/** 이미 한 번 돈 골(오케스트레이터가 붙인 `## 실행 기록` 표제가 있다)은 옛 판으로 계속 돈다. */
export function isInFlightGoal(document: string): boolean {
  return document.split(/\r?\n/).some((line) => line.trim() === '## 실행 기록');
}

/** ask 입구 판정 — 거절이면 사람이 읽을 줄들, 통과면 null. */
export function goalIntakeRefusal(document: string): string[] | null {
  if (isInFlightGoal(document)) return null;
  const missing = missingGoalContractFields(document);
  if (missing.length === 0) return null;
  const defaults = goalContractDefaults('<요청 한 줄>');
  return [
    `harness ask: 골 계약 칸이 빠졌다 (${missing.length}/${GOAL_CONTRACT_FIELDS.length}) — \`## ${GOAL_CONTRACT_SECTION}\` 절에 아래 칸을 채운 뒤 다시 쏜다`,
    ...missing.flatMap((field) => [`  ### ${field}`, `  기본: ${defaults[field]}`]),
  ];
}
