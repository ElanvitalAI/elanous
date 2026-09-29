import type { NextConfig } from 'next';
import { execSync } from 'node:child_process';

/**
 * 배포 최신 여부 구분용 build stamp — 빌드 시 1회 평가되어 `env` 로 클라이언트에
 * 인라인된다. `BuildBanner` 가 이 값을 화면 구석에 표시해 "지금 뜬 PWA 가 어느
 * 빌드인지" 를 눈으로 확인할 수 있게 한다.
 */
function gitShortSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const BUILD_TIME = new Date().toISOString();
const BUILD_SHA = gitShortSha();

/**
 * U-5 cutover (2026-05-05): static export so daemon-public-server can serve
 * `apps/pwa/out/` at `/app/*` in place of the legacy vanilla `pwa/` dir.
 *
 * `output: 'export'` produces a self-contained static SPA in `out/`.
 * All pages are pre-rendered at build time and use client-side fetch to
 * reach the daemon REST/WS endpoints — no runtime Node server needed
 * inside `elanous serve`.
 *
 * `basePath: '/app'` + `assetPrefix: '/app'` — daemon-public-server mounts
 * the export at `/app/*`, so generated <link>/<script> hrefs need the same
 * prefix or every chunk fetches `/_next/...` and 404s.
 *
 * `trailingSlash: true` — emits each route as `<name>/index.html` instead
 * of `<name>.html`. This makes `<Link href="/chat">` resolve to
 * `/app/chat/` which daemon's handleStatic serves as `chat/index.html`
 * directly (no SPA fallback to voice). Without it, `/app/chat` (no
 * extension) hits the SPA fallback and returns the index page, so all
 * sidebar nav clicks visually return to voice.
 *
 * `typedRoutes` removed — incompatible with `output: export` in Next 15.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'export',
  basePath: '/app',
  assetPrefix: '/app',
  trailingSlash: true,
  env: {
    NEXT_PUBLIC_BUILD_TIME: BUILD_TIME,
    NEXT_PUBLIC_BUILD_SHA: BUILD_SHA,
  },
  // 정적 생성 워커 상한 — Next 기본은 «CPU − 1» 이다. Pod 안에서도 호스트 코어 수(node-b = 32)가 보여 워커가
  // 최대 31 개 뜨고, 하나가 1~2.6GB 라 32Gi Pod 가 OOMKilled 됐다(2026-09-28 F-M1 런 · 🅣 가설 · 한 프로세스 최대 2.6GB 실측).
  // 4 면 이 맥(10코어)의 빌드 시간은 거의 같다. `ELANOUS_PWA_BUILD_CPUS` 로 바꿀 수 있다.
  experimental: {
    cpus: Math.max(1, Number(process.env.ELANOUS_PWA_BUILD_CPUS) || 4),
  },
};

export default nextConfig;
