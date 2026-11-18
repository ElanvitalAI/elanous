/**
 * MEMBER-BOARD-WEBCHAT-ENTRY (OP79819): the one web-chat entry a member reaches from the board and
 * right after claiming a handle. A same-origin, basePath-relative link with no query keeps the HttpOnly
 * member session cookie and never carries a token in the URL.
 */
export const MEMBER_WEBCHAT_PATH = '/app/chat/';
export const MEMBER_WEBCHAT_LABEL = '웹채팅 시작';
