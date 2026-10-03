const PRIVATE_MARKERS = /\u{1F451}|`[^`]+`|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b|\/Users\/|\/(?:home|root)\/|\/\.ssh\/|~\/\.elanous|elt_|\$\s*[-+]?\d[\d,.]*|run-[0-9a-f]{8}\b|\b(?:test|mirror):|\b(?:account|remote)-\d+\b|\bmsb\d+\b|\.ts\.net\b|\bgcpvm\b|user|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/iu;

export function seatLineIsPublicSafe(text: string): boolean {
  return !PRIVATE_MARKERS.test(text);
}

/** 조율 채널 글 첫 줄(`**[UX]** 2026-10-02 15:51 KST → OP TC · 본문`)에서 신원·시각·받는 이 머리표를 걷어 «본문»만 남긴다.
 *  머리표가 없으면 그대로 둔다. 화면(운영자·공개 둘 다)이 «지금 한 줄»에 쓴다. */
export function seatNowLine(text: string): string {
  const stripped = text
    .replace(/^\s*\*\*\[[A-Za-z]{1,4}\]\*\*\s*/, '')
    .replace(/^(?:\{\{TS\}\}|\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:KST)?)\s*/, '')
    .replace(/^→\s*(?:(?:[A-Z]{2,4}|전원|전체)(?=[\s·,(]|$)[\s·,]*)+/u, '')
    // `→ OP — 보고 · …`: the dash and kind word after the recipients are header too (10-03 board showed «— 보고 · …»).
    .replace(/^—\s*/, '')
    .replace(/^(?:보고|요청|정정|결정|사고|안내)\s*·\s*/, '');
  return (stripped.trim() || text.trim()).replace(/\*\*/g, '');
}

/** 공개 화면에서는 PR 번호(`#22745`)를 «PR» 로 바꾼다 — 번호는 내부 표지다(설계 #22746 §3). */
export function maskPublicRefs(line: string): string {
  return line.replace(/#\d{4,6}\b/g, 'PR');
}
