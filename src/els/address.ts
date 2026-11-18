// els address — host:ws/tab/pane (DESIGN-ELS «원격 = 1급» · from GROK-2 #38132).
// No host = local. ws/tab/pane are the stage-1 ids; this stage puts the host in front.
// The remote glyph ⇄ is a UX concern and is not part of the address.

export interface ElsAddress {
  /** 빈 문자열 = 로컬(이 프로세스의 호스트). */
  readonly host: string;
  readonly ws: string;
  readonly tab: string;
  readonly pane: string;
}

const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export function formatAddress(address: ElsAddress): string {
  return `${address.host}:${address.ws}/${address.tab}/${address.pane}`;
}

/** `host:ws/tab/pane` 또는 `ws/tab/pane`. pane id 단독은 로컬 조회로 남긴다(host 없음). */
export function parseAddress(raw: string): ElsAddress | undefined {
  const text = raw.trim();
  if (text === '') return undefined;
  const colon = text.indexOf(':');
  const slash = text.indexOf('/');
  let host = '';
  let rest = text;
  if (colon > 0 && (slash < 0 || colon < slash)) {
    host = text.slice(0, colon);
    rest = text.slice(colon + 1);
    if (!HOST.test(host)) return undefined;
  }
  const parts = rest.split('/');
  if (parts.length !== 3) return undefined;
  const [ws, tab, pane] = parts;
  if (!ws || !tab || !pane) return undefined;
  if (!PART.test(ws) || !PART.test(tab) || !PART.test(pane)) return undefined;
  return { host, ws, tab, pane };
}
