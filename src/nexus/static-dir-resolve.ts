// NEXUS · PWA static dir auto-detect (Track P · P.1 · 2026-05-07)
//
// `runNexus` 가 boot 시 `apps/pwa/out` 를 자동 detect 해서
// `startNexusHttpServer({staticDir})` 에 전달. T5.A 의 static handler 가
// production 부트에서도 활성화 → /app/* 가 PWA UI 서빙.
//
// Detect 후보 path (앞에서부터 try):
//   1. repo dev path: <bin>/../apps/pwa/out (bun run dev 환경)
//   2. npm install path: <bin>/../share/elanous/pwa-out (향후 npm 패키지
//      배포 시 packaged static export)
//
// 두 후보 모두 부재 시 undefined → http-server 가 staticDir 미wired 로
// 부팅 (`/app/*` 404). P.2 의 banner hint 가 "elanous nexus pwa build" 안내.

import { existsSync, realpathSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';

export interface ResolvePwaStaticDirOpts {
  /** Override the candidate roots (test seam). When set, only these
   *  paths are tried in order. */
  candidates?: string[];
  /** Override existsSync (test seam). */
  exists?: (path: string) => boolean;
  /** Override `process.argv[1]` (test seam). */
  argvBin?: string;
  /** Override `process.env` (test seam) — `ELANOUS_PWA_STATIC_DIR` is read from here. */
  env?: NodeJS.ProcessEnv;
}

/** Resolve the PWA static export directory. Returns absolute path or
 *  `undefined` when no candidate exists. Order = repo dev path first,
 *  npm install path second. */
export function resolvePwaStaticDir(opts: ResolvePwaStaticDirOpts = {}): string | undefined {
  const exists = opts.exists ?? existsSync;
  // ⭐ 명시 지정이 먼저 — 설치본 패키지엔 `apps/` 가 없어서(package.json `files`) 실행 파일 옆 후보가 «늘» 비어 있다.
  //   종전엔 부팅(`nexus/index.ts`)만 이 env 를 보고 headless 셋업 검사는 안 봐서, 설치본 데몬이 «PWA 미빌드»로
  //   exit 1 → launchd 가 10초마다 다시 띄우는 크래시 루프에 빠질 자리였다(2026-09-24 · 재시작 최소화 RFC S2).
  const explicit = (opts.env ?? process.env).ELANOUS_PWA_STATIC_DIR?.trim();
  if (!opts.candidates && explicit && exists(explicit)) return explicit;
  const candidates = opts.candidates ?? defaultCandidates(opts.argvBin ?? process.argv[1] ?? '');
  for (const path of candidates) {
    if (exists(path)) return safeRealpath(path);
  }
  return undefined;
}

/** Default candidates derived from the running binary's location. */
function defaultCandidates(argvBin: string, real: (p: string) => string = safeRealpath): string[] {
  if (!argvBin) return [];
  // 🩸 2026-09-24: 설치본은 `~/.local/share/elanous/bin/elanous` 심링크로 불린다 — 그 폴더 옆엔 `apps/` 가 없다.
  //    패키지는 이제 `apps/pwa/out/` 을 싣는다(package.json files) ⇒ 실경로(`…/elanous/bin/elanous.mjs`) 옆도 본다.
  const bins = [...new Set([argvBin, real(argvBin)])];
  return bins.flatMap((bin) => {
    const binDir = dirname(bin);
    return [
      // Dev: <repo>/src/index.ts (bun) → <repo>/apps/pwa/out · 설치본: <pkg>/bin/elanous.mjs → <pkg>/apps/pwa/out
      joinPath(binDir, '..', 'apps/pwa/out'),
      // Future npm install: <prefix>/bin/elanous → <prefix>/share/elanous/pwa-out
      joinPath(binDir, '..', 'share/elanous/pwa-out'),
    ];
  });
}

function safeRealpath(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}
