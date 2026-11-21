// 새 판 감지 — 판올림(데몬이 새 PWA 를 서빙)이 돼도 열린 탭은 옛 JS 로 돈다(대표 2026-09-28: 하루 열 번 넘게 판올림).
// 정적 export 는 HTML 의 RSC 머리에 빌드 id 를 `"b":"<id>"` 로 싣는다. 지금 문서의 id 와 서버가 지금 주는 HTML 의 id 를 견준다.

const BUILD_ID_RE = /\\?"b\\?":\\?"([A-Za-z0-9_-]{8,})\\?"/;

/** HTML(또는 그 안의 스크립트 문자열)에서 빌드 id 를 꺼낸다. 없으면 null — «모른다»를 «같다»로 읽지 않는다. */
export function extractBuildId(html: string): string | null {
  return BUILD_ID_RE.exec(html)?.[1] ?? null;
}

/** 새 판인가 — 둘 다 알아야 참. 한쪽이라도 모르면 배너를 띄우지 않는다(헛경보가 경보를 죽인다). */
export function isNewBuild(current: string | null, served: string | null): boolean {
  return current !== null && served !== null && current !== served;
}

export type ServedBuildProbe =
  | { kind: 'served'; id: string | null }
  | { kind: 'unavailable'; status: number }
  | { kind: 'offline' };

/**
 * Ask the surface for the build it serves — through the page the tab itself was loaded from (`pagePath`), which every
 * serving surface forwards (the bare handle host forwards only the entry documents, not `/app/`: PWA-NEWBUILD-BANNER-404).
 * A non-OK answer means this surface has no version document to compare: the caller stops polling instead of retrying every
 * two minutes into a 404.
 */
export async function probeServedBuild(
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  pagePath: string,
): Promise<ServedBuildProbe> {
  try {
    const res = await fetchImpl(pagePath, { cache: 'no-store' });
    if (!res.ok) return { kind: 'unavailable', status: res.status };
    return { kind: 'served', id: extractBuildId(await res.text()) };
  } catch {
    return { kind: 'offline' };
  }
}
