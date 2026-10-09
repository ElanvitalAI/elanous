#!/usr/bin/env bun
/**
 * f-session-monitor.ts — 🅕 세션 «자율 주행» 한 화면 감시자
 *
 * ⛔ 무엇을 답하나 — 「지금 이 세션이 로드맵의 «어느 칸»에 있고, 그 칸의 «나가는 조건»이
 *    몇 개나 서 있나」 하나뿐이다. 새 관측 기질(substrate)을 짓지 «않는다» —
 *    1급 CLI(`elanous self running-runs` · `elanous harness worktrees` · `elanous gh`)를
 *    «합성»할 뿐이다. (관측·하니스 툴 소유는 🅣 — 이 자는 세션 스코프 합성자다.)
 *
 * ⛔⭐ 이 자가 «가르는» 것 셋 — 이것이 이 자의 존재 이유다:
 *   ⓐ ***내 트리 ↔ 남의 트리*** — 도는 런은 elan·axon·pilot 세 트리에 «흩어져» 있다.
 *      로드맵 Ⓞ·Ⓐ 의 「도는 골 0개」는 ***내 트리 기준***이다. 함대 전체로 세면 영영 0이 안 된다.
 *   ⓑ ***「0」 ↔ 「못 쟀음」*** — 모든 칸이 status 를 «값으로» 갖는다(measured|unmeasured|error).
 *      ⛔ 못 잰 칸을 0 으로 그리지 않는다(⚪). 판정선 규율: 「⚪ 칸 필수」.
 *   ⓒ ***running ↔ probable-running*** — PTY 가 안 보이는 live 원장은 «확정»이 아니다.
 *      관문은 «둘을 합쳐» 보수적으로 판정한다(안 보이는 것을 「없다」로 안 읽는다).
 *
 * 사용:
 *   bun scripts/f-session-monitor.ts                 # 한 장 스냅숏
 *   bun scripts/f-session-monitor.ts --watch 300     # 300초마다 (12h 주행 심장박동)
 *   bun scripts/f-session-monitor.ts --json          # 파이프라인용
 *   bun scripts/f-session-monitor.ts --anchor        # 세션 시작 시각을 «지금»으로 못 박는다
 *   bun scripts/f-session-monitor.ts --phase Ⓕ      # ⭐ «실제» 칸을 적는다 (시계 칸과 가른다)
 *   bun scripts/f-session-monitor.ts --window 22    # ⭐ 창 «길이»를 바꾼다(연장) — ⛔ 앵커는 안 건드린다
 *
 * ⛔ 시각 앵커는 파일로 못 박는다(`.elanous-session/f-session.json`) — 「경과 시간」을
 *    매번 어림하면 로드맵 칸 판정이 조용히 미끄러진다.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
/**
 * ⛔⭐ 앵커 경로는 «인자»로 바꿀 수 있어야 한다 — 2026-09-10 실측:
 *    실물 진입점을 부르는 시험(`--phase Ⓞ`)이 ***도는 세션의 앵커를 덮어썼다***.
 *    화면의 「실제 칸」이 Ⓞ 로 되돌아갔고, 나는 그것을 «진짜 진도»로 읽을 뻔했다.
 * ⛔ 환경변수가 아니라 «인자»다(이 저장소 규율).
 */
function anchorPathFrom(argv: readonly string[]): string {
  const i = argv.indexOf("--anchor-file");
  const given = i >= 0 ? argv[i + 1] : undefined;
  return given && !given.startsWith("-") ? given : join(REPO, ".elanous-session", "f-session.json");
}
const ANCHOR_PATH = anchorPathFrom(process.argv.slice(2));
const ELANOUS = ["bin/elanous.mjs"];
/** ⛔ 탐침마다 시한을 준다 — 하나가 느리다고 스냅숏 전체가 멎으면 감시자가 아니다 */
const PROBE_TIMEOUT_MS = 90_000;
/** `--fast` — 가장 느린 탐침(워크트리 148개 훑기)을 «안 잰다». ⛔ 「0」이 아니라 ⚪ 로 낸다 */
const SKIP_WORKTREES = process.argv.includes("--fast");
/** ⛔ 회수·검증 작업이 다른 접두로 나간다 — 하나만 세면 «내 수»를 과소평가한다(실측 34 vs 36) */
const DEFAULT_BRANCH_PREFIXES: readonly string[] = ["f/", "recover/", "verify/"];

export type CellStatus = "measured" | "unmeasured" | "error";
export interface Cell<T> {
  status: CellStatus;
  value: T | null;
  /** 못 쟀으면 «왜» — 「0」과 구별되게 반드시 남긴다 */
  note?: string;
}

export const measured = <T,>(value: T, note?: string): Cell<T> => ({ status: "measured", value, note });
export const unmeasured = <T,>(note: string): Cell<T> => ({ status: "unmeasured", value: null, note });
export const errored = <T,>(note: string): Cell<T> => ({ status: "error", value: null, note });

function run(args: string[], timeoutMs = 120_000): { ok: boolean; out: string; err: string } {
  try {
    const out = execFileSync("bun", args, {
      cwd: REPO,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out, err: "" };
  } catch (e: any) {
    return { ok: false, out: String(e?.stdout ?? ""), err: String(e?.stderr ?? e?.message ?? e) };
  }
}

// ── 로드맵 칸 (ROADMAP-F-12h-advanced-clone-2026-09-10.md 의 배분을 그대로 옮긴다) ──
// ⛔⭐ 이 표는 «12h 로드맵»의 것이다. 창을 연장하면 ***그 뒤엔 칸이 «없다»*** —
//    없는 칸을 마지막 칸(Ⓗ)으로 늘려 «채우면» 감시자가 「인계 중」이라고 계속 말한다(거짓).
//    ⇒ 창 밖은 `null` 로 두고 그 사실을 «화면이 말한다».
export const PHASES: { key: string; from: number; to: number; title: string }[] = [
  { key: "Ⓞ", from: 0.0, to: 1.0, title: "이월 회수 — 도는 골 넷을 착지시키거나 회수" },
  { key: "Ⓐ", from: 1.0, to: 2.0, title: "A/B ② 발사 (관문 넷)" },
  { key: "Ⓑ", from: 2.0, to: 4.0, title: "L1 어포던스 ⊕ L2 네트워크 기록기" },
  { key: "Ⓒ", from: 4.0, to: 5.0, title: "HAR → OpenAPI (기존 도구 먼저)" },
  { key: "Ⓓ", from: 5.0, to: 6.5, title: "RFC 저작 (대상 하나 · 흐름 하나)" },
  { key: "Ⓔ", from: 6.5, to: 8.5, title: "backend 스텁 → Tailscale" },
  { key: "Ⓕ", from: 8.5, to: 10.5, title: "frontend(Next.js) → Tailscale" },
  { key: "Ⓖ", from: 10.5, to: 11.5, title: "왕복 검증 다섯 관문 ⊕ A/B ② 채점" },
  { key: "Ⓗ", from: 11.5, to: 12.0, title: "인계 ⊕ 로드맵 갱신" },
];

interface Anchor {
  startedAt: string;
  session: string;
  /** 조율 채널에서 마지막으로 «성공적으로» 읽은 코멘트 수 — ⛔ 실패한 fetch 로는 전진하지 않는다 */
  channelLastCount?: number;
  channelLastCheckedAt?: string;
  /** ⛔⭐ 실제로 도달한 칸. 시계 칸과 «다를 수 있다» — 그리고 실제로 달랐다.
   *  📏 2026-09-10 실측: 1.72h 에 Ⓞ~Ⓔ 를 끝냈는데 시계는 「Ⓐ」라고 말했다.
   *  ⇒ ***칸을 시계로만 정하면 감시자가 「진도」가 아니라 「시각」을 보고한다.***
   *    둘을 «가른다» — 시계 칸은 예산이고, 실제 칸은 진도다. */
  actualPhase?: string;
  actualPhaseAt?: string;
  /** 내 브랜치 접두«들» — 착지를 «내 것»으로 좁히는 유일한 축.
   *  ⛔ 이 저장소는 «한 사람 이름»으로 돌아 저자로는 못 가른다.
   *  🩸 2026-09-10 실측: 접두 하나(`f/`)로 세니 «34», 실제로 쓴 접두 셋으로 세니 «36» 이었다
   *     — 회수 작업이 `recover/`·`verify/` 로 나갔다. ⇒ 접두를 «목록»으로 둔다. */
  branchPrefixes?: readonly string[];
  /**
   * ⭐ 이 창의 «길이»(시간). 기본 12.
   * 🩸 왜 값이 됐나(2026-09-10 · 대표 이 10시간 연장을 지시): ***12 가 세 자리에 «박혀» 있었다*** —
   *    진행바·머리글·칸 표. 연장하면 셋이 «따로» 늙는다.
   * ⛔ 연장은 «앵커를 미루는 것»이 아니다 — 시작 시각은 사실이고, 바뀌는 것은 «예산»이다.
   *    (앵커를 미루면 「얼마나 달렸나」가 통째로 거짓이 된다.)
   */
  windowHours?: number;
}

/** ⛔ 기본은 한 자리에만 둔다 — 세 자리에 박혀 있던 것이 이 값이 된 계기다. */
export const DEFAULT_WINDOW_HOURS = 12;

function loadAnchor(): Anchor {
  if (existsSync(ANCHOR_PATH)) {
    try {
      return JSON.parse(readFileSync(ANCHOR_PATH, "utf8")) as Anchor;
    } catch {
      /* 깨졌으면 아래에서 새로 만든다 */
    }
  }
  const fresh: Anchor = { startedAt: new Date().toISOString(), session: "F-53" };
  saveAnchor(fresh);
  return fresh;
}

function saveAnchor(a: Anchor): void {
  mkdirSync(dirname(ANCHOR_PATH), { recursive: true });
  writeFileSync(ANCHOR_PATH, JSON.stringify(a, null, 2) + "\n");
}

// ── ⓐ 도는 런 — 트리별로 «가른다» ────────────────────────────────
export interface RunsView {
  myTree: { running: string[]; probable: string[] };
  otherTrees: Record<string, number>;
  totalLive: number;
}

/**
 * ⛔⭐ 실물 프로세스 관측 — 원장과 «대조»하기 위해 있다.
 *
 * 📏 2026-09-10 실측(이 자를 세운 날): `self running-runs --include-test` 가 **running 0** 을 냈는데,
 *    같은 순간 내 트리 워크트리에서 self-impl 런 «둘»이 tsc 게이트로 478% CPU 를 태우고 있었다.
 *    원장이 늦다(발사 직후 창은 원장에 아직 안 적힌다 — 도구가 스스로 그 한계를 낸다).
 * ⇒ 그래서 「도는 골 0개」를 원장 «하나»로 판정하면 «거짓 통과»가 난다.
 *    ⛔ 둘이 어긋나면 조용히 한쪽을 고르지 않는다 — «어긋났다»고 말하고 보수적으로 막는다.
 */
export interface LiveProcView {
  byTree: Record<string, string[]>;
  total: number;
}

/** ps 한 줄에서 워크트리 소유 트리와 워크트리 이름을 뽑는다. 못 뽑으면 null(«세지 않는다»). */
/**
 * ⛔⭐ 「템플릿 둘로 자 시험」 원장. ***사이트는 이 저장소 «밖»에 산다*** — 그래서
 * 각 사이트가 자기 준수 결과를 «한 줄»로 여기에 적고, 이 자는 그 줄을 «센다».
 * ⛔ 「손으로 돌린다」는 관측이 아니다 — 그 문면이 이 칸을 여러 창 동안 ⚪ 로 붙들고 있었다.
 * 형식(한 줄에 하나): `<이름>\t<맞음>\t<전체>\t<잰 날>`
 *
 * ⛔⭐⭐ 🩸 첫 판은 이것을 `.elanous-session/` 에 뒀다 — ***그 디렉토리는 `.gitignore` 안이다.***
 *    ⇒ 「재는 자리」를 만들었는데 그 자리가 «이 트리에서만» 살았다. 관문은 초록인데 기록은 «안 따라간다».
 *    🔑 이 저장소가 이미 못 박은 규율의 또 한 판 — ***「있다」와 「닿는다」는 다르다.***
 *    ⇒ 추적되는 자리(`docs/`)로 옮긴다. 원장은 세션 상태가 «아니라» 기록이다.
 */
export const TEMPLATE_LEDGER = "docs/webclone/template-conformance.tsv";

export interface TemplateConformance {
  readonly passing: number;
  readonly total: number;
  readonly rows: readonly string[];
}

export function readTemplateConformance(
  path = TEMPLATE_LEDGER,
  read: (p: string) => string | null = (p) => {
    try { return readFileSync(p, "utf8"); } catch { return null; }
  },
): TemplateConformance {
  const raw = read(path);
  // ⛔ 「없다」와 「0건」을 가른다 — 없으면 total 0 이고 판정은 unknown 이다.
  if (raw === null) return { passing: 0, total: 0, rows: [] };
  const rows: string[] = [];
  let passing = 0;
  let total = 0;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const [name, matched, axes, when] = t.split("\t");
    if (name === undefined || matched === undefined || axes === undefined) continue;
    const m = Number(matched);
    const a = Number(axes);
    if (!Number.isFinite(m) || !Number.isFinite(a) || a <= 0) continue;
    total += 1;
    if (m === a) passing += 1;
    rows.push(`${name} ${m}/${a}${when ? ` (${when})` : ""}`);
  }
  return { passing, total, rows };
}

export function parseWorktreeProcess(command: string): { tree: string; worktree: string } | null {
  const m = /\/\.elanous\/worktrees\/([a-z0-9]+)-[0-9a-f]+\/[^/]*\.worktrees\/([^/]+)/i.exec(command);
  return m ? { tree: m[1], worktree: m[2] } : null;
}

function collectLiveProcesses(myTree: string): Cell<LiveProcView> {
  let out: string;
  try {
    out = execFileSync("ps", ["-axo", "command="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  } catch (e: any) {
    return errored<LiveProcView>(`ps 실패: ${String(e?.message ?? e).slice(0, 120)}`);
  }
  const byTree: Record<string, Set<string>> = {};
  for (const line of out.split("\n")) {
    const hit = parseWorktreeProcess(line);
    if (!hit) continue;
    (byTree[hit.tree] ??= new Set()).add(hit.worktree);
  }
  const flat: Record<string, string[]> = {};
  for (const [tree, set] of Object.entries(byTree)) flat[tree] = [...set].sort();
  return measured({ byTree: flat, total: (flat[myTree] ?? []).length });
}

function collectRuns(): Cell<RunsView> {
  const r = run([...ELANOUS, "self", "running-runs", "--include-test", "--json"], PROBE_TIMEOUT_MS);
  if (!r.ok && !r.out.trim()) return errored<RunsView>(`running-runs 실패: ${r.err.slice(0, 200)}`);
  let parsed: any;
  try {
    parsed = JSON.parse(r.out);
  } catch {
    return errored<RunsView>("running-runs --json 이 JSON 이 아니다");
  }
  const entries: any[] = Array.isArray(parsed?.entries) ? parsed.entries : [];
  if (entries.length === 0) return unmeasured<RunsView>("entries 가 비었다 — 조회 자체가 안 닿았을 수 있다");

  const view: RunsView = { myTree: { running: [], probable: [] }, otherTrees: {}, totalLive: 0 };
  for (const e of entries) {
    const status = String(e?.status ?? "");
    if (status !== "running" && status !== "probable-running") continue;
    view.totalLive += 1;
    const dirs: string[] = Array.isArray(e?.ledgerDirectories) ? e.ledgerDirectories : [];
    // 트리는 원장 경로에서 읽는다 — /Users/<u>/source/<tree>/monad-agent/...
    const tree = dirs.map((d) => /\/source\/([^/]+)\/monad-agent\b/.exec(d)?.[1]).find(Boolean) ?? "unknown";
    const short = String(e?.runId ?? "?").slice(0, 12);
    if (REPO.includes(`/source/${tree}/`)) {
      (status === "running" ? view.myTree.running : view.myTree.probable).push(short);
    } else {
      view.otherTrees[tree] = (view.otherTrees[tree] ?? 0) + 1;
    }
  }
  return measured(view);
}

// ── 워크트리 수명 사다리 ────────────────────────────────
function collectWorktrees(): Cell<Record<string, number>> {
  if (SKIP_WORKTREES) return unmeasured<Record<string, number>>("--fast — 이번 스냅숏에서 «안 쟀다»(0이 아니다)");
  const r = run([...ELANOUS, "harness", "worktrees"], PROBE_TIMEOUT_MS);
  if (!r.ok && !r.out.trim()) return errored<Record<string, number>>(`harness worktrees 실패: ${r.err.slice(0, 160)}`);
  const counts: Record<string, number> = {};
  let matched = 0;
  for (const line of r.out.split("\n")) {
    const m = /^\s*-\s*\[([a-z-]+)\]/.exec(line);
    if (!m) continue;
    matched += 1;
    counts[m[1]] = (counts[m[1]] ?? 0) + 1;
  }
  if (matched === 0) return unmeasured<Record<string, number>>("행을 한 줄도 못 읽었다 — 형식이 바뀌었을 수 있다");
  return measured(counts);
}

// ── 열린 PR — 웹클론 축을 «따로» 센다 ────────────────────────────────
/**
 * ⭐ 이 창이 «무엇을 착지시켰나». 감시자의 첫 물음이 「무엇이 막혔나」였는데,
 *    두 번째 물음은 「내가 무엇을 냈나」다 — 그것을 «세는 자리»가 없으면 보고가 어림이 된다.
 * ⛔ 표식(제목)이 아니라 «시각»으로 센다 — 세션 앵커 뒤에 머지된 것만.
 *    (⚠️ 그래도 «남의 착지»가 섞일 수 있다 — 저장소가 한 사람 이름으로 돈다. 그래서 브랜치 접두로 좁힌다.)
 */
export interface LandingView {
  readonly count: number;
  readonly recent: { readonly number: number; readonly title: string; readonly agoH: number }[];
  /** ⛔ 접두로 좁혔다는 사실을 «값으로» — 0 을 「아무것도 안 했다」로 읽지 않게 */
  readonly prefixes: readonly string[];
  readonly sinceIso: string;
  /** ⛔ 조회 상한에 닿았나. 참이면 «더 오래된 착지가 잘렸다» — 이 수는 «하한»이다. */
  readonly truncated: boolean;
}

export interface PrView {
  total: number;
  truncated: boolean;
  webclone: { number: number; ageH: number; title: string; target: string }[];
  oldestAgeH: number | null;
  /** ⭐ 같은 «대상»에 몇 겹으로 쌓였나 — 이월의 «형태»는 수가 아니라 겹수다 */
  stacks: { target: string; depth: number; numbers: number[]; spanH: number }[];
}

const WEBCLONE_RE = /webclone|design-seed|seed-conformance|computed-tokens|design-md|fidelity|mirror-open|archive-run|js-erasure|asset-integrity/i;

/**
 * ⛔ 「PR 25건」은 «25가지 일»이 아니다 — 같은 대상에 다시 쏜 겹이다.
 * 브랜치·제목에서 «대상 모듈»을 뽑아 겹을 센다. 못 뽑으면 «못 쟀음»으로 두지 않고
 * PR 번호를 대상으로 써서 겹수 1 로 둔다(혼자 서 있는 것도 사실이다).
 */
export function targetOf(pr: { headRefName: string; title: string }): string {
  const hay = `${pr.headRefName} ${pr.title}`;
  const known = [
    "seed-conformance", "computed-tokens", "design-md", "measure-fidelity", "clone-fidelity",
    "mirror-open-verdict", "mirror-open-check", "archive-run", "js-erasure", "asset-integrity",
    "design-extract", "graph-authority",
  ];
  for (const k of known) if (new RegExp(k, "i").test(hay)) return k;
  const m = /([a-z0-9-]+)\.ts/i.exec(hay);
  return m ? m[1].toLowerCase() : "미분류";
}

function collectPrs(): Cell<PrView> {
  const r = run([...ELANOUS, "gh", "pr", "list", "--limit", "100", "--json", "number,title,headRefName,createdAt"], PROBE_TIMEOUT_MS);
  const body = r.out.trim();
  if (!body) return errored<PrView>(`gh pr list 산출 0바이트: ${r.err.slice(0, 200)}`);
  // ⛔ 상태 줄은 stderr 라 stdout 은 «원 바이트 그대로»다 — 그래도 방어적으로 첫 배열만 집는다
  const start = body.indexOf("[");
  let list: any[];
  try {
    list = JSON.parse(body.slice(start));
  } catch {
    return errored<PrView>("gh pr list --json 이 JSON 이 아니다");
  }
  const truncated = /MAYBE_TRUNCATED/.test(r.err);
  const now = Date.now();
  const ageH = (iso: string) => Math.round(((now - Date.parse(iso)) / 3_600_000) * 10) / 10;
  const webclone = list
    .filter((p) => WEBCLONE_RE.test(`${p.headRefName} ${p.title}`))
    .map((p) => ({
      number: p.number,
      ageH: ageH(p.createdAt),
      title: String(p.title).slice(0, 46),
      target: targetOf(p),
    }))
    .sort((a, b) => b.ageH - a.ageH);
  const oldest = list.length ? Math.max(...list.map((p) => ageH(p.createdAt))) : null;
  return measured({ total: list.length, truncated, webclone, oldestAgeH: oldest, stacks: stacksOf(webclone) });
}

// ── 로드 ────────────────────────────────
export interface LoadView {
  one: number;
  cores: number;
  perCore: number;
  /**
   * ⛔⭐⭐ 🩸 이 칸이 없을 때 이 관문은 ***「내 상태」가 아니라 「기계 상태」***를 재고 있었다.
   * 📏 2026-09-11 실측: 내 잔여 프로세스를 «전부 0» 으로 걷었는데 로드가 **82** 였다
   *    (`ast-grep` 383% · 안드로이드 에뮬레이터 · java · 남의 bun·node).
   * 🔑 ⇒ 막힘은 «맞지만» 원인이 내 것이 아니었다. 그래서 ***누가 먹고 있는지를 같이 낸다.***
   * ⚪ 못 읽으면 빈 배열이 아니라 `undefined` — 「없다」와 「못 쟀다」를 가른다.
   */
  top?: readonly { readonly cpu: number; readonly name: string }[];
}

/** ⛔ 상위 몇 개를 볼 것인가. 임계는 «값으로» 나간다. */
export const LOAD_TOP_N = 4;

/** ⛔ `ps` 산출을 읽는다. 못 읽으면 `undefined` — 0 으로 «몰지» 않는다. */
export function parseTopCpu(psOut: string, topN = LOAD_TOP_N): LoadView["top"] {
  const lines = psOut.split("\n").map((l) => l.trim()).filter(Boolean);
  const rows: { cpu: number; name: string }[] = [];
  for (const line of lines) {
    const m = /^(\d+(?:\.\d+)?)\s+(.+)$/.exec(line);
    if (!m) continue;
    const cpu = Number(m[1]);
    if (!Number.isFinite(cpu) || cpu <= 0) continue;
    // 경로가 길면 «마지막 조각»만 — 읽는 쪽이 이름으로 알아본다.
    const raw = m[2]!.trim();
    rows.push({ cpu, name: raw.split("/").pop()!.slice(0, 28) });
  }
  if (rows.length === 0) return undefined;
  return rows.sort((a, b) => b.cpu - a.cpu).slice(0, topN);
}

/** 대상별 겹을 세어 «깊은 것부터» 낸다 */
export function stacksOf(webclone: PrView["webclone"]): PrView["stacks"] {
  const by = new Map<string, PrView["webclone"]>();
  for (const p of webclone) {
    const arr = by.get(p.target) ?? [];
    arr.push(p);
    by.set(p.target, arr);
  }
  return [...by.entries()]
    .map(([target, prs]) => ({
      target,
      depth: prs.length,
      numbers: prs.map((p) => p.number).sort((a, b) => a - b),
      spanH: Math.round((Math.max(...prs.map((p) => p.ageH)) - Math.min(...prs.map((p) => p.ageH))) * 10) / 10,
    }))
    .sort((a, b) => b.depth - a.depth || b.spanH - a.spanH);
}

/**
 * 세션 앵커 «뒤»에 머지된 내 브랜치 PR.
 * ⛔ 「0」이 「아무것도 안 했다」가 아니다 — 접두가 다르면 안 잡힌다. 그 접두를 결과에 싣는다.
 */
function collectLandings(sinceIso: string, prefixes: readonly string[]): Cell<LandingView> {
  const LIMIT = 100;
  const r = run([...ELANOUS, "gh", "pr", "list", "--state", "merged", "--limit", String(LIMIT), "--json", "number,title,mergedAt,headRefName"], PROBE_TIMEOUT_MS);
  const body = r.out.trim();
  if (!body) return errored<LandingView>(`gh pr list --state merged 산출 0바이트: ${r.err.slice(0, 160)}`);
  let list: { number: number; title: string; mergedAt: string; headRefName: string }[];
  try {
    list = JSON.parse(body.slice(body.indexOf("[")));
  } catch {
    return errored<LandingView>("merged PR 목록이 JSON 이 아니다");
  }
  const since = Date.parse(sinceIso);
  const now = Date.now();
  const mine = list
    .filter((p) => prefixes.some((x) => p.headRefName.startsWith(x)) && Date.parse(p.mergedAt) >= since)
    .map((p) => ({ number: p.number, title: String(p.title).slice(0, 52), agoH: Math.round(((now - Date.parse(p.mergedAt)) / 3_600_000) * 10) / 10 }))
    .sort((a, b) => a.agoH - b.agoH);
  // ⛔ 상한에 «닿았으면» 더 오래된 착지가 «잘렸다» — 그 사실을 값으로 낸다
  return measured({ count: mine.length, recent: mine.slice(0, 5), prefixes, sinceIso, truncated: list.length >= LIMIT });
}

function collectLoad(): Cell<LoadView> {
  try {
    const up = execFileSync("uptime", { encoding: "utf8" });
    const m = /load averages?:\s*([\d.]+)/.exec(up);
    if (!m) return unmeasured("uptime 에서 load 를 못 읽었다");
    const cores = Number(execFileSync("sysctl", ["-n", "hw.ncpu"], { encoding: "utf8" }).trim());
    const one = Number(m[1]);
    // ⛔ 귀속을 «같이» 잰다 — 못 재면 undefined 로 두고 「없다」로 몰지 않는다.
    let top: LoadView["top"];
    try {
      top = parseTopCpu(execFileSync("ps", ["-Ao", "pcpu,comm", "-r"], { encoding: "utf8" }));
    } catch { top = undefined; }
    return measured({ one, cores, perCore: Math.round((one / cores) * 100) / 100, top });
  } catch (e: any) {
    return errored(`load 측정 실패: ${String(e?.message ?? e).slice(0, 120)}`);
  }
}

// ── 조율 채널 — ⛔ 성공한 fetch 에서만 last 를 전진시킨다 ────────────────────────────────
function channelNumber(): Cell<number> {
  const p = join(REPO, "docs/manual/MANUAL-multi-agent-coordination-channel-2026-07-28.md");
  if (!existsSync(p)) return errored("채널 canonical 매뉴얼이 없다");
  const m = /현재 채널 = \[PR #(\d+)\]/.exec(readFileSync(p, "utf8"));
  return m ? measured(Number(m[1])) : unmeasured("매뉴얼 머리말에서 채널 번호를 못 읽었다");
}

/** GitHub 은 코멘트 2500 을 넘기면 «쓰기»를 차단한다 — 채널이 조용히 막힌다 */
const CHANNEL_COMMENT_CAP = 2500;

function collectChannel(anchor: Anchor, advance: boolean): Cell<{ pr: number; count: number; delta: number | null; headroom: number }> {
  const ch = channelNumber();
  if (ch.status !== "measured" || ch.value === null) return unmeasured(ch.note ?? "채널 번호 미상");
  const r = run([...ELANOUS, "gh", "api", `repos/{owner}/{repo}/issues/${ch.value}`, "--jq", ".comments"], PROBE_TIMEOUT_MS);
  const n = Number(r.out.trim().split("\n").filter(Boolean).pop());
  if (!Number.isFinite(n)) return errored(`채널 코멘트 수 조회 실패: ${r.err.slice(0, 160)}`);
  const prev = anchor.channelLastCount;
  const delta = typeof prev === "number" ? n - prev : null;
  if (advance) {
    anchor.channelLastCount = n;
    anchor.channelLastCheckedAt = new Date().toISOString();
    saveAnchor(anchor);
  }
  return measured({ pr: ch.value, count: n, delta, headroom: CHANNEL_COMMENT_CAP - n });
}

// ── 관문표 ────────────────────────────────
export type Verdict = "pass" | "fail" | "unknown";

/** TECHBLOG1 판정은 호출자가 제공한 근거만 읽는다. 스냅숏·출력·원장에는 연결하지 않는다. */
export interface Techblog1Entry {
  readonly installment: number;
  readonly publishedAt: string;
}

export interface Techblog1Candidate {
  readonly installment: number;
  readonly publishAt: string;
  readonly measurements: readonly { readonly value: number; readonly source: string; readonly measuredAt: string }[];
  readonly exposure: {
    readonly publicBeforePublish: boolean;
    readonly approved: boolean;
    readonly revealsProtectedDetails: boolean;
    readonly attorneyReviewed: boolean;
  };
}

export interface Techblog1Verdict {
  readonly verdict: Verdict;
  readonly reasons: readonly string[];
}

/** 순번은 1부터 빠짐없이, 게시 간격은 직전 게시에서 48시간 이상이어야 한다. */
export function evaluateTechblog1(
  published: readonly Techblog1Entry[],
  candidate: Techblog1Candidate,
): Techblog1Verdict {
  const reasons: string[] = [];
  const validPublicationDate = (iso: string) => {
    if (typeof iso !== "string") return false;
    const match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1\d|2[0-3]):[0-5]\d)$/.exec(iso);
    if (!match || !Number.isFinite(Date.parse(iso))) return false;
    const day = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
    return day.getUTCFullYear() === Number(match[1])
      && day.getUTCMonth() + 1 === Number(match[2])
      && day.getUTCDate() === Number(match[3]);
  };
  const history = [...published].sort((a, b) => a.installment - b.installment);
  if (history.some((entry, index) => entry.installment !== index + 1 || !validPublicationDate(entry.publishedAt))
      || candidate.installment !== history.length + 1) {
    reasons.push("TECHBLOG1 연재 순서 또는 이전 게시 시각이 유효하지 않음");
  }
  if (history.some((entry, index) => index > 0 && validPublicationDate(entry.publishedAt)
      && validPublicationDate(history[index - 1]!.publishedAt)
      && Date.parse(entry.publishedAt) - Date.parse(history[index - 1]!.publishedAt) < 48 * 60 * 60 * 1000)) {
    reasons.push("TECHBLOG1 이전 연재의 이틀 간격이 지켜지지 않음");
  }
  if (!validPublicationDate(candidate.publishAt)) {
    reasons.push("TECHBLOG1 게시 시각을 확인할 수 없음");
  } else if (history.length > 0 && validPublicationDate(history[history.length - 1]!.publishedAt)
      && Date.parse(candidate.publishAt) - Date.parse(history[history.length - 1]!.publishedAt) < 48 * 60 * 60 * 1000) {
    reasons.push("TECHBLOG1 직전 게시에서 이틀이 지나지 않음");
  }
  if (candidate.measurements.length === 0 || candidate.measurements.some((m) =>
    !Number.isFinite(m.value) || !m.source.trim() || !validPublicationDate(m.measuredAt)
    || (validPublicationDate(candidate.publishAt) && Date.parse(m.measuredAt) > Date.parse(candidate.publishAt)))) {
    reasons.push("TECHBLOG1 실측 수치·출처·측정 시각이 확인되지 않음");
  }
  if (candidate.exposure.revealsProtectedDetails && !candidate.exposure.attorneyReviewed) {
    reasons.push("TECHBLOG1 보호 대상 상세는 변리사 검토 전 노출 불가");
  }
  if (candidate.exposure.publicBeforePublish && !candidate.exposure.approved) {
    reasons.push("TECHBLOG1 공개 전 노출 승인 없음");
  }
  return { verdict: reasons.length === 0 ? "pass" : "fail", reasons };
}

export interface Gate {
  phase: string;
  name: string;
  verdict: Verdict;
  detail: string;
}

export function buildGates(
  runs: Cell<RunsView>,
  load: Cell<LoadView>,
  prs: Cell<PrView>,
  live?: Cell<LiveProcView>,
  // ⛔ 원장을 «여기서 읽지 않는다» — 안 그러면 조회가 전부 오류인 창에서도 이 칸만 pass 로 샌다
  //    (시험이 그것을 잡았다). 맥락은 «인자»로 내려온다.
  templates?: Cell<TemplateConformance>,
): Gate[] {
  const gates: Gate[] = [];

  // 도는 골 0개 — ⛔ 내 트리 기준 ⊕ running+probable 을 «합쳐» 보수적으로
  const ledgerMine =
    runs.status === "measured" && runs.value
      ? runs.value.myTree.running.length + runs.value.myTree.probable.length
      : null;
  const procMine = live && live.status === "measured" && live.value ? live.value.total : null;

  if (ledgerMine === null && procMine === null) {
    gates.push({
      phase: "Ⓞ/Ⓐ",
      name: "도는 골 0개 (내 트리)",
      verdict: "unknown",
      detail: `원장·실물 둘 다 못 쟀음 — ${runs.note ?? "?"}`,
    });
  } else if (ledgerMine !== null && procMine !== null && (ledgerMine === 0) !== (procMine === 0)) {
    // ⛔ 원장과 실물이 «갈린다» — 조용히 한쪽을 고르지 않는다. 보수적으로 막고 «어긋났다»고 말한다.
    gates.push({
      phase: "Ⓞ/Ⓐ",
      name: "도는 골 0개 (내 트리)",
      verdict: "fail",
      detail: `🚨 원장 ${ledgerMine} ↔ 실물 프로세스 ${procMine} — «어긋난다». 원장이 늦을 수 있다(발사 직후 창)`,
    });
  } else {
    const mine = Math.max(ledgerMine ?? 0, procMine ?? 0);
    const parts: string[] = [];
    if (ledgerMine !== null) parts.push(`원장 ${ledgerMine}`);
    else parts.push("원장 ⚪");
    if (procMine !== null) parts.push(`실물 ${procMine}`);
    else parts.push("실물 ⚪");
    gates.push({
      phase: "Ⓞ/Ⓐ",
      name: "도는 골 0개 (내 트리)",
      verdict: mine === 0 ? "pass" : "fail",
      detail: parts.join(" · "),
    });
  }

  // conform 자 착지 — 열린 seed-conformance PR 이 있으면 «아직 안 섰다»
  if (prs.status === "measured" && prs.value) {
    const conform = prs.value.webclone.filter((p) => /seed-conformance|conformance/i.test(p.title));
    gates.push({
      phase: "Ⓞ/Ⓐ",
      name: "conform 자 착지",
      verdict: conform.length === 0 ? "unknown" : "fail",
      detail:
        conform.length === 0
          ? "열린 conform PR 없음 — ⛔ 「착지했다」가 «아니다». 머지 여부는 손으로 확인"
          : `열린 PR ${conform.map((p) => `#${p.number}(${p.ageH}h)`).join(" ")}`,
    });
  } else {
    gates.push({ phase: "Ⓞ/Ⓐ", name: "conform 자 착지", verdict: "unknown", detail: prs.note ?? "PR 을 못 쟀음" });
  }

  // ⛔⭐ 이 칸은 ***사이트 저장소가 이 저장소 «밖»에 있어*** 자동으로 못 쟀었다.
  //    ⇒ 「못 잰다」로 두지 않고 ***재는 자리를 만든다*** — 각 사이트의 준수 결과를 «파일»로 남기고 센다.
  //    ⛔ 「손으로 돌린다」는 관측이 아니다. 그 문면이 이 칸을 다섯 창 동안 ⚪ 로 붙들고 있었다.
  const t = templates && templates.status === "measured" ? templates.value : null;
  gates.push({
    phase: "Ⓐ",
    name: "템플릿 둘로 자 시험",
    verdict: t === null || t.total === 0 ? "unknown" : t.passing >= 2 ? "pass" : "fail",
    detail: t === null
      ? `⚪ 원장을 «못 읽었다** — ${TEMPLATE_LEDGER}`
      : t.total === 0
        ? `⚪ ${TEMPLATE_LEDGER} 가 «비었다» — 사이트를 지을 때 준수 결과를 여기에 적는다`
        : `${t.passing}/${t.total} 통과 · ${t.rows.join(" · ")}`,
  });

  if (load.status === "measured" && load.value) {
    gates.push({
      phase: "Ⓐ",
      name: "로드 < 5",
      verdict: load.value.one < 5 ? "pass" : "fail",
      // ⛔ 막혔으면 «누가 먹는지»를 같이 낸다 — 안 그러면 내 축의 결함으로 읽힌다.
      detail: `${load.value.one} (${load.value.cores}코어 · 코어당 ${load.value.perCore})`
        + (load.value.one >= 5
          ? load.value.top === undefined
            ? `  ⚪ 누가 먹는지 «못 쟀다»`
            : `  ← ${load.value.top.map((t) => `${t.name} ${t.cpu}%`).join(" · ")}`
          : ""),
    });
  } else {
    gates.push({ phase: "Ⓐ", name: "로드 < 5", verdict: "unknown", detail: load.note ?? "못 쟀음" });
  }

  return gates;
}

// ── 렌더 ────────────────────────────────
/** ⛔ 한글은 «두 칸»을 먹는다 — padEnd 로는 표가 어긋난다 */
export function padW(s: string, width: number): string {
  let w = 0;
  for (const ch of s) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return s + " ".repeat(Math.max(0, width - w));
}

const MARK: Record<Verdict, string> = { pass: "✅", fail: "⛔", unknown: "⚪" };

export function phaseFor(elapsedH: number) {
  return PHASES.find((p) => elapsedH >= p.from && elapsedH < p.to) ?? PHASES[PHASES.length - 1];
}

function render(snapshot: any): string {
  const L: string[] = [];
  const { elapsedH, phase, runs, worktrees, load, channel, myTree } = snapshot;
  const live: Cell<LiveProcView> = snapshot.live;
  const prs: Cell<PrView> = snapshot.prs;
  const gates: Gate[] = snapshot.gates;
  const windowH = snapshot.windowHours;
  const bar = (() => {
    const width = 36;
    const filled = Math.max(0, Math.min(width, Math.round((elapsedH / windowH) * width)));
    return "█".repeat(filled) + "░".repeat(width - filled);
  })();

  L.push(`╭─ 🅕 세션 «${windowH}h 자율 주행» 감시자 ${new Date().toLocaleTimeString("ko-KR")} ─────────────`);
  L.push(`│ ⏱  ${bar}  ${elapsedH.toFixed(2)}h / ${windowH.toFixed(2)}h`);
  // ⛔ 칸 표가 «12h» 배분이다 — 연장분엔 칸이 없다. 그것을 «말한다».
  if (windowH > DEFAULT_WINDOW_HOURS) {
    L.push(`│ ⚪ 칸 표는 «${DEFAULT_WINDOW_HOURS}h 로드맵»의 것이다 — ${DEFAULT_WINDOW_HOURS}h 뒤 ${(windowH - DEFAULT_WINDOW_HOURS).toFixed(1)}h 는 «칸이 없다»(로드맵을 새로 적어야 한다)`);
  }
  const actual = snapshot.actualPhase as { key: string; title: string; from: number; to: number } | null;
  if (actual && actual.key !== phase.key) {
    // ⛔ 시계 칸과 실제 칸이 «다르다» — 둘 다 보여 준다. 하나로 접으면 「진도」나 「예산」 중 하나를 잃는다
    const ahead = actual.from > phase.from;
    L.push(`│ 📍 실제 ${actual.key} ${actual.title}   ${ahead ? "⭐ 예산보다 앞선다" : "⚠️ 예산보다 뒤진다"}`);
    L.push(`│ 🕐 시계 ${phase.key} ${phase.title}  (${phase.from}–${phase.to}h)`);
  } else {
    L.push(`│ 📍 ${phase.key} ${phase.title}  (${phase.from}–${phase.to}h · 이 칸 잔여 ${(phase.to - elapsedH).toFixed(2)}h)`);
    if (!actual) L.push("│ ⚪ 실제 칸을 «안 적었다» — `--phase <칸>` 으로 적으면 예산과 진도를 가른다");
  }
  L.push(`╰──────────────────────────────────────────────────────────────`);

  L.push("");
  L.push("🔥 도는 런 — ⛔ 트리로 «가른다»");
  if (runs.status === "measured") {
    const v = runs.value;
    L.push(`   내 트리(elan)   running ${v.myTree.running.length} ${v.myTree.running.join(" ")}`);
    L.push(`                   probable ${v.myTree.probable.length} ${v.myTree.probable.join(" ")}`);
    const others = Object.entries(v.otherTrees).map(([k, n]) => `${k} ${n}`).join(" · ") || "없음";
    L.push(`   남의 트리       ${others}   ⓘ 내 관문에 «안 센다»`);
  } else {
    L.push(`   ⚪ 원장: ${runs.note}`);
  }
  if (live.status === "measured" && live.value) {
    const mine = live.value.byTree[myTree] ?? [];
    L.push(`   실물 프로세스   내 트리 ${mine.length}  ${mine.map((w: string) => w.slice(0, 34)).join(" ")}`);
    const otherProc = Object.entries(live.value.byTree)
      .filter(([t]) => t !== myTree)
      .map(([t, ws]) => `${t} ${(ws as string[]).length}`)
      .join(" · ");
    if (otherProc) L.push(`                   남의 트리 ${otherProc}`);
  } else {
    L.push(`   ⚪ 실물: ${live.note}`);
  }

  L.push("");
  if (prs.status === "measured" && prs.value) {
    const v: PrView = prs.value;
    L.push(`📋 열린 PR   전체 ${v.total}${v.truncated ? " (⚠️ 상한 도달 — 더 있을 수 있다)" : ""} · 웹클론 축 ${v.webclone.length}`);
    L.push("   ⛔ 「25건」은 25가지 일이 «아니다» — 같은 대상에 다시 쏜 «겹»이다");
    for (const st of v.stacks.slice(0, 8)) {
      const mark = st.depth >= 3 ? "🔁" : st.depth === 2 ? "··" : "  ";
      L.push(
        `   ${mark} ${padW(st.target, 20)} ${String(st.depth).padStart(2)}겹  ${String(st.spanH).padStart(5)}h 폭  ${st.numbers.map((n) => `#${n}`).join(" ")}`,
      );
    }
    const deep: PrView["stacks"] = v.stacks.filter((s2: PrView["stacks"][number]) => s2.depth >= 2);
    const wasted = deep.reduce((n: number, s2: PrView["stacks"][number]) => n + s2.depth - 1, 0);
    L.push(`   ⇒ 겹친 대상 ${deep.length}개 · ***겹으로 버려진 초안 ${wasted}건*** (대상당 하나만 살아남는다면)`);
  } else {
    L.push(`📋 열린 PR   ⚪ ${prs.note}`);
  }

  L.push("");
  const landings: Cell<LandingView> = snapshot.landings;
  if (landings.status === "measured" && landings.value) {
    const v = landings.value;
    L.push(`🚢 이 창의 착지  **${v.count}건**${v.truncated ? " ⚠️ (조회 상한에 닿음 — 이 수는 «하한»이다)" : ""}  (접두 ${v.prefixes.join(" ")} · 앵커 뒤)`);
    for (const p of v.recent) L.push(`   #${p.number}  ${String(p.agoH).padStart(5)}h 전  ${p.title}`);
    if (v.count === 0) L.push("   ⚪ 0건 — ⛔ 「아무것도 안 했다」가 «아니다». 브랜치 접두가 다를 수 있다");
  } else {
    L.push(`🚢 이 창의 착지  ⚪ ${landings.note}`);
  }

  L.push("");
  if (worktrees.status === "measured") {
    L.push(`🌲 워크트리   ${Object.entries(worktrees.value).map(([k, n]) => `${k} ${n}`).join(" · ")}`);
  } else {
    L.push(`🌲 워크트리   ⚪ ${worktrees.note}`);
  }

  if (load.status === "measured") {
    L.push(`🖥  로드       ${load.value.one} (${load.value.cores}코어 · 코어당 ${load.value.perCore})`);
  } else {
    L.push(`🖥  로드       ⚪ ${load.note}`);
  }

  if (channel.status === "measured") {
    const d = channel.value.delta;
    const deltaTxt = d === null ? "기준선 없음(이번이 첫 확인)" : d > 0 ? `🔔 새 코멘트 ${d}건` : "새 코멘트 없음";
    const hr = channel.value.headroom;
    const hrTxt = hr <= 0 ? "🚨 상한 도달 — 쓰기 차단" : hr < 150 ? `🚨 여유 ${hr}건 — 채널 이전 준비` : `여유 ${hr}건`;
    L.push(`📡 조율 채널  #${channel.value.pr} · 코멘트 ${channel.value.count}/${2500} · ${hrTxt} · ${deltaTxt}`);
  } else {
    L.push(`📡 조율 채널  ⚪ ${channel.note}`);
  }

  L.push("");
  L.push("🚦 관문표  (⛔ 판정선은 관측 «전»에 못 박혔다 — 뒤에 고치지 않는다)");
  for (const g of gates) L.push(`   ${MARK[g.verdict]} ${padW(g.phase, 5)} ${padW(g.name, 26)} ${g.detail}`);
  const unknowns = gates.filter((g: Gate) => g.verdict === "unknown").length;
  const fails = gates.filter((g: Gate) => g.verdict === "fail").length;
  L.push("");
  L.push(`   ⇒ 통과 ${gates.length - fails - unknowns} · 막힘 ${fails} · ⚪못 쟀음 ${unknowns}`);
  return L.join("\n");
}

// ── 본체 ────────────────────────────────
function snapshot(anchor: Anchor, advanceChannel: boolean) {
  const elapsedH = (Date.now() - Date.parse(anchor.startedAt)) / 3_600_000;
  const myTree = /\/source\/([^/]+)\/monad-agent/.exec(REPO)?.[1] ?? "unknown";
  const runs = collectRuns();
  const live = collectLiveProcesses(myTree);
  const worktrees = collectWorktrees();
  const prs = collectPrs();
  const load = collectLoad();
  const channel = collectChannel(anchor, advanceChannel);
  const landings = collectLandings(anchor.startedAt, anchor.branchPrefixes ?? DEFAULT_BRANCH_PREFIXES);
  // ⛔ 「없다」와 「0건」을 가른다 — 파일이 아예 없으면 «못 쟀음»이다.
  const ledger = readTemplateConformance();
  const gates = buildGates(runs, load, prs, live, ledger.total === 0 ? unmeasured(`${TEMPLATE_LEDGER} 없음`) : measured(ledger));
  const clockPhase = phaseFor(elapsedH);
  const actual = anchor.actualPhase ? PHASES.find((p) => p.key === anchor.actualPhase) ?? null : null;
  return { at: new Date().toISOString(), elapsedH, windowHours: anchor.windowHours ?? DEFAULT_WINDOW_HOURS, phase: clockPhase, actualPhase: actual, actualPhaseAt: anchor.actualPhaseAt ?? null, myTree, landings, runs, live, worktrees, prs, load, channel, gates };
}

const isMain = import.meta.main;
const argv = process.argv.slice(2);
const wantJson = argv.includes("--json");
const watchIdx = argv.indexOf("--watch");
const watchSec = watchIdx >= 0 ? Number(argv[watchIdx + 1] ?? 300) : 0;

const phaseIdx = argv.indexOf("--phase");
if (isMain && phaseIdx >= 0) {
  const key = argv[phaseIdx + 1] ?? "";
  if (!PHASES.some((p) => p.key === key)) {
    console.error(`⛔ 모르는 칸: ${JSON.stringify(key)} — 가능한 값: ${PHASES.map((p) => p.key).join(" ")}`);
    process.exit(2);
  }
  const a = loadAnchor();
  a.actualPhase = key;
  a.actualPhaseAt = new Date().toISOString();
  saveAnchor(a);
  console.log(`📍 실제 칸을 ${key} 로 적었다 (시계 칸과 다를 수 있다 — 그것이 «정보»다)`);
  process.exit(0);
}

if (isMain && argv.includes("--window")) {
  const raw = argv[argv.indexOf("--window") + 1] ?? "";
  const hours = Number(raw);
  // ⛔ 못 읽는 값은 «버린다» — NaN 을 창 길이로 쓰면 진행바가 조용히 이상해진다.
  if (!Number.isFinite(hours) || hours <= 0) {
    console.error(`⛔ 창 길이를 못 읽었다: ${raw || "(없음)"} — 예: --window 22`);
    process.exit(2);
  }
  const a = loadAnchor();
  const before = a.windowHours ?? DEFAULT_WINDOW_HOURS;
  a.windowHours = hours;
  saveAnchor(a);
  // ⛔ 「바꿨다」를 «말»로 하지 않는다 — 앞뒤 값과 앵커를 «같이» 낸다(앵커는 «안» 건드렸다는 증거).
  console.log(`⏱ 창 길이 ${before}h → ${hours}h  ·  앵커는 그대로: ${a.startedAt}  →  ${ANCHOR_PATH}`);
  process.exit(0);
}

if (isMain && argv.includes("--anchor")) {
  const a: Anchor = { startedAt: new Date().toISOString(), session: "F-53" };
  saveAnchor(a);
  console.log(`⏱ 세션 앵커를 지금으로 못 박았다: ${a.startedAt}  →  ${ANCHOR_PATH}`);
  process.exit(0);
}

function once(advanceChannel: boolean) {
  const anchor = loadAnchor();
  const s = snapshot(anchor, advanceChannel);
  console.log(wantJson ? JSON.stringify(s, null, 2) : render(s));
}

if (!isMain) {
  // 시험이 import 한 경우 — 아무것도 돌리지 않는다
} else if (watchSec > 0) {
  once(true);
  setInterval(() => {
    console.log("\n" + "─".repeat(70) + "\n");
    once(true);
  }, watchSec * 1000);
} else {
  once(true);
}
