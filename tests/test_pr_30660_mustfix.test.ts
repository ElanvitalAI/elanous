import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// PR #30660(head c0105f36161408f0a2a028447e1ed4dffada5c44) 리뷰 기록을 실체에 묶는 시험.
// 같은 diff 가 쓴 문서의 «형태»만 검사하면 Goodhart 다(round-0 시험은 불릿을 «advisory» 만
// 포함한 아무 문장으로 바꿔도 통과했다). 여기는 리뷰 원문 문구·인용 경로의 실재·수리 시험의 실재를 단언한다.

const REPO = resolve(import.meta.dir, "..");
const DOC = resolve(REPO, "docs/reviews/pr-30660-mustfix.md");
const text = readFileSync(DOC, "utf-8");

function section(name: string): string {
  const re = new RegExp(`^## ${name}[^\\n]*\\n`, "m");
  const start = text.search(re);
  if (start < 0) return "";
  const rest = text.slice(start).replace(re, "");
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

// 리뷰 원문 — must-fix 0. 이 줄은 그대로 보존한다(수리 대상은 SHOULD-FIX 두 항목뿐).
const MUSTFIX_EMPTY_LINE =
  "(없음. 아래 SHOULD-FIX 첫 두 줄은 머지 전에 고치기를 강하게 권한다.)";

// 리뷰 verify-by-breaking 이 실제로 남긴 두 항목 — 파일·근거·반증이 한 줄에 들어가 있어야 한다.
const SHOULD_FIX_1 =
  "- `src/cli/msg-cli.test.ts` — 근거: 이 파일을 완료경계 증거로 실행한 결과가 배선을 되돌린 상태에서 «이름 붙은 단언 실패» 없이 프로세스가 죽어 PR 변경을 구별하지 못한다(verify-by-breaking 관측). 반증: `git checkout f74e24568d -- src/cli/msg-cli.ts && bun test src/cli/msg-cli.test.ts -t agent-reply` → `error: unknown option '--agent-reply'` exit 2, 시험 요약 없이 즉사(ambiguous).";
const SHOULD_FIX_2 =
  "- `src/msg/msg-post-office.test.ts` — 근거: 같은 verify-by-breaking — 우편국 모듈이 PR 에서 새로 생겨 변경 전(base)에는 이 파일이 import crash 로 시험 0개로 끝나 변경을 구별하지 못한다. 반증: 모듈을 worktree 밖으로 치운 뒤 `bun test src/msg/msg-post-office.test.ts` → `Cannot find module './msg-post-office.js'`, 0 pass 1 error(ambiguous).";

// 이번 수리가 두 항목에 넣은 구별자 시험 이름 — 문서의 수리 기록 ↔ 소스 실체가 일치해야 한다.
const REPAIR_TEST_1 =
  "post office restart fires after the durable save, so the launch can already read the new post";
const REPAIR_TEST_2 =
  "a restart is ordered at the registered port and the discovery line survives for the next reader";

describe("PR #30660 must-fix review record", () => {
  it("Must-Fix 칸은 리뷰 원문 그대로 비어 있다", () => {
    const mustfix = section("Must-Fix");
    expect(mustfix).not.toBe("");
    expect(mustfix).toContain(MUSTFIX_EMPTY_LINE);
    const numbered = mustfix.split("\n").filter((l) => /^\s*\d+\.\s+\S/.test(l));
    expect(numbered.filter((l) => !l.includes("없음"))).toEqual([]);
  });

  it("Should-Fix 두 줄은 원본 권고 항목 그대로 — 파일·근거·반증이 명시적 문구로 들어 있다", () => {
    const shouldfix = section("Should-Fix");
    expect(shouldfix).not.toBe("");
    expect(shouldfix).toContain(SHOULD_FIX_1);
    expect(shouldfix).toContain(SHOULD_FIX_2);
  });

  it("기록이 인용한 경로는 모두 실재한다", () => {
    for (const rel of [
      "docs/reviews/pr-30660-mustfix.md",
      "src/cli/msg-cli.test.ts",
      "src/cli/msg-cli.ts",
      "src/msg/msg-post-office.test.ts",
      "src/msg/msg-post-office.ts",
    ]) {
      expect(existsSync(resolve(REPO, rel))).toBe(true);
    }
  });

  it("수리 기록이 적은 구별자 시험이 실제 소스와 문서 양쪽에 존재한다", () => {
    const cli = readFileSync(resolve(REPO, "src/cli/msg-cli.test.ts"), "utf-8");
    const office = readFileSync(resolve(REPO, "src/msg/msg-post-office.test.ts"), "utf-8");
    expect(cli).toContain(REPAIR_TEST_1);
    expect(office).toContain(REPAIR_TEST_2);
    const repair = section("Repair");
    expect(repair).toContain(REPAIR_TEST_1);
    expect(repair).toContain(REPAIR_TEST_2);
  });
});
