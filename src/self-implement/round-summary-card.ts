export interface RoundSummaryEntry {
  /** The round whose result this entry records; zero is the first implementation. */
  round: number;
  kind: 'gate' | 'review';
  tried?: string;
  failedIds?: readonly string[];
  filesTouched?: readonly string[];
  rung?: string;
  premiseFindings?: readonly string[];
}

const HEADER = '[라운드 요약 카드 — 이미 해 본 수와 결과]';

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function list(items: readonly string[] | undefined): string {
  return items === undefined ? '못 쟀다' : items.length === 0 ? '0건' : items.map(singleLine).join(', ');
}

function failureKey(entry: RoundSummaryEntry): string | undefined {
  return entry.failedIds?.length ? JSON.stringify([...new Set(entry.failedIds)].sort()) : undefined;
}

/** Only recorded results are rendered; no filesystem or runtime state is consulted. */
export function renderRoundSummaryCard(entries: readonly RoundSummaryEntry[], { maxChars = 1500 }: { maxChars?: number } = {}): string {
  if (!entries.length) return '';
  const lines = entries.map((entry) => `라운드 ${entry.round} · ${entry.kind} · 해 본 수: ${entry.tried === undefined ? '못 쟀다' : singleLine(entry.tried)} · 실패 id: ${list(entry.failedIds)} · 손댄 파일: ${list(entry.filesTouched)}`
    + (entry.rung === undefined ? '' : ` · rung: ${singleLine(entry.rung)}`)
    + (entry.premiseFindings === undefined ? '' : ` · premiseFindings: ${list(entry.premiseFindings)}`));
  const lastKey = failureKey(entries[entries.length - 1]!);
  const prior = lastKey === undefined ? undefined : entries.slice(0, -1).find((entry) => failureKey(entry) === lastKey);
  const guidance = prior === undefined ? '' : [
    `이 실패 집합은 라운드 ${prior.round} 에서도 같았다 — 같은 수 대신 다른 칸을 열 수 있다.`,
    '이렇게 하라: (F1) base(origin/main)에서 같은 시험을 돌려 원래 깨진 것인지 보고, 호출자와 `git log -S <심볼>`로 선례를 보라.',
    '(F2) docs/의 매뉴얼·FINDING에서 같은 증상을 찾아라. 원인이 이 골의 범위 밖이라면 근거(파일:줄·명령 출력)를 PR 본문 «남은 것»에 적어라.',
  ].join('\n');
  const render = (omitted: number) => [HEADER, ...(omitted ? [`…(앞 라운드 ${omitted}개 생략)`] : []), ...lines.slice(omitted), ...(guidance ? [guidance] : [])].join('\n');
  let omitted = 0;
  while (omitted < lines.length - 1 && render(omitted).length > maxChars) omitted++;
  const card = render(omitted);
  if (card.length <= maxChars) return card;
  // Reserve the repeated-failure actions before truncating the latest round's details.
  const latestEntry = entries[entries.length - 1]!;
  const latest = lines[lines.length - 1]!;
  const identity = `라운드 ${latestEntry.round} · ${latestEntry.kind}`;
  const marker = omitted ? `…(앞 라운드 ${omitted}개 생략)\n` : '';
  const heading = `${HEADER}\n`;
  const prefix = heading.length + marker.length + identity.length <= maxChars ? heading + marker
    : heading.length + identity.length <= maxChars ? heading
    : '';
  const available = Math.max(0, maxChars - prefix.length);
  if (available < identity.length) return identity.slice(0, available);
  const fullAdvice = guidance ? `\n${guidance}` : '';
  const shortAdvice = prior ? `\n라운드 ${prior.round} 실패 반복 — base 시험을 확인하고 다른 칸을 열어라.` : '';
  const advice = identity.length + fullAdvice.length <= available ? fullAdvice
    : identity.length + shortAdvice.length <= available ? shortAdvice : '';
  const resultBudget = available - advice.length;
  const visible = latest.length <= resultBudget ? latest
    : resultBudget > identity.length ? `${latest.slice(0, resultBudget - 1)}…` : identity;
  return prefix + visible + advice;
}
