// ── 최소 PATH 보강 (2026-07-25) ───────────────────────────────────────────
// cron/launchd 는 최소 PATH(/usr/bin:/bin)로 프로세스를 띄운다. elanous 내부 subprocess 호출
// (execFileSync('gh', …)·git 등)은 bare 커맨드라, homebrew/local 바이너리가 PATH 에 없으면 ENOENT 로
// **무음실패**한다 — 예: review-watch 크론이 `gh`(/opt/homebrew/bin/gh)를 못 찾아 fetchLabeledOpenPrs 가
// catch→[] → 라벨 PR 이 항상 prs:0·triggered:0 → 무인 리뷰 파이프라인 통째 사문화. B1(#5342)은 elanous/bun
// 진입점 절대경로만 고쳤고 내부 gh/기타 subprocess 는 여전히 PATH 의존이었다.
//
// 여기서 표준 bin 디렉토리를 process.env.PATH 에 **없을 때만 append**(기존 우선순위 무접촉·이미 있으면
// no-op). index.ts 최상단에서 import 되어 어떤 커맨드보다 먼저 1회 실행된다.
import { homedir } from 'node:os';

/** cron/launchd 최소 PATH 에서도 gh/git/bun 등을 찾도록 append 할 표준 bin 디렉토리 후보.
 *
 * 🩸⛔⭐⭐ **2026-09-03 실측: 이 목록이 «외부 코딩 CLI 둘»을 못 찾고 있었다.**
 * ```
 * 📏 맥(운영)에서 cron 최소 PATH + 이 목록으로 실제 탐색:
 *    codex  ✅ /opt/homebrew/bin/codex      ⇐ 후보에 있다
 *    claude ⛔ ***못 찾는다***               ⇐ ~/.local/bin 에 산다(후보에 «없었다»)
 *    grok   ⛔ ***못 찾는다***               ⇐ ~/.local/bin → ~/.grok/downloads/…
 * ```
 * 🔑 ***그래서 무인(cron/launchd) 경로에서는 `claude`·`grok` 백엔드가 「바이너리 부재」로 죽고
 *    `codex` 만 살아남았다*** — 「codex 로만 간다」가 «설정»이 아니라 «PATH» 문제였을 수 있다.
 * ⚠️ `src/agent-mission/driver.ts` 의 grok 주석이 이것을 ***예언***해 뒀다:
 *    *"바이너리는 xAI install.sh 가 ~/.grok/bin/grok 에 둔다 — 최소 PATH 에선 ensure-bin-path 보강 필요할 수 있음"*.
 *    ⇒ 예언만 있고 «후보에는 안 들어와 있었다».
 * ⛔ append 전용이라 기존 항목·우선순위는 무접촉 — 이미 있으면 skip 한다(아래 함수).
 */
export const CANDIDATE_BIN_DIRS: readonly string[] = [
  '/opt/homebrew/bin', // macOS ARM homebrew (gh 등)
  '/usr/local/bin',    // macOS Intel homebrew / 수동 설치
  `${homedir()}/.bun/bin`,
  // 🆕 사용자 설치 CLI — claude(install.sh) · codex(npm prefix=~/.local) · grok(심링크).
  //    ⚠️ Linux VM(엘라누스봇)에서도 같은 자리다: claude·codex = ~/.local/bin.
  `${homedir()}/.local/bin`,
  // 🆕 grok 은 xAI install.sh 가 «자기 디렉토리»에 둔다 — Linux 에서는 ~/.local/bin 심링크가 «없을 수» 있다.
  `${homedir()}/.grok/bin`,
  '/usr/bin',
  '/bin',
];

/**
 * env.PATH 에 없는 표준 bin 디렉토리만 뒤에 append 한다. 기존 항목·우선순위는 무접촉(이미 있으면 skip).
 * @returns 변경 여부(테스트/관측용).
 */
export function ensureBinPath(
  env: NodeJS.ProcessEnv = process.env,
  candidates: readonly string[] = CANDIDATE_BIN_DIRS,
): boolean {
  const cur = (env.PATH ?? '').split(':').filter(Boolean);
  const seen = new Set(cur);
  let changed = false;
  for (const dir of candidates) {
    if (!seen.has(dir)) { cur.push(dir); seen.add(dir); changed = true; }
  }
  if (changed) env.PATH = cur.join(':');
  return changed;
}

// import 시점 즉시 보강 — 어떤 CLI 커맨드/subprocess 호출보다 먼저.
// Isolated CLI integration tests can supply the candidate list without inheriting host tools.
const testCandidateOverride = process.env.NODE_ENV === 'test'
  ? process.env.ELANOUS_TEST_BIN_PATH_CANDIDATES
  : undefined;
ensureBinPath(process.env, testCandidateOverride === undefined ? CANDIDATE_BIN_DIRS : testCandidateOverride.split(':'));
