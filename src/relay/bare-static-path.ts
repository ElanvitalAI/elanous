// MK #109530 — bare 핸들 호스트에서 PWA 정적 빌드 산출물(/app/_next/static/**,
// 아이콘, manifest)만 무쿠키로 회원 Nexus 에 포워드하기 위한 단일 판정.
// 릴레이(포워드/게이트)와 Nexus(서빙) 양쪽이 같은 함수를 쓴다 — 허용 집합이 갈라지지 않게.
// 해시된 빌드 산출물이라 비밀이 없다. GET/HEAD 만, 경로 탈출(.., 인코딩, 백슬래시) 거부.

const STATIC_PREFIXES = ["/app/_next/static/", "/app/icons/", "/app/fonts/"] as const;
const STATIC_EXACT = new Set(["/app/manifest.webmanifest"]);

export function isBareStaticAssetRequest(
  method: string,
  pathname: string,
): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  // 해시 산출물 경로에는 % · \ · NUL 이 없다 — 인코딩된 탈출 시도는 통째로 거부.
  if (/[%\\\0]/.test(pathname)) return false;
  if (!STATIC_EXACT.has(pathname)) {
    const prefix = STATIC_PREFIXES.find((p) => pathname.startsWith(p));
    if (!prefix || pathname.length === prefix.length) return false;
  }
  if (!pathname
    .split("/")
    .slice(1)
    .every((segment) => segment !== "" && segment !== "." && segment !== "..")) return false;
  if (pathname.startsWith("/app/_next/static/")) {
    // Next emits these two fixed manifest names under a per-build directory.
    if (/^\/app\/_next\/static\/[A-Za-z0-9_-]+\/_(?:build|ssg)Manifest\.js$/.test(pathname)) return true;
    const match = /^\/app\/_next\/static\/(?:[A-Za-z0-9_-]+\/)*([A-Za-z0-9_.-]+)\.(js|css|woff|woff2|ttf)$/.exec(pathname);
    return !!match && /[a-f0-9]{8,}/i.test(match[1]!);
  }
  if (pathname.startsWith("/app/icons/")) return /\.(?:png|jpg|jpeg|gif|ico|svg)$/i.test(pathname);
  if (pathname.startsWith("/app/fonts/")) return /\.(?:woff|woff2|ttf)$/i.test(pathname);
  return STATIC_EXACT.has(pathname);
}
