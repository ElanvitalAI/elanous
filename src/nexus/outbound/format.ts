// ── 채널별 메시지 포맷터 (2026-07-07 · 발송 팬아웃 구조) ──────────────
//
// 대표 요구: 메신저 타입별로 포맷팅이 다르게 필요. 라우터의 deliver 함수에
// 흩어져 있던 포맷 로직을 명시적 seam으로 추출 — 채널이 늘어도 여기만 확장.
// 지금은 telegram-only 운영이나 discord/pushcut 포맷도 구조로 준비.
//
// 원칙: 원본(text·markdown·kind)은 불변. 채널별 변환은 순수 함수.

export type OutboundChannelType = 'telegram' | 'discord' | 'pushcut';

export interface OutboundMsg {
  text: string;
  markdown: boolean;
  kind: string;
  /** Optional routing role; absent preserves per-kind fan-out. */
  role?: string;
}

export interface FormattedMessage {
  /** 채널에 실제 보낼 본문(단일). chunks가 있으면 그걸 우선 사용. */
  text: string;
  /** 길이 제한 분할(discord 2000 등). 없으면 text 단일 전송. */
  chunks?: string[];
  /** pushcut 등 제목 필요 채널. */
  title?: string;
  /** telegram markdown 여부(다른 채널은 plain). */
  markdown?: boolean;
}

/** Discord 웹훅 2000자 제한 — 줄 경계 분할(라우터에서 이관). */
export function chunkForDiscord(text: string, limit = 2000): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let buf = '';
  for (const line of text.split('\n')) {
    let rest = line;
    while (rest.length > limit) {
      if (buf) { chunks.push(buf); buf = ''; }
      chunks.push(rest.slice(0, limit));
      rest = rest.slice(limit);
    }
    const candidate = buf ? `${buf}\n${rest}` : rest;
    if (candidate.length > limit) { chunks.push(buf); buf = rest; }
    else buf = candidate;
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/** 채널 타입 → 포맷된 메시지. 채널별 포맷 정책의 단일 출처.
 *  - telegram: 원문 + markdown 플래그(sendTelegramReport가 3900자 분할 처리).
 *  - discord:  plain(markdown 폴백) + 2000자 분할.
 *  - pushcut:  제목("elanous <kind>") + 본문(아이폰 네이티브 푸시). */
export function formatForChannel(type: OutboundChannelType, msg: OutboundMsg): FormattedMessage {
  switch (type) {
    case 'telegram':
      return { text: msg.text, markdown: msg.markdown };
    case 'discord':
      return { text: msg.text, chunks: chunkForDiscord(msg.text), markdown: false };
    case 'pushcut':
      return { text: msg.text, title: `elanous ${msg.kind}` };
    default:
      return { text: msg.text };
  }
}
