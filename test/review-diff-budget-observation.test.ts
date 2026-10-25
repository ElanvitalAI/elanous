import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as childProcess from "node:child_process";
import { debug } from "../src/debug/log.js";
import { reviewPullRequest } from "../src/agent-substrate/pr-reviewer.js";
import {
  runSelfReviewCliCommand,
  type SelfReviewCliDeps,
} from "../src/agent-substrate/self-review-cli.js";
import { defaultSeams } from "../src/self-implement/seams.js";
import { buildHarnessSeams, postPrReview } from "../src/harness/harness-seams.js";

const roots: string[] = [];
// ⚠️ delete 는 복원이 아니다 — 사전 설정값이 있으면 그 값을 잃는다. 원본을 잡아 두고 되돌린다.
const originalDiffCharsEnv = process.env.ELANOUS_PR_REVIEW_DIFF_CHARS;

afterEach(() => {
  if (originalDiffCharsEnv === undefined) delete process.env.ELANOUS_PR_REVIEW_DIFF_CHARS;
  else process.env.ELANOUS_PR_REVIEW_DIFF_CHARS = originalDiffCharsEnv;
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function largeMultiFileDiff(files = 8, contentChars = 800): string {
  return Array.from({ length: files }, (_, index) =>
    [
      `diff --git a/file-${index}.ts b/file-${index}.ts`,
      `--- a/file-${index}.ts`,
      `+++ b/file-${index}.ts`,
      "@@ -0,0 +1 @@",
      `+${"x".repeat(contentChars)}`,
    ].join("\n"),
  ).join("\n");
}

function oversizedSingleFileDiff(contentChars = 10_000): string {
  return largeMultiFileDiff(1, contentChars);
}

const TRUNCATED_MULTI_PASS_DIFF = largeMultiFileDiff(8, 3_000);

function git(cwd: string, args: string[]): void {
  const result = childProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

function tempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "review-budget-"));
  roots.push(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  writeFileSync(join(root, "README.md"), "base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "base"]);
  git(root, ["remote", "add", "origin", root]);
  git(root, ["fetch", "origin", "main"]);
  return root;
}

function cliDeps(
  review: Awaited<ReturnType<typeof reviewPullRequest>>,
  logs: Array<{ event: string; data: Record<string, unknown> }>,
): SelfReviewCliDeps {
  return {
    gh: (args) =>
      args[1] === "diff"
        ? { status: 0, stdout: TRUNCATED_MULTI_PASS_DIFF, stderr: "" }
        : {
            status: 0,
            stdout: JSON.stringify({ title: "title", body: "body" }),
            stderr: "",
          },
    reviewPullRequest: async () => review,
    renderReview: () => "rendered",
    makeApiLlm: () => async () => "VERDICT: PASS",
    makeAcpLlm: () => async () => "VERDICT: PASS",
    registerSink: async () => {},
    log: (event, data) =>
      logs.push({ event, data: data as Record<string, unknown> }),
    info: () => {},
    error: () => {},
    print: () => {},
    now: () => 100,
    envModel: () => undefined,
  };
}

describe("review diff-budget transport", () => {
  it("returns the exact prompt budget for an oversized file while fail-soft results omit it", async () => {
    process.env.ELANOUS_PR_REVIEW_DIFF_CHARS = "2000";
    const prDiff = oversizedSingleFileDiff();
    let prompt = "";
    const result = await reviewPullRequest(
      { prDiff, phaseIntent: "test" },
      async (value) => {
        prompt = value;
        return "VERDICT: PASS";
      },
    );

    expect(result.diffBudget).toEqual(
      expect.objectContaining({ truncated: true }),
    );
    expect(result.diffBudget?.omittedFiles).toBe(0);
    expect(prompt).toContain(
      `budget-truncated: ${result.diffBudget?.shownChars}/${result.diffBudget?.totalChars} chars shown`,
    );
    expect(
      await reviewPullRequest({ prDiff, phaseIntent: "test" }),
    ).not.toHaveProperty("diffBudget");
    expect(
      await reviewPullRequest({ prDiff, phaseIntent: "test" }, async () => {
        throw new Error("offline");
      }),
    ).not.toHaveProperty("diffBudget");
  });

  it("reports the complete diff for untruncated input", async () => {
    const prDiff = largeMultiFileDiff(1).slice(0, 200);
    const result = await reviewPullRequest(
      { prDiff, phaseIntent: "test" },
      async () => "VERDICT: PASS",
    );
    expect(result.diffBudget).toEqual({
      truncated: false,
      shownChars: prDiff.length,
      totalChars: prDiff.length,
      omittedFiles: 0,
    });
  });

  it("bounds referenced context per file, across files, and in total", async () => {
    process.env.ELANOUS_PR_REVIEW_DIFF_CHARS = "2000";
    const paths = Array.from({ length: 6 }, (_, index) => `src/file-${index}.ts`);
    const prDiff = `${oversizedSingleFileDiff()}\n${paths.join("\n")}`;
    const reads: string[] = [];
    let prompt = "";
    const review = await reviewPullRequest(
      {
        prDiff,
        phaseIntent: "test",
        readReferencedFile: (path) => {
          reads.push(path);
          return { kind: "ok", contents: "x".repeat(10_000) };
        },
      },
      async (value) => {
        prompt = value;
        return "VERDICT: PASS";
      },
    );

    const context = prompt.split("## Repository file context (read within repository boundary)\n")[1]!
      .split("\n\nReply in Korean.")[0]!;
    expect(reads).toHaveLength(4);
    expect(review).toMatchObject({ referencedFilesOpened: true, referencedFilesRead: 4 });
    expect(context.length).toBeLessThanOrEqual(12_000);
    expect((context.match(/^### /gm) ?? [])).toHaveLength(3);
    expect(context).toContain("chars omitted from referenced file");
  });

  it("passes the injected repository reader to the actual review call and observes its reads", async () => {
    process.env.ELANOUS_PR_REVIEW_DIFF_CHARS = "2000";
    const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
    const reader = (path: string) => ({ kind: "ok" as const, contents: `context for ${path}` });
    let capturedInput: Parameters<SelfReviewCliDeps["reviewPullRequest"]>[0] | undefined;
    const deps = cliDeps({ verdict: "pass", mustFix: [], shouldFix: [], reviewed: true }, logs);
    deps.gh = (args) => args[1] === "diff"
      ? { status: 0, stdout: oversizedSingleFileDiff(), stderr: "" }
      : { status: 0, stdout: JSON.stringify({ title: "title", body: "body" }), stderr: "" };
    deps.readReferencedFile = reader;
    deps.reviewPullRequest = async (input, llm) => {
      capturedInput = input;
      return reviewPullRequest(input, llm);
    };

    await runSelfReviewCliCommand(["42"], { intent: "test", reviewerMix: null }, deps);

    expect(capturedInput?.readReferencedFile).toBe(reader);
    const done = logs.find((entry) => entry.event === "done")?.data;
    expect(done?.referencedFilesOpened).toBe(true);
    expect(typeof done?.referencedFilesRead).toBe("number");
    expect(done?.referencedFilesRead as number).toBeGreaterThan(0);
  });

  it("keeps CLI observation field names and values from the returned budget", async () => {
    process.env.ELANOUS_PR_REVIEW_DIFF_CHARS = "2000";
    const review = await reviewPullRequest(
      { prDiff: oversizedSingleFileDiff(), phaseIntent: "test" },
      async () => "VERDICT: PASS",
    );
    const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
    await runSelfReviewCliCommand(
      ["42"],
      { intent: "test", reviewerMix: null },
      cliDeps(review, logs),
    );
    expect(logs.find((entry) => entry.event === "done")?.data).toMatchObject({
      diffTruncated: true,
      diffShownChars: review.diffBudget?.shownChars,
      diffTotalChars: review.diffBudget?.totalChars,
      diffOmittedFiles: review.diffBudget?.omittedFiles,
    });
  });

  it("emits an untruncated budget from the self-implement review.done seam", async () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "small.ts"), "export const small = true;\n");
    git(repo, ["add", "-N", "small.ts"]);
    const events: Record<string, unknown>[] = [];
    const log = spyOn(debug, "log").mockImplementation(((
      _category: string,
      event: string,
      data?: Record<string, unknown>,
    ) => {
      if (event === "review.done") events.push(data ?? {});
    }) as never);
    try {
      await defaultSeams({ llmReview: async () => "VERDICT: PASS" })
        .reviewDiff!(repo, { goal: "test", round: 2 });
    } finally {
      log.mockRestore();
    }
    expect(events).toContainEqual(expect.objectContaining({
      diffTruncated: false,
      diffOmittedFiles: 0,
      round: 2,
    }));
    expect(events[0]?.diffShownChars).toBe(events[0]?.diffTotalChars);
  });

  it("keeps no-diff review.done budget fields absent rather than fabricating completeness", async () => {
    const repo = tempRepo();
    const events: Record<string, unknown>[] = [];
    const log = spyOn(debug, "log").mockImplementation(((
      _category: string,
      event: string,
      data?: Record<string, unknown>,
    ) => {
      if (event === "review.done") events.push(data ?? {});
    }) as never);
    try {
      await defaultSeams({ llmReview: async () => "VERDICT: PASS" })
        .reviewDiff!(repo, { goal: "test", round: 3 });
    } finally {
      log.mockRestore();
    }
    expect(events).toContainEqual(expect.objectContaining({ reason: "no-diff", reviewed: false, round: 3 }));
    expect(events[0]).not.toHaveProperty("diffTruncated");
    expect(events[0]).not.toHaveProperty("diffShownChars");
    expect(events[0]).not.toHaveProperty("diffTotalChars");
    expect(events[0]).not.toHaveProperty("diffOmittedFiles");
  });

  it("omits round from completed review.done when the context does not provide it", async () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "small.ts"), "export const small = true;\n");
    git(repo, ["add", "-N", "small.ts"]);
    const events: Record<string, unknown>[] = [];
    const log = spyOn(debug, "log").mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === "review.done") events.push(data ?? {});
    }) as never);
    try {
      await defaultSeams({ llmReview: async () => "VERDICT: PASS" })
        .reviewDiff!(repo, { goal: "test" });
    } finally {
      log.mockRestore();
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ verdict: "pass", reviewed: true, mustFix: 0, shouldFix: 0 });
    expect(events[0]).not.toHaveProperty("round");
  });

  it("preserves the review budget through the self-implement control seam", async () => {
    process.env.ELANOUS_PR_REVIEW_DIFF_CHARS = "2000";
    const repo = tempRepo();
    const files = Array.from({ length: 8 }, (_, index) => `file-${index}.ts`);
    for (const file of files) writeFileSync(join(repo, file), "x".repeat(3_000));
    git(repo, ["add", "-N", ...files]);

    const review = await defaultSeams({ llmReview: async () => "VERDICT: WARN" })
      .reviewDiff!(repo, { goal: "test" });

    expect(review).toMatchObject({
      reviewed: true,
      diffTruncated: true,
      diffShownChars: expect.any(Number),
      diffTotalChars: expect.any(Number),
      diffOmittedFiles: expect.any(Number),
    });
  });

  it("emits a truncated budget from the self-implement review.done seam", async () => {
    process.env.ELANOUS_PR_REVIEW_DIFF_CHARS = "2000";
    const repo = tempRepo();
    const files = Array.from({ length: 8 }, (_, index) => `file-${index}.ts`);
    for (const file of files) writeFileSync(join(repo, file), "x".repeat(3_000));
    git(repo, ["add", "-N", ...files]);
    const events: Record<string, unknown>[] = [];
    const log = spyOn(debug, "log").mockImplementation(((
      _category: string,
      event: string,
      data?: Record<string, unknown>,
    ) => {
      if (event === "review.done") events.push(data ?? {});
    }) as never);
    try {
      await defaultSeams({ llmReview: async () => "VERDICT: PASS" })
        .reviewDiff!(repo, { goal: "test" });
    } finally {
      log.mockRestore();
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        diffTruncated: true,
        diffShownChars: expect.any(Number),
        diffTotalChars: expect.any(Number),
        diffOmittedFiles: expect.any(Number),
      }),
    );
    expect(events[0]?.diffOmittedFiles).toBeGreaterThan(0);
  });

  it("marks an empty harness critique diff as unreviewed rather than an authoritative pass", async () => {
    const repo = tempRepo();
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const log = spyOn(debug, "log").mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      events.push({ category, event, data: data ?? {} });
    }) as never);
    try {
      const seams = buildHarnessSeams({
        seams: {
          createWorktree: async () => ({ path: repo, branch: "test" }),
          gate: async () => ({ passed: true, steps: [], log: "" }),
          implement: async () => ({ ok: true, summary: "" }),
          openPr: async () => ({ url: "", number: 0 }),
        } as never,
        llmReview: async () => "VERDICT: PASS",
      });
      await seams.plan({ objective: "non-code goal" });
      await expect(seams.review({ objective: "non-code goal", changes: [] })).resolves.toMatchObject({
        verdict: "warn",
        findings: ["자율 PR 리뷰 미실행(fail-soft) — 미검토"],
      });
    } finally {
      log.mockRestore();
    }
    expect(events).toContainEqual(expect.objectContaining({
      category: "harness.seams", event: "review.done",
      data: expect.objectContaining({ verdict: "pass", reviewed: false, mustFix: 0, shouldFix: 0, reason: "no-diff" }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      category: "harness.review", event: "unreviewed",
      data: expect.objectContaining({ reviewed: false, reason: "no-diff" }),
    }));
  });

  it("preserves reviewed LLM critique behavior for a non-empty harness diff", async () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "changed.ts"), "export const changed = true;\n");
    git(repo, ["add", "-N", "changed.ts"]);
    const events: Record<string, unknown>[] = [];
    const log = spyOn(debug, "log").mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === "review.done") events.push(data ?? {});
    }) as never);
    try {
      const seams = buildHarnessSeams({
        seams: {
          createWorktree: async () => ({ path: repo, branch: "test" }),
          gate: async () => ({ passed: true, steps: [], log: "" }),
          implement: async () => ({ ok: true, summary: "" }),
          openPr: async () => ({ url: "", number: 0 }),
        } as never,
        llmReview: async () => "VERDICT: PASS",
      });
      await seams.plan({ objective: "code goal" });
      await expect(seams.review({ objective: "code goal", changes: ["changed.ts"] })).resolves.toMatchObject({
        verdict: "pass", findings: [],
      });
    } finally {
      log.mockRestore();
    }
    expect(events).toContainEqual(expect.objectContaining({ verdict: "pass", reviewed: true }));
  });

  it("emits the same fields from the harness critique review seam", async () => {
    process.env.ELANOUS_PR_REVIEW_DIFF_CHARS = "2000";
    const repo = tempRepo();
    const files = Array.from({ length: 8 }, (_, index) => `file-${index}.ts`);
    for (const file of files) writeFileSync(join(repo, file), "x".repeat(3_000));
    git(repo, ["add", "-N", ...files]);
    const events: Record<string, unknown>[] = [];
    const log = spyOn(debug, "log").mockImplementation(((
      _category: string,
      event: string,
      data?: Record<string, unknown>,
    ) => {
      if (event === "review.done") events.push(data ?? {});
    }) as never);
    try {
      const seams = buildHarnessSeams({
        seams: {
          createWorktree: async () => ({ path: repo, branch: "test" }),
          gate: async () => ({ passed: true, steps: [], log: "" }),
          implement: async () => ({ ok: true, summary: "" }),
          openPr: async () => ({ url: "", number: 0 }),
        } as never,
        llmReview: async () => "VERDICT: PASS",
      });
      await seams.plan({ objective: "test" });
      await seams.review({ objective: "test", changes: [] });
    } finally {
      log.mockRestore();
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        diffTruncated: true,
        diffShownChars: expect.any(Number),
        diffTotalChars: expect.any(Number),
        diffOmittedFiles: expect.any(Number),
      }),
    );
    expect(events[0]?.diffOmittedFiles).toBeGreaterThan(0);
  });

  it("emits budget fields from the harness deployed-review seam", async () => {
    process.env.ELANOUS_PR_REVIEW_DIFF_CHARS = "2000";
    const events: Record<string, unknown>[] = [];
    const log = spyOn(debug, "log").mockImplementation(((
      _category: string,
      event: string,
      data?: Record<string, unknown>,
    ) => {
      if (event === "deployed-review") events.push(data ?? {});
    }) as never);
    try {
      await postPrReview(
        ".", 42, "test", async () => "VERDICT: PASS",
        ((command: string, args: string[]) => command === "gh" && args[1] === "diff"
          ? { status: 0, stdout: TRUNCATED_MULTI_PASS_DIFF, stderr: "" }
          : { status: 0, stdout: "", stderr: "" }) as never,
      );
    } finally {
      log.mockRestore();
    }
    expect(events).toContainEqual(expect.objectContaining({
      diffTruncated: true,
      diffShownChars: expect.any(Number),
      diffTotalChars: expect.any(Number),
      diffOmittedFiles: expect.any(Number),
    }));
    expect(events[0]?.diffOmittedFiles).toBeGreaterThan(0);
  });
});
