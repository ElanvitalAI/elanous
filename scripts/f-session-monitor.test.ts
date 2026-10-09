/**
 * f-session-monitor.test.ts — 감시자가 «존재하는 이유» 넷을 문다.
 *
 * ⛔ 이 시험은 「화면이 예쁜가」를 안 묻는다. 이 자가 없으면 다시 밟는 오독 넷만 문다:
 *   ⓐ 「0」을 「못 쟀음」과 섞는가          ⓑ probable-running 을 「없다」로 읽는가
 *   ⓒ 남의 트리 런을 내 관문에 세는가       ⓓ 한글 폭 때문에 표가 어긋나는가
 */
import { setDefaultTimeout, describe, expect, test } from "bun:test";
import {
  buildGates,
  evaluateTechblog1,
  type Techblog1Candidate,
  errored,
  measured,
  padW,
  phaseFor,
  PHASES,
  unmeasured,
  type LoadView,
  type PrView,
  parseWorktreeProcess,
  readTemplateConformance,
  TEMPLATE_LEDGER,
  parseTopCpu,
  stacksOf,
  targetOf,
  type Cell,
  type LiveProcView,
  type RunsView,
} from "./f-session-monitor";

describe('TECHBLOG1 독립 게시 판정', () => {
  const published = [{ installment: 1, publishedAt: '2026-10-01T00:00:00Z' }];
  const candidate = (): Techblog1Candidate => ({
    installment: 2,
    publishAt: '2026-10-03T00:00:00Z',
    measurements: [{ value: 0, source: '실측 로그', measuredAt: '2026-10-02T00:00:00Z' }],
    exposure: { publicBeforePublish: false, approved: false, revealsProtectedDetails: false, attorneyReviewed: false },
  });

  test('연속된 회차·정확히 이틀·출처 있는 0 실측·비공개 초안은 통과', () => {
    expect(evaluateTechblog1(published, candidate())).toEqual({ verdict: 'pass', reasons: [] });
  });

  test('회차를 건너뛰거나 중복하면 거부하며 이전 기록의 구멍도 거부', () => {
    expect(evaluateTechblog1(published, { ...candidate(), installment: 3 }).reasons).toContain('TECHBLOG1 연재 순서 또는 이전 게시 시각이 유효하지 않음');
    expect(evaluateTechblog1([{ installment: 2, publishedAt: published[0]!.publishedAt }], candidate()).verdict).toBe('fail');
    expect(evaluateTechblog1([{ ...published[0]! }, { ...published[0]! }], { ...candidate(), installment: 3 }).verdict).toBe('fail');
    expect(evaluateTechblog1([], { ...candidate(), installment: 1 }).verdict).toBe('pass');
  });

  test('48시간보다 1밀리초 빠르면 거부, 잘못된 날짜도 통과하지 않는다', () => {
    expect(evaluateTechblog1(published, { ...candidate(), publishAt: '2026-10-02T23:59:59.999Z' }).reasons).toContain('TECHBLOG1 직전 게시에서 이틀이 지나지 않음');
    expect(evaluateTechblog1(published, { ...candidate(), publishAt: 'bad' }).verdict).toBe('fail');
    expect(evaluateTechblog1([
      published[0]!, { installment: 2, publishedAt: '2026-10-02T23:59:59.999Z' },
    ], { ...candidate(), installment: 3, publishAt: '2026-10-05T00:00:00Z' }).reasons)
      .toContain('TECHBLOG1 이전 연재의 이틀 간격이 지켜지지 않음');
  });

  test('밀리초 초과 정밀도의 게시 시각은 거부하고 정확히 48시간인 밀리초 경계는 통과', () => {
    expect(evaluateTechblog1(
      [{ installment: 1, publishedAt: '2026-10-01T00:00:00.0009Z' }],
      { ...candidate(), publishAt: '2026-10-03T00:00:00.0000Z' },
    ).reasons).toContain('TECHBLOG1 연재 순서 또는 이전 게시 시각이 유효하지 않음');
    expect(evaluateTechblog1(published, { ...candidate(), publishAt: '2026-10-03T00:00:00.0000Z' }).reasons)
      .toContain('TECHBLOG1 게시 시각을 확인할 수 없음');
    expect(evaluateTechblog1(published, { ...candidate(), publishAt: '2026-10-03T00:00:00.000Z' }))
      .toEqual({ verdict: 'pass', reasons: [] });
    expect(evaluateTechblog1(
      [{ installment: 1, publishedAt: '2026-10-01T00:00:00.001Z' }],
      { ...candidate(), publishAt: '2026-10-03T00:00:00.001Z' },
    )).toEqual({ verdict: 'pass', reasons: [] });
    expect(evaluateTechblog1(
      [{ installment: 1, publishedAt: '2026-10-01T00:00:00.001Z' }],
      { ...candidate(), publishAt: '2026-10-03T00:00:00.000Z' },
    ).reasons).toContain('TECHBLOG1 직전 게시에서 이틀이 지나지 않음');
  });

  test('publishAt·publishedAt의 시간대 누락은 거부하며 오프셋을 포함한 정확히 48시간은 통과', () => {
    expect(evaluateTechblog1(published, { ...candidate(), publishAt: '2026-10-03T00:00:00' }).reasons)
      .toContain('TECHBLOG1 게시 시각을 확인할 수 없음');
    expect(evaluateTechblog1([{ installment: 1, publishedAt: '2026-10-01T00:00:00' }], candidate()).reasons)
      .toContain('TECHBLOG1 연재 순서 또는 이전 게시 시각이 유효하지 않음');
    expect(evaluateTechblog1(published, { ...candidate(), publishAt: '2026-10-03' }).reasons)
      .toContain('TECHBLOG1 게시 시각을 확인할 수 없음');
    expect(evaluateTechblog1(published, { ...candidate(), publishAt: '2026-10-03T08:59:59.999+09:00' }).reasons)
      .toContain('TECHBLOG1 직전 게시에서 이틀이 지나지 않음');
    expect(evaluateTechblog1(published, { ...candidate(), publishAt: '2026-10-03T09:00:00+09:00' }))
      .toEqual({ verdict: 'pass', reasons: [] });
    expect(evaluateTechblog1([
      published[0]!, { installment: 2, publishedAt: '2026-10-03T09:00:00+09:00' },
    ], { ...candidate(), installment: 3, publishAt: '2026-10-05T00:00:00Z' }))
      .toEqual({ verdict: 'pass', reasons: [] });
  });

  test('달력상 존재하지 않는 게시일은 정규화해 통과시키지 않는다', () => {
    expect(evaluateTechblog1(published, { ...candidate(), publishAt: '2026-02-30T00:00:00Z' }).reasons)
      .toContain('TECHBLOG1 게시 시각을 확인할 수 없음');
    expect(evaluateTechblog1([{ installment: 1, publishedAt: '2026-02-30T00:00:00Z' }], candidate()).reasons)
      .toContain('TECHBLOG1 연재 순서 또는 이전 게시 시각이 유효하지 않음');
    expect(evaluateTechblog1([], { ...candidate(), installment: 1, publishAt: '2024-02-29T00:00:00Z',
      measurements: [{ value: 0, source: '실측 로그', measuredAt: '2024-02-28T00:00:00Z' }],
    }).verdict).toBe('pass');
  });

  test('실측 시각에 시간대를 요구하고 게시 시각 경계를 오프셋으로 비교한다', () => {
    const withMeasuredAt = (measuredAt: string) => ({
      ...candidate(), measurements: [{ value: 1, source: '로그', measuredAt }],
    });
    expect(evaluateTechblog1(published, withMeasuredAt('2026-10-03T00:00:00')).reasons)
      .toContain('TECHBLOG1 실측 수치·출처·측정 시각이 확인되지 않음');
    expect(evaluateTechblog1(published, withMeasuredAt('2026-10-03T09:00:00+09:00')).verdict).toBe('pass');
    expect(evaluateTechblog1(published, withMeasuredAt('2026-10-03T09:00:00.001+09:00')).reasons)
      .toContain('TECHBLOG1 실측 수치·출처·측정 시각이 확인되지 않음');
  });

  test('실측 근거가 없거나 무한 수치·빈 출처·미래 측정이면 거부', () => {
    expect(evaluateTechblog1(published, { ...candidate(), measurements: [] }).verdict).toBe('fail');
    expect(evaluateTechblog1(published, { ...candidate(), measurements: [{ value: Infinity, source: '로그', measuredAt: '2026-10-02T00:00:00Z' }] }).verdict).toBe('fail');
    expect(evaluateTechblog1(published, { ...candidate(), measurements: [{ value: 1, source: ' ', measuredAt: '2026-10-02T00:00:00Z' }] }).verdict).toBe('fail');
    expect(evaluateTechblog1(published, { ...candidate(), measurements: [{ value: 1, source: '로그', measuredAt: '2026-10-04T00:00:00Z' }] }).verdict).toBe('fail');
  });

  test('공개 전 노출은 승인 필요, 보호 상세는 변리사 검토 필요', () => {
    const base = candidate();
    expect(evaluateTechblog1(published, { ...base, exposure: { ...base.exposure, publicBeforePublish: true } }).reasons).toContain('TECHBLOG1 공개 전 노출 승인 없음');
    expect(evaluateTechblog1(published, { ...base, exposure: { ...base.exposure, revealsProtectedDetails: true, approved: true } }).reasons).toContain('TECHBLOG1 보호 대상 상세는 변리사 검토 전 노출 불가');
    expect(evaluateTechblog1(published, { ...base, exposure: { publicBeforePublish: true, approved: true, revealsProtectedDetails: true, attorneyReviewed: true } }).verdict).toBe('pass');
  });
});

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const runsOf = (running: string[], probable: string[], others: Record<string, number> = {}): RunsView => ({
  myTree: { running, probable },
  otherTrees: others,
  totalLive: running.length + probable.length + Object.values(others).reduce((a, b) => a + b, 0),
});

const prsOf = (webclone: PrView["webclone"]): PrView => ({
  total: webclone.length,
  truncated: false,
  webclone,
  oldestAgeH: webclone.length ? Math.max(...webclone.map((p) => p.ageH)) : null,
  stacks: stacksOf(webclone),
});

const prOf = (number: number, target: string, ageH: number) => ({ number, ageH, title: target, target });

const gateNamed = (gates: ReturnType<typeof buildGates>, needle: string) => {
  const g = gates.find((x) => x.name.includes(needle));
  expect(g, `관문 「${needle}」 이 표에 없다`).toBeDefined();
  return g!;
};

describe("ⓐ 「0」과 「못 쟀음」을 섞지 않는다", () => {
  test("런을 못 쟀으면 「도는 골 0개」가 pass 가 «되지 않는다»", () => {
    const gates = buildGates(
      unmeasured<RunsView>("entries 가 비었다"),
      measured<LoadView>({ one: 1, cores: 18, perCore: 0.06 }),
      measured(prsOf([])),
    );
    const g = gateNamed(gates, "도는 골 0개");
    expect(g.verdict).toBe("unknown");
    expect(g.verdict).not.toBe("pass");
  });

  test("조회가 «오류»여도 pass 로 새지 않는다", () => {
    const gates = buildGates(
      errored<RunsView>("running-runs 실패"),
      errored<LoadView>("uptime 실패"),
      errored<PrView>("gh 산출 0바이트"),
    );
    expect(gates.every((g) => g.verdict !== "pass")).toBe(true);
    expect(gates.filter((g) => g.verdict === "unknown").length).toBe(gates.length);
  });

  test("열린 conform PR 이 «없다»는 것을 「착지했다」로 읽지 않는다", () => {
    const gates = buildGates(measured(runsOf([], [])), measured<LoadView>({ one: 1, cores: 18, perCore: 0.06 }), measured(prsOf([])));
    const g = gateNamed(gates, "conform");
    expect(g.verdict).toBe("unknown");
    expect(g.detail).toContain("아니다");
  });
});

describe("ⓑ probable-running 을 「없다」로 읽지 않는다", () => {
  test("PTY 가 안 보여도 live 원장이 있으면 관문이 «막힌다»", () => {
    const gates = buildGates(
      measured(runsOf([], ["run-1b08a2c6"])),
      measured<LoadView>({ one: 1, cores: 18, perCore: 0.06 }),
      measured(prsOf([])),
    );
    const g = gateNamed(gates, "도는 골 0개");
    expect(g.verdict).toBe("fail");
    // 원장이 «1» 을 봤다고 적는다 — 실물은 안 줬으니 ⚪ 로 남는다(0 으로 안 읽는다)
    expect(g.detail).toContain("원장 1");
    expect(g.detail).toContain("실물 ⚪");
  });

  test("running·probable 이 «둘 다» 0 일 때만 통과한다", () => {
    const gates = buildGates(
      measured(runsOf([], [])),
      measured<LoadView>({ one: 1, cores: 18, perCore: 0.06 }),
      measured(prsOf([])),
    );
    expect(gateNamed(gates, "도는 골 0개").verdict).toBe("pass");
  });
});

describe("ⓒ 남의 트리 런은 내 관문에 «안 센다»", () => {
  test("axon·pilot 이 돌아도 내 트리가 비면 통과한다", () => {
    const gates = buildGates(
      measured(runsOf([], [], { axon: 2, pilot: 1 })),
      measured<LoadView>({ one: 1, cores: 18, perCore: 0.06 }),
      measured(prsOf([])),
    );
    expect(gateNamed(gates, "도는 골 0개").verdict).toBe("pass");
  });
});

describe("ⓓ 표시폭 — 한글은 두 칸이다", () => {
  test("한글 라벨과 영문 라벨이 «같은 폭»으로 정렬된다", () => {
    expect(padW("로드", 10)).toHaveLength(10 - 4 + 2); // 4칸 먹고 6칸 채운다 ⇒ 문자수 2+6
    expect(padW("load", 10)).toHaveLength(10);
    const w = (s: string) => [...s].reduce((n, c) => n + (/[가-힣]/.test(c) ? 2 : 1), 0);
    expect(w(padW("도는 골 0개", 26))).toBe(26);
    expect(w(padW("load < 5", 26))).toBe(26);
  });

  test("이미 폭을 넘으면 자르지 «않는다»(정보 손실 금지)", () => {
    expect(padW("아주아주긴라벨", 3)).toBe("아주아주긴라벨");
  });
});

describe("로드맵 칸 — 경계에서 미끄러지지 않는다", () => {
  test("칸 경계는 [from, to) 로 붙어 있고 구멍이 없다", () => {
    for (let i = 1; i < PHASES.length; i += 1) expect(PHASES[i].from).toBe(PHASES[i - 1].to);
    expect(PHASES[0].from).toBe(0);
    expect(PHASES[PHASES.length - 1].to).toBe(12);
  });

  test("경계 시각은 «다음» 칸으로 넘어간다", () => {
    expect(phaseFor(0).key).toBe("Ⓞ");
    expect(phaseFor(0.999).key).toBe("Ⓞ");
    expect(phaseFor(1.0).key).toBe("Ⓐ");
    expect(phaseFor(6.5).key).toBe("Ⓔ");
  });

  test("12시간을 넘겨도 마지막 칸을 낸다(빈 값으로 안 샌다)", () => {
    expect(phaseFor(99).key).toBe("Ⓗ");
  });
});

describe("로드 관문", () => {
  test("판정선은 «절대 로드 5» 다 — 코어당으로 바꾸지 않는다", () => {
    const gates = buildGates(
      measured(runsOf([], [])),
      measured<LoadView>({ one: 11.5, cores: 18, perCore: 0.64 }),
      measured(prsOf([])),
    );
    expect(gateNamed(gates, "로드").verdict).toBe("fail");
  });
});


describe("ⓔ 이월의 «형태»는 수가 아니라 겹수다", () => {
  test("같은 대상에 쏜 것을 «한 겹»으로 묶는다", () => {
    const st = stacksOf([prOf(1, "archive-run", 30), prOf(2, "archive-run", 6), prOf(3, "measure-fidelity", 5)]);
    expect(st[0]).toMatchObject({ target: "archive-run", depth: 2, numbers: [1, 2] });
    expect(st[0].spanH).toBe(24);
    expect(st[1]).toMatchObject({ target: "measure-fidelity", depth: 1 });
  });

  test("깊은 겹이 «먼저» 온다 — 회수는 깊은 곳부터다", () => {
    const st = stacksOf([prOf(1, "a", 1), prOf(2, "b", 1), prOf(3, "b", 2), prOf(4, "b", 3)]);
    expect(st[0].target).toBe("b");
    expect(st[0].depth).toBe(3);
  });

  test("겹수 1 은 «겹이 아니다» — 버려진 초안으로 세지 않는다", () => {
    const st = stacksOf([prOf(1, "a", 1), prOf(2, "b", 1)]);
    const wasted = st.filter((s) => s.depth >= 2).reduce((n, s) => n + s.depth - 1, 0);
    expect(wasted).toBe(0);
  });
});

describe("대상 추출 — 브랜치·제목 어느 쪽에서든 집는다", () => {
  test("알려진 모듈 이름을 집는다", () => {
    expect(targetOf({ headRefName: "self-impl/goalid-x-src-webclone-archive-run-ts-y", title: "무관" })).toBe("archive-run");
    expect(targetOf({ headRefName: "z", title: "scripts/webclone: measure-fidelity.ts, measure-fidelity.test.ts" })).toBe("measure-fidelity");
    expect(targetOf({ headRefName: "z", title: "seed-conformance.ts, check-seed-conformance.ts" })).toBe("seed-conformance");
  });

  test("모르는 것은 «미분류»로 두지 말고 파일명이라도 집는다", () => {
    expect(targetOf({ headRefName: "b", title: "src/foo: widget-thing.ts" })).toBe("widget-thing");
  });

  test("아무 단서도 없으면 «미분류»라고 말한다 (조용히 뭉치지 않는다)", () => {
    expect(targetOf({ headRefName: "b", title: "설명만 있는 제목" })).toBe("미분류");
  });
});


describe("ⓕ 원장 «하나»로 판정하면 «거짓 통과»가 난다", () => {
  // 📏 계기 (2026-09-10 실측): running-runs 가 running 0 을 냈는데 같은 순간
  //    내 트리 워크트리 둘이 tsc 게이트로 478% CPU 를 태우고 있었다.
  const liveOf = (mine: string[], others: Record<string, string[]> = {}): Cell<LiveProcView> =>
    measured({ byTree: { elan: mine, ...others }, total: mine.length });
  const okLoad = () => measured<LoadView>({ one: 1, cores: 18, perCore: 0.06 });

  test("원장 0 인데 실물이 돌면 — 통과시키지 «않는다»", () => {
    const gates = buildGates(measured(runsOf([], [])), okLoad(), measured(prsOf([])), liveOf(["wt-a", "wt-b"]));
    const g = gateNamed(gates, "도는 골 0개");
    expect(g.verdict).toBe("fail");
    expect(g.detail).toContain("어긋난다");
  });

  test("원장이 돌고 실물이 0 이어도 — 역시 «어긋났다»고 말한다", () => {
    const gates = buildGates(measured(runsOf(["run-x"], [])), okLoad(), measured(prsOf([])), liveOf([]));
    expect(gateNamed(gates, "도는 골 0개").verdict).toBe("fail");
    expect(gateNamed(gates, "도는 골 0개").detail).toContain("어긋난다");
  });

  test("둘 다 0 이어야 통과한다", () => {
    const gates = buildGates(measured(runsOf([], [])), okLoad(), measured(prsOf([])), liveOf([]));
    expect(gateNamed(gates, "도는 골 0개").verdict).toBe("pass");
  });

  test("둘 다 돌면 통과 안 하고 «어긋남»이라고도 안 한다(같은 방향이다)", () => {
    const gates = buildGates(measured(runsOf(["r"], [])), okLoad(), measured(prsOf([])), liveOf(["wt"]));
    const g = gateNamed(gates, "도는 골 0개");
    expect(g.verdict).toBe("fail");
    expect(g.detail).not.toContain("어긋난다");
  });

  test("실물을 못 쟀으면 «0 으로 안 읽는다» — ⚪ 로 적고 원장으로 판정한다", () => {
    const gates = buildGates(measured(runsOf([], [])), okLoad(), measured(prsOf([])), errored<LiveProcView>("ps 실패"));
    const g = gateNamed(gates, "도는 골 0개");
    expect(g.verdict).toBe("pass");
    expect(g.detail).toContain("실물 ⚪");
  });

  test("둘 다 못 쟀으면 pass 가 «아니다»", () => {
    const gates = buildGates(unmeasured<RunsView>("원장 못 읽음"), okLoad(), measured(prsOf([])), errored<LiveProcView>("ps 실패"));
    expect(gateNamed(gates, "도는 골 0개").verdict).toBe("unknown");
  });
});

describe("실물 프로세스 줄 읽기", () => {
  test("워크트리 소유 트리와 워크트리 이름을 뽑는다", () => {
    const line =
      "node /Users/j/.elanous/worktrees/elan-7665ee85/monad-agent.worktrees/self-impl-in-src-webclone-computed-tokens-ts-defin-5d9c8685/node_modules/.bin/tsc --noEmit";
    expect(parseWorktreeProcess(line)).toEqual({
      tree: "elan",
      worktree: "self-impl-in-src-webclone-computed-tokens-ts-defin-5d9c8685",
    });
  });

  test("남의 트리도 트리 이름으로 갈린다", () => {
    const line = "node /Users/j/.elanous/worktrees/pilot-b2431b2b/monad-agent.worktrees/self-impl-x/node_modules/.bin/tsc";
    expect(parseWorktreeProcess(line)?.tree).toBe("pilot");
  });

  test("워크트리와 무관한 줄은 «세지 않는다»(null)", () => {
    expect(parseWorktreeProcess("/Applications/Adobe/Creative Cloud")).toBeNull();
    expect(parseWorktreeProcess("bun bin/elanous.mjs logs --category self-dev")).toBeNull();
  });
});


describe("ⓖ 시계 칸과 «실제» 칸을 가른다", () => {
  // 📏 계기 (2026-09-10): 1.72h 에 Ⓞ~Ⓔ 를 끝냈는데 감시자가 「📍 Ⓐ」라고 말했다.
  //    ⇒ 칸을 시계로만 정하면 «진도»가 아니라 «시각»을 보고한다.
  // ⛔ 이 시험은 «실물 진입점»을 부른다 — 플래그 배선은 import 로 원리상 못 문다.
  // ⛔⭐ 실물 진입점을 부르되 «실물 앵커»를 안 건드린다 — 2026-09-10 실측:
  //    이 시험이 도는 세션의 앵커를 덮어써서 화면의 「실제 칸」이 Ⓞ 로 되돌아갔다.
  const tmpAnchor = `/tmp/f-session-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`;
  const run = async (args: string[]) => {
    const proc = Bun.spawn(["bun", "scripts/f-session-monitor.ts", "--anchor-file", tmpAnchor, ...args], {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { out, err, code };
  };

  test("모르는 칸은 «거부»한다 — 조용히 삼키지 않는다", async () => {
    const r = await run(["--phase", "Ⓩ"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("모르는 칸");
    expect(r.err).toContain("Ⓞ");
  }, 30_000);

  test("칸을 안 주면 «거부»한다 (빈 문자열을 칸으로 안 읽는다)", async () => {
    const r = await run(["--phase"]);
    expect(r.code).toBe(2);
  }, 30_000);

  test("아는 칸은 받고 «즉시» 끝난다 — 느린 탐침을 안 돈다", async () => {
    const started = Date.now();
    const r = await run(["--phase", "Ⓞ"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("실제 칸을 Ⓞ");
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);
});

describe('⛔⭐ 「템플릿 둘로 자 시험」 — 「손으로 돌린다」를 «세는 자리»로 바꿨다', () => {
  const read = (text: string | null) => () => text;

  test('원장이 «없으면» 「0건」이 아니라 「없다」다', () => {
    const r = readTemplateConformance('x', read(null));
    expect(r.total).toBe(0);
    expect(r.rows).toEqual([]);
  });

  test('둘이 전 축을 통과하면 센다', () => {
    const r = readTemplateConformance('x', read('a\t7\t7\t2026-09-10\nb\t7\t7\t2026-09-10\n'));
    expect(r).toMatchObject({ passing: 2, total: 2 });
    expect(r.rows[0]).toContain('a 7/7');
  });

  test('⛔ 어긋난 축이 있으면 «통과로 세지 않는다»', () => {
    const r = readTemplateConformance('x', read('a\t7\t7\nb\t5\t7\n'));
    expect(r).toMatchObject({ passing: 1, total: 2 });
  });

  test('주석·빈 줄·모양이 깨진 줄은 «버린다» — 지어내지 않는다', () => {
    const r = readTemplateConformance('x', read('# 머리말\n\na\t7\t7\n깨진줄\nb\tzz\t7\n'));
    expect(r).toMatchObject({ passing: 1, total: 1 });
  });
});

// 🩸 2026-09-10: 원장을 `.elanous-session/`(=.gitignore 안)에 뒀다가 «기록이 트리를 못 떠나는» 것을 잡았다.
//    ⇒ 「재는 자리」는 «추적되는» 자리여야 한다. 이 시험이 그 자리를 못 박는다.
test('⛔ 원장은 «추적되는» 자리에 있다 — .elanous-session/ 은 .gitignore 안이다', () => {
  expect(TEMPLATE_LEDGER.startsWith('docs/')).toBe(true);
  expect(TEMPLATE_LEDGER).not.toContain('.elanous-session');
});

// 🩸 2026-09-11: 「로드 < 5」 관문이 «내 상태»가 아니라 «기계 상태»를 재고 있었다.
//    내 잔여를 전부 0 으로 걷었는데 로드는 82 였다 ⇒ 막힘은 맞지만 원인이 내 것이 아니었다.
describe('⛔⭐ 로드가 막히면 «누가 먹는지»를 같이 낸다', () => {
  test('ps 산출에서 상위를 뽑는다 — 경로는 마지막 조각만', () => {
    const out = ' %CPU COMM\n 383.1 /usr/local/bin/ast-grep\n 78.0 /x/y/qemu-headless\n 0.0 idle\n';
    const top = parseTopCpu(out, 2);
    expect(top).toEqual([
      { cpu: 383.1, name: 'ast-grep' },
      { cpu: 78, name: 'qemu-headless' },
    ]);
  });

  test('⛔ 못 읽으면 «빈 배열»이 아니라 undefined — 「없다」와 「못 쟀다」를 가른다', () => {
    expect(parseTopCpu('')).toBeUndefined();
    expect(parseTopCpu('머리말만 있고 수가 없다')).toBeUndefined();
  });

  test('0% 는 세지 않는다 — 「돌지만 안 먹는 것」은 말할 게 없다', () => {
    expect(parseTopCpu(' 0.0 idle\n 12.5 bun\n', 5)).toEqual([{ cpu: 12.5, name: 'bun' }]);
  });
});
